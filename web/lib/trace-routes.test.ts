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
  Svc: 'frontend', Route: '/api/orders/{id}', NextSvc: 'orders', NextRoute: '/orders/{id}', Calls: '12', ...over,
});
const answer = (rows: unknown[], extra: Record<string, unknown> = {}) =>
  invokeMcpLambdaTool.mockResolvedValue({ rows, collectionStatus: rows.length ? 'ok' : 'empty', ...extra });
const read = (over: Partial<Parameters<typeof readTraceRoutes>[0]> = {}) =>
  readTraceRoutes({ windowMins: 60, deadlineMs: 5_000, limit: 200, ...over });
const sqlOf = (i = 0) => invokeMcpLambdaTool.mock.calls[i][0].args.sql as string;

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
    expect(invokeMcpLambdaTool).toHaveBeenCalledTimes(1);
    const { kind, tool, args, connConfig } = invokeMcpLambdaTool.mock.calls[0][0];
    expect({ kind, tool, connConfig }).toEqual({
      kind: 'clickhouse', tool: 'clickhouse_query', connConfig: { endpoint: 'https://ch.example.com' },
    });
    expect(args.max_rows).toBe(120);
    const sql = sqlOf();
    expect(sql).toMatch(/INTERVAL 15 MINUTE/);
    expect(sql).toMatch(/LIMIT 120$/);
    expect(sql).toContain('FROM otel_traces');
    // Every attribute read is the route template; never raw paths or resource attributes.
    const keys = [...sql.matchAll(/Attributes\['([^']+)'\]/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys)).toEqual(new Set(['http.route']));
    expect(sql).not.toContain('ResourceAttributes');
    expect(sql).not.toContain('url.path');
    expect(sql).not.toMatch(/http\.target|http\.url|url\.full/);
    // Join sides are restricted to the window and the exporter's span kinds.
    expect(sql.match(/fromUnixTimestamp64Milli\(\d+\) - INTERVAL 15 MINUTE/g)).toHaveLength(3);
    expect(sql).toContain("SpanKind IN ('Server', 'SERVER', 'SPAN_KIND_SERVER')");
    expect(sql).toContain("SpanKind IN ('Client', 'CLIENT', 'SPAN_KIND_CLIENT')");
    expect(sql).toContain("SpanAttributes['http.route'] != ''");
    expect(sql).toContain('LEFT JOIN');
    expect(sql).toMatch(/GROUP BY Svc, Route, NextSvc, NextRoute ORDER BY Calls DESC LIMIT 120$/);
    // Same-service children are excluded from `next` without dropping the parent route.
    expect(sql).toMatch(/if\(\w+\.ServiceName = \w+\.ServiceName, '', /);
  });

  it('clamps the limit to 500 and rejects windows outside the allowlist', async () => {
    answer([row()]);
    await read({ limit: 10_000 });
    expect(sqlOf()).toMatch(/LIMIT 500$/);
    expect(invokeMcpLambdaTool.mock.calls[0][0].args.max_rows).toBe(500);
    invokeMcpLambdaTool.mockClear();
    expect(await read({ windowMins: 61 as 60 })).toEqual({ status: 'unavailable', reasons: ['invalid_request'], routes: [] });
    expect(await read({ limit: Number.NaN })).toEqual({ status: 'unavailable', reasons: ['invalid_request'], routes: [] });
    expect(invokeMcpLambdaTool).not.toHaveBeenCalled();
  });

  it('folds rows into one hop per service route with summed calls and per-downstream next', async () => {
    answer([
      row(),
      row({ NextSvc: 'payments', NextRoute: '', Calls: '5' }),
      row({ NextSvc: '', NextRoute: '', Calls: '3' }),
      row({ Route: '/healthz', NextSvc: '', NextRoute: '', Calls: 40 }),
      row({ Svc: 'orders', Route: '/orders/{id}', NextSvc: null, NextRoute: null, Calls: '9' }),
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
    invokeMcpLambdaTool.mockResolvedValue({ rows: [] });
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

  it('marks a saturated limit as capped', async () => {
    answer([row(), row({ NextSvc: 'payments', Calls: '2' })]);
    const out = await read({ limit: 2 });
    expect(out.status).toBe('partial');
    expect(out.reasons).toEqual(['capped']);
    expect(out.routes).toHaveLength(1);
  });

  it('carries connector truncation markers as partial evidence', async () => {
    answer([row()], { truncated: true });
    expect(await read()).toMatchObject({ status: 'partial', reasons: ['payload_truncated'] });
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
  });

  it('fails closed on malformed rows', async () => {
    for (const bad of [
      row({ Calls: '0' }), row({ Calls: '1.5' }), row({ Svc: '' }), row({ Route: 42 }),
      row({ NextSvc: 7 }), row({ Route: `/a${'x'.repeat(600)}` }), row({ Svc: 'a\nb' }), 'nope',
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
