import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyUser, allowed, resolve, transfer } = vi.hoisted(() => ({
  verifyUser: vi.fn(), allowed: vi.fn(), resolve: vi.fn(), transfer: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ verifyUser }));
vi.mock('@/lib/eks-registry', () => ({ isAllowed: allowed }));
vi.mock('@/lib/nfm', () => ({ nfmPodTransfer: transfer }));
vi.mock('@/lib/eks-context', () => ({
  resolveEksCluster: resolve,
  EksScopeError: class extends Error { constructor(message: string, public status: number) { super(message); } },
}));
const ARN = 'arn:aws:eks:us-west-2:222222222222:cluster/shared';

beforeEach(() => {
  vi.stubEnv('AWS_REGION', 'ap-northeast-2');
  vi.clearAllMocks();
  verifyUser.mockResolvedValue({ sub: 'u' }); allowed.mockResolvedValue(true);
  resolve.mockReset().mockResolvedValue({ id: ARN, name: 'shared', accountId: '222222222222', region: 'us-west-2' });
  transfer.mockResolvedValue({ available: true });
});
afterEach(() => vi.unstubAllEnvs());

describe('host-only pod transfer', () => {
  it.each([
    ['222222222222', 'ap-northeast-2'],
    ['222222222222', 'us-west-2'],
    ['self', 'us-west-2'],
  ])('does not query host NFM for account=%s region=%s', async (accountId, region) => {
    resolve.mockResolvedValue({ id: ARN, name: 'shared', accountId, region });
    const { GET } = await import('./route');
    const res = await GET(new Request(`http://local/?account=${accountId}&region=${region}&range=900`), { params: { cluster: 'shared' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ available: false, rangeSec: 900, message: expect.stringMatching(/host account.*default region/i) });
    expect(allowed).toHaveBeenCalledWith(ARN);
    expect(transfer).not.toHaveBeenCalled();
  });

  it('queries the raw host name with an allowed range', async () => {
    resolve.mockResolvedValue({ id: 'shared', name: 'shared', accountId: 'self', region: 'ap-northeast-2' });
    const { GET } = await import('./route');
    expect((await GET(new Request('http://local/?range=86400'), { params: { cluster: 'shared' } })).status).toBe(200);
    expect(transfer).toHaveBeenCalledWith('shared', 3600);
  });

  it('does not use a same-name host registration for a member', async () => {
    allowed.mockImplementation(async id => id === 'shared');
    const { GET } = await import('./route');
    expect((await GET(new Request('http://local/?account=222222222222'), { params: { cluster: 'shared' } })).status).toBe(404);
    expect(transfer).not.toHaveBeenCalled();
  });
});
