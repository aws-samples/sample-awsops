import { verifyUser } from '@/lib/auth';
import { getPool } from '@/lib/db';
import { ec2FleetLive, rdsMetrics, resourceSeries } from '@/lib/metrics';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Monitoring hub BFF (v1 /monitoring parity).
 *   ?tab=ec2 | rds       → fleet rows with live CloudWatch columns
 *   ?series=<ec2|rds>&id=&range=1h|6h|24h|7d → multi-metric time series for one resource
 * Inventory identity comes from Aurora (synced); metrics are live CloudWatch reads.
 */
export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const url = new URL(request.url);
  const seriesKind = url.searchParams.get('series');
  try {
    if (seriesKind) {
      const id = url.searchParams.get('id') ?? '';
      const range = url.searchParams.get('range') ?? '6h';
      if (!id) return Response.json({ status: 'error', message: 'id required' }, { status: 400 });
      return Response.json({ series: await resourceSeries(seriesKind, id, range) });
    }

    const tab = url.searchParams.get('tab') ?? 'ec2';
    const pool = getPool();
    if (tab === 'ec2') {
      const r = await pool.query<{ id: string; name: string | null; itype: string | null; az: string | null }>(
        `SELECT resource_id AS id, data->>'name' AS name, data->>'instance_type' AS itype,
                data->>'placement_availability_zone' AS az
         FROM inventory_resources
         WHERE resource_type='ec2' AND account_id='self' AND data->>'instance_state'='running'
         ORDER BY resource_id LIMIT 300`,
      );
      const live = await ec2FleetLive(r.rows.map((x) => x.id));
      const rows = r.rows.map((x) => ({ ...x, ...(live[x.id] ?? { cpu: null, netIn: null, netOut: null }) }));
      return Response.json({ rows });
    }
    if (tab === 'rds') {
      const r = await pool.query<{ id: string; engine: string | null; clazz: string | null }>(
        `SELECT resource_id AS id, data->>'engine' AS engine, data->>'class' AS clazz
         FROM inventory_resources WHERE resource_type='rds' AND account_id='self'
         ORDER BY resource_id LIMIT 100`,
      );
      const m = await rdsMetrics(r.rows.map((x) => x.id));
      const rows = r.rows.map((x) => ({ ...x, ...(m.byInstance[x.id] ?? {}) }));
      return Response.json({ rows });
    }
    return Response.json({ status: 'error', message: 'unknown tab' }, { status: 400 });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
