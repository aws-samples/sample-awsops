import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const isAdmin = vi.fn();
const listClusters = vi.fn();
const getAllowedClusters = vi.fn();
const isAllowed = vi.fn();
const isEnvCluster = vi.fn();
const registerCluster = vi.fn();
const unregisterCluster = vi.fn();
const hasAccessEntry = vi.fn();
const onboardingGuide = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/aws', () => ({ listClusters: (...a: unknown[]) => listClusters(...a) }));
vi.mock('@/lib/eks-registry', () => ({
  getAllowedClusters: (...a: unknown[]) => getAllowedClusters(...a),
  isAllowed: (...a: unknown[]) => isAllowed(...a),
  isEnvCluster: (...a: unknown[]) => isEnvCluster(...a),
  registerCluster: (...a: unknown[]) => registerCluster(...a),
  unregisterCluster: (...a: unknown[]) => unregisterCluster(...a),
  setClusterAuth: async () => true,
  getAuthModes: async () => new Map(),
}));
vi.mock('@/lib/eks-access', () => ({
  hasAccessEntry: (...a: unknown[]) => hasAccessEntry(...a),
  onboardingGuide: (...a: unknown[]) => onboardingGuide(...a),
}));

const req = (method = 'POST') => new Request('http://x/api/eks/c1/register', { method, headers: { cookie: 'awsops_token=t' } });
const P = { params: { cluster: 'c1' } };

describe('GET /api/eks access synthesis', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it('env-allowed=connected (no recheck), runtime-allowed=re-verified, entry holders=entry-only, rest=no-entry', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    isAdmin.mockResolvedValue(true);
    listClusters.mockResolvedValue([{ name: 'env-a' }, { name: 'rt-ok' }, { name: 'rt-revoked' }, { name: 'b' }, { name: 'c' }]);
    getAllowedClusters.mockResolvedValue(new Set(['env-a', 'rt-ok', 'rt-revoked']));
    isEnvCluster.mockImplementation((n: string) => n === 'env-a');
    hasAccessEntry.mockImplementation(async (n: string) => (n === 'rt-ok' || n === 'b' ? true : false));
    onboardingGuide.mockResolvedValue({ commands: ['c1', 'c2'], note: 'n' });
    const { GET } = await import('./route');
    const body = await (await GET(req('GET'))).json();
    const by = Object.fromEntries(body.clusters.map((c: { name: string; access: string }) => [c.name, c.access]));
    expect(by).toEqual({ 'env-a': 'connected', 'rt-ok': 'connected', 'rt-revoked': 'no-entry', b: 'entry-only', c: 'no-entry' });
    expect(hasAccessEntry).not.toHaveBeenCalledWith('env-a');
    expect(body.admin).toBe(true);
    const rt = body.clusters.find((c: { name: string }) => c.name === 'rt-ok');
    expect(rt.runtime).toBe(true);
    // v1 parity: not-connected rows always carry the onboarding script
    const cold = body.clusters.find((c: { name: string }) => c.name === 'c');
    expect(cold.guide.commands).toHaveLength(2);
    const conn = body.clusters.find((c: { name: string }) => c.name === 'env-a');
    expect(conn.guide).toBeUndefined();
  });
});

describe('POST /api/eks/[cluster]/register', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('401 unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { POST } = await import('./[cluster]/register/route');
    expect((await POST(req(), P)).status).toBe(401);
  });

  it('403 non-admin', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    isAdmin.mockResolvedValue(false);
    const { POST } = await import('./[cluster]/register/route');
    expect((await POST(req(), P)).status).toBe(403);
  });

  it('404 for a cluster that does not exist', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    isAdmin.mockResolvedValue(true);
    listClusters.mockResolvedValue([]);
    const { POST } = await import('./[cluster]/register/route');
    expect((await POST(req(), P)).status).toBe(404);
  });

  it('400 for an invalid cluster name', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    isAdmin.mockResolvedValue(true);
    const { POST } = await import('./[cluster]/register/route');
    expect((await POST(req(), { params: { cluster: 'bad/../name' } })).status).toBe(400);
  });

  it('200 registers when the access entry exists', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    isAdmin.mockResolvedValue(true);
    listClusters.mockResolvedValue([{ name: 'c1' }]);
    hasAccessEntry.mockResolvedValue(true);
    registerCluster.mockResolvedValue(true);
    const { POST } = await import('./[cluster]/register/route');
    const res = await POST(req(), P);
    expect(res.status).toBe(200);
    expect(registerCluster).toHaveBeenCalledWith('c1', 'u');
  });

  it('409 + guide when no access entry', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    isAdmin.mockResolvedValue(true);
    listClusters.mockResolvedValue([{ name: 'c1' }]);
    hasAccessEntry.mockResolvedValue(false);
    onboardingGuide.mockResolvedValue({ commands: ['cmd1', 'cmd2'], note: 'n' });
    const { POST } = await import('./[cluster]/register/route');
    const res = await POST(req(), P);
    expect(res.status).toBe(409);
    expect((await res.json()).guide.commands).toHaveLength(2);
  });

  it('env cluster: 200 managedBy terraform when the entry exists, NO db row (PR #36 r3)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    isAdmin.mockResolvedValue(true);
    listClusters.mockResolvedValue([{ name: 'c1' }]);
    isEnvCluster.mockReturnValue(true);
    hasAccessEntry.mockResolvedValue(true);
    const { POST } = await import('./[cluster]/register/route');
    const res = await POST(req(), P);
    expect(res.status).toBe(200);
    expect((await res.json()).managedBy).toBe('terraform');
    expect(registerCluster).not.toHaveBeenCalled();
  });

  it('env cluster WITHOUT an entry yet (tfvars added, apply pending) gets 409+guide, not a hollow 200 (PR #36 r3)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    isAdmin.mockResolvedValue(true);
    listClusters.mockResolvedValue([{ name: 'c1' }]);
    isEnvCluster.mockReturnValue(true);
    hasAccessEntry.mockResolvedValue(false);
    onboardingGuide.mockResolvedValue({ commands: ['cmd1'], note: 'n' });
    const { POST } = await import('./[cluster]/register/route');
    expect((await POST(req(), P)).status).toBe(409);
  });

  it('503 when the registry has no DB', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    isAdmin.mockResolvedValue(true);
    listClusters.mockResolvedValue([{ name: 'c1' }]);
    isEnvCluster.mockReturnValue(false); // clearAllMocks keeps implementations — the env tests above set true
    hasAccessEntry.mockResolvedValue(true);
    registerCluster.mockResolvedValue(false);
    const { POST } = await import('./[cluster]/register/route');
    expect((await POST(req(), P)).status).toBe(503);
  });

  it('DELETE 400 for an invalid cluster name (panel r5: parity with POST)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    isAdmin.mockResolvedValue(true);
    const { DELETE } = await import('./[cluster]/register/route');
    expect((await DELETE(req('DELETE'), { params: { cluster: 'bad/../name' } })).status).toBe(400);
  });

  it('DELETE 400 for a Terraform(env) cluster', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    isAdmin.mockResolvedValue(true);
    isEnvCluster.mockReturnValue(true);
    const { DELETE } = await import('./[cluster]/register/route');
    expect((await DELETE(req('DELETE'), P)).status).toBe(400);
  });

  it('DELETE 200 removes a runtime registration', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    isAdmin.mockResolvedValue(true);
    isEnvCluster.mockReturnValue(false);
    unregisterCluster.mockResolvedValue('deleted');
    const { DELETE } = await import('./[cluster]/register/route');
    expect((await DELETE(req('DELETE'), P)).status).toBe(200);
  });

  it('DELETE 404 when not registered vs 503 when storage is down (PR #36)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    isAdmin.mockResolvedValue(true);
    isEnvCluster.mockReturnValue(false);
    const { DELETE } = await import('./[cluster]/register/route');
    unregisterCluster.mockResolvedValue('not-found');
    expect((await DELETE(req('DELETE'), P)).status).toBe(404);
    unregisterCluster.mockResolvedValue('unavailable');
    expect((await DELETE(req('DELETE'), P)).status).toBe(503);
  });
});
