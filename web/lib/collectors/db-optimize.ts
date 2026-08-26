// DB Rightsizing Optimizer collector — v1 port (v1 src/lib/collectors/db-optimize.ts) on v2 sources.
// DB 서비스 적정 규모 컬렉터: RDS + ElastiCache + OpenSearch 구성(Steampipe) + CloudWatch 메트릭 수집.
//
// v1 → v2 source mapping:
// - Steampipe lists (v1 runQuery + queries/*.ts) → runSteampipeQuery (guarded, 200-row cap).
// - CloudWatch metrics (v1 fetched its own /api/rds|elasticache|opensearch routes over localhost)
//   → lib/metrics fleet helpers DIRECTLY (rdsFleetLive/elasticacheFleetLive/opensearchFleetLive) —
//   no self-HTTP hop, richer diagnostic keys (burst/credit, thread-pool rejects, evictions).
import { runSteampipeQuery, steampipeAvailable } from '../aws-data';
import { rdsFleetLive, elasticacheFleetLive, opensearchFleetLive } from '../metrics';
import type { ChatCollector, CollectCtx, CollectOutput } from './index';

// Cap the CloudWatch fan-out per service (fleetLatest batches internally; this bounds context size).
const METRIC_ID_CAP = 25;

// ── Steampipe SQL (v1 queries/rds|elasticache|opensearch list queries, trimmed to the columns the
//    analysis uses + explicit LIMITs; the runSteampipeQuery guard enforces SELECT-only + 200 cap) ──

export const DB_SQL = {
  // v1 queries/rds.ts detail-style list (class AS instance_class — v1 catalog rule)
  rdsInstances: `
SELECT
  db_instance_identifier,
  engine,
  engine_version,
  class AS instance_class,
  status,
  multi_az,
  allocated_storage,
  storage_type,
  region,
  account_id
FROM aws_rds_db_instance
ORDER BY db_instance_identifier
LIMIT 100`,

  // v1 queries/elasticache.ts clusterList (trimmed)
  ecClusters: `
SELECT
  cache_cluster_id,
  cache_node_type,
  engine,
  engine_version,
  cache_cluster_status,
  num_cache_nodes,
  replication_group_id,
  region,
  account_id
FROM aws_elasticache_cluster
ORDER BY cache_cluster_id
LIMIT 100`,

  // v1 queries/opensearch.ts list (cluster_config/ebs_options JSONB → text, parsed in TS)
  osDomains: `
SELECT
  domain_name,
  engine_version,
  processing,
  cluster_config::text AS cluster_config,
  ebs_options::text AS ebs_options,
  region,
  account_id
FROM aws_opensearch_domain
ORDER BY domain_name
LIMIT 50`,
} as const;

const oneLine = (sql: string) => sql.trim().replace(/\s+/g, ' ');
const str = (v: unknown) => (v == null ? '' : String(v));
const parseJson = (v: unknown): Record<string, unknown> | null => {
  if (v && typeof v === 'object') return v as Record<string, unknown>;
  if (typeof v !== 'string') return null;
  try { return JSON.parse(v) as Record<string, unknown>; } catch { return null; }
};

type Rows = Record<string, unknown>[];
type Fleet = Record<string, Record<string, number | null>>;

// ── Collector implementation ────────────────────────────────────────────────

const dbOptimizeCollector: ChatCollector = {
  key: 'db-optimize',
  sectionMeta: { agentName: 'DB Rightsizing Optimizer' },

  // Resource discovery rides Steampipe — down ⇒ normal routing (CloudWatch alone cannot even
  // enumerate the instances/clusters/domains to probe).
  available: () => steampipeAvailable(),

  async collect(ctx: CollectCtx): Promise<CollectOutput> {
    const summary: string[] = [];
    const sections: string[] = [];
    const tools: string[] = [];
    let collected = 0;

    // ── Phase 1: resource lists (Steampipe, parallel; per-service fail-open) ──
    const lists = [
      { key: 'rds', label: 'RDS instances', sql: DB_SQL.rdsInstances },
      { key: 'ec', label: 'ElastiCache clusters', sql: DB_SQL.ecClusters },
      { key: 'os', label: 'OpenSearch domains', sql: DB_SQL.osDomains },
    ] as const;
    for (const l of lists) ctx.onStep({ tool: 'steampipe_sql', query: oneLine(l.sql) });
    const listResults = await Promise.allSettled(lists.map((l) => runSteampipeQuery(l.sql)));

    const rows: Record<string, Rows> = { rds: [], ec: [], os: [] };
    for (let i = 0; i < lists.length; i++) {
      const r = listResults[i];
      const l = lists[i];
      if (r.status === 'fulfilled') {
        rows[l.key] = r.value.rows;
        collected++;
        if (!tools.includes('steampipe_sql')) tools.push('steampipe_sql');
        summary.push(`${l.label} (Steampipe): ${r.value.rowCount} found`);
      } else {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        summary.push(`${l.label} (Steampipe): 미가용 (query failed: ${msg.slice(0, 120)})`);
      }
    }

    // ── Phase 2: CloudWatch metrics for discovered resources (lib/metrics fleets, parallel).
    //    fleetLatest never throws — an all-null map means no datapoints (stopped / wrong region). ──
    const rdsIds = rows.rds.map((r) => str(r.db_instance_identifier)).filter(Boolean).slice(0, METRIC_ID_CAP);
    const ecIds = rows.ec.map((r) => str(r.cache_cluster_id)).filter(Boolean).slice(0, METRIC_ID_CAP);
    const osNames = rows.os.map((r) => str(r.domain_name)).filter(Boolean).slice(0, METRIC_ID_CAP);

    if (rdsIds.length) ctx.onStep({ tool: 'cloudwatch_metrics', query: `AWS/RDS fleet metrics: ${rdsIds.length} instances (last 1h)` });
    if (ecIds.length) ctx.onStep({ tool: 'cloudwatch_metrics', query: `AWS/ElastiCache fleet metrics: ${ecIds.length} clusters (last 1h)` });
    if (osNames.length) ctx.onStep({ tool: 'cloudwatch_metrics', query: `AWS/ES fleet metrics: ${osNames.length} domains (last 1h)` });

    const [rdsM, ecM, osM]: Fleet[] = await Promise.all([
      rdsIds.length ? rdsFleetLive(rdsIds) : Promise.resolve({}),
      ecIds.length ? elasticacheFleetLive(ecIds) : Promise.resolve({}),
      osNames.length ? opensearchFleetLive(osNames) : Promise.resolve({}),
    ]);
    const withData = (f: Fleet) => Object.values(f).filter((m) => Object.values(m).some((v) => v !== null)).length;
    const metricCounts = { rds: withData(rdsM), ec: withData(ecM), os: withData(osM) };
    const totalMetricSets = metricCounts.rds + metricCounts.ec + metricCounts.os;
    if (totalMetricSets > 0) {
      collected++;
      tools.push('cloudwatch_metrics');
      summary.push(`CloudWatch metrics: RDS ${metricCounts.rds}/${rdsIds.length}, ElastiCache ${metricCounts.ec}/${ecIds.length}, OpenSearch ${metricCounts.os}/${osNames.length} with data`);
    } else if (rdsIds.length + ecIds.length + osNames.length > 0) {
      summary.push('CloudWatch metrics: 미가용 (no datapoints returned — check region/permissions)');
    }

    // ── Format context (v1 formatContext parity: per-resource config + metrics JSON) ──
    if (rows.rds.length > 0) {
      const enriched = rows.rds.map((inst) => {
        const m = rdsM[str(inst.db_instance_identifier)];
        return {
          id: inst.db_instance_identifier,
          engine: `${str(inst.engine)} ${str(inst.engine_version)}`,
          class: inst.instance_class,
          multiAz: inst.multi_az,
          storage: `${str(inst.allocated_storage)} GB (${str(inst.storage_type)})`,
          status: inst.status,
          region: inst.region,
          account: inst.account_id,
          metrics: m ?? 'No metrics available',
        };
      });
      sections.push(`## RDS Instances (config: Steampipe, metrics: CloudWatch last 1h — cpu %, freeStorage/freeMem bytes, conn, read/writeLat s, read/writeIops, diskQueue, burst/cpuCredit %, replicaLag s)\n\`\`\`json\n${JSON.stringify(enriched)}\n\`\`\``);
    }
    if (rows.ec.length > 0) {
      const enriched = rows.ec.map((cl) => ({
        id: cl.cache_cluster_id,
        engine: `${str(cl.engine)} ${str(cl.engine_version)}`,
        nodeType: cl.cache_node_type,
        numNodes: cl.num_cache_nodes,
        status: cl.cache_cluster_status,
        replicationGroup: cl.replication_group_id ?? null,
        region: cl.region,
        account: cl.account_id,
        metrics: ecM[str(cl.cache_cluster_id)] ?? 'No metrics available',
      }));
      sections.push(`## ElastiCache Clusters (config: Steampipe, metrics: CloudWatch last 1h — cpu/ecpu %, mem bytes free, dbMemPct %, hitRate %, evictions, swap bytes, conn, netIn/Out bytes, bwIn/OutEx counts, replLag s)\n\`\`\`json\n${JSON.stringify(enriched)}\n\`\`\``);
    }
    if (rows.os.length > 0) {
      const enriched = rows.os.map((dom) => {
        const cfg = parseJson(dom.cluster_config);
        const ebs = parseJson(dom.ebs_options);
        return {
          name: dom.domain_name,
          version: dom.engine_version,
          instanceType: cfg?.InstanceType ?? 'unknown',
          instanceCount: cfg?.InstanceCount ?? 'unknown',
          ebsVolumeSize: ebs?.VolumeSize != null ? `${str(ebs.VolumeSize)} GB` : 'unknown',
          ebsVolumeType: ebs?.VolumeType ?? 'unknown',
          region: dom.region,
          account: dom.account_id,
          metrics: osM[str(dom.domain_name)] ?? 'No metrics available',
        };
      });
      sections.push(`## OpenSearch Domains (config: Steampipe, metrics: CloudWatch last 1h — cpu/jvm/masterCpu %, freeStorage MB, green/yellow/red 0|1, search/indexLatency ms, search/indexRate, writesBlocked, threadpool queues/rejects, http5xx, snapshotFail)\n\`\`\`json\n${JSON.stringify(enriched)}\n\`\`\``);
    }

    sections.push('\n## Collection Summary\n' + summary.map((s) => `- ${s}`).join('\n'));
    const totalResources = rows.rds.length + rows.ec.length + rows.os.length;
    const context = collected === 0
      ? '--- No DB optimization data could be collected ---\n' + sections.join('\n\n')
      : '--- DB SERVICE RIGHTSIZING DATA (collected automatically) ---\n' + sections.join('\n\n');

    return {
      context,
      summary,
      tools,
      collected,
      via: `DB Rightsizing (${totalResources} resources, ${totalMetricSets} metric sets)`,
    };
  },

  // v1 analysisPrompt adapted: metric key names follow lib/metrics fleets (documented per section
  // header in the context); language rule is handled by the shared buildAnalysisInput directive.
  analysisPrompt: `You are a database service rightsizing expert for AWS. You have been given REAL data from the user's environment:
- RDS instances with CloudWatch metrics (cpu, freeStorage, freeMem, swap, conn, read/write latency & IOPS, diskQueue, burst/cpuCredit balance, replicaLag)
- ElastiCache clusters with CloudWatch metrics (cpu, ecpu, freeable memory, dbMemPct, hitRate, evictions, swap, connections, network, bandwidth-allowance-exceeded, replLag)
- OpenSearch domains with CloudWatch metrics (cpu, JVM pressure, free storage, cluster status green/yellow/red, latency, rates, writesBlocked, thread-pool queues/rejects, 5xx, snapshot failures)

Analyze ALL the provided data and give specific, actionable rightsizing recommendations.

## Analysis Structure

### 1. Executive Summary
- Total estimated monthly savings across all DB services
- Number of over-provisioned resources found
- Any critical issues (high CPU, low memory/storage, cluster health, throttling/credit exhaustion)

### 2. RDS Rightsizing
For each RDS instance with optimization potential:
| Instance | Engine | Current Class | CPU Avg | Free Memory | Connections | IOPS | Recommended Class | Est. Savings |
- **CPU < 20% sustained** → downsize instance class (e.g., db.r6g.xlarge → db.r6g.large)
- **freeStorage > 50% of allocated** → reduce allocated storage or switch to gp3
- **Low connections (< 10)** → consider downsizing or consolidating
- **burst/cpuCredit low** → gp2/T-class exhaustion risk — do NOT downsize, consider gp3/M-class
- **Multi-AZ** → evaluate if Multi-AZ is needed for non-production workloads
- Check Reserved Instance applicability for stable workloads

### 3. ElastiCache Rightsizing
For each ElastiCache cluster with optimization potential:
| Cluster | Engine | Current Type | CPU Avg | dbMemPct | Evictions | Connections | Recommended | Est. Savings |
- **CPU < 15% and dbMemPct < 40%** → downsize node type (e.g., cache.r6g.xlarge → cache.r6g.large)
- **Evictions > 0 sustained or dbMemPct > 80%** → memory pressure — needs MORE memory, not less
- **bwInEx/bwOutEx > 0** → network allowance bottleneck — larger node or traffic review
- **Low connections (< 5)** → reduce node count or consolidate clusters
- Check Reserved Node pricing for stable clusters

### 4. OpenSearch Rightsizing
For each OpenSearch domain with optimization potential:
| Domain | Version | Current Type | CPU Avg | JVM Pressure | Free Storage | Recommended | Est. Savings |
- **JVM pressure < 50% and CPU < 20%** → downsize instance type
- **freeStorage > 60% of EBS** → reduce EBS volume size
- **writesBlocked = 1, thread-pool rejects > 0, or status yellow/red** → investigate BEFORE any downsizing
- **Low search/indexing rate** → reduce instance count
- Evaluate UltraWarm/Cold tiers for infrequently accessed indices

### 5. Cross-Service Recommendations
- DB services with matching workload patterns that could share infrastructure
- Non-production environments candidates for scheduled scaling
- Reserved capacity recommendations (RI/Savings Plans)

## Important Rules
- Provide specific instance type recommendations (not just "downsize")
- Include estimated monthly cost savings per recommendation
- Flag any resources that should NOT be downsized (high utilization, credit exhaustion, health issues)
- If a metric is null or a source is marked 미가용/unavailable, say monitoring data is insufficient — do not invent values
- Use tables and formatting for easy scanning`,
};

export default dbOptimizeCollector;
