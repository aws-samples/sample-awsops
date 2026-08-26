import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const readResources = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/inventory', () => ({ readResources: (...a: unknown[]) => readResources(...a) }));
const req = (url = 'http://x/api/inventory/ec2', cookie = 'awsops_token=t') => new Request(url, { headers: { cookie } });
const ctx = { params: { type: 'ec2' } };
beforeEach(() => {
  verifyUser.mockReset(); readResources.mockReset();
  verifyUser.mockResolvedValue({ sub: 'u' });
  readResources.mockResolvedValue({ rows: [{ resource_id: 'i-1' }], run: { status: 'succeeded' } });
});

describe('GET /api/inventory/[type]', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req(), ctx)).status).toBe(401);
  });
  it('200 with rows+run', async () => {
    const { GET } = await import('./route');
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).rows[0].resource_id).toBe('i-1');
  });

  describe('scope query params', () => {
    it('no params → regions "__all__", includeGlobal true (unchanged default)', async () => {
      const { GET } = await import('./route');
      await GET(req(), ctx);
      expect(readResources).toHaveBeenCalledWith('ec2', { limit: 100, offset: 0, regions: '__all__', includeGlobal: true, accounts: ['self'] });
    });
    it('regions=ap-northeast-2,us-east-1 → parsed to an array', async () => {
      const { GET } = await import('./route');
      await GET(req('http://x/api/inventory/ec2?regions=ap-northeast-2,us-east-1'), ctx);
      expect(readResources).toHaveBeenCalledWith('ec2', { limit: 100, offset: 0, regions: ['ap-northeast-2', 'us-east-1'], includeGlobal: true, accounts: ['self'] });
    });
    it('regions=__all__ explicit → same as unset', async () => {
      const { GET } = await import('./route');
      await GET(req('http://x/api/inventory/ec2?regions=__all__'), ctx);
      expect(readResources).toHaveBeenCalledWith('ec2', { limit: 100, offset: 0, regions: '__all__', includeGlobal: true, accounts: ['self'] });
    });
    it('includeGlobal=0 → false', async () => {
      const { GET } = await import('./route');
      await GET(req('http://x/api/inventory/ec2?includeGlobal=0'), ctx);
      expect(readResources).toHaveBeenCalledWith('ec2', { limit: 100, offset: 0, regions: '__all__', includeGlobal: false, accounts: ['self'] });
    });
    it('regions= (explicit empty) → [] , not "__all__"', async () => {
      const { GET } = await import('./route');
      await GET(req('http://x/api/inventory/ec2?regions=&includeGlobal=0'), ctx);
      expect(readResources).toHaveBeenCalledWith('ec2', { limit: 100, offset: 0, regions: [], includeGlobal: false, accounts: ['self'] });
    });
  });
});
