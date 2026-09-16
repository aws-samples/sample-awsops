import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const listClusters = vi.fn();
const listAccounts = vi.fn();
const listAccountRegions = vi.fn();
vi.mock('@/lib/accounts', () => ({ listAccounts: (...a: unknown[]) => listAccounts(...a) }));
vi.mock('@/lib/account-regions', () => ({
  listAccountRegions: (...a: unknown[]) => listAccountRegions(...a),
  listScanScope: async () => [{ accountId: '222222222222', regions: ['*'] }],
}));
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/aws', () => ({ listClusterInventory: async (...a: unknown[]) =>
  ({ clusters: await listClusters(...a), region: 'ap-northeast-2', truncated: false }) }));
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
  vi.stubEnv('HOST_ACCOUNT_ID', '111111111111');
  vi.stubEnv('AWS_REGION', 'ap-northeast-2');
  listAccounts.mockReset().mockResolvedValue([
    { accountId: '111111111111', isHost: true, enabled: true, region: 'ap-northeast-2' },
    { accountId: '222222222222', isHost: false, enabled: true, region: 'ap-northeast-2' },
  ]);
  listAccountRegions.mockReset().mockResolvedValue([]);
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
  it('reports the enumerated region even when no cluster exists', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' }); listClusters.mockResolvedValue([]);
    const { GET } = await import('./route');
    expect(await (await GET(req())).json()).toMatchObject({ clusters: [], region: 'ap-northeast-2', truncated: false });
  });
  it('reports upstream failure rather than successful empty inventory', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    listClusters.mockRejectedValue(new Error('denied'));
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(502);
  });
  it('queries every selected account and preserves same-name cluster identities', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    listClusters.mockResolvedValue([{ name: 'same', status: 'ACTIVE' }]);
    const { GET } = await import('./route');
    const response = await GET(new Request('http://x/api/eks?accounts=__all__&regions=ap-northeast-2'));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(listClusters).toHaveBeenCalledWith('self', 'ap-northeast-2');
    expect(listClusters).toHaveBeenCalledWith('222222222222', 'ap-northeast-2');
    expect(body.clusters.map((c: { id: string }) => c.id)).toEqual([
      'same', 'arn:aws:eks:ap-northeast-2:222222222222:cluster/same',
    ]);
    expect(hasAccessEntry).toHaveBeenCalledWith('arn:aws:eks:ap-northeast-2:222222222222:cluster/same');
  });
  it('does not treat a host registration as access to a member with the same name', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    getAllowedClusters.mockResolvedValue(new Set(['same']));
    isEnvCluster.mockImplementation((id: string) => id === 'same');
    listClusters.mockResolvedValue([{ name: 'same', status: 'ACTIVE' }]);
    const { GET } = await import('./route');
    const body = await (await GET(new Request('http://x/api/eks?account=222222222222'))).json();
    expect(body.clusters[0]).toMatchObject({
      id: 'arn:aws:eks:ap-northeast-2:222222222222:cluster/same', access: 'no-entry', runtime: false,
    });
  });
  it('keeps partial results with an explicit failed account instead of silently substituting host', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    listClusters.mockImplementation(async (id: string) => {
      if (id === '222222222222') throw new Error('AssumeRole denied');
      return [{ name: 'host' }];
    });
    const { GET } = await import('./route');
    const response = await GET(new Request('http://x/api/eks?accounts=__all__'));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.clusters).toHaveLength(1);
    expect(body.errors).toEqual([expect.objectContaining({ accountId: '222222222222', message: 'EKS inventory query failed' })]);
  });
  it.each([
    new Error('arn:aws:iam::222222222222:role/private ExternalId=private-id sessionToken=private-token'),
    { status: 403, message: 'ExternalId=private-id sessionToken=private-token' },
    'sessionToken=private-token',
  ])('does not expose unexpected inventory failures: %#', async error => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    listClusters.mockRejectedValue(error);
    const { GET } = await import('./route');
    const response = await GET(req());
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.message).toBe('EKS inventory query failed');
    expect(body.errors[0].message).toBe('EKS inventory query failed');
    expect(JSON.stringify(body)).not.toMatch(/private|ExternalId|sessionToken/);
  });
  it('sanitizes unexpected registry failures before discovery', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    getAllowedClusters.mockRejectedValue(new Error('password=private-token'));
    const { GET } = await import('./route');
    const response = await GET(req());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ status: 'error', message: 'EKS inventory is unavailable' });
    expect(listClusters).not.toHaveBeenCalled();
  });
  it('preserves the trusted disabled-account reason and status', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    const { GET } = await import('./route');
    const response = await GET(new Request('http://x/api/eks?accounts=333333333333'));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ status: 'error', message: 'EKS account is not registered or is disabled' });
    expect(listClusters).not.toHaveBeenCalled();
  });
  it('returns useful wildcard results with incomplete-discovery metadata without marking successful calls failed', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    getAllowedClusters.mockResolvedValue(new Set(['arn:aws:eks:us-west-2:222222222222:cluster/member']));
    listClusters.mockResolvedValue([{ name: 'member', status: 'ACTIVE' }]);
    const { GET } = await import('./route');
    const response = await GET(new Request('http://x/api/eks?accounts=222222222222&regions=__all__'));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.clusters).not.toHaveLength(0);
    expect(body.status).toBeUndefined();
    expect(body.errors).toEqual([expect.objectContaining({ accountId: '222222222222', region: '__all__' })]);
    expect(listClusters).toHaveBeenCalledWith('222222222222', 'us-west-2');
  });
});
