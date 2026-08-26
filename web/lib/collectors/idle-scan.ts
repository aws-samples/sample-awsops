// Idle Resource Scanner collector — v1 port (v1 src/lib/collectors/idle-scan.ts).
// 유휴/미사용 AWS 리소스 스캔: Steampipe SQL로 낭비 리소스 탐지 (모든 수집은 aws-data의
// guarded runSteampipeQuery 경유 — 새 커넥션 없음). Per-category fail-open: a failed query is
// disclosed in the context, never fails the whole scan.
import { runSteampipeQuery, steampipeAvailable } from '../aws-data';
import type { ChatCollector, CollectCtx, CollectOutput } from './index';

// ── SQL queries for idle resource detection (v1 verbatim + explicit LIMITs; the
//    runSteampipeQuery guard additionally enforces SELECT-only and a 200-row cap) ──

// v1 fix: v1 filtered on `status`, but the Steampipe column is `state` (aws-data catalog).
const SQL_UNATTACHED_EBS = `
SELECT volume_id, volume_type, size, create_time, account_id, region
FROM aws_ebs_volume
WHERE state = 'available'
ORDER BY size DESC
LIMIT 200`;

const SQL_GP2_VOLUMES = `
SELECT volume_id, volume_type, size, iops, account_id, region
FROM aws_ebs_volume
WHERE volume_type = 'gp2'
ORDER BY size DESC
LIMIT 200`;

const SQL_UNASSOCIATED_EIPS = `
SELECT allocation_id, public_ip, account_id, region
FROM aws_vpc_eip
WHERE association_id IS NULL
LIMIT 200`;

const SQL_STOPPED_INSTANCES = `
SELECT instance_id, instance_type, launch_time, instance_state, account_id, region,
  tags ->> 'Name' AS name
FROM aws_ec2_instance
WHERE instance_state = 'stopped'
LIMIT 200`;

const SQL_OLD_SNAPSHOTS = `
SELECT snapshot_id, volume_id, volume_size, start_time, account_id, region
FROM aws_ebs_snapshot
WHERE start_time < NOW() - INTERVAL '90 days'
ORDER BY volume_size DESC
LIMIT 50`;

// v1 fix: v1 used unnest(security_groups), but the Steampipe table exposes `groups` (JSONB of
// {GroupId, GroupName}) — the v1 query was marked fragile and error-swallowed; this form works.
const SQL_UNUSED_SECURITY_GROUPS = `
SELECT group_id, group_name, vpc_id, account_id, region
FROM aws_vpc_security_group
WHERE group_name != 'default'
  AND group_id NOT IN (
    SELECT DISTINCT g ->> 'GroupId'
    FROM aws_ec2_network_interface,
         jsonb_array_elements(groups) AS g
    WHERE groups IS NOT NULL
  )
LIMIT 200`;

// ── Cost estimation (v1 parity — ap-northeast-2 pricing) ────────────────────

interface IdleCategory {
  key: string;
  label: string;
  sql: string;
  /** Estimate monthly cost for a single row */
  estimateCost: (row: Record<string, unknown>) => number;
  costLabel: string;
}

export const IDLE_CATEGORIES: IdleCategory[] = [
  {
    key: 'unattachedEbs',
    label: 'Unattached EBS Volumes',
    sql: SQL_UNATTACHED_EBS,
    estimateCost: (row) => (Number(row.size) || 0) * 0.10,
    costLabel: '$0.10/GB/mo (gp3 rate)',
  },
  {
    key: 'gp2Volumes',
    label: 'Previous-gen EBS (gp2)',
    sql: SQL_GP2_VOLUMES,
    estimateCost: (row) => (Number(row.size) || 0) * 0.02, // $0.10 - $0.08 savings
    costLabel: '$0.02/GB/mo savings if migrated to gp3',
  },
  {
    key: 'unassociatedEips',
    label: 'Unassociated Elastic IPs',
    sql: SQL_UNASSOCIATED_EIPS,
    estimateCost: () => 3.60,
    costLabel: '$3.60/mo each',
  },
  {
    key: 'stoppedInstances',
    label: 'Stopped EC2 Instances',
    sql: SQL_STOPPED_INSTANCES,
    estimateCost: () => 0,
    costLabel: '$0 direct (RI waste risk)',
  },
  {
    key: 'oldSnapshots',
    label: 'Old EBS Snapshots (90+ days)',
    sql: SQL_OLD_SNAPSHOTS,
    estimateCost: (row) => (Number(row.volume_size) || 0) * 0.05,
    costLabel: '$0.05/GB/mo',
  },
  {
    key: 'unusedSecurityGroups',
    label: 'Unused Security Groups',
    sql: SQL_UNUSED_SECURITY_GROUPS,
    estimateCost: () => 0,
    costLabel: '$0 (security hygiene)',
  },
];

interface CategoryResult {
  key: string;
  label: string;
  rows: Record<string, unknown>[];
  count: number;
  truncated: boolean;
  estimatedMonthlyCost: number;
  costLabel: string;
  error?: string;
}

// ── Collector implementation ────────────────────────────────────────────────

const idleScanCollector: ChatCollector = {
  key: 'idle-scan',
  sectionMeta: { agentName: 'Idle Resource Scanner' },

  // The scan is 100% Steampipe SQL — Steampipe down ⇒ fall through to normal routing.
  available: () => steampipeAvailable(),

  async collect(ctx: CollectCtx): Promise<CollectOutput> {
    // Surface every category as a step BEFORE firing (SSE query previews), then run in parallel.
    for (const cat of IDLE_CATEGORIES) {
      ctx.onStep({ tool: 'steampipe_sql', query: cat.sql.trim().replace(/\s+/g, ' ') });
    }
    const results = await Promise.allSettled(
      IDLE_CATEGORIES.map((cat) => runSteampipeQuery(cat.sql)),
    );

    const categories: CategoryResult[] = [];
    const summary: string[] = [];
    let totalMonthlyCost = 0;
    let totalIdleCount = 0;
    let okQueries = 0;

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const cat = IDLE_CATEGORIES[i];
      if (r.status === 'fulfilled') {
        const rows = r.value.rows;
        const monthlyCost = rows.reduce((sum, row) => sum + cat.estimateCost(row), 0);
        categories.push({
          key: cat.key, label: cat.label, rows, count: rows.length,
          truncated: r.value.truncated, estimatedMonthlyCost: monthlyCost, costLabel: cat.costLabel,
        });
        totalMonthlyCost += monthlyCost;
        totalIdleCount += rows.length;
        okQueries++;
        summary.push(`${cat.label}: ${rows.length} found${r.value.truncated ? ' (truncated at 200 — cost is a lower bound)' : ''}${monthlyCost > 0 ? ` (~$${monthlyCost.toFixed(2)}/mo)` : ''}`);
      } else {
        const errMsg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        categories.push({
          key: cat.key, label: cat.label, rows: [], count: 0,
          truncated: false, estimatedMonthlyCost: 0, costLabel: cat.costLabel, error: errMsg,
        });
        summary.push(`${cat.label}: 미가용 (query failed: ${errMsg.slice(0, 120)})`);
      }
    }

    // ── Format context (v1 formatContext parity) ──
    const sections: string[] = [];
    sections.push('## Idle Resource Summary');
    sections.push('| Category | Count | Est. Monthly Cost | Note |');
    sections.push('|----------|------:|------------------:|------|');
    for (const cat of categories) {
      if (cat.error) {
        sections.push(`| ${cat.label} | - | - | Query failed |`);
      } else {
        sections.push(`| ${cat.label} | ${cat.count}${cat.truncated ? '+' : ''} | $${cat.estimatedMonthlyCost.toFixed(2)} | ${cat.costLabel} |`);
      }
    }
    sections.push(`| **TOTAL** | **${totalIdleCount}** | **$${totalMonthlyCost.toFixed(2)}** | |`);
    for (const cat of categories) {
      if (cat.count === 0) continue;
      sections.push(`\n### ${cat.label} (${cat.count}${cat.truncated ? ', truncated at 200' : ''})`);
      sections.push(`\`\`\`json\n${JSON.stringify(cat.rows.slice(0, 50))}\n\`\`\``);
    }
    sections.push('\n## Collection Summary\n' + summary.map((s) => `- ${s}`).join('\n'));

    const context = okQueries > 0 && totalIdleCount === 0
      ? '--- IDLE RESOURCE SCAN: No idle resources found ---\n' + sections.join('\n')
      : '--- IDLE RESOURCE SCAN DATA (collected automatically via Steampipe) ---\n' + sections.join('\n');

    return {
      context,
      summary,
      tools: okQueries > 0 ? ['steampipe_sql'] : [],
      collected: okQueries,
      via: `Idle Resource Scanner (${totalIdleCount} idle, ~$${totalMonthlyCost.toFixed(0)}/mo)`,
    };
  },

  // v1 analysisPrompt verbatim
  analysisPrompt: `You are an AWS FinOps expert analyzing idle and unused resources.
You have been given REAL data from Steampipe scans of the user's AWS account.

## Analysis Structure

### 1. Executive Summary
- Total estimated monthly waste from idle resources
- Number of idle resources by category
- Quick wins (easy to clean up)

### 2. High Priority (Immediate Action)
- Unattached EBS volumes (wasting money right now)
- Unassociated Elastic IPs ($3.60/month each)
- Old snapshots consuming storage

### 3. Medium Priority (Review Needed)
- Stopped EC2 instances (may have associated EBS, RI waste)
- gp2 -> gp3 migration candidates (cost + performance improvement)

### 4. Low Priority (Hygiene)
- Unused security groups (security posture improvement)

### 5. Remediation Commands
For each finding, provide specific AWS CLI commands:
- \`aws ec2 delete-volume --volume-id vol-xxx\`
- \`aws ec2 release-address --allocation-id eipalloc-xxx\`
- \`aws ec2 modify-volume --volume-type gp3 --volume-id vol-xxx\`

## Rules
- Calculate savings using the cost estimates provided
- Group by account_id if multi-account
- Flag any resources with tags suggesting they may still be needed
- If a category is marked failed/unavailable, say so — do not invent data for it
- Use tables for easy scanning`,
};

export default idleScanCollector;
