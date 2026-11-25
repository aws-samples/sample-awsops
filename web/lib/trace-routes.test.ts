import { describe, it, expect, vi, beforeEach } from 'vitest';

const getDefaultDatasource = vi.fn();
const getDatasource = vi.fn();
const resolveConnConfig = vi.fn();
const invokeMcpLambdaTool = vi.fn();
vi.mock('@/lib/datasources', () => ({
  getDefaultDatasource: (...a: unknown[]) => getDefaultDatasource(...a),
  getDatasource: (...a: unknown[]) => getDatasource(...a),
  resolveConnConfig: (...a: unknown[]) => resolveConnConfig(...a),
}));
vi.mock('@/lib/mcp-lambda-invoke', () => ({
  invokeMcpLambdaTool: (...a: unknown[]) => invokeMcpLambdaTool(...a),
}));

import { readTraceRoutes, type RouteHop } from './trace-routes';
import type { SiteRoute } from './site-flow';

const row = (over: Record<string, unknown> = {}) => ({
  Svc: 'frontend', Route: '/api/orders/{id}', NextSvc: 'orders', NextRoute: '/orders/{id}', Calls: '12',
  RouteCalls: '12', ...over,
});
// The clickhouse_query tool's real body (agent/lambda/clickhouse_mcp.py _run_sql).
const envelope = (rows: unknown[], maxRows: number, extra: Record<string, unknown> = {}) => ({
  rowCount: rows.length, rows, meta: [{ name: 'Calls', type: 'UInt64' }],
  truncated: rows.length >= maxRows, collectionStatus: rows.length >= maxRows ? 'partial' : rows.length ? 'ok' : 'empty',
  ...extra,
});
const isAmbiguity = (sql: string) => sql.includes('AS AmbiguousTraces');
const answer = (rows: unknown[], extra: Record<string, unknown> = {}, ambiguity: unknown[] = [{ AmbiguousTraces: '0' }]) =>
  invokeMcpLambdaTool.mockImplementation(async ({ args }: { args: { sql: string; max_rows: number } }) =>
    isAmbiguity(args.sql) ? envelope(ambiguity, args.max_rows) : envelope(rows, args.max_rows, extra));
const read = (over: Partial<Parameters<typeof readTraceRoutes>[0]> = {}) =>
  readTraceRoutes({ windowMins: 60, deadlineMs: 5_000, limit: 200, ...over });
const callOf = (ambiguity = false) => invokeMcpLambdaTool.mock.calls
  .map(([call]) => call).find((call) => isAmbiguity(call.args.sql) === ambiguity)!;
const sqlOf = (ambiguity = false) => callOf(ambiguity).args.sql as string;

describe('readTraceRoutes', () => {
  beforeEach(() => {
    getDefaultDatasource.mockReset(); getDatasource.mockReset(); resolveConnConfig.mockReset(); invokeMcpLambdaTool.mockReset();
    getDefaultDatasource.mockResolvedValue({ id: 3, kind: 'clickhouse', isDefault: true });
    getDatasource.mockResolvedValue({ id: 7, kind: 'clickhouse', isDefault: false });
    resolveConnConfig.mockResolvedValue({ endpoint: 'https://ch.example.com' });
  });

  it('builds one bounded, window-anchored query that selects only route templates, services and counts', async () => {
    answer([row()]);
    await read({ windowMins: 15, limit: 120 });
    expect(invokeMcpLambdaTool).toHaveBeenCalledTimes(2);
    for (const [{ kind, tool, connConfig }] of invokeMcpLambdaTool.mock.calls) {
      expect({ kind, tool, connConfig }).toEqual({
        kind: 'clickhouse', tool: 'clickhouse_query', connConfig: { endpoint: 'https://ch.example.com' },
      });
    }
    expect(callOf().args.max_rows).toBe(120);
    // The connector flags len(rows) >= max_rows as truncated; the one count row needs headroom.
    expect(callOf(true).args.max_rows).toBe(2);
    // The tool only tightens its execution bound: ClickHouse stops when the BFF deadline does.
    expect(callOf().args.max_execution_time).toBe(5);
    expect(callOf(true).args.max_execution_time).toBe(5);
    const sql = sqlOf();
    expect(sql).toMatch(/INTERVAL 15 MINUTE/);
    expect(sql).toMatch(/LIMIT 120$/);
    expect(sql).toContain('FROM otel_traces');
    // Every attribute read is the route template; never raw paths or resource attributes.
    for (const text of [sql, sqlOf(true)]) {
      const keys = [...text.matchAll(/Attributes\['([^']+)'\]/g)].map((m) => m[1]);
      expect(keys.length).toBeGreaterThan(0);
      expect(new Set(keys)).toEqual(new Set(['http.route']));
      expect(text).not.toContain('ResourceAttributes');
      expect(text).not.toContain('url.path');
      expect(text).not.toMatch(/http\.target|http\.url|url\.full/);
    }
    // Join sides are restricted to the window and the exporter's span kinds.
    expect(sql.match(/fromUnixTimestamp64Milli\(\d+\) - INTERVAL 15 MINUTE/g)).toHaveLength(3);
    expect(sql).toContain("toString(SpanKind) IN ('Server', 'SERVER', 'SPAN_KIND_SERVER', '2')");
    expect(sql).toContain("toString(SpanKind) IN ('Client', 'CLIENT', 'SPAN_KIND_CLIENT', '3')");
    expect(sql).toContain("countIf(SpanRoute != '') > 0");
    expect(sql).toContain("'Consumer', 'CONSUMER', 'SPAN_KIND_CONSUMER', '5'");
    expect(sql).toContain("if(toString(SpanKind) IN ('Server', 'SERVER', 'SPAN_KIND_SERVER', '2'), SpanAttributes['http.route'], '')");
    expect(sql).toContain('uniqExact(s.TraceId) AS Calls');
    expect(sql).toContain('count() OVER (PARTITION BY ServiceName, RouteTemplate) AS RouteCalls');
    expect(sql).toContain('LEFT JOIN');
    expect(sqlOf(true)).toMatch(/INTERVAL 15 MINUTE/);
    expect(sqlOf(true)).toMatch(/WHERE Entries > 1$/);
    // Each hop's rows are contiguous (route total, then the hop key), so a LIMIT cut splits at most the last hop.
    expect(sql).toMatch(/GROUP BY Svc, Route, NextSvc, NextRoute ORDER BY RouteCalls DESC, Svc, Route, Calls DESC, NextSvc, NextRoute LIMIT 120$/);
    // Same-service children are excluded from `next` without dropping the parent route.
    expect(sql).toMatch(/if\(\w+\.ServiceName = \w+\.ServiceName, '', /);
  });

  it('clamps the limit to 500 and rejects windows outside the allowlist', async () => {
    answer([row()]);
    await read({ limit: 10_000, deadlineMs: 1 });
    expect(sqlOf()).toMatch(/LIMIT 500$/);
    expect(callOf().args.max_rows).toBe(500);
    expect(callOf().args.max_execution_time).toBe(1);
    invokeMcpLambdaTool.mockClear();
    expect(await read({ windowMins: 61 as 60 })).toEqual({ status: 'unavailable', reasons: ['invalid_request'], routes: [] });
    expect(await read({ limit: Number.NaN })).toEqual({ status: 'unavailable', reasons: ['invalid_request'], routes: [] });
    expect(invokeMcpLambdaTool).not.toHaveBeenCalled();
  });

  it('folds rows into one hop per service route with distinct-trace counts and per-downstream next', async () => {
    // 20 traces hit the route; 12 reached orders, 5 payments (some may reach both), 3 neither.
    answer([
      row({ RouteCalls: '20' }),
      row({ NextSvc: 'payments', NextRoute: '', Calls: '5', RouteCalls: '20' }),
      row({ NextSvc: '', NextRoute: '', Calls: '3', RouteCalls: '20' }),
      row({ Route: '/healthz', NextSvc: '', NextRoute: '', Calls: 40, RouteCalls: 40 }),
      row({ Svc: 'orders', Route: '/orders/{id}', NextSvc: null, NextRoute: null, Calls: '9', RouteCalls: '9' }),
    ]);
    const out = await read({ instanceId: 7 });
    expect(getDatasource).toHaveBeenCalledWith(7);
    expect(out).toEqual({
      status: 'ok', reasons: [],
      routes: [
        { service: 'frontend', route: '/healthz', next: [], calls: 40 },
        { service: 'frontend', route: '/api/orders/{id}', calls: 20, next: [
          { service: 'orders', route: '/orders/{id}', calls: 12 },
          { service: 'payments', calls: 5 },
        ] },
        { service: 'orders', route: '/orders/{id}', next: [], calls: 9 },
      ],
    });
    expect(out.routes[1].next[1]).not.toHaveProperty('route');
  });

  it('returns ok with no routes for a confirmed empty window', async () => {
    answer([]);
    expect(await read()).toEqual({ status: 'ok', reasons: [], routes: [] });
  });

  it('does not treat an unconfirmed empty response as a complete window', async () => {
    invokeMcpLambdaTool.mockImplementation(async ({ args }: { args: { sql: string } }) => isAmbiguity(args.sql)
      ? { rows: [{ AmbiguousTraces: '0' }], collectionStatus: 'ok' } : { rows: [] });
    expect(await read()).toEqual({ status: 'partial', reasons: ['empty_not_confirmed'], routes: [] });
  });

  it('reports a deadline when the query does not answer in time', async () => {
    invokeMcpLambdaTool.mockImplementation(() => new Promise(() => {}));
    expect(await read({ deadlineMs: 5 })).toEqual({ status: 'unavailable', reasons: ['deadline'], routes: [] });
  });

  it('applies the deadline to datasource resolution as well', async () => {
    getDefaultDatasource.mockImplementation(() => new Promise(() => {}));
    expect(await read({ deadlineMs: 5 })).toEqual({ status: 'unavailable', reasons: ['deadline'], routes: [] });
    expect(invokeMcpLambdaTool).not.toHaveBeenCalled();
  });

  it('starts nothing when the signal is already aborted', async () => {
    answer([row()]);
    const controller = new AbortController();
    controller.abort();
    expect(await read({ signal: controller.signal })).toEqual({ status: 'unavailable', reasons: ['deadline'], routes: [] });
    expect(getDefaultDatasource).not.toHaveBeenCalled();
    expect(invokeMcpLambdaTool).not.toHaveBeenCalled();
  });

  it('stops before the ClickHouse reads when the signal aborts during datasource resolution', async () => {
    answer([row()]);
    let resolve!: (v: unknown) => void;
    getDefaultDatasource.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const controller = new AbortController();
    const pending = read({ signal: controller.signal });
    await vi.waitFor(() => expect(getDefaultDatasource).toHaveBeenCalled());
    controller.abort();
    expect(await pending).toEqual({ status: 'unavailable', reasons: ['deadline'], routes: [] });
    resolve({ id: 3, kind: 'clickhouse', isDefault: true });
    await new Promise((r) => setTimeout(r, 5));
    expect(invokeMcpLambdaTool).not.toHaveBeenCalled();
  });

  it('settles as a deadline when the signal aborts while the ClickHouse reads are in flight', async () => {
    invokeMcpLambdaTool.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = read({ signal: controller.signal });
    await vi.waitFor(() => expect(invokeMcpLambdaTool).toHaveBeenCalledTimes(2));
    controller.abort();
    expect(await pending).toEqual({ status: 'unavailable', reasons: ['deadline'], routes: [] });
  });

  it('marks a saturated limit as capped and drops the hop the cut may have split', async () => {
    answer([row({ Route: '/healthz', NextSvc: '', NextRoute: '', Calls: '40', RouteCalls: '40' }),
      row(), row({ NextSvc: 'payments', Calls: '2' })]);
    const out = await read({ limit: 3 });
    expect(out.status).toBe('partial');
    // The connector's own truncation markers for the same saturated read are carried alongside.
    expect(out.reasons).toEqual(['payload_truncated', 'incomplete_collection', 'capped']);
    // The last row's hop may continue past the LIMIT, so only the complete hop before it is kept.
    expect(out.routes).toEqual([{ service: 'frontend', route: '/healthz', next: [], calls: 40 }]);
  });

  it('never turns a hop cut down to its empty-next row into a terminal route', async () => {
    // The cut lands inside /api/orders/{id}: its no-downstream row (15 traces) came back, its orders row did not.
    answer([row({ Route: '/healthz', NextSvc: '', NextRoute: '', Calls: '40', RouteCalls: '40' }),
      row({ NextSvc: '', NextRoute: '', Calls: '15', RouteCalls: '20' })]);
    const out = await read({ limit: 2 });
    expect(out.reasons).toContain('capped');
    expect(out.routes).toEqual([{ service: 'frontend', route: '/healthz', next: [], calls: 40 }]);
    expect(out.routes.some((h) => h.route === '/api/orders/{id}')).toBe(false);
  });

  it('drops the last hop of a connector-truncated or partial read even under the limit (no capped)', async () => {
    // The connector flags truncation below max_rows too (rows_before_limit_at_least, a 206, a `partial` body).
    const rows = [row({ Route: '/healthz', NextSvc: '', NextRoute: '', Calls: '40', RouteCalls: '40' }),
      row({ NextSvc: '', NextRoute: '', Calls: '15', RouteCalls: '20' })];
    for (const extra of [{ truncated: true }, { collectionStatus: 'partial' }]) {
      invokeMcpLambdaTool.mockReset();
      answer(rows, extra);
      const out = await read({ limit: 200 });
      expect(out.status).toBe('partial');
      expect(out.reasons).not.toContain('capped');
      expect(out.routes).toEqual([{ service: 'frontend', route: '/healthz', next: [], calls: 40 }]);
    }
  });

  it('keeps every hop when the read stayed under the limit', async () => {
    answer([row({ Route: '/healthz', NextSvc: '', NextRoute: '', Calls: '40', RouteCalls: '40' }),
      row({ NextSvc: '', NextRoute: '', Calls: '15', RouteCalls: '20' })]);
    const out = await read({ limit: 3 });
    expect(out).toMatchObject({ status: 'ok', reasons: [] });
    expect(out.routes.map((h) => h.route)).toEqual(['/healthz', '/api/orders/{id}']);
  });

  it('drops hops whose route or downstream route carries a raw path segment (route_raw_path)', async () => {
    const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e', hex = 'a1b2c3d4e5f60718', digits = '48151';
    answer([
      row({ Route: '/healthz', NextSvc: '', NextRoute: '', Calls: '40', RouteCalls: '40' }),
      // A raw downstream route: the hop also has an empty-next row, which must not survive as a terminal hop.
      row({ NextRoute: `/orders/${digits}`, Calls: '12', RouteCalls: '20' }),
      row({ NextSvc: '', NextRoute: '', Calls: '8', RouteCalls: '20' }),
      row({ Svc: 'users', Route: `/users/${uuid}`, NextSvc: '', NextRoute: '', Calls: '5', RouteCalls: '5' }),
      row({ Svc: 'files', Route: `/files/${hex.toUpperCase()}/meta`, NextSvc: '', NextRoute: '', Calls: '4', RouteCalls: '4' }),
      // Templates, short numbers and version segments are not ids.
      row({ Svc: 'catalog', Route: '/v2/items/{id}/:sku/123', NextSvc: 'search', NextRoute: '/q/abc123', Calls: '3', RouteCalls: '3' }),
    ]);
    const out = await read();
    expect(out.status).toBe('partial');
    expect(out.reasons).toEqual(['route_raw_path']);
    expect(out.routes).toEqual([
      { service: 'frontend', route: '/healthz', next: [], calls: 40 },
      { service: 'catalog', route: '/v2/items/{id}/:sku/123', calls: 3, next: [{ service: 'search', route: '/q/abc123', calls: 3 }] },
    ]);
    const text = JSON.stringify(out);
    for (const raw of [uuid, hex, hex.toUpperCase(), digits]) expect(text).not.toContain(raw);
  });

  it('carries connector truncation markers as partial evidence', async () => {
    answer([row()], { truncated: true });
    expect(await read()).toMatchObject({ status: 'partial', reasons: ['payload_truncated'] });
  });

  it('pairs a route with its service\'s client calls by trace, so INTERNAL spans in between keep the hop', async () => {
    // S (frontend, routed) -> INTERNAL handler -> C (frontend client) -> D (orders server).
    answer([row()]);
    await read();
    const sql = sqlOf();
    expect(sql).toContain('ON n.TraceId = s.TraceId AND n.ClientService = s.ServiceName');
    expect(sql).not.toMatch(/ParentSpanId = s\.SpanId/);
    expect(sql).toContain('ON d.TraceId = c.TraceId AND d.ParentSpanId = c.SpanId');
    // Only (trace, service) pairs with exactly one server span are paired.
    expect(sql).toContain('WHERE Entries = 1) AS s');
  });

  it('skips traces where a service has several server spans and reports them as partial', async () => {
    answer([row()], {}, [{ AmbiguousTraces: '4' }]);
    expect(await read()).toEqual({
      status: 'partial', reasons: ['route_ambiguous_traces'], ambiguousTraces: 4,
      routes: [{ service: 'frontend', route: '/api/orders/{id}', calls: 12,
        next: [{ service: 'orders', route: '/orders/{id}', calls: 12 }] }],
    });
    invokeMcpLambdaTool.mockReset();
    answer([], {}, [{ AmbiguousTraces: 2 }]);
    expect(await read()).toEqual({ status: 'partial', reasons: ['route_ambiguous_traces'], ambiguousTraces: 2, routes: [] });
  });

  it('fails closed on a malformed or missing ambiguity count', async () => {
    for (const ambiguity of [[], [{ AmbiguousTraces: '-1' }], [{ AmbiguousTraces: 'x' }], [{}]]) {
      invokeMcpLambdaTool.mockReset();
      answer([row()], {}, ambiguity);
      expect(await read()).toEqual({ status: 'unavailable', reasons: ['malformed_rows'], routes: [] });
    }
    invokeMcpLambdaTool.mockReset();
    invokeMcpLambdaTool.mockImplementation(async ({ args }: { args: { sql: string } }) => isAmbiguity(args.sql)
      ? { error: 'DB::Exception: detail', collectionStatus: 'error' } : { rows: [row()], collectionStatus: 'ok' });
    expect(await read()).toEqual({ status: 'unavailable', reasons: ['query_failed'], routes: [] });
  });

  it('never accepts a truncated ambiguity count as a clean read', async () => {
    invokeMcpLambdaTool.mockImplementation(async ({ args }: { args: { sql: string; max_rows: number } }) =>
      isAmbiguity(args.sql)
        ? envelope([{ AmbiguousTraces: '0' }], args.max_rows, { truncated: true, collectionStatus: 'partial' })
        : envelope([row()], args.max_rows));
    const out = await read();
    expect(out.status).not.toBe('ok');
    expect(out.reasons).toContain('payload_truncated');
    // Two count rows (only possible from a connector ignoring the SQL shape) are malformed.
    invokeMcpLambdaTool.mockReset();
    answer([row()], {}, [{ AmbiguousTraces: '0' }, { AmbiguousTraces: '0' }]);
    expect(await read()).toMatchObject({ status: 'unavailable', routes: [] });
  });

  it('refuses non-exporter shapes before querying', async () => {
    const custom = 'SELECT trace_id AS TraceId FROM spans LIMIT {cap}';
    const noKind = 'SELECT TraceId, SpanId, ParentSpanId, ServiceName, Timestamp, Duration, ResourceAttributes, ' +
      'SpanAttributes FROM `otel`.`otel_traces` WHERE Timestamp >= now() - INTERVAL {window} MINUTE AND ' +
      'Timestamp <= now() ORDER BY Timestamp DESC LIMIT {cap}';
    for (const template of [custom, noKind]) {
      expect(await read({ template })).toEqual({ status: 'unavailable', reasons: ['route_unsupported_schema'], routes: [] });
    }
    expect(invokeMcpLambdaTool).not.toHaveBeenCalled();
  });

  it('reads the catalog-qualified exporter table when the template carries SpanKind', async () => {
    answer([row()]);
    const template = 'SELECT TraceId, SpanId, ParentSpanId, ServiceName, SpanKind, Timestamp, Duration, ' +
      'ResourceAttributes, SpanAttributes FROM `otel`.`otel_traces` WHERE Timestamp >= now() - INTERVAL {window} ' +
      'MINUTE AND Timestamp <= now() ORDER BY Timestamp DESC LIMIT {cap}';
    expect((await read({ template })).status).toBe('ok');
    expect(sqlOf().match(/FROM `otel`\.`otel_traces`/g)).toHaveLength(3);
    expect(sqlOf(true).match(/FROM `otel`\.`otel_traces`/g)).toHaveLength(1);
  });

  it('fails closed on malformed rows', async () => {
    for (const bad of [
      row({ Calls: '0' }), row({ Calls: '1.5' }), row({ Svc: '' }), row({ Route: 42 }),
      row({ NextSvc: 7 }), row({ Route: `/a${'x'.repeat(600)}` }), row({ Svc: 'a\nb' }), 'nope',
      row({ RouteCalls: '13', NextSvc: 'payments' }), row({ Calls: '13' }), row({ RouteCalls: undefined }), row(),
    ]) {
      invokeMcpLambdaTool.mockReset();
      answer([row(), bad]);
      expect(await read()).toEqual({ status: 'unavailable', reasons: ['malformed_rows'], routes: [] });
    }
  });

  it('uses fixed reasons for resolution, query and envelope failures', async () => {
    getDefaultDatasource.mockResolvedValueOnce(undefined);
    expect(await read()).toEqual({ status: 'unavailable', reasons: ['missing_configuration'], routes: [] });
    getDefaultDatasource.mockRejectedValueOnce(new Error('secret arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:x'));
    expect(await read()).toEqual({ status: 'unavailable', reasons: ['configuration_failed'], routes: [] });
    invokeMcpLambdaTool.mockRejectedValueOnce(new Error('Code: 241. Memory limit exceeded SELECT secret'));
    expect(await read()).toEqual({ status: 'unavailable', reasons: ['query_failed'], routes: [] });
    invokeMcpLambdaTool.mockResolvedValueOnce({ error: 'DB::Exception: details', collectionStatus: 'error' });
    expect(await read()).toEqual({ status: 'unavailable', reasons: ['query_failed'], routes: [] });
    invokeMcpLambdaTool.mockResolvedValueOnce({ unexpected: true });
    expect(await read()).toEqual({ status: 'unavailable', reasons: ['malformed_payload'], routes: [] });
  });

  it('produces hops assignable to SiteRoute', async () => {
    answer([row()]);
    const hops: RouteHop[] = (await read()).routes;
    const routes: SiteRoute[] = hops;
    void routes;
    expect(hops[0]).toMatchObject({ service: 'frontend', route: '/api/orders/{id}' });
  });
});
