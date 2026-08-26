import { describe, it, expect } from 'vitest';

describe('POST /api/auth/signout', () => {
  it('clears the awsops_token cookie (Max-Age=0)', async () => {
    const { POST } = await import('./route');
    const res = await POST();
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('awsops_token=');
    expect(setCookie).toContain('Max-Age=0');
    expect(setCookie).toContain('HttpOnly');
  });
  it("returns { redirect: '/login' } (no hosted-UI round-trip)", async () => {
    const { POST } = await import('./route');
    const res = await POST();
    expect(await res.json()).toEqual({ redirect: '/login' });
  });
});
