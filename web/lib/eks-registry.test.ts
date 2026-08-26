import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));

describe('eks-registry', () => {
  beforeEach(async () => {
    query.mockReset();
    process.env.AURORA_ENDPOINT = 'x';
    process.env.ONBOARDED_EKS_CLUSTERS = 'tf-a,tf-b';
    const { _resetForTests } = await import('./eks-registry');
    _resetForTests();
  });

  it('allow-list = env ∪ DB', async () => {
    query.mockResolvedValue({ rows: [{ cluster_name: 'db-c' }] });
    const { getAllowedClusters } = await import('./eks-registry');
    const s = await getAllowedClusters();
    expect(s.has('tf-a')).toBe(true);
    expect(s.has('tf-b')).toBe(true);
    expect(s.has('db-c')).toBe(true);
    expect(s.has('nope')).toBe(false);
  });

  it('degrades to env-only when the DB query fails', async () => {
    query.mockRejectedValue(new Error('db down'));
    const { getAllowedClusters } = await import('./eks-registry');
    const s = await getAllowedClusters();
    expect(s.has('tf-a')).toBe(true);
    expect(s.size).toBe(2);
  });

  it('is env-only without AURORA_ENDPOINT (no DB call)', async () => {
    delete process.env.AURORA_ENDPOINT;
    const { getAllowedClusters } = await import('./eks-registry');
    await getAllowedClusters();
    expect(query).not.toHaveBeenCalled();
  });

  it('caches within TTL (one DB query for two calls)', async () => {
    query.mockResolvedValue({ rows: [] });
    const { getAllowedClusters } = await import('./eks-registry');
    await getAllowedClusters();
    await getAllowedClusters();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('isAllowed consults the union', async () => {
    query.mockResolvedValue({ rows: [{ cluster_name: 'db-c' }] });
    const { isAllowed } = await import('./eks-registry');
    expect(await isAllowed('db-c')).toBe(true);
    expect(await isAllowed('nope')).toBe(false);
  });

  it('registerCluster inserts idempotently and busts the cache', async () => {
    query.mockResolvedValue({ rows: [] });
    const { registerCluster, getAllowedClusters } = await import('./eks-registry');
    await getAllowedClusters(); // warm cache
    expect(await registerCluster('new-c', 'u1')).toBe(true);
    const [sql, params] = query.mock.calls.at(-1) as [string, unknown[]];
    expect(String(sql)).toContain('ON CONFLICT (cluster_name) DO NOTHING');
    expect(params).toEqual(['new-c', 'u1']);
    query.mockResolvedValue({ rows: [{ cluster_name: 'new-c' }] });
    expect((await getAllowedClusters()).has('new-c')).toBe(true); // cache busted → re-query
  });

  it('registerCluster returns false when the DB write fails (degrade, not throw)', async () => {
    query.mockRejectedValue(new Error('db down'));
    const { registerCluster } = await import('./eks-registry');
    expect(await registerCluster('c', 'u')).toBe(false);
  });

  it('registerCluster returns false without a DB', async () => {
    delete process.env.AURORA_ENDPOINT;
    const { registerCluster } = await import('./eks-registry');
    expect(await registerCluster('c', 'u')).toBe(false);
  });

  it('unregisterCluster deletes and reports whether a row was removed', async () => {
    query.mockResolvedValue({ rowCount: 1, rows: [] });
    const { unregisterCluster } = await import('./eks-registry');
    expect(await unregisterCluster('db-c')).toBe('deleted');
  });

  it('unregisterCluster distinguishes not-found from storage failure (PR #36)', async () => {
    query.mockResolvedValue({ rowCount: 0, rows: [] });
    const { unregisterCluster } = await import('./eks-registry');
    expect(await unregisterCluster('ghost')).toBe('not-found');
    query.mockRejectedValue(new Error('db down'));
    expect(await unregisterCluster('db-c')).toBe('unavailable');
  });

  it('isEnvCluster identifies Terraform-managed clusters', async () => {
    const { isEnvCluster } = await import('./eks-registry');
    expect(isEnvCluster('tf-a')).toBe(true);
    expect(isEnvCluster('db-c')).toBe(false);
  });
});
