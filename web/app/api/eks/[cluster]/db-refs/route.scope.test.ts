import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolve, allowed, listDbRefs, resolveDbHosts } = vi.hoisted(() => ({
  resolve: vi.fn(), allowed: vi.fn(), listDbRefs: vi.fn(), resolveDbHosts: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ verifyUser: async () => ({ sub: 'u' }) }));
vi.mock('@/lib/eks-registry', () => ({ isAllowed: allowed }));
vi.mock('@/lib/eks-db-refs', () => ({ listDbRefs }));
vi.mock('@/lib/db-ref-resolve', () => ({ resolveDbHosts }));
vi.mock('@/lib/eks-context', () => ({
  resolveEksCluster: resolve,
  EksScopeError: class extends Error { constructor(message: string, public status: number) { super(message); } },
}));
const ARN = 'arn:aws:eks:us-west-2:222222222222:cluster/shared';
const request = () => new Request('http://local/?account=222222222222&region=us-west-2');
const ctx = { params: Promise.resolve({ cluster: 'shared' }) };

beforeEach(() => {
  vi.clearAllMocks();
  allowed.mockResolvedValue(true);
  resolve.mockReset().mockResolvedValue({ id: ARN, name: 'shared', accountId: '222222222222', region: 'us-west-2' });
  listDbRefs.mockResolvedValue({ refs: [], secretRefs: [], truncated: false, partial: false });
  resolveDbHosts.mockResolvedValue({ map: new Map(), capped: false, incomplete: false });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('db-refs canonical Kubernetes scope', () => {
  it('uses the canonical ID for registration and the Kubernetes call', async () => {
    const { GET } = await import('./route');
    expect((await GET(request(), ctx)).status).toBe(200);
    expect(allowed).toHaveBeenCalledWith(ARN);
    expect(listDbRefs).toHaveBeenCalledWith(ARN);
  });

  it('reads inventory scoped to the member account only', async () => {
    listDbRefs.mockResolvedValue({ refs: [{ workload: { namespace: 'a', name: 'b' }, via: 'env', host: 'h.rds.amazonaws.com', kind: 'rds' }], secretRefs: [], truncated: false, partial: false });
    const { GET } = await import('./route');
    await GET(request(), ctx);
    expect(resolveDbHosts).toHaveBeenCalledWith(['h.rds.amazonaws.com'], '222222222222');
  });

  it('rejects a member if only its namesake host is registered', async () => {
    allowed.mockImplementation(async (id: string) => id === 'shared');
    const { GET } = await import('./route');
    expect((await GET(request(), ctx)).status).toBe(404);
    expect(listDbRefs).not.toHaveBeenCalled();
  });

  it.each([400, 403, 503])('preserves resolver status %s and never falls back to host', async status => {
    const { EksScopeError } = await import('@/lib/eks-context');
    resolve.mockRejectedValue(new EksScopeError('scope rejected', status));
    const { GET } = await import('./route');
    expect((await GET(request(), ctx)).status).toBe(status);
    expect(listDbRefs).not.toHaveBeenCalled();
  });
});
