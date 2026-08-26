import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const listClusters = vi.fn();
const getMtdCost = vi.fn();
const query = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/aws', () => ({ listClusters: (...a: unknown[]) => listClusters(...a), getMtdCost: (...a: unknown[]) => getMtdCost(...a) }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));
const req = (cookie = 'awsops_token=t') => new Request('http://x/api/overview', { headers: { cookie } });
beforeEach(() => { verifyUser.mockReset(); listClusters.mockReset(); getMtdCost.mockReset(); query.mockReset(); });

describe('GET /api/overview', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(401);
  });
  it('aggregates jobs/clusters/cost, degrades cost to null on CE failure', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValue({ rows: [{ status: 'succeeded', n: '5' }, { status: 'failed', n: '1' }] });
    listClusters.mockResolvedValue([{ name: 'c1' }, { name: 'c2' }]);
    getMtdCost.mockRejectedValue(new Error('no ce'));
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobs.succeeded).toBe(5);
    expect(body.jobs.failed).toBe(1);
    expect(body.clusterCount).toBe(2);
    expect(body.mtdCost).toBeNull(); // cost degrades, page still loads
  });
});
