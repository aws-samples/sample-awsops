import { describe, it, expect, beforeEach, vi } from 'vitest';

// The generate route is now Bedrock-DIRECT (datasource-querygen), not the AgentCore monitoring gateway.
const verifyUser = vi.fn();
const generateQuery = vi.fn();
const listConfiguredSchemas = vi.fn();
const upsertSchema = vi.fn();
const renderSchemaForPrompt = vi.fn();
const getDatasource = vi.fn();
const resolveConnConfig = vi.fn();
const invokeMcpLambdaTool = vi.fn();
const assertDatasourceEndpointAllowed = vi.fn();

vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/datasource-querygen', () => ({ generateQuery: (...a: unknown[]) => generateQuery(...a) }));
vi.mock('@/lib/datasource-schema', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/datasource-schema')>()), // keep the REAL prioritizeSchemaForQuery
  listConfiguredSchemas: (...a: unknown[]) => listConfiguredSchemas(...a),
  upsertSchema: (...a: unknown[]) => upsertSchema(...a),
  renderSchemaForPrompt: (...a: unknown[]) => renderSchemaForPrompt(...a),
}));
vi.mock('@/lib/account', () => ({ currentAccountId: () => 'self' }));
vi.mock('@/lib/datasources', () => ({
  getDatasource: (...a: unknown[]) => getDatasource(...a),
  resolveConnConfig: (...a: unknown[]) => resolveConnConfig(...a),
}));
vi.mock('@/lib/mcp-lambda-invoke', () => ({ invokeMcpLambdaTool: (...a: unknown[]) => invokeMcpLambdaTool(...a) }));
vi.mock('@/lib/ssrf-guard', () => ({ assertDatasourceEndpointAllowed: (...a: unknown[]) => assertDatasourceEndpointAllowed(...a) }));

function req(body: unknown, cookie = 'awsops_token=t') {
  return new Request('http://x/api/datasources/generate', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
  });
}
const lastGen = () => generateQuery.mock.calls.at(-1)![0] as { nl: string; lang: string; schemaBlock: string; isSql: boolean };

beforeEach(() => {
  for (const m of [verifyUser, generateQuery, listConfiguredSchemas, upsertSchema, renderSchemaForPrompt, getDatasource, resolveConnConfig, invokeMcpLambdaTool, assertDatasourceEndpointAllowed]) m.mockReset();
  verifyUser.mockResolvedValue({ sub: 'u', email: 'a@x' });
  listConfiguredSchemas.mockResolvedValue([]);
  // pass-through renderer: `__block` for assertion convenience; metric/table arrays → a non-empty marker
  renderSchemaForPrompt.mockImplementation((s: unknown) => {
    const o = (s || {}) as { __block?: string; metrics?: unknown[]; tables?: unknown[] };
    if (typeof o.__block === 'string') return o.__block;
    if (Array.isArray(o.metrics) && o.metrics.length) return `M:${o.metrics.join(',')}`;
    if (Array.isArray(o.tables) && o.tables.length) return 'T';
    return '';
  });
  generateQuery.mockResolvedValue('SELECT 1');
});

describe('auth + validation', () => {
  it('401 unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { POST } = await import('./route');
    expect((await POST(req({ slug: 'prometheus', nl: 'x' }))).status).toBe(401);
  });
  it('400 when nl missing', async () => {
    getDatasource.mockResolvedValue({ id: 2, kind: 'clickhouse', endpoint: 'http://ch', authType: 'none' });
    const { POST } = await import('./route');
    expect((await POST(req({ id: 2, nl: '   ' }))).status).toBe(400);
  });
  it('400 unknown instance id', async () => {
    getDatasource.mockResolvedValue(null);
    const { POST } = await import('./route');
    expect((await POST(req({ id: 999, nl: 'x' }))).status).toBe(400);
  });
});

describe('SQL generation (the ClickHouse fix)', () => {
  it('uses the cached schema block and read-only SQL lang for a clickhouse instance', async () => {
    getDatasource.mockResolvedValue({ id: 2, kind: 'clickhouse', endpoint: 'http://ch', authType: 'none' });
    listConfiguredSchemas.mockResolvedValue([{ integrationId: 2, kind: 'clickhouse', schema: { __block: 'otel_traces(ServiceName String)' }, fetched_at: new Date().toISOString() }]);
    generateQuery.mockResolvedValue('SELECT ServiceName FROM otel_traces');
    const { POST } = await import('./route');
    const res = await POST(req({ id: 2, nl: 'api gateway가 보내는 서비스는' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ query: 'SELECT ServiceName FROM otel_traces', lang: 'read-only SQL' });
    const g = lastGen();
    expect(g).toMatchObject({ lang: 'read-only SQL', isSql: true, schemaBlock: 'otel_traces(ServiceName String)' });
    expect(invokeMcpLambdaTool).not.toHaveBeenCalled(); // FRESH cache hit → no introspect (sync or background)
  });

  const flush = () => new Promise((r) => setTimeout(r, 30)); // let the fire-and-forget cache-warm run

  it('on cache miss, serves schema-less now + warms the cache in the BACKGROUND (thin-BFF: no inline introspect)', async () => {
    getDatasource.mockResolvedValue({ id: 5, kind: 'clickhouse', endpoint: 'http://ch', authType: 'none' });
    listConfiguredSchemas.mockResolvedValue([]); // connect-time warm never ran / failed
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://ch', authType: 'none' });
    invokeMcpLambdaTool.mockResolvedValue({ __block: 'logs(Body String)', tables: [] });
    const { POST } = await import('./route');
    const res = await POST(req({ id: 5, nl: 'recent logs' }));
    expect(res.status).toBe(200);
    expect(lastGen().schemaBlock).toBe(''); // schema-less THIS request — the read path does NOT block on introspect
    await flush();
    expect(invokeMcpLambdaTool).toHaveBeenCalledWith(expect.objectContaining({ kind: 'clickhouse', tool: 'clickhouse_schema' }));
    expect(assertDatasourceEndpointAllowed).toHaveBeenCalledWith('http://ch'); // SSRF guard before introspect
    expect(upsertSchema).toHaveBeenCalled(); // cache warmed for next time
  });

  it('on miss, warms THIS instance in the background — never a same-kind SIBLING schema [10]', async () => {
    getDatasource.mockResolvedValue({ id: 6, kind: 'clickhouse', endpoint: 'http://ch-b', authType: 'none' });
    // a DIFFERENT clickhouse instance (99) is cached, but instance 6 is not
    listConfiguredSchemas.mockResolvedValue([{ integrationId: 99, kind: 'clickhouse', schema: { __block: 'SIBLING(x String)' }, fetched_at: 't' }]);
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://ch-b', authType: 'none' });
    invokeMcpLambdaTool.mockResolvedValue({ __block: 'OWN(y String)' });
    const { POST } = await import('./route');
    const res = await POST(req({ id: 6, nl: 'tables' }));
    expect(res.status).toBe(200);
    expect(lastGen().schemaBlock).toBe(''); // NOT the sibling's 'SIBLING(…)' — a sibling is never used for a specific id
    await flush();
    expect(resolveConnConfig).toHaveBeenCalled(); // background warm resolved THIS instance's conn-config
    expect(invokeMcpLambdaTool).toHaveBeenCalledWith(expect.objectContaining({ tool: 'clickhouse_schema' }));
  });

  it('background cache-warm falls back to a trimmed write when the schema exceeds the size limit [4]', async () => {
    getDatasource.mockResolvedValue({ id: 7, kind: 'clickhouse', endpoint: 'http://ch', authType: 'none' });
    listConfiguredSchemas.mockResolvedValue([]);
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://ch', authType: 'none' });
    invokeMcpLambdaTool.mockResolvedValue({ __block: 'X(c String)', tables: [{ name: 'X', columns: [] }] });
    upsertSchema.mockRejectedValueOnce(new Error('introspected schema exceeds size limit')); // full write fails
    upsertSchema.mockResolvedValueOnce(undefined); // trimmed write succeeds
    const { POST } = await import('./route');
    const res = await POST(req({ id: 7, nl: 'tables' }));
    expect(res.status).toBe(200);
    await flush();
    expect(upsertSchema).toHaveBeenCalledTimes(2); // full (failed) → trimmed fallback
  });

  it('502 when the generator throws (e.g. prose-not-SQL guard or Bedrock failure)', async () => {
    getDatasource.mockResolvedValue({ id: 2, kind: 'clickhouse', endpoint: 'http://ch', authType: 'none' });
    generateQuery.mockRejectedValue(new Error('could not generate a valid read-only query'));
    const { POST } = await import('./route');
    const res = await POST(req({ id: 2, nl: 'whatever' }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/read-only query/);
  });
});

describe('Prometheus metric relevance', () => {
  it('floats NL-relevant metrics to the front before rendering (so the cap keeps them)', async () => {
    getDatasource.mockResolvedValue({ id: 1, kind: 'prometheus', endpoint: 'http://prom', authType: 'none' });
    // relevant metric is LAST (alphabetical), would be dropped by the render cap without prioritization
    const metrics = ['ALERTS', 'aggregator_total', 'alertmanager_alerts', 'kube_pod_container_resource_requests'];
    listConfiguredSchemas.mockResolvedValue([{ integrationId: 1, kind: 'prometheus', schema: { metrics }, fetched_at: 't' }]);
    generateQuery.mockResolvedValue('kube_pod_container_resource_requests');
    const { POST } = await import('./route');
    const res = await POST(req({ id: 1, nl: 'pod resource조회' }));
    expect(res.status).toBe(200);
    // renderSchemaForPrompt received the REAL-prioritized schema → pod/resource metric is now first
    const schemaArg = renderSchemaForPrompt.mock.calls.at(-1)![0] as { metrics: string[] };
    expect(schemaArg.metrics[0]).toBe('kube_pod_container_resource_requests');
    expect(lastGen()).toMatchObject({ lang: 'PromQL', isSql: false });
  });
});

describe('lazy refresh (TTL) [P2]', () => {
  const flush = () => new Promise((r) => setTimeout(r, 25)); // let the fire-and-forget refresh run

  it('refreshes in the background on a STALE cache hit (serves cached now)', async () => {
    getDatasource.mockResolvedValue({ id: 11, kind: 'prometheus', endpoint: 'http://prom', authType: 'none' });
    listConfiguredSchemas.mockResolvedValue([{ integrationId: 11, kind: 'prometheus', schema: { __block: 'CACHED', metrics: ['up'] }, fetched_at: '2020-01-01T00:00:00Z' }]);
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://prom', authType: 'none' });
    invokeMcpLambdaTool.mockResolvedValue({ __block: 'FRESH', metrics: ['up'] });
    generateQuery.mockResolvedValue('up');
    const { POST } = await import('./route');
    const res = await POST(req({ id: 11, nl: 'is it up' }));
    expect(res.status).toBe(200);
    expect(lastGen().schemaBlock).toBe('CACHED'); // served the cached copy immediately
    await flush();
    expect(invokeMcpLambdaTool).toHaveBeenCalledWith(expect.objectContaining({ tool: 'prometheus_schema' })); // background refresh fired
  });

  it('does NOT refresh on a FRESH cache hit', async () => {
    getDatasource.mockResolvedValue({ id: 12, kind: 'prometheus', endpoint: 'http://prom', authType: 'none' });
    listConfiguredSchemas.mockResolvedValue([{ integrationId: 12, kind: 'prometheus', schema: { __block: 'CACHED', metrics: ['up'] }, fetched_at: new Date().toISOString() }]);
    generateQuery.mockResolvedValue('up');
    const { POST } = await import('./route');
    await POST(req({ id: 12, nl: 'is it up' }));
    await flush();
    expect(invokeMcpLambdaTool).not.toHaveBeenCalled(); // fresh → no introspect
  });
});

describe('non-SQL datasources', () => {
  it('marks PromQL as non-SQL (no read-verb guard) for a slug/kind request', async () => {
    listConfiguredSchemas.mockResolvedValue([{ integrationId: 1, kind: 'prometheus', schema: { __block: 'metrics: up' }, fetched_at: 't' }]);
    generateQuery.mockResolvedValue('up');
    const { POST } = await import('./route');
    const res = await POST(req({ slug: 'prometheus', kind: 'prometheus', nl: 'is it up' }));
    expect(res.status).toBe(200);
    expect(lastGen()).toMatchObject({ lang: 'PromQL', isSql: false, schemaBlock: 'metrics: up' });
    expect(getDatasource).not.toHaveBeenCalled(); // slug path → no instance fetch / introspect
  });
});
