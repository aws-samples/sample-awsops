import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyUser, allowed, resolve, diagnosis } = vi.hoisted(() => ({
  verifyUser: vi.fn(), allowed: vi.fn(), resolve: vi.fn(), diagnosis: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ verifyUser }));
vi.mock('@/lib/eks-registry', () => ({ isAllowed: allowed }));
vi.mock('@/lib/metrics', () => ({ eksDiagnosisMetrics: diagnosis }));
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
  diagnosis.mockReset().mockResolvedValue({
    controlPlane: {}, cluster: {}, nodes: {},
    sources: { controlPlane: { status: 'no-data' }, cluster: { status: 'no-data' }, nodes: { status: 'no-data' } },
  });
});

describe('EKS detail metrics scope', () => {
  it.each(['shared', ARN])('resolves %s before checking registration and querying CloudWatch', async cluster => {
    const { GET } = await import('./route');
    const search = 'account=222222222222&region=us-west-2&range=21600';
    const res = await GET(new Request(`http://local/?${search}`), { params: Promise.resolve({ cluster }) });
    expect(res.status).toBe(200);
    expect(resolve).toHaveBeenCalledWith(cluster, new URLSearchParams(search));
    expect(allowed).toHaveBeenCalledWith(ARN);
    expect(diagnosis).toHaveBeenCalledWith('shared', 'us-west-2', 21600, '222222222222');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ accountId: '222222222222', region: 'us-west-2' });
  });

  it('keeps the host default region and validates range presets', async () => {
    resolve.mockResolvedValue({ id: 'shared', name: 'shared', accountId: 'self', region: 'ap-northeast-2' });
    const { GET } = await import('./route');
    const res = await GET(new Request('http://local/?range=invalid'), { params: Promise.resolve({ cluster: 'shared' }) });
    expect((await res.json()).range).toBe(3600);
    expect(diagnosis).toHaveBeenCalledWith('shared', 'ap-northeast-2', 3600, 'self');
  });

  it.each([400, 403, 503])('returns scope error %s without any metrics call', async status => {
    const { EksScopeError } = await import('@/lib/eks-context');
    resolve.mockRejectedValue(new EksScopeError('scope rejected', status));
    const { GET } = await import('./route');
    expect((await GET(new Request('http://local/'), { params: Promise.resolve({ cluster: ARN }) })).status).toBe(status);
    expect(diagnosis).not.toHaveBeenCalled();
  });

  it('cannot borrow the registration of a same-name host cluster', async () => {
    allowed.mockImplementation(async id => id === 'shared');
    const { GET } = await import('./route');
    expect((await GET(new Request('http://local/?account=222222222222'), { params: Promise.resolve({ cluster: 'shared' }) })).status).toBe(404);
    expect(diagnosis).not.toHaveBeenCalled();
  });

  it('does not expose an unexpected raw SDK failure', async () => {
    diagnosis.mockRejectedValue(new Error('AccessDenied arn:aws:iam::222222222222:role/private-role SECRET'));
    const { GET } = await import('./route');
    const res = await GET(new Request('http://local/'), { params: Promise.resolve({ cluster: 'shared' }) });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ status: 'error', message: 'EKS metrics are unavailable.' });
  });
});
