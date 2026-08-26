import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const triggerSync = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/inventory', () => ({ triggerSync: (...a: unknown[]) => triggerSync(...a) }));
const req = () => new Request('http://x/api/security/refresh', { method: 'POST', headers: { cookie: 'awsops_token=t' } });
beforeEach(() => { verifyUser.mockReset(); triggerSync.mockReset(); delete process.env.INV_SYNC_FUNCTION; });

describe('POST /api/security/refresh', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { POST } = await import('./route');
    expect((await POST(req())).status).toBe(401);
  });
  it('503 when INV_SYNC_FUNCTION unconfigured', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    const { POST } = await import('./route');
    expect((await POST(req())).status).toBe(503);
  });
  it('202 invokes triggerSync for each security type', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    process.env.INV_SYNC_FUNCTION = 'awsops-v2-inv-sync';
    triggerSync.mockResolvedValue({ status: 'succeeded' });
    const { POST } = await import('./route');
    const res = await POST(req());
    expect(res.status).toBe(202);
    expect(triggerSync).toHaveBeenCalledTimes(4);
    expect(triggerSync.mock.calls.map((c) => c[0]).sort()).toEqual(
      ['ebs_volume', 'iam_user', 's3_public_access', 'security_group'],
    );
  });
  it('202 even when a triggerSync rejects (one type fails)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    process.env.INV_SYNC_FUNCTION = 'awsops-v2-inv-sync';
    triggerSync.mockRejectedValue(new Error('boom'));
    const { POST } = await import('./route');
    expect((await POST(req())).status).toBe(202);
  });
});
