import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const isAdmin = vi.fn();
const listDatasources = vi.fn();
const getConfiguredIds = vi.fn();
const deleteDatasource = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/datasources', () => ({
  listDatasources: (...a: unknown[]) => listDatasources(...a),
  deleteDatasource: (...a: unknown[]) => deleteDatasource(...a),
}));
vi.mock('@/lib/integration-credentials', () => ({ getConfiguredIds: (...a: unknown[]) => getConfiguredIds(...a) }));

const get = () => new Request('http://x/api/datasources', { headers: { cookie: 'awsops_token=t' } });
const del = () => new Request('http://x/api/datasources/5', { method: 'DELETE', headers: { cookie: 'awsops_token=t' } });

beforeEach(() => {
  for (const m of [verifyUser, isAdmin, listDatasources, getConfiguredIds, deleteDatasource]) m.mockReset();
  verifyUser.mockResolvedValue({ sub: 'u' });
  isAdmin.mockResolvedValue(true);
  listDatasources.mockResolvedValue([
    { id: 1, name: 'prod-prom', kind: 'prometheus', endpoint: 'http://p', authType: 'none', isDefault: true, enabled: true },
    { id: 2, name: 'stg-prom', kind: 'prometheus', endpoint: 'http://s', authType: 'basic', isDefault: false, enabled: true },
  ]);
  getConfiguredIds.mockResolvedValue(['2']);
  deleteDatasource.mockResolvedValue(undefined);
});

describe('GET /api/datasources (list instances)', () => {
  it('401 unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(get())).status).toBe(401);
  });
  it('returns instances with isDefault + connected, no credentials (read = any authed user)', async () => {
    const { GET } = await import('./route');
    const resp = await GET(get());
    expect(resp.status).toBe(200);
    const { datasources } = await resp.json();
    expect(datasources).toHaveLength(2);
    // admin (default mock): the registered URL is included (v1 parity for managers)
    expect(datasources[0]).toEqual({ id: 1, name: 'prod-prom', kind: 'prometheus', endpoint: 'http://p', authType: 'none', isDefault: true, connected: true });
    expect(datasources[1].connected).toBe(true); // id '2' has a credential
  });

  it('omits endpoint (connection detail) for non-admin readers', async () => {
    isAdmin.mockResolvedValue(false);
    const { GET } = await import('./route');
    const resp = await GET(get());
    const { datasources } = await resp.json();
    expect(JSON.stringify(datasources)).not.toContain('endpoint'); // never leak connection detail to read-only users
  });
  it('degrades to [] (200) when the data layer throws', async () => {
    listDatasources.mockRejectedValue(new Error('aurora down'));
    const { GET } = await import('./route');
    const resp = await GET(get());
    expect(resp.status).toBe(200);
    expect((await resp.json()).datasources).toEqual([]);
  });
});

describe('DELETE /api/datasources/[id]', () => {
  it('admin-only', async () => {
    isAdmin.mockResolvedValue(false);
    const { DELETE } = await import('./[id]/route');
    expect((await DELETE(del(), { params: { id: '5' } })).status).toBe(403);
    expect(deleteDatasource).not.toHaveBeenCalled();
  });
  it('deletes and returns ok', async () => {
    const { DELETE } = await import('./[id]/route');
    const resp = await DELETE(del(), { params: { id: '5' } });
    expect(resp.status).toBe(200);
    expect(deleteDatasource).toHaveBeenCalledWith(5);
  });
});
