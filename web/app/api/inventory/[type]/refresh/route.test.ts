import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const triggerSync = vi.fn();
const readResources = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/inventory', () => ({ triggerSync: (...a: unknown[]) => triggerSync(...a), readResources: (...a: unknown[]) => readResources(...a) }));
const req = () => new Request('http://x/api/inventory/ec2/refresh', { method: 'POST', headers: { cookie: 'awsops_token=t' } });
const ctx = { params: { type: 'ec2' } };
beforeEach(() => { verifyUser.mockReset(); triggerSync.mockReset(); readResources.mockReset(); });

describe('POST refresh', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { POST } = await import('./route');
    expect((await POST(req(), ctx)).status).toBe(401);
  });
  it('syncs then returns fresh rows', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    triggerSync.mockResolvedValue({ status: 'succeeded', row_count: 2 });
    readResources.mockResolvedValue({ rows: [{ resource_id: 'i-1' }], run: { status: 'succeeded' } });
    const { POST } = await import('./route');
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).rows.length).toBe(1);
    expect(triggerSync).toHaveBeenCalledWith('ec2');
  });
  it('503 when sync fails', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    triggerSync.mockRejectedValue(new Error('lambda down'));
    const { POST } = await import('./route');
    expect((await POST(req(), ctx)).status).toBe(503);
  });
});
