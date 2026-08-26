import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const getMonthlyCostByService = vi.fn();
const getDailyCostByService = vi.fn();
const getCostForecast = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/aws', () => ({
  getMonthlyCostByService: (...a: unknown[]) => getMonthlyCostByService(...a),
  getDailyCostByService: (...a: unknown[]) => getDailyCostByService(...a),
  getCostForecast: (...a: unknown[]) => getCostForecast(...a),
}));
const req = (cookie = 'awsops_token=t') => new Request('http://x/api/cost', { headers: { cookie } });
beforeEach(() => {
  (async () => { const m = await import('@/lib/cost-availability'); m._clearCostSnapshotsForTests(); })();
  verifyUser.mockReset(); getMonthlyCostByService.mockReset();
  getDailyCostByService.mockReset(); getCostForecast.mockReset();
  // sensible defaults so older cases don't crash on the new secondary calls
  getDailyCostByService.mockResolvedValue([]); getCostForecast.mockResolvedValue(null);
});

describe('GET /api/cost', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(401);
  });
  it('200 derives total/currency/byService from the last month of monthlyByService', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    getMonthlyCostByService.mockResolvedValue([
      { month: '2026-05', byService: [{ service: 'Amazon RDS', amount: 200 }] },
      { month: '2026-06', byService: [{ service: 'Amazon RDS', amount: 310.5 }, { service: 'Amazon EC2', amount: 180 }] },
    ]);
    getDailyCostByService.mockResolvedValue([{ date: '2026-06-01', byService: [{ service: 'Amazon RDS', amount: 12.3 }] }]);
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(490.5);
    expect(body.currency).toBe('USD');
    expect(body.byService).toEqual([{ service: 'Amazon RDS', amount: 310.5 }, { service: 'Amazon EC2', amount: 180 }]);
    expect(body.trend).toEqual([{ date: '2026-06-01', amount: 12.3 }]);
  });
  it('200 derives monthly totals + passes through forecast + the raw matrices', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    getMonthlyCostByService.mockResolvedValue([
      { month: '2026-05', byService: [{ service: 'Amazon RDS', amount: 400 }] },
      { month: '2026-06', byService: [{ service: 'Amazon RDS', amount: 490.5 }] },
    ]);
    getCostForecast.mockResolvedValue(120.25);
    const { GET } = await import('./route');
    const body = await (await GET(req())).json();
    expect(body.monthly).toEqual([{ month: '2026-05', total: 400 }, { month: '2026-06', total: 490.5 }]);
    expect(body.forecast).toBe(120.25);
    expect(body.monthlyByService).toHaveLength(2);
    expect(body.dailyByService).toEqual([]);
  });
  it('200 with secondaries degraded on error (trend [], forecast null); monthly still derives from the primary call', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    getMonthlyCostByService.mockResolvedValue([{ month: '2026-06', byService: [{ service: 'Amazon RDS', amount: 1 }] }]);
    getDailyCostByService.mockRejectedValue(new Error('no ce perms'));
    getCostForecast.mockRejectedValue(new Error('insufficient history'));
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.trend).toEqual([]);
    expect(body.monthly).toEqual([{ month: '2026-06', total: 1 }]);
    expect(body.forecast).toBeNull();
  });
  it('500 when the primary call (monthlyByService) fails', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    getMonthlyCostByService.mockRejectedValue(new Error('no ce perms'));
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(500);
  });
});

describe('GET /api/cost — period filter (?months=)', () => {
  beforeEach(() => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    getMonthlyCostByService.mockResolvedValue([{ month: '2026-06', byService: [] }]);
  });
  it('default (no ?months) → 6', async () => {
    const { GET } = await import('./route');
    await GET(req());
    expect(getMonthlyCostByService).toHaveBeenCalledWith(6, undefined);
  });
  it('?months=3 → 3', async () => {
    const { GET } = await import('./route');
    await GET(new Request('http://x/api/cost?months=3', { headers: { cookie: 'awsops_token=t' } }));
    expect(getMonthlyCostByService).toHaveBeenCalledWith(3, undefined);
  });
  it('?months=<not allowed> → falls back to 6', async () => {
    const { GET } = await import('./route');
    await GET(new Request('http://x/api/cost?months=99', { headers: { cookie: 'awsops_token=t' } }));
    expect(getMonthlyCostByService).toHaveBeenCalledWith(6, undefined);
  });
});

describe('GET /api/cost — account scoping', () => {
  const reqU = (url: string, cookie = 'awsops_token=t') => new Request(url, { headers: { cookie } });
  beforeEach(() => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    getMonthlyCostByService.mockResolvedValue([{ month: '2026-06', byService: [] }]);
  });
  it('default → host (cost fns called with undefined account)', async () => {
    const { GET } = await import('./route');
    const res = await GET(reqU('http://x/api/cost'));
    expect(res.status).toBe(200);
    expect(getMonthlyCostByService).toHaveBeenCalledWith(6, undefined);
    expect((await res.json()).account).toBe('self');
  });
  it('?account=<id> → that account', async () => {
    const { GET } = await import('./route');
    const res = await GET(reqU('http://x/api/cost?account=210987654321'));
    expect(getMonthlyCostByService).toHaveBeenCalledWith(6, '210987654321');
    expect((await res.json()).account).toBe('210987654321');
  });
  it('?account=__all__ → 400 (client aggregates)', async () => {
    const { GET } = await import('./route');
    const res = await GET(reqU('http://x/api/cost?account=__all__'));
    expect(res.status).toBe(400);
    expect(getMonthlyCostByService).not.toHaveBeenCalled();
  });
});
