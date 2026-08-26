import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const listInCluster = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/eks-incluster', async () => {
  const actual = await vi.importActual<typeof import('@/lib/eks-incluster')>('@/lib/eks-incluster');
  return { ...actual, listInCluster: (...a: unknown[]) => listInCluster(...a) };
});

const req = (url: string, cookie = 'awsops_token=t') => new Request(url, { headers: { cookie } });
const ctx = (cluster = 'fsi-demo-cluster') => ({ params: { cluster } });

beforeEach(() => {
  verifyUser.mockReset();
  listInCluster.mockReset();
  process.env.ONBOARDED_EKS_CLUSTERS = 'fsi-demo-cluster,other-cluster';
});

describe('GET /api/eks/[cluster]/incluster', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    const res = await GET(req('http://x/api/eks/fsi-demo-cluster/incluster?kind=nodes'), ctx());
    expect(res.status).toBe(401);
  });

  it('404 when cluster not onboarded', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    const { GET } = await import('./route');
    const res = await GET(req('http://x/api/eks/rogue/incluster?kind=nodes'), ctx('rogue'));
    expect(res.status).toBe(404);
    expect(listInCluster).not.toHaveBeenCalled();
  });

  it('400 on unknown kind', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    const { GET } = await import('./route');
    const res = await GET(req('http://x/api/eks/fsi-demo-cluster/incluster?kind=secrets'), ctx());
    expect(res.status).toBe(400);
    expect(listInCluster).not.toHaveBeenCalled();
  });

  it('400 on missing kind', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    const { GET } = await import('./route');
    const res = await GET(req('http://x/api/eks/fsi-demo-cluster/incluster'), ctx());
    expect(res.status).toBe(400);
  });

  it('200 returns {kind, rows}', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    listInCluster.mockResolvedValue([{ name: 'ip-10-0-0-1', status: 'Ready' }]);
    const { GET } = await import('./route');
    const res = await GET(req('http://x/api/eks/fsi-demo-cluster/incluster?kind=nodes'), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe('nodes');
    expect(body.rows[0].name).toBe('ip-10-0-0-1');
    expect(listInCluster).toHaveBeenCalledWith('fsi-demo-cluster', 'nodes');
  });

  it('502 on in-cluster error', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    listInCluster.mockRejectedValue(new Error('forbidden'));
    const { GET } = await import('./route');
    const res = await GET(req('http://x/api/eks/fsi-demo-cluster/incluster?kind=pods'), ctx());
    expect(res.status).toBe(502);
    expect((await res.json()).message).toBe('forbidden');
  });
});
