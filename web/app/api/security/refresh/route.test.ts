import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const isAdmin = vi.fn();
const triggerSync = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/inventory', () => ({ triggerSync: (...a: unknown[]) => triggerSync(...a) }));
const req = () => new Request('http://x/api/security/refresh', { method: 'POST', headers: { cookie: 'awsops_token=t' } });
beforeEach(() => {
  verifyUser.mockReset();
  isAdmin.mockReset();
  triggerSync.mockReset();
  isAdmin.mockResolvedValue(true);
  delete process.env.INV_SYNC_FUNCTION;
});

describe('POST /api/security/refresh', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { POST } = await import('./route');
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(isAdmin).not.toHaveBeenCalled();
    expect(triggerSync).not.toHaveBeenCalled();
  });
  it('403 authenticated non-admin without invoking any refresh', async () => {
    const user = { sub: 'u' };
    verifyUser.mockResolvedValue(user);
    isAdmin.mockResolvedValue(false);
    process.env.INV_SYNC_FUNCTION = 'awsops-v2-inv-sync';
    const { POST } = await import('./route');
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(isAdmin).toHaveBeenCalledWith(user);
    expect(triggerSync).not.toHaveBeenCalled();
  });
  it('503 when INV_SYNC_FUNCTION unconfigured', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    const { POST } = await import('./route');
    expect((await POST(req())).status).toBe(503);
  });
  it('202 invokes triggerSync for each security type for an admin', async () => {
    const user = { sub: 'admin-u' };
    verifyUser.mockResolvedValue(user);
    process.env.INV_SYNC_FUNCTION = 'awsops-v2-inv-sync';
    triggerSync.mockResolvedValue({ status: 'queued' });
    const { POST } = await import('./route');
    const res = await POST(req());
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      status: 'refreshing',
      queuedCount: 4,
      failedCount: 0,
      failedTypes: [],
    });
    expect(isAdmin).toHaveBeenCalledWith(user);
    expect(triggerSync).toHaveBeenCalledTimes(4);
    expect(triggerSync.mock.calls.map((c) => c[0]).sort()).toEqual(
      ['ebs_volume', 'iam_user', 's3_public_access', 'security_group'],
    );
  });
  it('202 discloses a safe partial result when one type fails but others queue', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    process.env.INV_SYNC_FUNCTION = 'awsops-v2-inv-sync';
    triggerSync.mockImplementation((type: string) => (
      type === 'iam_user'
        ? Promise.reject(new Error('credential=supersecret account=123456789012'))
        : Promise.resolve({ status: 'queued' })
    ));
    const { POST } = await import('./route');
    const res = await POST(req());
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({
      status: 'partial',
      types: ['s3_public_access', 'security_group', 'ebs_volume', 'iam_user'],
      queuedCount: 3,
      failedCount: 1,
      queuedTypes: ['s3_public_access', 'security_group', 'ebs_volume'],
      failedTypes: ['iam_user'],
    });
    expect(JSON.stringify(body)).not.toContain('supersecret');
    expect(JSON.stringify(body)).not.toContain('123456789012');
  });
  it('503 reports failed when no security type queues', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    process.env.INV_SYNC_FUNCTION = 'awsops-v2-inv-sync';
    triggerSync.mockRejectedValue(new Error('lambda down: credential=supersecret'));
    const { POST } = await import('./route');
    const res = await POST(req());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({
      status: 'failed',
      types: ['s3_public_access', 'security_group', 'ebs_volume', 'iam_user'],
      queuedCount: 0,
      failedCount: 4,
      queuedTypes: [],
      failedTypes: ['s3_public_access', 'security_group', 'ebs_volume', 'iam_user'],
    });
    expect(JSON.stringify(body)).not.toContain('supersecret');
  });
});
