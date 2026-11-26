import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ verify: vi.fn(), query: vi.fn(), read: vi.fn(), pool: null as unknown }));
vi.mock('@/lib/auth', () => ({ verifyUser: mocks.verify }));
// The registry read runs in graphReadTransaction: a pool with `connect` only (no direct pool.query). Transaction
// control statements are answered here; the registry SELECT goes to mocks.query.
vi.mock('@/lib/db', () => ({ getPool: () => mocks.pool }));
// graph-sources (real) → trace-source → datasources/mcp-lambda-invoke: stub the AWS-facing leaves.
vi.mock('@/lib/datasources', () => ({
  getDatasource: vi.fn(async () => null), getDefaultDatasource: vi.fn(async () => null), resolveConnConfig: vi.fn(),
}));
vi.mock('@/lib/mcp-lambda-invoke', () => ({ invokeMcpLambdaTool: vi.fn() }));
vi.mock('@/lib/trace-routes', () => ({ readTraceRoutes: mocks.read }));
import { GET } from './route';
import { clearRouteCache } from '@/lib/site-routes-cache';

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

const CONTROL = /^(BEGIN|SET LOCAL|COMMIT|ROLLBACK)\b/;
const freshPool = () => {
  const client = {
    query: vi.fn(async (text: string, ...rest: unknown[]) => (CONTROL.test(text) ? { rows: [] } : mocks.query(text, ...rest))),
    release: vi.fn(), on: vi.fn(), removeListener: vi.fn(),
  };
  return { connect: vi.fn(async () => client), client };
};
let pool: ReturnType<typeof freshPool>;

beforeEach(() => {
  clearRouteCache();
  // Graph-read admission is per pool and a hung read keeps its slot: every test gets its own pool.
  pool = freshPool();
  mocks.pool = pool;
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

  it('keeps route_raw_path from a source', async () => {
    mocks.query.mockResolvedValue({ rows: [otelRow(7)] });
    mocks.read.mockResolvedValue({ status: 'partial', reasons: ['route_raw_path'], routes: [hop()] });
    expect((await get()).body).toEqual({ status: 'partial', reasons: ['route_raw_path'], routes: [hop()] });
  });

  it('reuses an ok/partial per-source read for 60 s, keyed by source, template and window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-24T00:00:00Z'));
    mocks.query.mockResolvedValue({ rows: [otelRow(7)] });
    mocks.read.mockResolvedValue({ status: 'partial', reasons: ['capped'], routes: [hop()] });
    const first = await get();
    vi.setSystemTime(new Date('2026-11-24T00:00:59Z'));
    const second = await get();
    expect(second.body).toEqual(first.body);
    expect(second.res.headers.get('Cache-Control')).toBe('private, no-store'); // reuse is server-side only
    expect(mocks.read).toHaveBeenCalledTimes(1);
    await get('?windowMins=15'); // another window is another aggregate
    expect(mocks.read).toHaveBeenCalledTimes(2);
    mocks.query.mockResolvedValue({ rows: [otelRow(7, CATALOG_SQL.replace('`otel`.', '`traces`.'))] });
    await get(); // another registry template for the same source is another key
    expect(mocks.read).toHaveBeenCalledTimes(3);
    mocks.query.mockResolvedValue({ rows: [otelRow(7)] });
    vi.setSystemTime(new Date('2026-11-24T00:01:00Z')); // expired
    await get();
    expect(mocks.read).toHaveBeenCalledTimes(4);
  });

  it('single-flight: concurrent requests for the same source share one read', async () => {
    mocks.query.mockResolvedValue({ rows: [otelRow(7)] });
    let release!: () => void;
    mocks.read.mockImplementation(() => new Promise((r) => { release = () => r({ status: 'ok', reasons: [], routes: [hop()] }); }));
    const a = GET(req()), b = GET(req());
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 5));
    expect(mocks.read).toHaveBeenCalledTimes(1);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(await ra.json()).toEqual({ status: 'ok', reasons: [], routes: [hop()] });
    expect(await rb.json()).toEqual({ status: 'ok', reasons: [], routes: [hop()] });
  });

  it('never reuses an unavailable or rejected read', async () => {
    mocks.query.mockResolvedValue({ rows: [otelRow(7)] });
    mocks.read.mockResolvedValueOnce({ status: 'unavailable', reasons: ['deadline'], routes: [] });
    expect((await get()).body.status).toBe('unavailable');
    mocks.read.mockRejectedValueOnce(new Error('upstream'));
    expect((await get()).body).toEqual({ status: 'unavailable', reasons: ['query_failed'], routes: [] });
    mocks.read.mockResolvedValueOnce({ status: 'ok', reasons: [], routes: [hop()] });
    expect((await get()).body.status).toBe('ok');
    expect(mocks.read).toHaveBeenCalledTimes(3);
  });

  it('reads at most 4 sources at once, each within what is left of the total budget', async () => {
    vi.useFakeTimers();
    mocks.query.mockResolvedValue({ rows: [1, 2, 3, 4, 5, 6].map((id) => otelRow(id)) });
    let inFlight = 0, peak = 0;
    // Like readTraceRoutes: settles (unavailable) once its own deadline passes or the cache aborts its signal.
    mocks.read.mockImplementation(({ deadlineMs, signal }: { deadlineMs: number; signal: AbortSignal }) => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      return new Promise((r) => {
        const settle = () => { clearTimeout(timer); inFlight -= 1; r({ status: 'unavailable', reasons: ['deadline'], routes: [] }); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', settle); settle(); }, deadlineMs);
        signal.addEventListener('abort', settle, { once: true });
      });
    });
    const pending = GET(req());
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await pending;
    expect(await res.json()).toEqual({ status: 'unavailable', reasons: ['deadline'], routes: [] });
    expect(peak).toBe(4);
    expect(mocks.read.mock.calls.every(([o]) => o.signal instanceof AbortSignal)).toBe(true);
    const deadlines = mocks.read.mock.calls.map(([o]) => o.deadlineMs);
    expect(deadlines.slice(0, 4)).toEqual([8000, 8000, 8000, 8000]);
    // Lanes 5 and 6 start when the first four give up at 8 s: only 2 s of the 10 s budget remain.
    expect(deadlines.slice(4)).toEqual([2000, 2000]);
  });

  it('reads the registry in a read-only transaction with server-side timeouts, then releases the client', async () => {
    mocks.query.mockResolvedValue({ rows: [otelRow(7)] });
    mocks.read.mockResolvedValue({ status: 'ok', reasons: [], routes: [hop()] });
    expect((await get()).res.status).toBe(200);
    expect('query' in pool).toBe(false);
    expect(pool.connect).toHaveBeenCalledTimes(1);
    const sql = pool.client.query.mock.calls.map(([text]) => String(text));
    expect(sql[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const select = sql.findIndex((t) => /datasource_graph_queries/.test(t));
    for (const setting of ['statement_timeout', 'lock_timeout', 'transaction_timeout']) {
      const at = sql.findIndex((t) => t.startsWith(`SET LOCAL ${setting}`));
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(select);
    }
    expect(sql[sql.length - 1]).toBe('COMMIT');
    expect(pool.client.release).toHaveBeenCalledTimes(1);
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
    expect(pool.client.query.mock.calls.map(([t]) => t)).toContain('ROLLBACK');
    expect(pool.client.release).toHaveBeenCalledTimes(1);
  });

  it('bounds a hung registry read with a fixed 503 timeout and discards its connection', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.query.mockReturnValue(new Promise(() => {}));
    const pending = GET(req());
    await vi.advanceTimersByTimeAsync(2_000);
    const res = await pending;
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'timeout' });
    expect(mocks.read).not.toHaveBeenCalled();
    // The client is destroyed (release(true)), not returned to the pool with the statement still running.
    expect(pool.client.release).toHaveBeenCalledWith(true);
  });

  it('refuses a third concurrent registry read with a fixed 503 instead of taking another connection', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.query.mockReturnValue(new Promise(() => {}));
    const first = GET(req()), second = GET(req());
    await vi.advanceTimersByTimeAsync(0);
    expect(pool.connect).toHaveBeenCalledTimes(2);
    const third = await GET(req());
    expect(third.status).toBe(503);
    expect(await third.json()).toEqual({ error: 'read_unavailable' });
    expect(pool.connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    for (const res of await Promise.all([first, second])) {
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'timeout' });
    }
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
