import { verifyUser } from '@/lib/auth';
import { getPool } from '@/lib/db';
import { INVENTORY_TYPES } from '@/lib/inventory-types';
import { PUBLIC_S3_WHERE } from '@/lib/security-findings';

export const dynamic = 'force-dynamic';

interface ByType { type: string; label: string; count: number }
interface ByCategory { group: string; count: number }
interface Splits {
  ec2Running: number;
  ec2Stopped: number;
  ebsUnencrypted: number;
  iamUserNoMfa: number;
  sgOpenIngress: number;
  s3Public: number;
  cwAlarm: number;
  // Gap L82 — per-type tile micro-stat sublines (all from synced JSONB, same query).
  lambdaRuntimes: number;
  lambdaLongTimeout: number;
  ebsTotalGb: number;
  rdsMultiAz: number;
  rdsUnencrypted: number;
  ecrScanOnPush: number;
  ecrImmutable: number;
  s3VersioningOff: number;
  cloudfrontEnabled: number;
}

// Account-scope SQL fragment. Values are STRICTLY validated ('self' | 12-digit id) before
// inlining — the UNION-ALL template makes positional params impractical here.
function accountCond(accounts: '__all__' | string[]): string {
  if (accounts === '__all__') return 'TRUE';
  const safe = accounts.filter((a) => a === 'self' || /^[0-9]{12}$/.test(a));
  if (!safe.length) return "account_id='self'";
  return `account_id IN (${safe.map((a) => `'${a}'`).join(',')})`;
}

// Region-scope SQL fragment (gap L110): the counts must honor the SAME regions/includeGlobal
// contract the rows route applies via regionWhereClause — otherwise a region-narrowed page
// compares region-filtered rows against an all-region "true total". Values are STRICTLY
// validated (region-name charset) before inlining, mirroring accountCond; an explicitly empty
// selection yields FALSE (empty result), never an unfiltered count.
function regionCond(regions: '__all__' | string[], includeGlobal: boolean): string {
  if (regions === '__all__') return includeGlobal ? 'TRUE' : `region <> 'global'`;
  const base = regions.filter((r) => r !== 'global' && /^[a-z0-9-]{1,32}$/.test(r));
  const allowed = includeGlobal ? [...base, 'global'] : base;
  if (!allowed.length) return 'FALSE';
  return `region IN (${allowed.map((r) => `'${r}'`).join(',')})`;
}

// Derived KPI sublines: one UNION-ALL round-trip over the synced JSONB (the EC2-type
// donut adds a second small aggregation query below; both degrade independently).
// SG ingress-open match is anchored to the cidr field key (description text can't
// false-trigger) and covers IPv6 ::/0; both Steampipe key casings matched.
const splitsSql = (ACC: string): string => `
  SELECT 'ec2_running' AS k, count(*)::int AS n FROM inventory_resources WHERE ${ACC} AND resource_type='ec2' AND data->>'instance_state'='running'
  UNION ALL SELECT 'ec2_stopped', count(*)::int FROM inventory_resources WHERE ${ACC} AND resource_type='ec2' AND data->>'instance_state'='stopped'
  UNION ALL SELECT 'ebs_unencrypted', count(*)::int FROM inventory_resources WHERE ${ACC} AND resource_type='ebs_volume' AND (data->>'encrypted')='false'
  UNION ALL SELECT 'iam_user_no_mfa', count(*)::int FROM inventory_resources WHERE ${ACC} AND resource_type='iam_user' AND (data->>'mfa_enabled')='false'
  UNION ALL SELECT 'sg_open_ingress', count(*)::int FROM inventory_resources
    WHERE ${ACC} AND resource_type='security_group'
    AND (data->'ip_permissions')::text ~ '"(cidr_ip|CidrIp|cidr_ipv6|CidrIpv6)"\\s*:\\s*"(0\\.0\\.0\\.0/0|::/0)"'
  UNION ALL SELECT 's3_public', count(*)::int FROM inventory_resources WHERE ${ACC} AND resource_type='s3_public_access' AND ${PUBLIC_S3_WHERE}
  UNION ALL SELECT 'cw_alarm', count(*)::int FROM inventory_resources WHERE ${ACC} AND resource_type='cloudwatch_alarm' AND lower(data->>'state_value')='alarm'
  UNION ALL SELECT 'lambda_runtimes', count(DISTINCT COALESCE(NULLIF(data->>'runtime',''),'custom'))::int FROM inventory_resources WHERE ${ACC} AND resource_type='lambda'
  UNION ALL SELECT 'lambda_long_timeout', count(*)::int FROM inventory_resources WHERE ${ACC} AND resource_type='lambda' AND (data->>'timeout') ~ '^[0-9]+$' AND (data->>'timeout')::int > 300
  UNION ALL SELECT 'ebs_total_gb', COALESCE(sum(CASE WHEN (data->>'size') ~ '^[0-9]+$' THEN (data->>'size')::int ELSE 0 END),0)::int FROM inventory_resources WHERE ${ACC} AND resource_type='ebs_volume'
  UNION ALL SELECT 'rds_multi_az', count(*)::int FROM inventory_resources WHERE ${ACC} AND resource_type='rds' AND (data->>'multi_az')='true'
  UNION ALL SELECT 'rds_unencrypted', count(*)::int FROM inventory_resources WHERE ${ACC} AND resource_type='rds' AND (data->>'storage_encrypted')='false'
  UNION ALL SELECT 'ecr_scan_on_push', count(*)::int FROM inventory_resources
    WHERE ${ACC} AND resource_type='ecr'
    AND (data->'image_scanning_configuration')::text ~* '"(scan_on_push|ScanOnPush)"\\s*:\\s*(true|"true"|1)'
  UNION ALL SELECT 'ecr_immutable', count(*)::int FROM inventory_resources WHERE ${ACC} AND resource_type='ecr' AND upper(data->>'image_tag_mutability')='IMMUTABLE'
  UNION ALL SELECT 's3_versioning_off', count(*)::int FROM inventory_resources WHERE ${ACC} AND resource_type='s3' AND (data->>'versioning_enabled')='false'
  UNION ALL SELECT 'cloudfront_enabled', count(*)::int FROM inventory_resources WHERE ${ACC} AND resource_type='cloudfront' AND (data->>'enabled')='true'
`;

/** Aggregate inventory counts: per resource_type (desc) and rolled up per category group. */
export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const url = new URL(request.url);
  const accountsParam = url.searchParams.get('accounts');
  const accounts: '__all__' | string[] =
    accountsParam === null ? ['self'] : accountsParam === '__all__' ? '__all__' : accountsParam.split(',').filter(Boolean);
  // Same regions/includeGlobal parsing contract as the rows route ([type]/route.ts).
  const regionsParam = url.searchParams.get('regions');
  const regions: '__all__' | string[] =
    regionsParam === null || regionsParam === '__all__' ? '__all__' : regionsParam.split(',').filter(Boolean);
  const includeGlobal = url.searchParams.get('includeGlobal') !== '0';
  const ACC = `(${accountCond(accounts)}) AND (${regionCond(regions, includeGlobal)})`;
  try {
    const pool = getPool();
    const r = await pool.query<{ resource_type: string; n: number }>(
      `SELECT resource_type, count(*)::int AS n FROM inventory_resources
       WHERE ${ACC} GROUP BY resource_type`,
    );
    const byType: ByType[] = r.rows
      .map((row) => ({
        type: row.resource_type,
        label: INVENTORY_TYPES[row.resource_type]?.label ?? row.resource_type,
        count: Number(row.n),
      }))
      .sort((a, b) => b.count - a.count);
    const groups = new Map<string, number>();
    for (const row of r.rows) {
      const group = INVENTORY_TYPES[row.resource_type]?.group ?? 'Other';
      groups.set(group, (groups.get(group) ?? 0) + Number(row.n));
    }
    const byCategory: ByCategory[] = [...groups.entries()]
      .map(([group, count]) => ({ group, count }))
      .sort((a, b) => b.count - a.count);
    const total = byType.reduce((s, x) => s + x.count, 0);

    // Derived KPI sublines — a splits-query failure must NOT 500 the fleet view
    // (house rule: degrade to zeros, keep byType). Map UNION-ALL k→n rows.
    const splits: Splits = {
      ec2Running: 0,
      ec2Stopped: 0,
      ebsUnencrypted: 0,
      iamUserNoMfa: 0,
      sgOpenIngress: 0,
      s3Public: 0,
      cwAlarm: 0,
      lambdaRuntimes: 0,
      lambdaLongTimeout: 0,
      ebsTotalGb: 0,
      rdsMultiAz: 0,
      rdsUnencrypted: 0,
      ecrScanOnPush: 0,
      ecrImmutable: 0,
      s3VersioningOff: 0,
      cloudfrontEnabled: 0,
    };
    const SPLIT_KEY: Record<string, keyof Splits> = {
      ec2_running: 'ec2Running',
      ec2_stopped: 'ec2Stopped',
      ebs_unencrypted: 'ebsUnencrypted',
      iam_user_no_mfa: 'iamUserNoMfa',
      sg_open_ingress: 'sgOpenIngress',
      s3_public: 's3Public',
      cw_alarm: 'cwAlarm',
      lambda_runtimes: 'lambdaRuntimes',
      lambda_long_timeout: 'lambdaLongTimeout',
      ebs_total_gb: 'ebsTotalGb',
      rds_multi_az: 'rdsMultiAz',
      rds_unencrypted: 'rdsUnencrypted',
      ecr_scan_on_push: 'ecrScanOnPush',
      ecr_immutable: 'ecrImmutable',
      s3_versioning_off: 's3VersioningOff',
      cloudfront_enabled: 'cloudfrontEnabled',
    };
    let splitsOk = true;
    try {
      const sr = await pool.query<{ k: string; n: number }>(splitsSql(ACC));
      for (const row of sr.rows) {
        const key = SPLIT_KEY[row.k];
        if (key) splits[key] = Number(row.n);
      }
    } catch {
      // splits FAILED — return null, never fabricated zeros: "0 no MFA"/"0 open ingress"
      // sublines and a 'healthy' verdict from a broken aggregation would be false-clean
      // security claims. Consumers all handle a missing splits (DASH / hidden sublines).
      splitsOk = false;
    }

    // EC2 instance-type distribution for the landing donut (degrade to [] on failure).
    let ec2Types: { name: string; count: number }[] = [];
    try {
      const er = await pool.query<{ t: string; n: number }>(
        `SELECT COALESCE(NULLIF(data->>'instance_type',''),'unknown') AS t, count(*)::int AS n
         FROM inventory_resources WHERE ${ACC} AND resource_type='ec2'
         GROUP BY 1 ORDER BY n DESC LIMIT 10`,
      );
      ec2Types = er.rows.map((row) => ({ name: row.t, count: Number(row.n) }));
    } catch {
      // donut omitted — byType already computed, don't fail the response.
    }

    // Data freshness for the dashboard header — when the inventory was last synced.
    let lastSyncAt: string | null = null;
    try {
      const fr = await pool.query<{ t: string | null }>(
        `SELECT max(finished_at)::text AS t FROM inventory_sync_runs WHERE status='succeeded'`,
      );
      lastSyncAt = fr.rows[0]?.t ?? null;
    } catch {
      // freshness omitted — non-fatal.
    }

    return Response.json({ byType, byCategory, total, splits: splitsOk ? splits : null, ec2Types, lastSyncAt });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
