import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const getServiceCostDetail = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/aws', () => ({ getServiceCostDetail: (...a: unknown[]) => getServiceCostDetail(...a) }));

const req = (url: string, cookie = 'awsops_token=t') =>
  new Request(url, { headers: { cookie } });

beforeEach(() => {
  verifyUser.mockReset();
  getServiceCostDetail.mockReset();
});

describe('GET /api/cost/detail', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req('http://x/api/cost/detail?service=Amazon%20EC2'))).status).toBe(401);
  });

  it('400 when service is missing', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    const { GET } = await import('./route');
    expect((await GET(req('http://x/api/cost/detail'))).status).toBe(400);
  });

  it('400 when service exceeds 100 chars', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    const long = encodeURIComponent('A'.repeat(101));
    const { GET } = await import('./route');
    expect((await GET(req(`http://x/api/cost/detail?service=${long}`))).status).toBe(400);
  });

  it('200 with the detail shape', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    getServiceCostDetail.mockResolvedValue({
      service: 'Amazon EC2',
      currency: 'USD',
      trend: [{ date: '2026-06-01', amount: 4 }],
      byUsageType: [{ usageType: 'BoxUsage', amount: 12 }],
    });
    const { GET } = await import('./route');
    const res = await GET(req('http://x/api/cost/detail?service=Amazon%20EC2'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(getServiceCostDetail).toHaveBeenCalledWith('Amazon EC2', undefined);
    expect(body.service).toBe('Amazon EC2');
    expect(body.trend[0]).toEqual({ date: '2026-06-01', amount: 4 });
    expect(body.byUsageType[0]).toEqual({ usageType: 'BoxUsage', amount: 12 });
  });

  it('200 passes through trend:null when that CE leg failed', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    getServiceCostDetail.mockResolvedValue({
      service: 'Amazon S3',
      currency: 'USD',
      trend: null,
      byUsageType: [],
    });
    const { GET } = await import('./route');
    const res = await GET(req('http://x/api/cost/detail?service=Amazon%20S3'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.trend).toBeNull();
    expect(body.byUsageType).toEqual([]);
  });
});
