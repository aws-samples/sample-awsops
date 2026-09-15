import { verifyUser } from '@/lib/auth';
import { readResources, readAggregates, assertInventoryTypeAllowed } from '@/lib/inventory';
import { getEcsClusterCosts } from '@/lib/aws';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: { type: string } }) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const gate = await assertInventoryTypeAllowed(params.type, user);
  if (gate) return Response.json({ status: 'error', message: gate.message }, { status: gate.status });
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
  const offset = Number(url.searchParams.get('offset')) || 0;
  // `.get()` returns null only when the param is absent — distinct from an explicit `regions=`
  // (empty string), which must resolve to an empty array, not silently fall back to unfiltered.
  const regionsParam = url.searchParams.get('regions');
  const regions = regionsParam === null || regionsParam === '__all__' ? '__all__' : regionsParam.split(',').filter(Boolean);
  const includeGlobal = url.searchParams.get('includeGlobal') !== '0';
  // Account scope (v1 parity): absent → host only; '__all__' → every synced account.
  const accountsParam = url.searchParams.get('accounts');
  const accounts = accountsParam === null ? ['self'] : accountsParam === '__all__' ? ('__all__' as const) : accountsParam.split(',').filter(Boolean);
  try {
    // gap L102: full-fleet aggregates for capped pages — same gates, same scope params,
    // no rows returned (the page pairs this with its 500-row sample fetch).
    if (url.searchParams.get('view') === 'agg') {
      try {
        const aggs = await readAggregates(params.type, { regions, includeGlobal, accounts });
        return Response.json(aggs);
      } catch {
        // generic message — a pg error can embed SQL/identifiers; the page falls back to the
        // sample (with the disclosed qualifier) on any non-OK response
        return Response.json({ status: 'error', message: 'aggregation failed' }, { status: 503 });
      }
    }
    const page = await readResources(params.type, { limit, offset, regions, includeGlobal, accounts });
    // MTD real cost isn't in inventory_resources (Steampipe has no CE access) — merge it in here.
    // Degrades silently: cost-allocation tag not active yet, or CE denied → rows just lack the field.
    // ?cost=0 skips the billable Cost Explorer read for consumers that never render
    // mtd_cost_usd (the ECS overview page) — the type page keeps the default merge.
    if (params.type === 'ecs_cluster' && url.searchParams.get('cost') !== '0') {
      try {
        const costs = await getEcsClusterCosts();
        for (const row of page.rows) {
          // ecs_cluster's resource_id is the cluster *name* (steampipe sync's primary key for
          // this type), not an ARN — matches getEcsClusterCosts' region|name keying below.
          const cost = costs[`${row.region}|${row.resource_id}`];
          if (cost !== undefined) (row.data as Record<string, unknown>).mtd_cost_usd = cost;
        }
      } catch { /* leave rows without mtd_cost_usd */ }
    }
    return Response.json(page);
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
