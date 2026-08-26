import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const isAdmin = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
// module-level mock so EVERY case uses the stub (none hits the real SSM/admin path).
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
const req = (cookie = 'awsops_token=t') => new Request('http://x/api/me', { headers: { cookie } });
beforeEach(() => {
  verifyUser.mockReset();
  isAdmin.mockReset();
  isAdmin.mockResolvedValue(false);
});

describe('GET /api/me', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(401);
  });
  it('200 with identity + isAdmin', async () => {
    verifyUser.mockResolvedValue({ sub: 'u1', email: 'admin@awsops.io', groups: ['admins'] });
    isAdmin.mockResolvedValue(true);
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ sub: 'u1', email: 'admin@awsops.io', groups: ['admins'], isAdmin: true });
  });
  it('isAdmin false for a non-admin user', async () => {
    verifyUser.mockResolvedValue({ sub: 'u3', email: 'dev@awsops.io', groups: [] });
    isAdmin.mockResolvedValue(false);
    const { GET } = await import('./route');
    const body = await (await GET(req())).json();
    expect(body.isAdmin).toBe(false);
  });
  it('200 with empty groups when absent', async () => {
    verifyUser.mockResolvedValue({ sub: 'u2', email: 'x@y.z' });
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).groups).toEqual([]);
  });
});
