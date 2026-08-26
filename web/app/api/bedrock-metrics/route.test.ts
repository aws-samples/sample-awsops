import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const bedrockModelMetrics = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/metrics', () => ({ bedrockModelMetrics: (...a: unknown[]) => bedrockModelMetrics(...a) }));

const req = (url = 'http://x/api/bedrock-metrics', cookie = 'awsops_token=t') =>
  new Request(url, { headers: { cookie } });

beforeEach(() => {
  verifyUser.mockReset(); bedrockModelMetrics.mockReset();
  verifyUser.mockResolvedValue({ sub: 'u' });
  bedrockModelMetrics.mockResolvedValue({ models: [], totalCost: 0, series: [] });
});

describe('GET /api/bedrock-metrics', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(401);
  });

  it('default (no account) → host (accountId undefined)', async () => {
    const { GET } = await import('./route');
    const res = await GET(req('http://x/api/bedrock-metrics?range=24h'));
    expect(res.status).toBe(200);
    expect(bedrockModelMetrics).toHaveBeenCalledWith('24h', undefined);
    expect((await res.json()).account).toBe('self');
  });

  it('?account=<id> → metrics for that account', async () => {
    const { GET } = await import('./route');
    const res = await GET(req('http://x/api/bedrock-metrics?range=7d&account=210987654321'));
    expect(res.status).toBe(200);
    expect(bedrockModelMetrics).toHaveBeenCalledWith('7d', '210987654321');
    expect((await res.json()).account).toBe('210987654321');
  });

  it('?account=__all__ → 400 (client aggregates, not the server)', async () => {
    const { GET } = await import('./route');
    const res = await GET(req('http://x/api/bedrock-metrics?account=__all__'));
    expect(res.status).toBe(400);
    expect(bedrockModelMetrics).not.toHaveBeenCalled();
  });
});
