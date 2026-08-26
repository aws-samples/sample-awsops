import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const listClusters = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/aws', () => ({ listClusters: (...a: unknown[]) => listClusters(...a) }));
const getAllowedClusters = vi.fn();
const isEnvCluster = vi.fn();
const hasAccessEntry = vi.fn();
const isAdmin = vi.fn();
vi.mock('@/lib/eks-registry', () => ({
  getAllowedClusters: (...a: unknown[]) => getAllowedClusters(...a),
  isEnvCluster: (...a: unknown[]) => isEnvCluster(...a),
  getAuthModes: async () => new Map(),
}));
const onboardingGuide = vi.fn();
vi.mock('@/lib/eks-access', () => ({
  hasAccessEntry: (...a: unknown[]) => hasAccessEntry(...a),
  onboardingGuide: (...a: unknown[]) => onboardingGuide(...a),
}));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
const req = (cookie = 'awsops_token=t') => new Request('http://x/api/eks', { headers: { cookie } });
beforeEach(() => {
  verifyUser.mockReset(); listClusters.mockReset();
  getAllowedClusters.mockReset(); isEnvCluster.mockReset(); hasAccessEntry.mockReset(); isAdmin.mockReset();
  getAllowedClusters.mockResolvedValue(new Set());
  isEnvCluster.mockReturnValue(false);
  hasAccessEntry.mockResolvedValue(false);
  isAdmin.mockResolvedValue(false);
  onboardingGuide.mockReset();
  onboardingGuide.mockResolvedValue({ commands: ['c1', 'c2'], note: 'n' });
});

describe('GET /api/eks', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(401);
  });
  it('200 with clusters', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    listClusters.mockResolvedValue([{ name: 'c1', status: 'ACTIVE', version: '1.30', endpoint: 'e', createdAt: '' }]);
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).clusters[0].name).toBe('c1');
  });
  it('500 on SDK error', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    listClusters.mockRejectedValue(new Error('denied'));
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(500);
  });
});
