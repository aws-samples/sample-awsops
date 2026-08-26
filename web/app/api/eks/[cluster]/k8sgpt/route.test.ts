import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const isAdmin = vi.fn();
const getDiagnosis = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/k8sgpt', () => ({ getDiagnosis: (...a: unknown[]) => getDiagnosis(...a) }));

const req = (url: string, cookie = 'awsops_token=t') => new Request(url, { headers: { cookie } });
const ctx = (cluster = 'fsi-demo-cluster') => ({ params: { cluster } });

beforeEach(() => {
  verifyUser.mockReset();
  isAdmin.mockReset();
  getDiagnosis.mockReset();
  process.env.ONBOARDED_EKS_CLUSTERS = 'fsi-demo-cluster,other-cluster';
  process.env.K8SGPT_ENABLED = 'true';
});

describe('GET /api/eks/[cluster]/k8sgpt', () => {
  it('401 unauth — no admin check, no cluster read', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    const res = await GET(req('http://x/api/eks/fsi-demo-cluster/k8sgpt'), ctx());
    expect(res.status).toBe(401);
    expect(isAdmin).not.toHaveBeenCalled();
    expect(getDiagnosis).not.toHaveBeenCalled();
  });

  it('403 when authenticated but not admin — no cluster read', async () => {
    verifyUser.mockResolvedValue({ sub: 'u', email: 'user@x' });
    isAdmin.mockResolvedValue(false);
    const { GET } = await import('./route');
    const res = await GET(req('http://x/api/eks/fsi-demo-cluster/k8sgpt'), ctx());
    expect(res.status).toBe(403);
    expect(getDiagnosis).not.toHaveBeenCalled();
  });

  it('503 {enabled:false} when flag OFF — dark, NO cluster read even for admin/onboarded', async () => {
    process.env.K8SGPT_ENABLED = 'false';
    verifyUser.mockResolvedValue({ sub: 'u', email: 'admin@x' });
    isAdmin.mockResolvedValue(true);
    const { GET } = await import('./route');
    const res = await GET(req('http://x/api/eks/fsi-demo-cluster/k8sgpt'), ctx());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ enabled: false, message: 'k8sgpt diagnosis disabled' });
    expect(getDiagnosis).not.toHaveBeenCalled();
  });

  it('503 {enabled:false} when flag UNSET — dark', async () => {
    delete process.env.K8SGPT_ENABLED;
    verifyUser.mockResolvedValue({ sub: 'u', email: 'admin@x' });
    isAdmin.mockResolvedValue(true);
    const { GET } = await import('./route');
    const res = await GET(req('http://x/api/eks/fsi-demo-cluster/k8sgpt'), ctx());
    expect(res.status).toBe(503);
    expect((await res.json()).enabled).toBe(false);
    expect(getDiagnosis).not.toHaveBeenCalled();
  });

  it('404 when cluster not onboarded — no cluster read', async () => {
    verifyUser.mockResolvedValue({ sub: 'u', email: 'admin@x' });
    isAdmin.mockResolvedValue(true);
    const { GET } = await import('./route');
    const res = await GET(req('http://x/api/eks/rogue/k8sgpt'), ctx('rogue'));
    expect(res.status).toBe(404);
    expect(getDiagnosis).not.toHaveBeenCalled();
  });

  it('200 returns the diagnosis result for an admin + onboarded cluster', async () => {
    verifyUser.mockResolvedValue({ sub: 'u', email: 'admin@x' });
    isAdmin.mockResolvedValue(true);
    getDiagnosis.mockResolvedValue({ enabled: true, cluster: 'fsi-demo-cluster', findings: [] });
    const { GET } = await import('./route');
    const res = await GET(req('http://x/api/eks/fsi-demo-cluster/k8sgpt'), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.cluster).toBe('fsi-demo-cluster');
    expect(getDiagnosis).toHaveBeenCalledWith('fsi-demo-cluster');
  });

  it('502 on diagnosis error', async () => {
    verifyUser.mockResolvedValue({ sub: 'u', email: 'admin@x' });
    isAdmin.mockResolvedValue(true);
    getDiagnosis.mockRejectedValue(new Error('result fetch failed'));
    const { GET } = await import('./route');
    const res = await GET(req('http://x/api/eks/fsi-demo-cluster/k8sgpt'), ctx());
    expect(res.status).toBe(502);
    expect((await res.json()).message).toBe('result fetch failed');
  });
});
