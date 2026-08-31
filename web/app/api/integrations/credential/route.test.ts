import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const isAdmin = vi.fn();
const setIntegrationCredential = vi.fn();
const setMcpPresetCredential = vi.fn();
const getConfiguredSlugs = vi.fn();
const getConfiguredMcpPresetSlugs = vi.fn();
const getConfiguredIds = vi.fn();

vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/integration-credentials', () => ({
  setIntegrationCredential: (...a: unknown[]) => setIntegrationCredential(...a),
  setMcpPresetCredential: (...a: unknown[]) => setMcpPresetCredential(...a),
  getConfiguredSlugs: (...a: unknown[]) => getConfiguredSlugs(...a),
  getConfiguredMcpPresetSlugs: (...a: unknown[]) => getConfiguredMcpPresetSlugs(...a),
  getConfiguredIds: (...a: unknown[]) => getConfiguredIds(...a),
}));

function req(body: unknown, method = 'PUT') {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json', cookie: 'awsops_token=t' } };
  if (method !== 'GET' && method !== 'HEAD') init.body = JSON.stringify(body);
  return new Request('http://x/api/integrations/credential', init);
}

beforeEach(() => {
  for (const m of [verifyUser, isAdmin, setIntegrationCredential, setMcpPresetCredential, getConfiguredSlugs, getConfiguredMcpPresetSlugs, getConfiguredIds]) m.mockReset();
  process.env.AURORA_ENDPOINT = 'aurora.example';
  verifyUser.mockResolvedValue({ sub: 'u', email: 'a@x' });
  isAdmin.mockResolvedValue(true);
  setIntegrationCredential.mockResolvedValue(undefined);
  setMcpPresetCredential.mockResolvedValue(undefined);
  getConfiguredSlugs.mockResolvedValue(['notion']);
  getConfiguredMcpPresetSlugs.mockResolvedValue([]);
  getConfiguredIds.mockResolvedValue([]);
});

describe('/api/integrations/credential gate', () => {
  it('401 unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { PUT } = await import('./route');
    expect((await PUT(req({ slug: 'notion', secret: { token: 'x' } }))).status).toBe(401);
  });
  it('403 non-admin', async () => {
    isAdmin.mockResolvedValue(false);
    const { PUT } = await import('./route');
    expect((await PUT(req({ slug: 'notion', secret: { token: 'x' } }))).status).toBe(403);
    expect(setIntegrationCredential).not.toHaveBeenCalled();
  });
});

describe('PUT', () => {
  it('413 on an oversized body (bounded before parse — OOM guard)', async () => {
    const { PUT } = await import('./route');
    const huge = { slug: 'notion', secret: { token: 'x'.repeat(70_000) } }; // > readJsonBounded default cap
    const resp = await PUT(req(huge));
    expect(resp.status).toBe(413);
    expect(setIntegrationCredential).not.toHaveBeenCalled();
  });
  it('stores the credential and never echoes the secret', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { PUT } = await import('./route');
    const resp = await PUT(req({ slug: 'notion', secret: { token: 'supersecret_TOKEN' } }));
    expect(resp.status).toBe(200);
    expect(setIntegrationCredential).toHaveBeenCalledWith('notion', { token: 'supersecret_TOKEN' });
    const text = await resp.text();
    expect(text).not.toContain('supersecret_TOKEN'); // value not echoed
    expect(text).not.toContain('secret');             // no secret field in response
    // never logged
    for (const spy of [logSpy, errSpy]) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain('supersecret_TOKEN');
      }
    }
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('400 on malformed body (no secret object)', async () => {
    const { PUT } = await import('./route');
    expect((await PUT(req({ slug: 'notion' }))).status).toBe(400);
    expect(setIntegrationCredential).not.toHaveBeenCalled();
  });

  it('400 when the lib rejects an unknown slug', async () => {
    setIntegrationCredential.mockRejectedValue(new Error('unknown integration slug: evil'));
    const { PUT } = await import('./route');
    expect((await PUT(req({ slug: 'evil', secret: { token: 'x' } }))).status).toBe(400);
  });

  it('official=true (ADR-017 MCP preset) stores via setMcpPresetCredential, not setIntegrationCredential', async () => {
    const { PUT } = await import('./route');
    const resp = await PUT(req({ slug: 'clickhouse', secret: { token: 'x' }, official: true }));
    expect(resp.status).toBe(200);
    expect(setMcpPresetCredential).toHaveBeenCalledWith('clickhouse', { token: 'x' });
    expect(setIntegrationCredential).not.toHaveBeenCalled();
  });

  it('official absent (legacy/Notion/datasource path) still stores via setIntegrationCredential', async () => {
    const { PUT } = await import('./route');
    const resp = await PUT(req({ slug: 'notion', secret: { token: 'x' } }));
    expect(resp.status).toBe(200);
    expect(setIntegrationCredential).toHaveBeenCalledWith('notion', { token: 'x' });
    expect(setMcpPresetCredential).not.toHaveBeenCalled();
  });
});

describe('GET', () => {
  it('returns configured slugs + instance ids, no values', async () => {
    getConfiguredSlugs.mockResolvedValue(['notion', 'datadog']);
    getConfiguredIds.mockResolvedValue(['11', '12']);
    const { GET } = await import('./route');
    const resp = await GET(req(undefined, 'GET'));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(new Set(body.configured)).toEqual(new Set(['notion', 'datadog']));
    expect(new Set(body.configuredIds)).toEqual(new Set(['11', '12']));
  });

  it('keeps plain-slug `configured` and namespaced `mcpConfigured` as DISTINCT sets (round-2 review MAJOR)', async () => {
    // clickhouse is configured via the OLD plain-slug path (a datasource save) only — its ADR-017
    // "mcp:clickhouse" credential (the one provision.py actually reads) is NOT set. datadog is the
    // opposite: only the namespaced credential exists. Merging these (the pre-fix behavior) would
    // wrongly report clickhouse as MCP-ready and could wrongly report datadog as not-a-real-slug's
    // legacy connection. They must stay separate so ConnectorsTab checks the right one per row.
    getConfiguredSlugs.mockResolvedValue(['notion', 'clickhouse']);
    getConfiguredMcpPresetSlugs.mockResolvedValue(['datadog']);
    getConfiguredIds.mockResolvedValue([]);
    const { GET } = await import('./route');
    const resp = await GET(req(undefined, 'GET'));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(new Set(body.configured)).toEqual(new Set(['notion', 'clickhouse']));
    expect(new Set(body.mcpConfigured)).toEqual(new Set(['datadog']));
  });

  it('`configured` strips stray "mcp:" / numeric-id keys that getConfiguredSlugs leaks through unfiltered', async () => {
    getConfiguredSlugs.mockResolvedValue(['notion', 'mcp:datadog', '11']);
    getConfiguredMcpPresetSlugs.mockResolvedValue(['datadog']);
    getConfiguredIds.mockResolvedValue(['11']);
    const { GET } = await import('./route');
    const resp = await GET(req(undefined, 'GET'));
    const body = await resp.json();
    expect(new Set(body.configured)).toEqual(new Set(['notion']));
    expect(new Set(body.mcpConfigured)).toEqual(new Set(['datadog']));
  });

  it('NARROW downgrade: Secrets Manager AccessDenied → 200 empty (not 500)', async () => {
    getConfiguredSlugs.mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    const { GET } = await import('./route');
    const resp = await GET(req(undefined, 'GET'));
    expect(resp.status).toBe(200);
    expect((await resp.json()).configured).toEqual([]);
  });

  it('a NON-Secrets-Manager error (e.g. PG) surfaces as 500 — not masked', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    getConfiguredSlugs.mockRejectedValue(Object.assign(new Error('connection refused'), { name: 'PgConnError' }));
    const { GET } = await import('./route');
    const resp = await GET(req(undefined, 'GET'));
    expect(resp.status).toBe(500);
    errSpy.mockRestore();
  });
});

describe('PUT endpoint SSRF (datasource slugs)', () => {
  it('rejects a metadata/loopback endpoint with 400 and no store', async () => {
    const { PUT } = await import('./route');
    const resp = await PUT(req({ slug: 'clickhouse', secret: { endpoint: 'http://169.254.169.254/', username: 'u' } }));
    expect(resp.status).toBe(400);
    expect(setIntegrationCredential).not.toHaveBeenCalled();
  });
  it('accepts a private (in-cluster) endpoint', async () => {
    const { PUT } = await import('./route');
    const resp = await PUT(req({ slug: 'clickhouse', secret: { endpoint: 'http://10.0.0.5:8123', username: 'u', password: 'p' } }));
    expect(resp.status).toBe(200);
    expect(setIntegrationCredential).toHaveBeenCalledWith('clickhouse', { endpoint: 'http://10.0.0.5:8123', username: 'u', password: 'p' });
  });
});
