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
}

// Account-scope SQL fragment. Values are STRICTLY validated ('self' | 12-digit id) before
// inlining — the UNION-ALL template makes positional params impractical here.
function accountCond(accounts: '__all__' | string[]): string {
  if (accounts === '__all__') return 'TRUE';
  const safe = accounts.filter((a) => a === 'self' || /^[0-9]{12}$/.test(a));
  if (!safe.length) return "account_id='self'";
  return `account_id IN (${safe.map((a) => `'${a}'`).join(',')})`;
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
  const ACC = accountCond(accounts);
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
    };
    const SPLIT_KEY: Record<string, keyof Splits> = {
      ec2_running: 'ec2Running',
      ec2_stopped: 'ec2Stopped',
      ebs_unencrypted: 'ebsUnencrypted',
      iam_user_no_mfa: 'iamUserNoMfa',
      sg_open_ingress: 'sgOpenIngress',
      s3_public: 's3Public',
      cw_alarm: 'cwAlarm',
    };
    try {
      const sr = await pool.query<{ k: string; n: number }>(splitsSql(ACC));
      for (const row of sr.rows) {
        const key = SPLIT_KEY[row.k];
        if (key) splits[key] = Number(row.n);
      }
    } catch {
      // splits omitted/zeros — byType already computed, don't fail the response.
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

    return Response.json({ byType, byCategory, total, splits, ec2Types, lastSyncAt });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
