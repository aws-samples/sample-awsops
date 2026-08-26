import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const isAdmin = vi.fn();
const createDatasource = vi.fn();
const updateDatasource = vi.fn();
const getDatasource = vi.fn();
const setIntegrationCredentialById = vi.fn();
const mirrorDefaultCredential = vi.fn();
const invokeMcpLambdaTool = vi.fn();
const upsertSchema = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/datasources', () => ({
  createDatasource: (...a: unknown[]) => createDatasource(...a),
  updateDatasource: (...a: unknown[]) => updateDatasource(...a),
  getDatasource: (...a: unknown[]) => getDatasource(...a),
}));
vi.mock('@/lib/integration-credentials', () => ({
  setIntegrationCredentialById: (...a: unknown[]) => setIntegrationCredentialById(...a),
  mirrorDefaultCredential: (...a: unknown[]) => mirrorDefaultCredential(...a),
}));
vi.mock('@/lib/mcp-lambda-invoke', () => ({ invokeMcpLambdaTool: (...a: unknown[]) => invokeMcpLambdaTool(...a) }));
vi.mock('@/lib/datasource-schema', () => ({ upsertSchema: (...a: unknown[]) => upsertSchema(...a) }));
vi.mock('@/lib/account', () => ({ currentAccountId: () => 'self' }));

function req(body: unknown, method = 'POST') {
  return new Request('http://x/api/datasources/manage', {
    method, headers: { 'content-type': 'application/json', cookie: 'awsops_token=t' }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  for (const m of [verifyUser, isAdmin, createDatasource, updateDatasource, getDatasource, setIntegrationCredentialById, mirrorDefaultCredential, invokeMcpLambdaTool, upsertSchema]) m.mockReset();
  invokeMcpLambdaTool.mockResolvedValue({ version: '2.48.0', metrics: ['up'] });
  upsertSchema.mockResolvedValue(undefined);
  process.env.AURORA_ENDPOINT = 'aurora.example';
  verifyUser.mockResolvedValue({ sub: 'u' });
  isAdmin.mockResolvedValue(true);
  createDatasource.mockResolvedValue(7);
  getDatasource.mockResolvedValue({ id: 7, name: 'p', kind: 'prometheus', endpoint: 'http://p', authType: 'none', isDefault: true, enabled: true });
  setIntegrationCredentialById.mockResolvedValue(undefined);
  mirrorDefaultCredential.mockResolvedValue(undefined);
  updateDatasource.mockResolvedValue(undefined);
});

describe('POST create', () => {
  it('403 non-admin, no writes', async () => {
    isAdmin.mockResolvedValue(false);
    const { POST } = await import('./route');
    expect((await POST(req({ name: 'p', kind: 'prometheus', endpoint: 'http://10.0.0.5' }))).status).toBe(403);
    expect(createDatasource).not.toHaveBeenCalled();
  });

  it('creates the row, stores the id credential, mirrors when default, returns 201', async () => {
    const { POST } = await import('./route');
    const resp = await POST(req({ name: 'prod-prom', kind: 'prometheus', endpoint: 'http://10.0.0.5:9090', authType: 'bearer', creds: { token: 't' } }));
    expect(resp.status).toBe(201);
    expect(await resp.json()).toEqual({ id: 7 });
    expect(setIntegrationCredentialById).toHaveBeenCalledWith(7, { endpoint: 'http://10.0.0.5:9090', authType: 'bearer', token: 't' });
    expect(mirrorDefaultCredential).toHaveBeenCalledWith('prometheus', { endpoint: 'http://10.0.0.5:9090', authType: 'bearer', token: 't' });
  });

  it('fires a best-effort connect-time introspect (after the 201) and never lets it fail create', async () => {
    invokeMcpLambdaTool.mockRejectedValue(new Error('connector down'));
    const { POST } = await import('./route');
    const resp = await POST(req({ name: 'prod-prom', kind: 'prometheus', endpoint: 'http://10.0.0.5:9090', authType: 'none' }));
    expect(resp.status).toBe(201); // create succeeds regardless of introspection
    await new Promise((r) => setImmediate(r)); // let the fire-and-forget microtask run
    expect(invokeMcpLambdaTool).toHaveBeenCalledWith(expect.objectContaining({ kind: 'prometheus', tool: 'prometheus_schema' }));
    // upsertSchema not reached because invoke rejected — and no unhandled rejection escaped (test would fail otherwise)
    expect(upsertSchema).not.toHaveBeenCalled();
  });

  it('warms the schema cache on a successful create', async () => {
    const { POST } = await import('./route');
    const resp = await POST(req({ name: 'prod-prom', kind: 'prometheus', endpoint: 'http://10.0.0.5:9090', authType: 'none' }));
    expect(resp.status).toBe(201);
    await new Promise((r) => setImmediate(r));
    expect(upsertSchema).toHaveBeenCalledWith('self', 7, 'prometheus', expect.objectContaining({ version: '2.48.0' }));
  });

  it('SSRF-blocks the endpoint (400, no create)', async () => {
    const { POST } = await import('./route');
    expect((await POST(req({ name: 'x', kind: 'prometheus', endpoint: 'http://169.254.169.254' }))).status).toBe(400);
    expect(createDatasource).not.toHaveBeenCalled();
  });

  it('maps duplicate name to 409', async () => {
    createDatasource.mockRejectedValue(new Error('duplicate datasource name'));
    const { POST } = await import('./route');
    expect((await POST(req({ name: 'dupe', kind: 'loki', endpoint: 'http://10.0.0.5' }))).status).toBe(409);
  });

  it('rejects unknown kind / missing name', async () => {
    const { POST } = await import('./route');
    expect((await POST(req({ name: 'x', kind: 'notion', endpoint: 'http://10.0.0.5' }))).status).toBe(400);
    expect((await POST(req({ kind: 'loki', endpoint: 'http://10.0.0.5' }))).status).toBe(400);
  });
});

describe('PATCH update', () => {
  it('404 when not found', async () => {
    getDatasource.mockResolvedValue(null);
    const { PATCH } = await import('./route');
    expect((await PATCH(req({ id: 99, name: 'x' }, 'PATCH'))).status).toBe(404);
  });

  it('updates the credential when a connection field changes, then updateDatasource', async () => {
    const { PATCH } = await import('./route');
    const resp = await PATCH(req({ id: 7, endpoint: 'http://10.0.0.9:9090', authType: 'none' }, 'PATCH'));
    expect(resp.status).toBe(200);
    expect(setIntegrationCredentialById).toHaveBeenCalledWith(7, { endpoint: 'http://10.0.0.9:9090', authType: 'none' });
    expect(updateDatasource).toHaveBeenCalled();
  });
});
