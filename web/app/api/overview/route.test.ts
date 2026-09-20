import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const listClusterInventory = vi.fn();
const getMtdCost = vi.fn();
const query = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/aws', () => ({
  listClusterInventory: (...a: unknown[]) => listClusterInventory(...a),
  getMtdCost: (...a: unknown[]) => getMtdCost(...a),
}));
vi.mock('@/lib/account', () => ({ currentAccountId: () => '111111111111' }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));
const req = (cookie = 'awsops_token=t', account?: string) => new Request(
  `http://x/api/overview${account ? `?account=${encodeURIComponent(account)}` : ''}`, { headers: { cookie } },
);
beforeEach(() => {
  verifyUser.mockReset(); listClusterInventory.mockReset(); getMtdCost.mockReset(); query.mockReset();
  listClusterInventory.mockResolvedValue({ clusters: [{ name: 'c1' }, { name: 'c2' }], region: 'ap-northeast-2', truncated: false });
});

describe('GET /api/overview', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(401);
  });
  it('aggregates jobs/clusters/cost, degrades cost to null on CE failure', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValue({ rows: [{ status: 'succeeded', n: '5' }, { status: 'failed', n: '1' }] });
    getMtdCost.mockRejectedValue(new Error('no ce'));
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobs.succeeded).toBe(5);
    expect(body.jobs.failed).toBe(1);
    expect(body.clusterCount).toBe(2);
    expect(body.clusterScope).toEqual({ accountId: 'self', region: 'ap-northeast-2', names: ['c1', 'c2'], truncated: false });
    expect(body.mtdCost).toBeNull(); // cost degrades, page still loads
  });

  it.each([
    { selected: '222222222222', accountId: '222222222222', queried: '222222222222' },
    { selected: '__all__', accountId: 'self', queried: undefined },
    { selected: '111111111111', accountId: 'self', queried: '111111111111' },
  ])('reports the actual singleton EKS source for account=$selected', async ({ selected, accountId, queried }) => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValue({ rows: [] });
    getMtdCost.mockResolvedValue({ total: 10 });
    const { GET } = await import('./route');
    const body = await (await GET(req(undefined, selected))).json();
    expect(body.clusterScope).toEqual({ accountId, region: 'ap-northeast-2', names: ['c1', 'c2'], truncated: false });
    expect(listClusterInventory).toHaveBeenCalledWith(queried);
    expect(getMtdCost).toHaveBeenCalledWith(queried);
  });

  it('preserves bounded inventory truncation instead of certifying its count as complete', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValue({ rows: [] });
    listClusterInventory.mockResolvedValue({ clusters: [{ name: 'c1' }], region: 'us-west-2', truncated: true });
    const { GET } = await import('./route');
    const body = await (await GET(req(undefined, '222222222222'))).json();
    expect(body.clusterCount).toBe(1);
    expect(body.clusterScope).toEqual({ accountId: '222222222222', region: 'us-west-2', names: ['c1'], truncated: true });
  });

  it('does not invent headline provenance when the EKS read fails', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValue({ rows: [] });
    listClusterInventory.mockRejectedValue(new Error('EKS unavailable'));
    getMtdCost.mockResolvedValue({ total: 10 });
    const { GET } = await import('./route');
    const body = await (await GET(req())).json();
    expect(body.clusterCount).toBeNull();
    expect(body.clusterScope).toBeNull();
    expect(body.mtdCost).toBe(10);
  });
});
