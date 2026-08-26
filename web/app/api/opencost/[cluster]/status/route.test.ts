import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const isClusterOnboarded = vi.fn();
const detectOpencostInstall = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/opencost-allowlist', () => ({ isClusterOnboarded: (...a: unknown[]) => isClusterOnboarded(...a) }));
vi.mock('@/lib/opencost-status', () => ({ detectOpencostInstall: (...a: unknown[]) => detectOpencostInstall(...a) }));

const req = () => new Request('http://x/api/opencost/c1/status', { headers: { cookie: 'awsops_token=t' } });
const P = { params: { cluster: 'c1' } };

beforeEach(() => {
  vi.clearAllMocks();
  isClusterOnboarded.mockReturnValue(true);
  verifyUser.mockResolvedValue({ sub: 'u' });
});

describe('GET /api/opencost/[cluster]/status', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req(), P)).status).toBe(401);
  });
  it('404 not onboarded', async () => {
    isClusterOnboarded.mockReturnValue(false);
    const { GET } = await import('./route');
    expect((await GET(req(), P)).status).toBe(404);
  });
  it('200 installed', async () => {
    detectOpencostInstall.mockResolvedValue({ installed: true, ready: true, deployment: { name: 'opencost' } });
    const { GET } = await import('./route');
    const res = await GET(req(), P);
    expect(res.status).toBe(200);
    expect((await res.json()).installed).toBe(true);
  });
  it('LOAD-BEARING: in-cluster 403 → 200 {installed:false} (NOT a 5xx)', async () => {
    detectOpencostInstall.mockResolvedValue({ installed: false, ready: false, deployment: null, reason: 'HTTP 403' });
    const { GET } = await import('./route');
    const res = await GET(req(), P);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.installed).toBe(false);
    expect(body.reason).toContain('403');
  });
});
