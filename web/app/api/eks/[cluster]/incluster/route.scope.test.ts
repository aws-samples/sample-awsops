import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { resolve, allowed, list, describeObject, diagnosis } = vi.hoisted(() => ({
  resolve: vi.fn(), allowed: vi.fn(), list: vi.fn(), describeObject: vi.fn(), diagnosis: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ verifyUser: async () => ({ sub: 'u' }) }));
vi.mock('@/lib/admin', () => ({ isAdmin: async () => true }));
vi.mock('@/lib/eks-registry', () => ({ isAllowed: allowed }));
vi.mock('@/lib/eks-incluster', () => ({
  listInCluster: list, describeInCluster: describeObject,
  isKind: (kind: string) => kind === 'pods', isDescribableKind: (kind: string) => kind === 'pods',
}));
vi.mock('@/lib/k8sgpt', () => ({ getDiagnosis: diagnosis }));
vi.mock('@/lib/eks-context', () => ({
  resolveEksCluster: resolve,
  EksScopeError: class extends Error { constructor(message: string, public status: number) { super(message); } },
}));
const ARN = 'arn:aws:eks:us-west-2:222222222222:cluster/shared';
const routes = [
  { name: 'list', load: () => import('./route'), read: list, args: [ARN, 'pods'] },
  { name: 'describe', load: () => import('./describe/route'), read: describeObject, args: [ARN, 'pods', 'pod-a', 'default'] },
  { name: 'k8sgpt', load: () => import('../k8sgpt/route'), read: diagnosis, args: [ARN] },
];
const request = () => new Request('http://local/?kind=pods&name=pod-a&namespace=default&account=222222222222&region=us-west-2');

beforeEach(() => {
  vi.stubEnv('K8SGPT_ENABLED', 'true');
  vi.clearAllMocks();
  allowed.mockResolvedValue(true);
  resolve.mockReset().mockResolvedValue({ id: ARN, name: 'shared', accountId: '222222222222', region: 'us-west-2' });
  list.mockResolvedValue([]); describeObject.mockResolvedValue({}); diagnosis.mockResolvedValue({});
});
afterEach(() => vi.unstubAllEnvs());

describe.each(routes)('$name canonical Kubernetes scope', route => {
  it('uses the canonical ID for registration and the Kubernetes call', async () => {
    const { GET } = await route.load();
    expect((await GET(request(), { params: Promise.resolve({ cluster: 'shared' }) })).status).toBe(200);
    expect(resolve).toHaveBeenCalledWith('shared', new URL(request().url).searchParams);
    expect(allowed).toHaveBeenCalledWith(ARN);
    expect(route.read).toHaveBeenCalledWith(...route.args);
  });

  it('rejects a member if only its namesake host is registered', async () => {
    allowed.mockImplementation(async id => id === 'shared');
    const { GET } = await route.load();
    expect((await GET(request(), { params: Promise.resolve({ cluster: 'shared' }) })).status).toBe(404);
    expect(route.read).not.toHaveBeenCalled();
  });

  it.each([400, 403, 503])('preserves resolver status %s and never falls back to host', async status => {
    const { EksScopeError } = await import('@/lib/eks-context');
    resolve.mockRejectedValue(new EksScopeError('scope rejected', status));
    const { GET } = await route.load();
    expect((await GET(request(), { params: Promise.resolve({ cluster: 'shared' }) })).status).toBe(status);
    expect(route.read).not.toHaveBeenCalled();
  });
});
