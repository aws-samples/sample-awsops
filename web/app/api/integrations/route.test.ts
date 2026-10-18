import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const isAdmin = vi.fn();
const query = vi.fn();
const writeAudit = vi.fn();
const validateIntegration = vi.fn();
const assertEgressEndpointAllowed = vi.fn();
const upsertIntegration = vi.fn();
const listIntegrations = vi.fn();
const setIntegrationEnabled = vi.fn();
const getIntegrationById = vi.fn();
const attestAndEnableMcp = vi.fn();

vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/account', () => ({ currentAccountId: () => 'self' }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query }) }));
vi.mock('@/lib/catalog', () => ({ writeAudit: (...a: unknown[]) => writeAudit(...a) }));
vi.mock('@/lib/integration-validation', () => ({ validateIntegration: (...a: unknown[]) => validateIntegration(...a) }));
vi.mock('@/lib/ssrf-guard', () => ({ assertEgressEndpointAllowed: (...a: unknown[]) => assertEgressEndpointAllowed(...a) }));
vi.mock('@/lib/integrations', () => ({
  upsertIntegration: (...a: unknown[]) => upsertIntegration(...a),
  listIntegrations: (...a: unknown[]) => listIntegrations(...a),
  setIntegrationEnabled: (...a: unknown[]) => setIntegrationEnabled(...a),
  getIntegrationById: (...a: unknown[]) => getIntegrationById(...a),
  attestAndEnableMcp: (...a: unknown[]) => attestAndEnableMcp(...a),
}));

function req(body: unknown, method = 'POST') {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json', cookie: 'awsops_token=t' } };
  if (method !== 'GET' && method !== 'HEAD') init.body = JSON.stringify(body);
  return new Request('http://x/api/integrations', init);
}

beforeEach(() => {
  for (const m of [verifyUser, isAdmin, query, writeAudit, validateIntegration, assertEgressEndpointAllowed, upsertIntegration, listIntegrations, setIntegrationEnabled]) m.mockReset();
  process.env.AURORA_ENDPOINT = 'aurora.example';
  verifyUser.mockResolvedValue({ sub: 'u', email: 'a@x' });
  isAdmin.mockResolvedValue(true);
  validateIntegration.mockReturnValue({ ok: true, errors: [] });
  query.mockResolvedValue({ rows: [] });          // no agent_spaces opt-in row ⇒ allowPrivate false
  upsertIntegration.mockResolvedValue(9);
  getIntegrationById.mockReset().mockResolvedValue({ id: 3, tier: 'custom', kind: 'grafana', exposedTools: [] });
  attestAndEnableMcp.mockReset().mockResolvedValue(undefined);
});

describe('/api/integrations gate', () => {
  it('does not enable an existing unsupported OAuth connection', async () => {
    listIntegrations.mockResolvedValue([{ id: 9, direction: 'egress', transport: 'oauth_3lo' }]);
    const { PUT } = await import('./route');
    expect((await PUT(req({ op: 'enable', id: 9 }, 'PUT'))).status).toBe(400);
    expect(setIntegrationEnabled).not.toHaveBeenCalled();
  });
  it('401 unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { POST } = await import('./route');
    expect((await POST(req({}))).status).toBe(401);
  });
  it('403 non-admin', async () => {
    isAdmin.mockResolvedValue(false);
    const { POST } = await import('./route');
    expect((await POST(req({}))).status).toBe(403);
  });
  it('400 when Aurora not configured', async () => {
    delete process.env.AURORA_ENDPOINT;
    const { POST } = await import('./route');
    expect((await POST(req({}))).status).toBe(400);
  });
});

describe('/api/integrations POST', () => {
  it('egress: SSRF-guards with the account allowPrivate then upserts (200)', async () => {
    query.mockResolvedValue({ rows: [{ allow_private_datasource: false }] });
    const { POST } = await import('./route');
    const res = await POST(req({ name: 'grafana-ro', kind: 'grafana', direction: 'egress', endpoint: 'https://g.example', transport: 'api_key' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, id: 9 });
    expect(assertEgressEndpointAllowed).toHaveBeenCalledWith('https://g.example', { allowPrivate: false });
    expect(writeAudit).toHaveBeenCalled();
  });
  it('egress: 400 when the SSRF guard rejects a private endpoint', async () => {
    assertEgressEndpointAllowed.mockImplementation(() => { throw new Error('endpoint host 10.0.0.5 is a private/metadata address'); });
    const { POST } = await import('./route');
    const res = await POST(req({ name: 'priv', kind: 'grafana', direction: 'egress', endpoint: 'https://10.0.0.5', transport: 'api_key' }));
    expect(res.status).toBe(400);
    expect(upsertIntegration).not.toHaveBeenCalled();
  });
  it('egress: passes allowPrivate=true when the account opted in', async () => {
    query.mockResolvedValue({ rows: [{ allow_private_datasource: true }] });
    const { POST } = await import('./route');
    await POST(req({ name: 'priv-ok', kind: 'grafana', direction: 'egress', endpoint: 'https://10.0.0.5', transport: 'api_key' }));
    expect(assertEgressEndpointAllowed).toHaveBeenCalledWith('https://10.0.0.5', { allowPrivate: true });
  });
  it('ingress: generates + returns a receive_path (no SSRF/endpoint check)', async () => {
    const { POST } = await import('./route');
    const res = await POST(req({ name: 'pd-in', kind: 'pagerduty', direction: 'ingress', authMode: 'vendor_sig', triggerTarget: 'incident' }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.receivePath).toMatch(/^\/api\/integrations\/ingress\/[0-9a-f]{32}$/);
    expect(assertEgressEndpointAllowed).not.toHaveBeenCalled();
    expect(upsertIntegration).toHaveBeenCalledWith(expect.objectContaining({ receivePath: body.receivePath, direction: 'ingress' }));
  });
  it('400 on invalid integration', async () => {
    validateIntegration.mockReturnValue({ ok: false, errors: ['bad'] });
    const { POST } = await import('./route');
    expect((await POST(req({ name: 'x' }))).status).toBe(400);
  });
  it('409 on a built-in name collision', async () => {
    upsertIntegration.mockRejectedValue(new Error('name conflicts with a built-in integration'));
    const { POST } = await import('./route');
    expect((await POST(req({ name: 'slack', kind: 'slack', direction: 'egress', endpoint: 'https://s', transport: 'api_key' }))).status).toBe(409);
  });
});

describe('/api/integrations GET + PUT', () => {
  it.each([true, [3], '3', null])('rejects coercible non-number toggle ID %j before catalog access', async id => {
    const { PUT } = await import('./route');
    expect((await PUT(req({ op: 'enable', id }, 'PUT'))).status).toBe(400);
    expect(getIntegrationById).not.toHaveBeenCalled();
    expect(setIntegrationEnabled).not.toHaveBeenCalled();
  });
  it('re-enables a native datasource without routing it through MCP attestation', async () => {
    getIntegrationById.mockResolvedValue({ id: 3, tier: 'custom', kind: 'prometheus',
      direction: 'egress', capability: 'read', endpoint: 'https://example.com/query',
      transport: null, credentialsRef: null, exposedTools: [] });
    const { PUT } = await import('./route');
    expect((await PUT(req({ op: 'enable', id: 3 }, 'PUT'))).status).toBe(200);
    expect(setIntegrationEnabled).toHaveBeenCalledWith(3, true);
    expect(attestAndEnableMcp).not.toHaveBeenCalled();
  });
  it('GET lists integrations', async () => {
    listIntegrations.mockResolvedValue([{ id: 1, name: 'g' }]);
    const { GET } = await import('./route');
    const res = await GET(req({}, 'GET'));
    expect((await res.json()).integrations).toHaveLength(1);
  });
  it('PUT enable toggles (custom-only) + audits', async () => {
    const { PUT } = await import('./route');
    const res = await PUT(req({ op: 'enable', id: 3 }, 'PUT'));
    expect(res.status).toBe(200);
    expect(setIntegrationEnabled).toHaveBeenCalledWith(3, true);
  });
  it('PUT passes only the authenticated immutable identity and explicit confirmation to MCP enforcement', async () => {
    getIntegrationById.mockResolvedValue({ id: 3, tier: 'custom', kind: 'custom_mcp' });
    const { PUT } = await import('./route');
    const snapshot = { endpoint: 'https://example.com/mcp', exposedTools: ['query'] };
    expect((await PUT(req({ op: 'enable', id: 3, actorSub: 'spoof', attestReadOnly: true,
      attestRegistration: snapshot }, 'PUT'))).status).toBe(200);
    expect(attestAndEnableMcp).toHaveBeenCalledWith(3, 'u', true, snapshot);
    expect(setIntegrationEnabled).not.toHaveBeenCalled();
  });
  it('PUT does not treat a vendor label as a preset exemption', async () => {
    getIntegrationById.mockResolvedValue({ id: 3, tier: 'custom', kind: 'grafana', direction: 'egress', exposedTools: ['query'] });
    attestAndEnableMcp.mockRejectedValue(new Error('attestation required'));
    const { PUT } = await import('./route');
    expect((await PUT(req({ op: 'enable', id: 3 }, 'PUT'))).status).toBe(409);
    expect(attestAndEnableMcp).toHaveBeenCalledWith(3, 'u', false, undefined);
    expect(setIntegrationEnabled).not.toHaveBeenCalled();
    expect(writeAudit).toHaveBeenCalledWith({ actor: 'u', action: 'enable_rejected',
      objectType: 'integration', objectId: '3' });
  });
  it('PUT permits immediate disablement without attestation', async () => {
    getIntegrationById.mockResolvedValue({ id: 3, tier: 'custom', kind: 'custom_mcp' });
    const { PUT } = await import('./route');
    expect((await PUT(req({ op: 'disable', id: 3 }, 'PUT'))).status).toBe(200);
    expect(setIntegrationEnabled).toHaveBeenCalledWith(3, false);
    expect(attestAndEnableMcp).not.toHaveBeenCalled();
  });
  it.each([0, -1, 'other', 1.5])('PUT rejects invalid identifiers: %s', async id => {
    const { PUT } = await import('./route');
    expect((await PUT(req({ op: 'enable', id }, 'PUT'))).status).toBe(400);
    expect(getIntegrationById).not.toHaveBeenCalled();
  });
});
