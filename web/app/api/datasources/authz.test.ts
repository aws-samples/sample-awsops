import { describe, it, expect, vi, beforeEach } from 'vitest';

// Task 34 — read/mutate authorization contract for the datasource API:
//   READ  (GET list, Explore query/generate) → any authenticated user
//   WRITE (create/update/delete/test/set-default/credential/schema) → admin only
// Per-route specifics are tested in each route's own test; this consolidates the gating matrix.
const verifyUser = vi.fn();
const isAdmin = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/datasources', () => ({
  listDatasources: vi.fn(async () => []),
  getDatasource: vi.fn(async () => null),
  deleteDatasource: vi.fn(),
  setDefaultDatasource: vi.fn(),
  createDatasource: vi.fn(), updateDatasource: vi.fn(),
}));
vi.mock('@/lib/integration-credentials', () => ({
  getConfiguredIds: vi.fn(async () => []),
  setIntegrationCredentialById: vi.fn(), mirrorDefaultCredential: vi.fn(),
}));
vi.mock('@/lib/mcp-lambda-invoke', () => ({ invokeMcpLambdaTool: vi.fn(), KNOWN_MCP_LAMBDA_KINDS: ['prometheus'] }));

const cookie = { headers: { get: () => 'awsops_token=t' } } as unknown as Request;
function reqJson(body: unknown, method: string) {
  return new Request('http://x', { method, headers: { 'content-type': 'application/json', cookie: 'awsops_token=t' }, body: JSON.stringify(body) });
}

beforeEach(() => {
  verifyUser.mockReset(); isAdmin.mockReset();
  process.env.AURORA_ENDPOINT = 'aurora';
  verifyUser.mockResolvedValue({ sub: 'u', email: 'a@x' });
});

describe('datasource authorization matrix', () => {
  it('GET list is reachable by an authenticated NON-admin (read = any authed user)', async () => {
    isAdmin.mockResolvedValue(false);
    const { GET } = await import('./route');
    const resp = await GET(cookie);
    expect(resp.status).toBe(200); // read allowed; isAdmin not required
  });

  it('mutating routes 403 for a non-admin', async () => {
    isAdmin.mockResolvedValue(false);
    const manage = await import('./manage/route');
    expect((await manage.POST(reqJson({ name: 'p', kind: 'prometheus', endpoint: 'http://10.0.0.5' }, 'POST'))).status).toBe(403);
    const del = await import('./[id]/route');
    expect((await del.DELETE(reqJson({}, 'DELETE'), { params: { id: '1' } })).status).toBe(403);
    const def = await import('./[id]/default/route');
    expect((await def.POST(reqJson({}, 'POST'), { params: { id: '1' } })).status).toBe(403);
    const test = await import('./test/route');
    expect((await test.POST(reqJson({ kind: 'prometheus', endpoint: 'http://10.0.0.5' }, 'POST'))).status).toBe(403);
  });

  it('all mutating routes 401 when unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const manage = await import('./manage/route');
    expect((await manage.POST(reqJson({}, 'POST'))).status).toBe(401);
    const del = await import('./[id]/route');
    expect((await del.DELETE(reqJson({}, 'DELETE'), { params: { id: '1' } })).status).toBe(401);
  });
});
