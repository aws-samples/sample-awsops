import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ verify: vi.fn(), query: vi.fn(), read: vi.fn() }));
vi.mock('@/lib/auth', () => ({ verifyUser: mocks.verify }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: mocks.query }) }));
// graph-sources (real) → trace-source → datasources/mcp-lambda-invoke: stub the AWS-facing leaves.
vi.mock('@/lib/datasources', () => ({
  getDatasource: vi.fn(async () => null), getDefaultDatasource: vi.fn(async () => null), resolveConnConfig: vi.fn(),
}));
vi.mock('@/lib/mcp-lambda-invoke', () => ({ invokeMcpLambdaTool: vi.fn() }));
vi.mock('@/lib/trace-routes', () => ({ readTraceRoutes: mocks.read }));
import { GET } from './route';

const CATALOG_SQL = 'SELECT TraceId, SpanId, ParentSpanId, ServiceName, SpanKind, Timestamp, Duration, ' +
  'ResourceAttributes, SpanAttributes, StatusCode FROM `otel`.`otel_traces` WHERE Timestamp >= now() - ' +
  'INTERVAL {window} MINUTE AND Timestamp <= now() ORDER BY Timestamp DESC LIMIT {cap}';
const otelRow = (id: number, sql: string = CATALOG_SQL) =>
  ({ integration_id: id, query: { tool: 'clickhouse_query', mapper: 'otel_v1', args_template: { sql } } });
const tempoRow = { integration_id: 9, query: { tool: 'tempo_search', mapper: 'tempo_v1', args_template: {} } };
const hop = (over: Record<string, unknown> = {}) => ({
  service: 'frontend', route: '/api/orders/{id}', calls: 12,
  next: [{ service: 'orders', route: '/orders/{id}', calls: 10 }], ...over,
});
const req = (qs = '') => new Request(`http://localhost/api/topology/site-routes${qs}`);
const get = async (qs = '') => {
  const res = await GET(req(qs));
  return { res, body: await res.json() };
};

beforeEach(() => {
  vi.stubEnv('TOPOLOGY_ENTITIES_ENABLED', 'true');
  mocks.verify.mockResolvedValue({ sub: 'fixture' });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe('GET /api/topology/site-routes', () => {
  it('authenticates before flag disclosure, then mirrors the /api/topology feature gate', async () => {
    mocks.verify.mockResolvedValue(null);
    const unauth = await get();
    expect(unauth.res.status).toBe(401);
    expect(unauth.body).toEqual({ error: 'unauthenticated' });
    expect(unauth.res.headers.get('Cache-Control')).toBe('private, no-store');
    mocks.verify.mockResolvedValue({ sub: 'fixture' });
    vi.stubEnv('TOPOLOGY_ENTITIES_ENABLED', 'false');
    const off = await get();
    expect(off.res.status).toBe(404);
    expect(off.body).toEqual({ error: 'topology_entities_disabled', class: 'service' });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it.each([
    '?template=SELECT%201', '?instanceId=7', '?windowMins=30', '?windowMins=060', '?windowMins=6e1',
    '?windowMins=', '?windowMins=constructor', '?windowMins=60&windowMins=60', '?windowMins=60&x=1',
  ])('rejects %s with 400 before reading the registry', async (qs) => {
    const { res, body } = await get(qs);
    expect(res.status).toBe(400);
    expect(body).toEqual({ error: 'invalid_request' });
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it('serves one ok source with the registry template, default 60-minute window and bounded reads', async () => {
    mocks.query.mockResolvedValue({ rows: [otelRow(7), tempoRow] });
    mocks.read.mockResolvedValue({ status: 'ok', reasons: [], routes: [hop()] });
    const { res, body } = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(body).toEqual({ status: 'ok', reasons: [], routes: [hop()] });
    expect(mocks.read).toHaveBeenCalledTimes(1);
    const [opts] = mocks.read.mock.calls[0];
    expect(opts).toMatchObject({ instanceId: 7, template: CATALOG_SQL, windowMins: 60, limit: 500 });
    expect(opts.deadlineMs).toBeGreaterThan(0);
    expect(opts.deadlineMs).toBeLessThanOrEqual(8000);
    expect(String(mocks.query.mock.calls[0][0])).toMatch(/datasource_graph_queries[\s\S]*JOIN integrations/);
  });

  it.each([['15', 15], ['180', 180]])('passes the allowlisted window %s through as a number', async (qs, n) => {
    mocks.query.mockResolvedValue({ rows: [otelRow(7)] });
    mocks.read.mockResolvedValue({ status: 'ok', reasons: [], routes: [] });
    expect((await get(`?windowMins=${qs}`)).res.status).toBe(200);
    expect(mocks.read.mock.calls[0][0].windowMins).toBe(n);
  });

  it('takes the template only from the registry, never from the request', async () => {
    mocks.query.mockResolvedValue({ rows: [otelRow(7, 'SELECT 1 FROM t LIMIT {cap}')] });
    mocks.read.mockResolvedValue({ status: 'unavailable', reasons: ['route_unsupported_schema'], routes: [] });
    const { body } = await get('?windowMins=15');
    expect(mocks.read).toHaveBeenCalledWith(expect.objectContaining({
      instanceId: 7, template: 'SELECT 1 FROM t LIMIT {cap}', windowMins: 15,
    }));
    expect(body).toEqual({ status: 'unavailable', reasons: ['route_unsupported_schema'], routes: [] });
  });

  it('returns exactly { status, reasons, routes } with allowlisted hop and next fields', async () => {
    mocks.query.mockResolvedValue({ rows: [otelRow(7)] });
    mocks.read.mockResolvedValue({
      status: 'partial', reasons: ['route_ambiguous_traces'], ambiguousTraces: 4, extra: 'x',
      routes: [{ ...hop(), url: '/api/orders/123', next: [{ service: 'orders', calls: 3, path: '/orders/123?q=1' }] }],
    });
    const { body } = await get();
    expect(Object.keys(body).sort()).toEqual(['reasons', 'routes', 'status']);
    expect(Object.keys(body.routes[0]).sort()).toEqual(['calls', 'next', 'route', 'service']);
    expect(Object.keys(body.routes[0].next[0]).sort()).toEqual(['calls', 'service']);
    expect(JSON.stringify(body)).not.toMatch(/ambiguousTraces|123|extra/);
    expect(body.status).toBe('partial');
  });

  it('keeps a single partial source partial with its routes', async () => {
    mocks.query.mockResolvedValue({ rows: [otelRow(7)] });
    mocks.read.mockResolvedValue({ status: 'partial', reasons: ['capped'], routes: [hop()] });
    expect((await get()).body).toEqual({ status: 'partial', reasons: ['capped'], routes: [hop()] });
  });

  it('reports partial when one source is ok and another unavailable', async () => {
    mocks.query.mockResolvedValue({ rows: [otelRow(7), otelRow(8)] });
    mocks.read.mockImplementation(async ({ instanceId }: { instanceId: number }) => (instanceId === 7
      ? { status: 'ok', reasons: [], routes: [hop()] }
      : { status: 'unavailable', reasons: ['query_failed'], routes: [] }));
    const { body } = await get();
    expect(body).toEqual({ status: 'partial', reasons: ['query_failed'], routes: [hop()] });
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });

  it('reports unavailable when every source is unavailable, with sorted unique reasons', async () => {
    mocks.query.mockResolvedValue({ rows: [otelRow(7), otelRow(8)] });
    mocks.read.mockImplementation(async ({ instanceId }: { instanceId: number }) => ({
      status: 'unavailable', reasons: instanceId === 7 ? ['query_failed', 'deadline'] : ['deadline'], routes: [],
    }));
    expect((await get()).body).toEqual({ status: 'unavailable', reasons: ['deadline', 'query_failed'], routes: [] });
  });

  it('runs sources concurrently and treats a rejected read as that source failing', async () => {
    mocks.query.mockResolvedValue({ rows: [otelRow(7), otelRow(8)] });
    let started = 0;
    mocks.read.mockImplementation(async ({ instanceId }: { instanceId: number }) => {
      started += 1;
      await new Promise((r) => setTimeout(r, 5));
      expect(started).toBe(2);
      if (instanceId === 8) throw new Error('upstream secret detail');
      return { status: 'ok', reasons: [], routes: [hop()] };
    });
    const { body } = await get();
    expect(body).toEqual({ status: 'partial', reasons: ['query_failed'], routes: [hop()] });
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('reports unavailable no_trace_source when no ClickHouse trace datasource is registered', async () => {
    mocks.query.mockResolvedValue({ rows: [tempoRow] });
    const { res, body } = await get();
    expect(res.status).toBe(200);
    expect(body).toEqual({ status: 'unavailable', reasons: ['no_trace_source'], routes: [] });
    expect(mocks.read).not.toHaveBeenCalled();
    mocks.query.mockResolvedValue({ rows: [] });
    expect((await get()).body).toEqual({ status: 'unavailable', reasons: ['no_trace_source'], routes: [] });
  });

  it('collapses duplicate registry rows into one read', async () => {
    mocks.query.mockResolvedValue({ rows: [otelRow(7), otelRow(7)] });
    mocks.read.mockResolvedValue({ status: 'ok', reasons: [], routes: [hop()] });
    expect((await get()).body).toEqual({ status: 'ok', reasons: [], routes: [hop()] });
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });

  it('keeps the max per hop across sources and flags multi_source_counts instead of summing', async () => {
    mocks.query.mockResolvedValue({ rows: [otelRow(7), otelRow(8)] });
    mocks.read.mockImplementation(async ({ instanceId }: { instanceId: number }) => ({
      status: 'ok', reasons: [],
      routes: instanceId === 7
        ? [hop({ calls: 12, next: [{ service: 'orders', route: '/orders/{id}', calls: 10 }] }),
          hop({ service: 'orders', route: '/orders/{id}', calls: 2, next: [] })]
        : [hop({ calls: 20, next: [{ service: 'orders', route: '/orders/{id}', calls: 4 },
            { service: 'payments', calls: 6 }] })],
    }));
    const { body } = await get();
    expect(body).toEqual({
      status: 'partial', reasons: ['multi_source_counts'],
      routes: [
        { service: 'frontend', route: '/api/orders/{id}', calls: 20, next: [
          { service: 'orders', route: '/orders/{id}', calls: 10 }, { service: 'payments', calls: 6 }] },
        { service: 'orders', route: '/orders/{id}', calls: 2, next: [] },
      ],
    });
  });

  it('drops unknown reason strings from a source', async () => {
    mocks.query.mockResolvedValue({ rows: [otelRow(7)] });
    mocks.read.mockResolvedValue({ status: 'partial', reasons: ['capped', 'Code: 241 secret'], routes: [] });
    expect((await get()).body).toEqual({ status: 'partial', reasons: ['capped'], routes: [] });
  });

  it('maps a registry failure to a fixed 503 body', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.query.mockRejectedValue(Object.assign(new Error('password=hunter2'), { code: '57P01' }));
    const { res, body } = await get();
    expect(res.status).toBe(503);
    expect(body).toEqual({ error: 'read_unavailable' });
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(JSON.stringify(error.mock.calls)).not.toContain('hunter2');
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it('bounds a hung registry read with a fixed 503 timeout', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.query.mockReturnValue(new Promise(() => {}));
    const pending = GET(req());
    await vi.advanceTimersByTimeAsync(2_000);
    const res = await pending;
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'timeout' });
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
