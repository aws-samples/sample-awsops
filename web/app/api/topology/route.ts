import { verifyUser } from '@/lib/auth';
import { graphDiagnostic } from '@/lib/graph-state';
import { getPool } from '@/lib/db';
import { graphReadTransaction, GraphReadBusy, GraphReadDeadline } from '@/lib/graph-transaction';

export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } });
const validUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) return json({ error: 'unauthenticated' }, 401);
  if (process.env.TOPOLOGY_ENTITIES_ENABLED !== 'true')
    return json({ error: 'topology_entities_disabled', class: 'service' }, 404);
  const p = new URL(request.url).searchParams;
  for (const k of p.keys())
    if (
      !['lens', 'account', 'regions', 'includeGlobal', 'snapshot', 'q', 'focus', 'cursor'].includes(k) ||
      p.getAll(k).length !== 1
    )
      return json({ error: 'invalid_request' }, 400);
  if (
    (p.get('account') ?? 'self') !== 'self' ||
    (p.get('regions') ?? '__all__') !== '__all__' ||
    (p.get('includeGlobal') ?? '1') !== '1'
  )
    return json({ error: 'unsupported_scope' }, 422);
  const lens = p.get('lens') ?? 'service',
    snapshot = p.get('snapshot'),
    q = p.get('q') ?? '',
    focus = p.get('focus') ?? '',
    offset = p.get('cursor') ?? '0';
  if (
    !['service', 'entry', 'placement', 'evidence'].includes(lens) ||
    (snapshot !== null && !validUuid.test(snapshot)) ||
    q.length > 240 ||
    (focus && !/^[a-f0-9]{64}$/.test(focus)) ||
    !/^\d{1,5}$/.test(offset) ||
    +offset > 20000 ||
    (+offset > 0 && !snapshot)
  )
    return json({ error: 'invalid_request' }, 400);
  try {
    const cadence = Number(process.env.GRAPH_REBUILD_INTERVAL_MINS);
    const maxAge = Number.isInteger(cadence) && cadence > 0 ? Math.min(2880, Math.max(15, cadence * 2)) : 15;
    const result = await graphReadTransaction(getPool(), (c) =>
      c.query('SELECT sql_reader.service_topology_read($1,$2,$3,$4,$5,$6) AS view', [
        snapshot,
        lens,
        q,
        focus,
        +offset,
        maxAge,
      ]),
    );
    const view = result.rows[0]?.view;
    if (view) return json(view);
    return snapshot
      ? json({ error: 'snapshot_expired' }, 410)
      : json({ contractVersion: 1, status: 'unavailable', snapshotId: null, reason: 'no_publication' });
  } catch (e) {
    console.error('[service-topology] read failed', graphDiagnostic('graph_read', e));
    return json(
      { error: e instanceof GraphReadBusy ? 'busy' : e instanceof GraphReadDeadline ? 'timeout' : 'read_unavailable' },
      503,
    );
  }
}
