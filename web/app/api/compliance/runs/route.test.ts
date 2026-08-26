import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const query = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));
const req = () => new Request('http://x/api/compliance/runs', { headers: { cookie: 'awsops_token=t' } });
beforeEach(() => { verifyUser.mockReset(); query.mockReset(); });

describe('GET /api/compliance/runs', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req() as any)).status).toBe(401);
  });
  it('200 returns recent runs', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValueOnce({ rows: [{ id: 2, benchmark: 'cis_v300', status: 'succeeded', pass_rate: 80 }] });
    const { GET } = await import('./route');
    const res = await GET(req() as any);
    expect(res.status).toBe(200);
    expect((await res.json()).runs[0]).toMatchObject({ id: 2, benchmark: 'cis_v300' });
  });
  it('500 on db error', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockRejectedValue(new Error('no db'));
    const { GET } = await import('./route');
    expect((await GET(req() as any)).status).toBe(500);
  });
});
