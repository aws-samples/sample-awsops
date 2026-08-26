import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const query = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));
const req = (path = '/api/inventory/trend', cookie = 'awsops_token=t') =>
  new Request(`http://x${path}`, { headers: { cookie } });
beforeEach(() => { verifyUser.mockReset(); query.mockReset(); });

describe('GET /api/inventory/trend', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(401);
  });

  it('200 sums per-day totals and picks out the ec2 series', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValueOnce({ rows: [
      { d: '2026-07-01', resource_type: 'ec2', n: 5 },
      { d: '2026-07-01', resource_type: 'lambda', n: 12 },
      { d: '2026-07-02', resource_type: 'ec2', n: 6 },
      { d: '2026-07-02', resource_type: 'lambda', n: 12 },
      { d: '2026-07-02', resource_type: 's3', n: 3 },
    ] });
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    // Each point now also carries every resource type as a column (multi-line chart) and the
    // response lists types ranked by latest count.
    expect(body.trend).toEqual([
      { date: '2026-07-01', total: 17, ec2: 5, lambda: 12 },
      { date: '2026-07-02', total: 21, ec2: 6, lambda: 12, s3: 3 },
    ]);
    expect(body.types).toEqual(['lambda', 'ec2', 's3']);
  });

  it('clamps days into [1, 90] and defaults to 14', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValue({ rows: [] });
    const { GET } = await import('./route');
    await GET(req());
    expect(query.mock.calls[0][1]).toEqual([14]);
    await GET(req('/api/inventory/trend?days=9999'));
    expect(query.mock.calls[1][1]).toEqual([90]);
    await GET(req('/api/inventory/trend?days=-5'));
    expect(query.mock.calls[2][1]).toEqual([1]);
  });

  it('500 on db error', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockRejectedValue(new Error('no db'));
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(500);
  });
});
