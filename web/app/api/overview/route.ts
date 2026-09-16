import { verifyUser } from '@/lib/auth';
import { listClusterInventory, getMtdCost } from '@/lib/aws';
import { currentAccountId } from '@/lib/account';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  // jobs counts (Aurora) — required
  const jobs = { queued: 0, running: 0, succeeded: 0, failed: 0 } as Record<string, number>;
  try {
    const r = await getPool().query(`SELECT status, count(*)::int AS n FROM worker_jobs GROUP BY status`);
    for (const row of r.rows) if (row.status in jobs) jobs[row.status] = Number(row.n);
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
  // Account scope (single account or host; '__all__' stays host — the dashboard fans out cost
  // itself when needed). jobs/compliance are app-level (Aurora) — account-agnostic by design.
  const accountParam = new URL(request.url).searchParams.get('account') || undefined;
  const account = accountParam === '__all__' ? undefined : accountParam;
  // clusters + cost — degrade independently (a CE/EKS hiccup shouldn't blank the whole page)
  let clusterCount: number | null = null;
  let clusterScope: { accountId: string; region: string; names: string[]; truncated: boolean } | null = null;
  try {
    const inventory = await listClusterInventory(account);
    clusterCount = inventory.clusters.length;
    // Match the fleet's canonical host alias. This describes the actual singleton read,
    // including '__all__'→host, without claiming overview queried the full UI selection.
    clusterScope = {
      accountId: !account || account === 'self' || account === currentAccountId() ? 'self' : account,
      region: inventory.region,
      names: inventory.clusters.map(cluster => cluster.name),
      truncated: inventory.truncated,
    };
  } catch { clusterCount = null; }
  let mtdCost: number | null = null;
  try { mtdCost = (await getMtdCost(account)).total; } catch { mtdCost = null; }
  // latest *succeeded* CIS run, for the dashboard compliance tile — a newer failed run is
  // deliberately skipped (the tile shows the last known-good pass rate, not run health).
  // Degrades to null, same pattern as clusterCount/mtdCost above.
  let compliance: { pass_rate: number | null; alarm: number | null; finished_at: string | null } | null = null;
  try {
    const c = await getPool().query(
      `SELECT pass_rate, alarm, finished_at FROM compliance_runs
       WHERE status = 'succeeded' ORDER BY finished_at DESC NULLS LAST LIMIT 1`,
    );
    compliance = c.rows[0] ?? null;
  } catch { compliance = null; }
  return Response.json({ jobs, clusterCount, clusterScope, mtdCost, compliance });
}
