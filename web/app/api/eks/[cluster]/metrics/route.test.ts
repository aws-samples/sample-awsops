import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyUser, allowed, resolve, cp, ci, nodes } = vi.hoisted(() => ({
  verifyUser: vi.fn(), allowed: vi.fn(), resolve: vi.fn(), cp: vi.fn(), ci: vi.fn(), nodes: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ verifyUser }));
vi.mock('@/lib/eks-registry', () => ({ isAllowed: allowed }));
vi.mock('@/lib/metrics', () => ({ eksControlPlane: cp, eksClusterCI: ci, eksNodesCI: nodes }));
vi.mock('@/lib/eks-context', () => ({
  resolveEksCluster: resolve,
  EksScopeError: class extends Error { constructor(message: string, public status: number) { super(message); } },
}));
const ARN = 'arn:aws:eks:us-west-2:222222222222:cluster/shared';
const context = { id: ARN, name: 'shared', accountId: '222222222222', region: 'us-west-2' };

beforeEach(() => {
  vi.clearAllMocks();
  verifyUser.mockResolvedValue({ sub: 'u' });
  resolve.mockReset().mockResolvedValue(context);
  allowed.mockResolvedValue(true);
  cp.mockResolvedValue({}); ci.mockResolvedValue({}); nodes.mockResolvedValue({});
});

describe('EKS detail metrics scope', () => {
  it.each(['shared', ARN])('resolves %s before checking registration and querying CloudWatch', async cluster => {
    const { GET } = await import('./route');
    const search = 'account=222222222222&region=us-west-2&range=21600';
    const res = await GET(new Request(`http://local/?${search}`), { params: { cluster } });
    expect(res.status).toBe(200);
    expect(resolve).toHaveBeenCalledWith(cluster, new URLSearchParams(search));
    expect(allowed).toHaveBeenCalledWith(ARN);
    expect(cp).toHaveBeenCalledWith('shared', 'us-west-2', 21600, '222222222222');
    expect(ci).toHaveBeenCalledWith('shared', 'us-west-2', 21600, '222222222222');
    expect(nodes).toHaveBeenCalledWith('shared', 'us-west-2', 21600, 100, '222222222222');
  });

  it('keeps the host default region and validates range presets', async () => {
    resolve.mockResolvedValue({ id: 'shared', name: 'shared', accountId: 'self', region: 'ap-northeast-2' });
    const { GET } = await import('./route');
    const res = await GET(new Request('http://local/?range=invalid'), { params: { cluster: 'shared' } });
    expect((await res.json()).range).toBe(3600);
    expect(cp).toHaveBeenCalledWith('shared', 'ap-northeast-2', 3600, 'self');
  });

  it.each([400, 403, 503])('returns scope error %s without any metrics call', async status => {
    const { EksScopeError } = await import('@/lib/eks-context');
    resolve.mockRejectedValue(new EksScopeError('scope rejected', status));
    const { GET } = await import('./route');
    expect((await GET(new Request('http://local/'), { params: { cluster: ARN } })).status).toBe(status);
    expect(cp).not.toHaveBeenCalled(); expect(ci).not.toHaveBeenCalled(); expect(nodes).not.toHaveBeenCalled();
  });

  it('cannot borrow the registration of a same-name host cluster', async () => {
    allowed.mockImplementation(async id => id === 'shared');
    const { GET } = await import('./route');
    expect((await GET(new Request('http://local/?account=222222222222'), { params: { cluster: 'shared' } })).status).toBe(404);
    expect(cp).not.toHaveBeenCalled();
  });
});
