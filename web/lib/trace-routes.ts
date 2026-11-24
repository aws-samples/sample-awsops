// Read-only route-template aggregation over the exporter-default ClickHouse otel_traces schema.
// Only http.route templates, service names and counts leave this boundary: never url.path, query
// strings or any other span/resource attribute value (raw paths carry ids and PII).
import { invokeMcpLambdaTool } from '@/lib/mcp-lambda-invoke';
import { clickhouseRows, otelAggregateShape, resolveSource } from '@/lib/trace-source';

/** `calls` counts distinct traces in the window: for a hop, traces where the service handled the
 *  route; for a `next` entry, those of them that reached that downstream service/route. */
export interface RouteHop { service: string; route: string; next: { service: string; route?: string; calls: number }[]; calls: number }
export interface RouteRead {
  status: 'ok' | 'partial' | 'unavailable'; reasons: string[]; routes: RouteHop[];
  /** Internal diagnostic: distinct traces skipped because one service had several entry spans
   *  (pairing ambiguous). API routes must strip it and return exactly `{ status, reasons, routes }`. */
  ambiguousTraces?: number;
}

type RouteReason = 'deadline' | 'capped' | 'malformed_rows' | 'route_unsupported_schema' | 'invalid_request'
  | 'missing_configuration' | 'configuration_failed' | 'query_failed' | 'malformed_payload' | 'payload_truncated'
  | 'incomplete_collection' | 'count_not_confirmed' | 'empty_not_confirmed' | 'route_ambiguous_traces';

const WINDOWS = new Set([15, 60, 180]);
const ROUTE_LIMIT_CAP = 500;
const VALUE_MAX = 512;
// The spellings spanKind() (trace-source.ts) normalizes. The exporter's default schema stores
// SpanKind as text ('Server'/'Client'); toString() also admits a numeric column's OTLP codes.
const SERVER_KINDS = "toString(SpanKind) IN ('Server', 'SERVER', 'SPAN_KIND_SERVER', '2')";
const CLIENT_KINDS = "toString(SpanKind) IN ('Client', 'CLIENT', 'SPAN_KIND_CLIENT', '3')";
// Entry spans: a consumer span of the service is another request it handles in the trace.
const ENTRY_KINDS = "toString(SpanKind) IN ('Server', 'SERVER', 'SPAN_KIND_SERVER', '2', " +
  "'Consumer', 'CONSUMER', 'SPAN_KIND_CONSUMER', '5')";
const ROUTE = "SpanAttributes['http.route']";

function unavailable(reason: RouteReason): RouteRead {
  return { status: 'unavailable', reasons: [reason], routes: [] };
}

/** `table` comes from the regex-validated catalog shape; everything else is a constant or the
 *  allowlisted window/limit. A client span is paired with its service's routed server span by
 *  (trace, service) rather than by direct parent, so INTERNAL controller/middleware spans in
 *  between do not hide the downstream hop. That pairing is only sound when the service has exactly
 *  one entry (server or consumer) span in the trace; traces with several are skipped and counted
 *  separately. `s` is then unique per (trace, service), so counts are distinct traces. */
function routeSql(table: string, windowMins: number, endMs: number, limit: number) {
  const window = `Timestamp >= fromUnixTimestamp64Milli(${endMs}) - INTERVAL ${windowMins} MINUTE ` +
    `AND Timestamp <= fromUnixTimestamp64Milli(${endMs})`;
  // Every entry span counts toward ambiguity (an unrouted one would otherwise donate its client
  // calls to the routed one); only (trace, service) pairs with a routed server span are kept.
  const perTrace = 'SELECT TraceId, ServiceName, count() AS Entries, ' +
    "anyIf(SpanRoute, SpanRoute != '') AS RouteTemplate FROM (SELECT TraceId, ServiceName, " +
    `if(${SERVER_KINDS}, ${ROUTE}, '') AS SpanRoute FROM ${table} WHERE ${window} AND ${ENTRY_KINDS}) ` +
    "GROUP BY TraceId, ServiceName HAVING countIf(SpanRoute != '') > 0";
  const downstream = 'SELECT c.TraceId AS TraceId, c.ServiceName AS ClientService, d.ServiceName AS ServiceName, ' +
    `d.HttpRoute AS HttpRoute FROM (SELECT TraceId, SpanId, ServiceName FROM ${table} ` +
    `WHERE ${window} AND ${CLIENT_KINDS}) AS c INNER JOIN (SELECT TraceId, ParentSpanId, ServiceName, ` +
    `${ROUTE} AS HttpRoute FROM ${table} WHERE ${window} AND ${SERVER_KINDS} AND ParentSpanId != '') AS d ` +
    'ON d.TraceId = c.TraceId AND d.ParentSpanId = c.SpanId';
  // Equality-only joins; same-service children become '' in the projection so the route still counts.
  // RouteCalls is a window count over `s` (one row per trace), computed before the join fans out.
  const routes = 'SELECT s.ServiceName AS Svc, s.RouteTemplate AS Route, ' +
    "if(n.ServiceName = s.ServiceName, '', n.ServiceName) AS NextSvc, " +
    "if(n.ServiceName = s.ServiceName, '', n.HttpRoute) AS NextRoute, uniqExact(s.TraceId) AS Calls, " +
    'any(s.RouteCalls) AS RouteCalls FROM (SELECT TraceId, ServiceName, RouteTemplate, ' +
    'count() OVER (PARTITION BY ServiceName, RouteTemplate) AS RouteCalls ' +
    `FROM (${perTrace}) WHERE Entries = 1) AS s ` +
    `LEFT JOIN (${downstream}) AS n ON n.TraceId = s.TraceId AND n.ClientService = s.ServiceName ` +
    `GROUP BY Svc, Route, NextSvc, NextRoute ORDER BY RouteCalls DESC, Calls DESC LIMIT ${limit}`;
  const ambiguous = `SELECT uniqExact(TraceId) AS AmbiguousTraces FROM (${perTrace}) WHERE Entries > 1`;
  return { routes, ambiguous };
}

function bounded(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= VALUE_MAX
    && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
}
/** Absent/empty is "none"; any other non-bounded value is malformed. */
function optional(value: unknown): { ok: boolean; value?: string } {
  if (value === undefined || value === null || value === '') return { ok: true };
  const v = bounded(value);
  return v ? { ok: true, value: v } : { ok: false };
}
function count(value: unknown, allowZero = false): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && (n > 0 || (allowZero && n === 0)) ? n : undefined;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function fold(rows: unknown[]): RouteHop[] | undefined {
  const hops = new Map<string, RouteHop & { byNext: Map<string, RouteHop['next'][number]> }>();
  for (const value of rows) {
    const row = record(value);
    const service = bounded(row?.Svc), route = bounded(row?.Route);
    const calls = count(row?.Calls), routeCalls = count(row?.RouteCalls);
    const nextService = optional(row?.NextSvc), nextRoute = optional(row?.NextRoute);
    if (!service || !route || calls === undefined || routeCalls === undefined || calls > routeCalls
        || !nextService.ok || !nextRoute.ok) return undefined;
    const key = JSON.stringify([service, route]);
    let hop = hops.get(key);
    if (!hop) { hop = { service, route, next: [], calls: routeCalls, byNext: new Map() }; hops.set(key, hop); }
    // Distinct-trace counts do not add up: every row of a hop must carry the same route total.
    if (hop.calls !== routeCalls) return undefined;
    if (!nextService.value || nextService.value === service) continue;
    const nextKey = JSON.stringify([nextService.value, nextRoute.value ?? null]);
    if (hop.byNext.has(nextKey)) return undefined;
    const entry = { service: nextService.value, ...(nextRoute.value ? { route: nextRoute.value } : {}), calls };
    hop.byNext.set(nextKey, entry);
    hop.next.push(entry);
  }
  return [...hops.values()]
    .map(({ service, route, next, calls: total }) => ({
      service, route, calls: total,
      next: next.sort((a, b) => b.calls - a.calls || cmp(a.service, b.service) || cmp(a.route ?? '', b.route ?? '')),
    }))
    .sort((a, b) => b.calls - a.calls || cmp(a.service, b.service) || cmp(a.route, b.route));
}

async function query(
  opts: { instanceId?: number; template?: string; deadlineMs: number }, windowMins: number, limit: number, endMs: number,
): Promise<RouteRead> {
  const shape = otelAggregateShape(opts.template);
  if (!shape || !shape.spanKind) return unavailable('route_unsupported_schema');
  const { connConfig, reason } = await resolveSource('clickhouse', opts.instanceId);
  if (reason) return unavailable(reason === 'missing_configuration' ? reason : 'configuration_failed');
  const sql = routeSql(shape.table, windowMins, endMs, limit);
  // The tool only tightens its own execution bound, so ClickHouse stops when the BFF gives up.
  const maxExecutionTime = Math.max(1, Math.ceil(opts.deadlineMs / 1000));
  const run = (text: string, maxRows: number) => invokeMcpLambdaTool({
    kind: 'clickhouse', tool: 'clickhouse_query',
    args: { sql: text, max_rows: maxRows, max_execution_time: maxExecutionTime }, connConfig,
  });
  let payloads: [unknown, unknown];
  try {
    // The connector marks len(rows) >= max_rows as truncated; the single count row needs headroom.
    payloads = await Promise.all([run(sql.routes, limit), run(sql.ambiguous, 2)]);
  } catch {
    return unavailable('query_failed');
  }
  const [main, amb] = payloads.map(clickhouseRows);
  // Both reads prove the window together: never publish routes without their ambiguity count.
  if ([main, amb].some((r) => r.reasons.includes('query_failed'))) return unavailable('query_failed');
  if (!main.rows || !amb.rows) {
    return { status: 'unavailable', reasons: [...new Set([...main.reasons, ...amb.reasons] as RouteReason[])], routes: [] };
  }
  const ambiguousTraces = amb.rows.length === 1 ? count(record(amb.rows[0])?.AmbiguousTraces, true) : undefined;
  // Defensive clamp, as in trace-source: a connector ignoring max_rows stays bounded.
  const rows = main.rows.slice(0, limit);
  const routes = fold(rows);
  if (!routes || ambiguousTraces === undefined) return unavailable('malformed_rows');
  const reasons: RouteReason[] = [...new Set([...main.reasons, ...amb.reasons] as RouteReason[])];
  if (main.rows.length >= limit) reasons.push('capped');
  if (ambiguousTraces > 0) reasons.push('route_ambiguous_traces');
  if (!rows.length && !reasons.length) {
    const outer = record(payloads[0]) ?? {};
    const status = outer.collectionStatus ?? record(outer.result)?.collectionStatus;
    if (status !== 'ok' && status !== 'empty') reasons.push('empty_not_confirmed');
  }
  return {
    status: reasons.length ? 'partial' : 'ok', reasons, routes,
    ...(ambiguousTraces > 0 ? { ambiguousTraces } : {}),
  };
}

/** Aggregate route templates per traced service over an allowlisted window. Every read is bounded
 *  by `deadlineMs` (datasource resolution included) and returns only fixed reason strings.
 *  `template` is the registry catalog's otel_v1 SQL (graph-sources); never a request input. */
export async function readTraceRoutes(opts: {
  instanceId?: number; template?: string; windowMins: 15 | 60 | 180; deadlineMs: number; limit: number;
}): Promise<RouteRead> {
  if (!WINDOWS.has(opts.windowMins) || !Number.isFinite(opts.limit) || !Number.isFinite(opts.deadlineMs)) {
    return unavailable('invalid_request');
  }
  const limit = Math.min(ROUTE_LIMIT_CAP, Math.max(1, Math.floor(opts.limit)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<RouteRead>((resolve) => {
    timer = setTimeout(() => resolve(unavailable('deadline')), Math.max(0, opts.deadlineMs));
  });
  try {
    return await Promise.race([
      query(opts, opts.windowMins, limit, Date.now()).catch(() => unavailable('query_failed')),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
