import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn(); const isAdmin = vi.fn();
const invokeMcpLambdaTool = vi.fn(); const upsertSchema = vi.fn(); const listConfiguredSchemas = vi.fn();
const getDatasource = vi.fn(); const resolveConnConfig = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/account', () => ({ currentAccountId: () => 'acct-1' }));
vi.mock('@/lib/mcp-lambda-invoke', () => ({ invokeMcpLambdaTool: (...a: unknown[]) => invokeMcpLambdaTool(...a) }));
vi.mock('@/lib/datasource-schema', () => ({
  upsertSchema: (...a: unknown[]) => upsertSchema(...a),
  listConfiguredSchemas: (...a: unknown[]) => listConfiguredSchemas(...a),
}));
vi.mock('@/lib/datasources', () => ({
  getDatasource: (...a: unknown[]) => getDatasource(...a),
  resolveConnConfig: (...a: unknown[]) => resolveConnConfig(...a),
}));

function req(body: unknown, method = 'POST') {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json', cookie: 'awsops_token=t' } };
  if (method !== 'GET') init.body = JSON.stringify(body);
  return new Request('http://x/api/integrations/schema', init);
}
beforeEach(() => {
  for (const m of [verifyUser, isAdmin, invokeMcpLambdaTool, upsertSchema, listConfiguredSchemas, getDatasource, resolveConnConfig]) m.mockReset();
  process.env.AURORA_ENDPOINT = 'aurora'; verifyUser.mockResolvedValue({ email: 'a@x' }); isAdmin.mockResolvedValue(true);
  getDatasource.mockResolvedValue({ id: 5, name: 'p', kind: 'prometheus', endpoint: 'http://10.0.0.5:9090', authType: 'none', isDefault: true, enabled: true });
  resolveConnConfig.mockResolvedValue({ endpoint: 'http://10.0.0.5:9090', authType: 'none' });
});

describe('/api/integrations/schema', () => {
  it('403 non-admin', async () => {
    isAdmin.mockResolvedValue(false);
    const { POST } = await import('./route');
    expect((await POST(req({ id: 5 }))).status).toBe(403);
    expect(invokeMcpLambdaTool).not.toHaveBeenCalled();
  });

  it('POST introspects by instance id + upserts under integration_id; returns summary (counts only)', async () => {
    invokeMcpLambdaTool.mockResolvedValue({ metrics: ['up', 'down'], labels: ['job'] });
    const { POST } = await import('./route');
    const resp = await POST(req({ id: 5 }));
    expect(resp.status).toBe(200);
    expect(invokeMcpLambdaTool).toHaveBeenCalledWith({ kind: 'prometheus', tool: 'prometheus_schema', connConfig: { endpoint: 'http://10.0.0.5:9090', authType: 'none' } });
    expect(upsertSchema).toHaveBeenCalledWith('acct-1', 5, 'prometheus', { metrics: ['up', 'down'], labels: ['job'] });
    const body = await resp.json();
    expect(body.summary).toEqual({ metrics: 2, labels: 1 });
    expect(JSON.stringify(body)).not.toContain('"up"'); // counts only, no values
  });

  it('400 on a bad id / unknown instance', async () => {
    const { POST } = await import('./route');
    expect((await POST(req({ id: 0 }))).status).toBe(400);
    getDatasource.mockResolvedValue(null);
    expect((await POST(req({ id: 99 }))).status).toBe(400);
    expect(invokeMcpLambdaTool).not.toHaveBeenCalled();
  });

  it('SSRF-blocks a bad resolved endpoint (400, no invoke)', async () => {
    getDatasource.mockResolvedValue({ id: 6, kind: 'clickhouse', endpoint: 'http://169.254.169.254', authType: 'none', isDefault: false, enabled: true });
    resolveConnConfig.mockResolvedValue({ endpoint: 'http://169.254.169.254', authType: 'none' });
    const { POST } = await import('./route');
    expect((await POST(req({ id: 6 }))).status).toBe(400);
    expect(invokeMcpLambdaTool).not.toHaveBeenCalled();
  });

  it('GET returns cached summaries keyed by integrationId (counts only)', async () => {
    listConfiguredSchemas.mockResolvedValue([{ integrationId: 5, kind: 'prometheus', schema: { metrics: ['up'] }, fetched_at: 't' }]);
    const { GET } = await import('./route');
    const resp = await GET(req(undefined, 'GET'));
    expect(resp.status).toBe(200);
    const { schemas } = await resp.json();
    expect(schemas[0]).toEqual({ integrationId: 5, kind: 'prometheus', fetched_at: 't', summary: { metrics: 1 } });
  });
});
