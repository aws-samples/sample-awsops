import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const query = vi.fn();
const getAccount = vi.fn();
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));
vi.mock('./accounts', () => ({ getAccount: (...a: unknown[]) => getAccount(...a) }));
vi.mock('./account-regions', () => ({ listScanScope: async () => [{ accountId: '222222222222', regions: ['*'] }] }));

describe('eks-registry', () => {
  afterEach(() => vi.useRealTimers());

  beforeEach(async () => {
    query.mockReset();
    process.env.AURORA_ENDPOINT = 'x';
    process.env.ONBOARDED_EKS_CLUSTERS = 'tf-a,tf-b';
    process.env.AWS_REGION = 'ap-northeast-2';
    process.env.HOST_ACCOUNT_ID = '111111111111';
    getAccount.mockReset().mockResolvedValue({ accountId: '222222222222', enabled: true, isHost: false, region: 'us-east-1' });
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

  it('strict reads surface a real registration SELECT failure as a sanitized 503', async () => {
    query.mockRejectedValue(new Error('password=private-db-detail'));
    const { getAllowedClusters } = await import('./eks-registry');
    await expect(getAllowedClusters(true)).rejects.toMatchObject({
      name: 'EksScopeError', status: 503, message: 'EKS registration registry is unavailable',
    });
    expect(query).toHaveBeenCalledWith('SELECT cluster_name FROM eks_registrations');
  });

  it('strict reads reject an env-only fallback already cached by a legacy reader', async () => {
    query.mockRejectedValue(new Error('registration SELECT failed'));
    const { getAllowedClusters } = await import('./eks-registry');
    expect(await getAllowedClusters()).toEqual(new Set(['tf-a', 'tf-b']));
    await expect(getAllowedClusters(true)).rejects.toMatchObject({ status: 503 });
    expect(await getAllowedClusters()).toEqual(new Set(['tf-a', 'tf-b']));
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('a strict failure keeps legacy fallback available without a repeated SQL read', async () => {
    query.mockRejectedValue(new Error('registration SELECT failed'));
    const { getAllowedClusters } = await import('./eks-registry');
    await expect(getAllowedClusters(true)).rejects.toMatchObject({ status: 503 });
    expect(await getAllowedClusters()).toEqual(new Set(['tf-a', 'tf-b']));
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('strict reads share successful registry cache entries with legacy reads', async () => {
    const member = 'arn:aws:eks:us-east-1:222222222222:cluster/tf-a';
    query.mockResolvedValue({ rows: [{ cluster_name: member }] });
    const { getAllowedClusters } = await import('./eks-registry');
    await getAllowedClusters();
    expect(await getAllowedClusters(true)).toEqual(new Set(['tf-a', 'tf-b', member]));
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('strict reads accept env-only mode when Aurora is not configured', async () => {
    delete process.env.AURORA_ENDPOINT;
    const { getAllowedClusters } = await import('./eks-registry');
    expect(await getAllowedClusters(true)).toEqual(new Set(['tf-a', 'tf-b']));
    expect(await getAllowedClusters(true)).toEqual(new Set(['tf-a', 'tf-b']));
    expect(query).not.toHaveBeenCalled();
  });

  it('retries failed registration reads after the cache expires', async () => {
    vi.useFakeTimers();
    query.mockRejectedValue(new Error('registration SELECT failed'));
    const { getAllowedClusters } = await import('./eks-registry');
    await getAllowedClusters();
    await expect(getAllowedClusters(true)).rejects.toMatchObject({ status: 503 });
    vi.advanceTimersByTime(30_001);
    query.mockResolvedValue({ rows: [{ cluster_name: 'recovered' }] });
    expect(await getAllowedClusters(true)).toEqual(new Set(['tf-a', 'tf-b', 'recovered']));
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('does not reuse an unconfigured env-only cache after Aurora becomes configured', async () => {
    delete process.env.AURORA_ENDPOINT;
    const { getAllowedClusters } = await import('./eks-registry');
    await getAllowedClusters();
    process.env.AURORA_ENDPOINT = 'x';
    query.mockRejectedValue(new Error('registration SELECT failed'));
    await expect(getAllowedClusters(true)).rejects.toMatchObject({ status: 503 });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('does not treat a cached SQL failure as an outage when Aurora is no longer configured', async () => {
    query.mockRejectedValue(new Error('registration SELECT failed'));
    const { getAllowedClusters } = await import('./eks-registry');
    await getAllowedClusters();
    delete process.env.AURORA_ENDPOINT;
    expect(await getAllowedClusters(true)).toEqual(new Set(['tf-a', 'tf-b']));
    expect(query).toHaveBeenCalledTimes(1);
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

  it('canonicalizes host default-region ARN lookups to the legacy TEXT key', async () => {
    query.mockResolvedValue({ rows: [] });
    const { isAllowed } = await import('./eks-registry');
    expect(await isAllowed('arn:aws:eks:ap-northeast-2:111111111111:cluster/tf-a')).toBe(true);
  });

  it('the TEXT primary key keeps same-name member, host, and other-region registrations separate', async () => {
    const member = 'arn:aws:eks:us-east-1:222222222222:cluster/tf-a';
    const hostOtherRegion = 'arn:aws:eks:us-east-1:111111111111:cluster/tf-a';
    query.mockResolvedValue({ rows: [] });
    const { registerCluster, isAllowed } = await import('./eks-registry');
    expect(await isAllowed(member)).toBe(false);
    expect(await isAllowed(hostOtherRegion)).toBe(false);
    await registerCluster(member, 'u');
    expect(query.mock.calls.at(-1)?.[1]).toEqual([member, 'u']);
    query.mockResolvedValue({ rows: [{ cluster_name: member }] });
    expect(await isAllowed(member)).toBe(true);
    expect(await isAllowed('tf-a')).toBe(true);
    expect(await isAllowed(hostOtherRegion)).toBe(false);
  });

  it('rechecks target enabled state before returning cached allow-list or credentials', async () => {
    const member = 'arn:aws:eks:us-east-1:222222222222:cluster/tf-a';
    query.mockResolvedValue({ rows: [{ cluster_name: member, auth: { mode: 'sa-token', token: 'member-token' } }] });
    const { isAllowed, getClusterAuth } = await import('./eks-registry');
    expect(await isAllowed(member)).toBe(true);
    expect(await getClusterAuth(member)).toEqual({ mode: 'sa-token', token: 'member-token' });
    getAccount.mockResolvedValue({ accountId: '222222222222', enabled: false });
    await expect(isAllowed(member)).rejects.toMatchObject({ status: 403 });
    await expect(getClusterAuth(member)).rejects.toMatchObject({ status: 403 });
  });

  it('does not switch saved token identity to task role when auth storage fails', async () => {
    query.mockRejectedValue(new Error('db unavailable'));
    const { getClusterAuth } = await import('./eks-registry');
    await expect(getClusterAuth('tf-a')).rejects.toMatchObject({ status: 503 });
  });

  it('unregister clears cached authentication before the same ID can be registered again', async () => {
    query.mockResolvedValue({ rows: [{ auth: { mode: 'sa-token', token: 'old-token' } }] });
    const { getClusterAuth, unregisterCluster, registerCluster } = await import('./eks-registry');
    expect(await getClusterAuth('reused')).toEqual({ mode: 'sa-token', token: 'old-token' });
    query.mockResolvedValue({ rows: [], rowCount: 1 });
    await unregisterCluster('reused');
    await registerCluster('reused', 'u');
    expect(await getClusterAuth('reused')).toBeNull();
  });

  it.each(['111111111111', '333333333333'])('rejects persisting and reading member overrides from account %s', async accountId => {
    const member = 'arn:aws:eks:us-east-1:222222222222:cluster/shared';
    const auth = { mode: 'assume-role' as const, roleArn: `arn:aws:iam::${accountId}:role/OtherReader` };
    const { setClusterAuth, getClusterAuth } = await import('./eks-registry');
    await expect(setClusterAuth(member, 'admin', auth)).rejects.toMatchObject({ status: 403 });
    expect(query).not.toHaveBeenCalled();
    // Existing rows from the former host-token design are also rejected on read.
    query.mockResolvedValue({ rows: [{ auth }] });
    await expect(getClusterAuth(member)).rejects.toMatchObject({ status: 403 });
  });

  it('allows a scoped member role override and keeps its cached auth isolated from the host key', async () => {
    const member = 'arn:aws:eks:us-east-1:222222222222:cluster/shared';
    const auth = { mode: 'assume-role' as const, roleArn: 'arn:aws:iam::222222222222:role/ScopedReader' };
    query.mockResolvedValue({ rows: [{ auth }] });
    const { setClusterAuth, getClusterAuth } = await import('./eks-registry');
    expect(await setClusterAuth(member, 'admin', auth)).toBe(true);
    expect(await getClusterAuth(member)).toEqual(auth);
    query.mockResolvedValue({ rows: [] });
    expect(await getClusterAuth('shared')).toBeNull();
    expect(await getClusterAuth(member)).toEqual(auth);
  });

  it('removes a canonical member registration even after the account registry becomes unavailable', async () => {
    const member = 'arn:aws:eks:us-east-1:222222222222:cluster/shared';
    getAccount.mockRejectedValue(new Error('account removed'));
    query.mockResolvedValue({ rows: [], rowCount: 1 });
    const { unregisterCluster } = await import('./eks-registry');
    expect(await unregisterCluster(member)).toBe('deleted');
    expect(query).toHaveBeenCalledWith('DELETE FROM eks_registrations WHERE cluster_name = $1', [member]);
    expect(getAccount).not.toHaveBeenCalled();
  });

  it('protects Terraform env registrations even for direct unregister helper calls', async () => {
    const { unregisterCluster } = await import('./eks-registry');
    await expect(unregisterCluster('arn:aws:eks:ap-northeast-2:111111111111:cluster/tf-a'))
      .rejects.toMatchObject({ status: 400 });
    expect(query).not.toHaveBeenCalled();
  });
});
