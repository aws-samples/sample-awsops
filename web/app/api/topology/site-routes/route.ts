// GET /api/topology/site-routes — trace route templates (http.route) per service for the site flow.
// Read-only: the registry is read in graphReadTransaction (server-side statement/lock/transaction timeouts, its 2 s
// deadline and shared admission cap), then every registered ClickHouse trace datasource (registry catalog, never the
// request) is read through readTraceRoutes, at most SOURCE_LANES at once, each within what is left of the total budget;
// only templates, service names and counts leave here. Per-source results are reused server-side for
// ROUTE_CACHE_TTL_MS with single-flight (site-routes-cache.ts, a BoundedTtlCache); the response stays `no-store`.
import { verifyUser } from '@/lib/auth';
import { getPool } from '@/lib/db';
import { listClickHouseTraceDatasources } from '@/lib/graph-sources';
import { graphDiagnostic } from '@/lib/graph-state';
import { graphReadTransaction, GraphReadDeadline } from '@/lib/graph-transaction';
import { readTraceRoutes, type RouteHop, type RouteRead } from '@/lib/trace-routes';
import { ROUTE_SOURCE_DEADLINE_MS, cachedRouteRead, routeCacheKey } from '@/lib/site-routes-cache';

export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } });

const WINDOWS = new Map<string, 15 | 60 | 180>([['15', 15], ['60', 60], ['180', 180]]);
const TOTAL_BUDGET_MS = 10_000;
const ROUTE_LIMIT = 500;
/** Sources read at once (each read is one ClickHouse aggregate pair through the MCP Lambda). */
const SOURCE_LANES = 4;
// readTraceRoutes' fixed reason vocabulary plus this route's own; anything else is dropped.
const REASONS = new Set([
  'deadline', 'capped', 'malformed_rows', 'route_unsupported_schema', 'invalid_request', 'missing_configuration',
  'configuration_failed', 'query_failed', 'malformed_payload', 'payload_truncated', 'incomplete_collection',
  'count_not_confirmed', 'empty_not_confirmed', 'route_ambiguous_traces', 'route_raw_path', 'multi_source_counts',
  'no_trace_source',
]);
const FAILED: RouteRead = { status: 'unavailable', reasons: ['query_failed'], routes: [] };
const DEADLINE: RouteRead = { status: 'unavailable', reasons: ['deadline'], routes: [] };

/** `read` bounded by this caller's remaining budget: a shared in-flight read started by another request may have
 *  more time left than this one. The shared read itself keeps running for its other callers. */
async function within(read: Promise<RouteRead>, ms: number): Promise<RouteRead> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read, new Promise<RouteRead>((r) => { timer = setTimeout(() => r(DEADLINE), Math.max(0, ms)); })]);
  } finally {
    clearTimeout(timer);
  }
}

type Next = RouteHop['next'][number];
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Union the sources' routes. Distinct-trace counts from different sources cannot be summed (the
 *  same trace may be exported to both), so a hop or downstream entry reported by several sources
 *  keeps the largest count and the response carries `multi_source_counts`. */
function merge(reads: RouteRead[]): { routes: RouteHop[]; multi: boolean } {
  const hops = new Map<string, { hop: RouteHop; next: Map<string, Next> }>();
  let multi = false;
  for (const read of reads) {
    for (const h of read.routes) {
      const key = JSON.stringify([h.service, h.route]);
      let acc = hops.get(key);
      if (acc) { multi = true; acc.hop.calls = Math.max(acc.hop.calls, h.calls); }
      else { acc = { hop: { service: h.service, route: h.route, calls: h.calls, next: [] }, next: new Map() }; hops.set(key, acc); }
      for (const n of h.next) {
        const nextKey = JSON.stringify([n.service, n.route ?? null]);
        const seen = acc.next.get(nextKey);
        if (seen) { multi = true; seen.calls = Math.max(seen.calls, n.calls); }
        else acc.next.set(nextKey, { service: n.service, ...(n.route ? { route: n.route } : {}), calls: n.calls });
      }
    }
  }
  const routes = [...hops.values()]
    .map(({ hop, next }) => ({
      ...hop,
      next: [...next.values()].sort((a, b) => b.calls - a.calls || cmp(a.service, b.service) || cmp(a.route ?? '', b.route ?? '')),
    }))
    .sort((a, b) => b.calls - a.calls || cmp(a.service, b.service) || cmp(a.route, b.route));
  return { routes, multi };
}

/** Body is exactly `{ status, reasons, routes }`: RouteRead's internal `ambiguousTraces` and any
 *  other field never leave the route; `merge` rebuilds hops field by field. */
function combine(reads: RouteRead[]): Pick<RouteRead, 'status' | 'reasons' | 'routes'> {
  const reasons = new Set(reads.flatMap((r) => r.reasons).filter((r) => REASONS.has(r)));
  const live = reads.filter((r) => r.status === 'ok' || r.status === 'partial');
  if (!live.length) return { status: 'unavailable', reasons: [...reasons].sort(), routes: [] };
  const { routes, multi } = merge(live);
  if (multi) reasons.add('multi_source_counts');
  const ok = live.length === reads.length && reads.every((r) => r.status === 'ok') && !reasons.size;
  return { status: ok ? 'ok' : 'partial', reasons: [...reasons].sort(), routes };
}

export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) return json({ error: 'unauthenticated' }, 401);
  if (process.env.TOPOLOGY_ENTITIES_ENABLED !== 'true')
    return json({ error: 'topology_entities_disabled', class: 'service' }, 404);
  const p = new URL(request.url).searchParams;
  for (const k of p.keys()) if (k !== 'windowMins' || p.getAll(k).length !== 1) return json({ error: 'invalid_request' }, 400);
  const raw = p.get('windowMins');
  const windowMins = raw === null ? 60 : WINDOWS.get(raw);
  if (windowMins === undefined) return json({ error: 'invalid_request' }, 400);

  const started = Date.now();
  try {
    // Bounded on Aurora as well as here: a lost race never leaves the statement holding one of the pool's connections.
    const datasources = await graphReadTransaction(getPool(), (c) => listClickHouseTraceDatasources(c));
    if (!datasources.length) return json({ status: 'unavailable', reasons: ['no_trace_source'], routes: [] });
    // At most SOURCE_LANES sources at once, lanes pulling from one shared index. Each source's deadline is what is
    // left of the total budget when its lane reaches it; a source reached with no budget left is not read.
    const reads: RouteRead[] = new Array(datasources.length);
    let next = 0;
    const lane = async () => {
      for (let i = next++; i < datasources.length; i = next++) {
        const { instanceId, template } = datasources[i];
        const remaining = TOTAL_BUDGET_MS - (Date.now() - started);
        const read = cachedRouteRead(routeCacheKey(instanceId, template, windowMins), (signal) => (remaining > 0
          ? readTraceRoutes({
            instanceId, template, windowMins, deadlineMs: Math.min(ROUTE_SOURCE_DEADLINE_MS, remaining), limit: ROUTE_LIMIT, signal,
          })
          : Promise.resolve(DEADLINE)));
        reads[i] = await within(read, remaining).catch(() => FAILED);
      }
    };
    await Promise.all(Array.from({ length: Math.min(SOURCE_LANES, datasources.length) }, lane));
    return json(combine(reads));
  } catch (e) {
    console.error('[site-routes] read failed', graphDiagnostic('trace_sources', e));
    // GraphReadBusy (both graph-read slots taken) and query failures share the fixed `read_unavailable` body.
    return json({ error: e instanceof GraphReadDeadline ? 'timeout' : 'read_unavailable' }, 503);
  }
}
