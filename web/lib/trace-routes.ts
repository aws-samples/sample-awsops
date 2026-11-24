// Read-only route-template aggregation over the exporter-default ClickHouse otel_traces schema.
// Only http.route templates, service names and counts leave this boundary: never url.path, query
// strings or any other span/resource attribute value (raw paths carry ids and PII).
import { invokeMcpLambdaTool } from '@/lib/mcp-lambda-invoke';
import { clickhouseRows, otelAggregateShape, resolveSource } from '@/lib/trace-source';

export interface RouteHop { service: string; route: string; next: { service: string; route?: string; calls: number }[]; calls: number }
export interface RouteRead { status: 'ok' | 'partial' | 'unavailable'; reasons: string[]; routes: RouteHop[] }

type RouteReason = 'deadline' | 'capped' | 'malformed_rows' | 'route_unsupported_schema' | 'invalid_request'
  | 'missing_configuration' | 'configuration_failed' | 'query_failed' | 'malformed_payload' | 'payload_truncated'
  | 'incomplete_collection' | 'count_not_confirmed' | 'empty_not_confirmed';

const WINDOWS = new Set([15, 60, 180]);
const ROUTE_LIMIT_CAP = 500;
const VALUE_MAX = 512;
// The kinds spanKind() (trace-source.ts) normalizes; the exporter writes 'Server'/'Client'.
const SERVER_KINDS = "SpanKind IN ('Server', 'SERVER', 'SPAN_KIND_SERVER')";
const CLIENT_KINDS = "SpanKind IN ('Client', 'CLIENT', 'SPAN_KIND_CLIENT')";
const ROUTE = "SpanAttributes['http.route']";

function unavailable(reason: RouteReason): RouteRead {
  return { status: 'unavailable', reasons: [reason], routes: [] };
}

/** Server spans with a route template, joined to the server children of their client children.
 *  `table` comes from the regex-validated catalog shape, everything else from constants or the
 *  allowlisted window/limit. Equality-only join conditions; the same-service exclusion is a
 *  projection, so a route whose only callee is itself still counts with no `next`. */
function routeSql(table: string, windowMins: number, endMs: number, limit: number): string {
  const window = `Timestamp >= fromUnixTimestamp64Milli(${endMs}) - INTERVAL ${windowMins} MINUTE ` +
    `AND Timestamp <= fromUnixTimestamp64Milli(${endMs})`;
  const servers = `SELECT TraceId, SpanId, ServiceName, ${ROUTE} AS HttpRoute FROM ${table} ` +
    `WHERE ${window} AND ${SERVER_KINDS} AND ${ROUTE} != ''`;
  const downstream = 'SELECT c.TraceId AS TraceId, c.ParentSpanId AS ParentSpanId, d.ServiceName AS ServiceName, ' +
    `d.HttpRoute AS HttpRoute FROM (SELECT TraceId, SpanId, ParentSpanId FROM ${table} ` +
    `WHERE ${window} AND ${CLIENT_KINDS} AND ParentSpanId != '') AS c INNER JOIN (SELECT TraceId, ParentSpanId, ` +
    `ServiceName, ${ROUTE} AS HttpRoute FROM ${table} WHERE ${window} AND ${SERVER_KINDS} ` +
    "AND ParentSpanId != '') AS d ON d.TraceId = c.TraceId AND d.ParentSpanId = c.SpanId";
  return 'SELECT s.ServiceName AS Svc, s.HttpRoute AS Route, ' +
    "if(n.ServiceName = s.ServiceName, '', n.ServiceName) AS NextSvc, " +
    "if(n.ServiceName = s.ServiceName, '', n.HttpRoute) AS NextRoute, count() AS Calls " +
    `FROM (${servers}) AS s LEFT JOIN (${downstream}) AS n ON n.TraceId = s.TraceId AND n.ParentSpanId = s.SpanId ` +
    `GROUP BY Svc, Route, NextSvc, NextRoute ORDER BY Calls DESC LIMIT ${limit}`;
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
function calls(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function fold(rows: unknown[]): RouteHop[] | undefined {
  const hops = new Map<string, RouteHop & { byNext: Map<string, RouteHop['next'][number]> }>();
  for (const value of rows) {
    const row = value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : undefined;
    const service = bounded(row?.Svc), route = bounded(row?.Route), count = calls(row?.Calls);
    const nextService = optional(row?.NextSvc), nextRoute = optional(row?.NextRoute);
    if (!service || !route || count === undefined || !nextService.ok || !nextRoute.ok) return undefined;
    const key = JSON.stringify([service, route]);
    let hop = hops.get(key);
    if (!hop) { hop = { service, route, next: [], calls: 0, byNext: new Map() }; hops.set(key, hop); }
    hop.calls += count;
    if (!nextService.value || nextService.value === service) continue;
    const nextKey = JSON.stringify([nextService.value, nextRoute.value ?? null]);
    const next = hop.byNext.get(nextKey);
    if (next) next.calls += count;
    else {
      const entry = { service: nextService.value, ...(nextRoute.value ? { route: nextRoute.value } : {}), calls: count };
      hop.byNext.set(nextKey, entry);
      hop.next.push(entry);
    }
  }
  for (const hop of hops.values()) if (!Number.isSafeInteger(hop.calls)) return undefined;
  return [...hops.values()]
    .map(({ service, route, next, calls: total }) => ({
      service, route, calls: total,
      next: next.sort((a, b) => b.calls - a.calls || cmp(a.service, b.service) || cmp(a.route ?? '', b.route ?? '')),
    }))
    .sort((a, b) => b.calls - a.calls || cmp(a.service, b.service) || cmp(a.route, b.route));
}

async function query(
  opts: { instanceId?: number; template?: string }, windowMins: number, limit: number, endMs: number,
): Promise<RouteRead> {
  const shape = otelAggregateShape(opts.template);
  if (!shape || !shape.spanKind) return unavailable('route_unsupported_schema');
  const { connConfig, reason } = await resolveSource('clickhouse', opts.instanceId);
  if (reason) return unavailable(reason === 'missing_configuration' ? reason : 'configuration_failed');
  let payload: unknown;
  try {
    payload = await invokeMcpLambdaTool({
      kind: 'clickhouse', tool: 'clickhouse_query',
      args: { sql: routeSql(shape.table, windowMins, endMs, limit), max_rows: limit }, connConfig,
    });
  } catch {
    return unavailable('query_failed');
  }
  const result = clickhouseRows(payload);
  const reasons: RouteReason[] = [...new Set(result.reasons as RouteReason[])];
  if (!result.rows || reasons.includes('query_failed')) {
    return { status: 'unavailable', reasons: reasons.includes('query_failed') ? ['query_failed'] : reasons, routes: [] };
  }
  // Defensive clamp, as in trace-source: a connector ignoring max_rows stays bounded.
  const rows = result.rows.slice(0, limit);
  const routes = fold(rows);
  if (!routes) return unavailable('malformed_rows');
  if (result.rows.length >= limit) reasons.push('capped');
  if (!rows.length && !reasons.length) {
    const outer = payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const inner = outer.result !== null && typeof outer.result === 'object' ? outer.result as Record<string, unknown> : {};
    const status = outer.collectionStatus ?? inner.collectionStatus;
    if (status !== 'ok' && status !== 'empty') reasons.push('empty_not_confirmed');
  }
  return { status: reasons.length ? 'partial' : 'ok', reasons, routes };
}

/** Aggregate route templates per traced service over an allowlisted window. Every read is bounded
 *  by `deadlineMs` (datasource resolution included) and returns only fixed reason strings. */
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
