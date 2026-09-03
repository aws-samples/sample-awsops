import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const isAdmin = vi.fn();
const triggerSync = vi.fn();
const readResources = vi.fn();
const assertInventoryTypeAllowed = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/inventory', () => ({
  triggerSync: (...a: unknown[]) => triggerSync(...a),
  readResources: (...a: unknown[]) => readResources(...a),
  assertInventoryTypeAllowed: (...a: unknown[]) => assertInventoryTypeAllowed(...a),
}));
const req = () => new Request('http://x/api/inventory/ec2/refresh', { method: 'POST', headers: { cookie: 'awsops_token=t' } });
const ctx = { params: { type: 'ec2' } };
beforeEach(() => {
  verifyUser.mockReset(); isAdmin.mockReset(); triggerSync.mockReset();
  readResources.mockReset(); assertInventoryTypeAllowed.mockReset();
  isAdmin.mockResolvedValue(true);
  assertInventoryTypeAllowed.mockResolvedValue(null);
});

describe('POST refresh', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { POST } = await import('./route');
    const res = await POST(req(), ctx);
    expect(res.status).toBe(401);
    expect(isAdmin).not.toHaveBeenCalled();
    expect(triggerSync).not.toHaveBeenCalled();
  });
  it('403 authenticated non-admin without invoking the sync Lambda', async () => {
    const user = { sub: 'u' };
    verifyUser.mockResolvedValue(user);
    isAdmin.mockResolvedValue(false);
    const { POST } = await import('./route');
    const res = await POST(req(), ctx);
    expect(res.status).toBe(403);
    expect(isAdmin).toHaveBeenCalledWith(user);
    expect(assertInventoryTypeAllowed).not.toHaveBeenCalled();
    expect(triggerSync).not.toHaveBeenCalled();
  });
  it('queues a sync for an admin and returns currently stored rows', async () => {
    const user = { sub: 'admin-u' };
    verifyUser.mockResolvedValue(user);
    triggerSync.mockResolvedValue({ status: 'queued' });
    readResources.mockResolvedValue({ rows: [{ resource_id: 'i-1' }], run: { status: 'succeeded' } });
    const { POST } = await import('./route');
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      rows: [{ resource_id: 'i-1' }],
      sync: { status: 'queued' },
    });
    expect(isAdmin).toHaveBeenCalledWith(user);
    expect(assertInventoryTypeAllowed).toHaveBeenCalledWith('ec2', user);
    expect(triggerSync).toHaveBeenCalledWith('ec2');
  });
  it('503 when sync fails', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    triggerSync.mockRejectedValue(new Error('lambda down'));
    const { POST } = await import('./route');
    expect((await POST(req(), ctx)).status).toBe(503);
  });
  // pentest-remediation P2-2: this route previously called only verifyUser() — no admin/type gate —
  // so a non-admin could POST /api/inventory/iam_user/refresh and get the same IAM rows GET 403s.
  it('403 when assertInventoryTypeAllowed rejects (e.g. non-admin on iam_user), without syncing', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    assertInventoryTypeAllowed.mockResolvedValue({ status: 403, message: '관리자 전용 메뉴입니다 (IAM)' });
    const { POST } = await import('./route');
    const res = await POST(req(), { params: { type: 'iam_user' } });
    expect(res.status).toBe(403);
    expect(triggerSync).not.toHaveBeenCalled();
  });
});
