import { beforeEach, describe, expect, it, vi } from 'vitest';

const listAccounts = vi.fn();
const listAccountRegions = vi.fn();
const listScanScope = vi.fn();
const getAllowedClusters = vi.fn();
vi.mock('./accounts', () => ({ listAccounts: (...args: unknown[]) => listAccounts(...args) }));
vi.mock('./account-regions', () => ({
  listAccountRegions: (...args: unknown[]) => listAccountRegions(...args),
  listScanScope: (...args: unknown[]) => listScanScope(...args),
}));
vi.mock('./eks-registry', () => ({
  getAllowedClusters: (...args: unknown[]) => getAllowedClusters(...args),
}));

const HOST = '111111111111';
const MEMBER = '222222222222';
const memberCluster = `arn:aws:eks:ap-northeast-2:${MEMBER}:cluster/shared`;

beforeEach(() => {
  vi.stubEnv('HOST_ACCOUNT_ID', HOST);
  vi.stubEnv('AWS_REGION', 'ap-northeast-2');
  listAccounts.mockReset().mockResolvedValue([
    { accountId: HOST, isHost: true, enabled: true, region: 'ap-northeast-2' },
    { accountId: MEMBER, isHost: false, enabled: true, region: 'ap-northeast-2' },
    { accountId: '333333333333', isHost: false, enabled: false, region: 'us-east-1' },
  ]);
  listAccountRegions.mockReset().mockResolvedValue([
    { accountId: HOST, region: 'ap-northeast-2', enabled: true },
    { accountId: MEMBER, region: 'ap-northeast-2', enabled: true },
    { accountId: MEMBER, region: 'us-east-1', enabled: true },
  ]);
  listScanScope.mockReset().mockResolvedValue([
    { accountId: HOST, regions: ['*'] }, { accountId: MEMBER, regions: ['ap-northeast-2', 'us-east-1'] },
  ]);
  getAllowedClusters.mockReset().mockResolvedValue(new Set(['shared', memberCluster]));
});

describe('EKS collection scope', () => {
  it('keeps the legacy no-parameter request on the host deployment region', async () => {
    const { getEksScope } = await import('./eks-scope');
    expect(await getEksScope(new URLSearchParams())).toEqual({
      targets: [{ accountId: 'self', region: 'ap-northeast-2' }], truncated: false,
    });
    expect(listAccounts).not.toHaveBeenCalled();
  });

  it('uses an explicitly selected member account and region', async () => {
    const { getEksScope } = await import('./eks-scope');
    expect((await getEksScope(new URLSearchParams(`accounts=${MEMBER}&regions=us-east-1`))).targets)
      .toEqual([{ accountId: MEMBER, region: 'us-east-1' }]);
  });

  it('enumerates enabled accounts for all instead of mapping all to host', async () => {
    const { getEksScope } = await import('./eks-scope');
    expect((await getEksScope(new URLSearchParams('account=__all__&regions=ap-northeast-2'))).targets)
      .toEqual([
        { accountId: 'self', region: 'ap-northeast-2' },
        { accountId: MEMBER, region: 'ap-northeast-2' },
      ]);
  });

  it('expands all enabled regions separately for each selected account', async () => {
    const { getEksScope } = await import('./eks-scope');
    expect((await getEksScope(new URLSearchParams(`accounts=${MEMBER}&regions=__all__`))).targets)
      .toEqual([
        { accountId: MEMBER, region: 'ap-northeast-2' },
        { accountId: MEMBER, region: 'us-east-1' },
      ]);
  });

  it.each(['333333333333', '444444444444'])('rejects disabled or unregistered account %s', async id => {
    const { getEksScope } = await import('./eks-scope');
    await expect(getEksScope(new URLSearchParams(`account=${id}`))).rejects.toMatchObject({ status: 403 });
  });

  it.each(['accounts=', 'account=invalid', 'accounts=__all__,self', 'regions=invalid', 'account=self&account=222222222222'])(
    'rejects malformed explicit scope rather than expanding to host: %s', async query => {
      const { getEksScope } = await import('./eks-scope');
      await expect(getEksScope(new URLSearchParams(query))).rejects.toMatchObject({ status: 400 });
    },
  );

  it('does not replace registry failure with host scope', async () => {
    listAccounts.mockRejectedValue(new Error('db unavailable'));
    const { getEksScope } = await import('./eks-scope');
    await expect(getEksScope(new URLSearchParams(`account=${MEMBER}`))).rejects.toMatchObject({ status: 503 });
  });

  it('rejects a member incorrectly marked as host instead of substituting host credentials', async () => {
    listAccounts.mockResolvedValue([{ accountId: MEMBER, isHost: true, enabled: true }]);
    const { getEksScope } = await import('./eks-scope');
    await expect(getEksScope(new URLSearchParams(`account=${MEMBER}`))).rejects.toMatchObject({ status: 403 });
  });

  it('rejects a disabled member region before it can be queried', async () => {
    listScanScope.mockResolvedValue([{ accountId: MEMBER, regions: ['ap-northeast-2'] }]);
    const { getEksScope } = await import('./eks-scope');
    await expect(getEksScope(new URLSearchParams(`account=${MEMBER}&region=us-east-1`)))
      .rejects.toMatchObject({ status: 403 });
  });

  it('reports when the requested account/region fan-out was capped', async () => {
    const regions = Array.from({ length: 15 }, (_, i) => `us-test-${i + 1}`);
    listScanScope.mockResolvedValue([{ accountId: MEMBER, regions: ['*'] }]);
    const { getEksScope } = await import('./eks-scope');
    const scope = await getEksScope(new URLSearchParams(`account=${MEMBER}&regions=${regions.join(',')}`));
    expect(scope.targets).toHaveLength(12);
    expect(scope.truncated).toBe(true);
  });

  it('separates registered same-name clusters by account', async () => {
    const { getScopedEksRegistrations } = await import('./eks-scope');
    expect((await getScopedEksRegistrations(new URLSearchParams(`account=${MEMBER}`))).clusters)
      .toEqual([{ id: memberCluster, name: 'shared', accountId: MEMBER, region: 'ap-northeast-2' }]);
    expect((await getScopedEksRegistrations(new URLSearchParams())).clusters)
      .toEqual([{ id: 'shared', name: 'shared', accountId: 'self', region: 'ap-northeast-2' }]);
  });

  it('does not query an unselected region from the registered fleet', async () => {
    getAllowedClusters.mockResolvedValue(new Set([
      memberCluster, `arn:aws:eks:us-east-1:${MEMBER}:cluster/shared`,
    ]));
    const { getScopedEksRegistrations } = await import('./eks-scope');
    expect((await getScopedEksRegistrations(
      new URLSearchParams(`accounts=${MEMBER}&regions=us-east-1`),
    )).clusters.map(c => c.id)).toEqual([`arn:aws:eks:us-east-1:${MEMBER}:cluster/shared`]);
  });

  it.each([HOST, MEMBER])('includes registered nondefault regions in an all-region wildcard fleet: %s', async accountId => {
    listScanScope.mockResolvedValue([{ accountId, regions: ['*'] }]);
    const id = `arn:aws:eks:us-west-2:${accountId}:cluster/shared`;
    getAllowedClusters.mockResolvedValue(new Set([id]));
    const { getScopedEksRegistrations } = await import('./eks-scope');
    const result = await getScopedEksRegistrations(new URLSearchParams(`accounts=${accountId}&regions=__all__`));
    expect(result).toMatchObject({ clusters: [{ id, name: 'shared', region: 'us-west-2' }], truncated: false });
  });

  it('discloses limited wildcard discovery instead of asserting complete regional enumeration', async () => {
    listScanScope.mockResolvedValue([{ accountId: MEMBER, regions: ['*'] }]);
    getAllowedClusters.mockResolvedValue(new Set([
      memberCluster, `arn:aws:eks:us-west-2:${MEMBER}:cluster/shared`,
    ]));
    const { getEksScope } = await import('./eks-scope');
    const scope = await getEksScope(new URLSearchParams(`accounts=${MEMBER}&regions=__all__`));
    expect(scope.targets).toContainEqual({ accountId: MEMBER, region: 'us-west-2' });
    expect(scope.errors).toEqual([expect.objectContaining({ accountId: MEMBER, region: '__all__' })]);
  });

  it('does not apply the discovery region cap to an otherwise complete registered fleet', async () => {
    const ids = Array.from({ length: 15 }, (_, i) => `arn:aws:eks:us-test-${i + 1}:${MEMBER}:cluster/shared`);
    listScanScope.mockResolvedValue([{ accountId: MEMBER, regions: ['*'] }]);
    getAllowedClusters.mockResolvedValue(new Set(ids));
    const { getScopedEksRegistrations } = await import('./eks-scope');
    const result = await getScopedEksRegistrations(new URLSearchParams(`accounts=${MEMBER}&regions=__all__`));
    expect(result.clusters.map(cluster => cluster.id)).toEqual(ids);
    expect(result.truncated).toBe(false);
  });
});
