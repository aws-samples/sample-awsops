import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getAccount = vi.fn();
const listScanScope = vi.fn();
vi.mock('./accounts', () => ({ getAccount: (...args: unknown[]) => getAccount(...args) }));
vi.mock('./account-regions', () => ({ listScanScope: () => listScanScope() }));

const HOST = '111111111111';
const MEMBER = '222222222222';
const ARN = `arn:aws:eks:us-east-1:${MEMBER}:cluster/shared`;

beforeEach(() => {
  vi.stubEnv('HOST_ACCOUNT_ID', HOST);
  vi.stubEnv('AWS_REGION', 'ap-northeast-2');
  getAccount.mockReset().mockResolvedValue({
    accountId: MEMBER, isHost: false, enabled: true, region: 'us-east-1',
  });
  listScanScope.mockReset().mockResolvedValue([
    { accountId: MEMBER, regions: ['us-east-1', 'ap-northeast-2'] },
  ]);
});
afterEach(() => vi.unstubAllEnvs());

describe('resolveEksCluster', () => {
  it('keeps the legacy host path independent of the registry', async () => {
    const { resolveEksCluster } = await import('./eks-context');
    expect(await resolveEksCluster('shared')).toEqual({
      id: 'shared', name: 'shared', accountId: 'self', region: 'ap-northeast-2',
    });
    expect(getAccount).not.toHaveBeenCalled();
    expect(listScanScope).not.toHaveBeenCalled();
  });

  it('resolves a name plus target query to the same ID as an ARN', async () => {
    const { resolveEksCluster } = await import('./eks-context');
    const expected = { id: ARN, name: 'shared', accountId: MEMBER, region: 'us-east-1' };
    expect(await resolveEksCluster('shared', new URLSearchParams(`account=${MEMBER}&region=us-east-1`))).toEqual(expected);
    expect(await resolveEksCluster(ARN)).toEqual(expected);
  });

  it('defaults member names to the registered account region', async () => {
    const { resolveEksCluster } = await import('./eks-context');
    expect(await resolveEksCluster('shared', new URLSearchParams(`account=${MEMBER}`))).toMatchObject({ id: ARN });
  });

  it('normalizes host ARNs to bare names only in the deployment region', async () => {
    const { resolveEksCluster } = await import('./eks-context');
    expect((await resolveEksCluster(`arn:aws:eks:ap-northeast-2:${HOST}:cluster/shared`)).id).toBe('shared');
    expect(await resolveEksCluster('shared', new URLSearchParams('account=self&region=us-east-1')))
      .toEqual({ id: `arn:aws:eks:us-east-1:${HOST}:cluster/shared`, name: 'shared', accountId: 'self', region: 'us-east-1' });
  });

  it.each(['account=self', `account=${HOST}`, 'region=us-west-2'])('rejects ARN/query conflicts: %s', async query => {
    const { resolveEksCluster } = await import('./eks-context');
    await expect(resolveEksCluster(ARN, new URLSearchParams(query))).rejects.toMatchObject({ status: 400 });
  });

  it.each(['account=', 'account=all', 'account=123', 'region=', 'region=oops', 'region=us-east-1&region=us-west-2'])(
    'rejects malformed scope: %s', async query => {
      const { resolveEksCluster } = await import('./eks-context');
      await expect(resolveEksCluster('shared', new URLSearchParams(query))).rejects.toMatchObject({ status: 400 });
    },
  );

  it.each([
    `accounts=${MEMBER}`,
    'accounts=member',
    'accounts=',
    'regions=us-east-1',
    'regions=',
    `account=self&accounts=${MEMBER}`,
    `account=${MEMBER}&accounts=${MEMBER}`,
    'region=ap-northeast-2&regions=us-east-1',
    `accounts=${MEMBER}&accounts=${MEMBER}`,
    'regions=us-east-1&regions=us-east-1',
    `account=${MEMBER}&account=${MEMBER}`,
    'region=us-east-1&region=us-east-1',
  ])('rejects plural, mixed, and repeated detail selectors before account/data reads: %s', async query => {
    const { resolveEksCluster } = await import('./eks-context');
    await expect(resolveEksCluster('shared', new URLSearchParams(query))).rejects.toMatchObject({ status: 400 });
    expect(getAccount).not.toHaveBeenCalled();
    expect(listScanScope).not.toHaveBeenCalled();
  });

  it('rejects collection-style plural selectors on an otherwise valid ARN', async () => {
    const { resolveEksCluster } = await import('./eks-context');
    await expect(resolveEksCluster(ARN, new URLSearchParams(`accounts=${MEMBER}`))).rejects.toMatchObject({ status: 400 });
    expect(getAccount).not.toHaveBeenCalled();
  });

  it.each([undefined, { accountId: MEMBER, enabled: false }, { accountId: MEMBER, enabled: true, isHost: true }])(
    'fails closed for unknown, disabled, or mismatched host targets', async account => {
      getAccount.mockResolvedValue(account);
      const { resolveEksCluster } = await import('./eks-context');
      await expect(resolveEksCluster(ARN)).rejects.toMatchObject({ status: 403 });
    },
  );

  it('rejects disabled target regions, while honoring all-regions registrations', async () => {
    const { resolveEksCluster } = await import('./eks-context');
    listScanScope.mockResolvedValue([{ accountId: MEMBER, regions: ['us-west-2'] }]);
    await expect(resolveEksCluster(ARN)).rejects.toMatchObject({ status: 403 });
    listScanScope.mockResolvedValue([{ accountId: MEMBER, regions: ['*'] }]);
    expect((await resolveEksCluster(ARN)).id).toBe(ARN);
  });

  it('maps registry failures to 503 without host fallback', async () => {
    getAccount.mockRejectedValue(new Error('database unavailable'));
    const { resolveEksCluster } = await import('./eks-context');
    await expect(resolveEksCluster(ARN)).rejects.toMatchObject({ status: 503 });
  });

  it('cannot qualify a host non-default region without a known host account', async () => {
    vi.stubEnv('HOST_ACCOUNT_ID', '');
    const { resolveEksCluster } = await import('./eks-context');
    await expect(resolveEksCluster('shared', new URLSearchParams('region=us-east-1'))).rejects.toMatchObject({ status: 503 });
  });
});

describe('resolveEksClusterForRemoval', () => {
  it('canonicalizes an ARN without consulting account or enabled-region registries', async () => {
    getAccount.mockRejectedValue(new Error('account no longer exists'));
    listScanScope.mockRejectedValue(new Error('scope unavailable'));
    const { resolveEksClusterForRemoval } = await import('./eks-context');
    expect(resolveEksClusterForRemoval(ARN)).toEqual({
      id: ARN, name: 'shared', accountId: MEMBER, region: 'us-east-1',
    });
    expect(getAccount).not.toHaveBeenCalled();
    expect(listScanScope).not.toHaveBeenCalled();
  });

  it('derives the exact member ID from an explicit account and region without account lookup', async () => {
    const { resolveEksClusterForRemoval } = await import('./eks-context');
    expect(resolveEksClusterForRemoval('shared', new URLSearchParams(`account=${MEMBER}&region=us-east-1`)).id).toBe(ARN);
    expect(getAccount).not.toHaveBeenCalled();
  });

  it('requires a region for a bare member name rather than guessing a registry default', async () => {
    const { resolveEksClusterForRemoval } = await import('./eks-context');
    expect(() => resolveEksClusterForRemoval('shared', new URLSearchParams(`account=${MEMBER}`)))
      .toThrow(expect.objectContaining({ status: 400 }));
    expect(getAccount).not.toHaveBeenCalled();
  });

  it('preserves legacy host identity and normalizes host default-region ARN aliases', async () => {
    const { resolveEksClusterForRemoval } = await import('./eks-context');
    expect(resolveEksClusterForRemoval('shared').id).toBe('shared');
    expect(resolveEksClusterForRemoval(`arn:aws:eks:ap-northeast-2:${HOST}:cluster/shared`).id).toBe('shared');
  });

  it.each([
    'account=self', 'region=us-west-2', `accounts=${MEMBER}`, 'regions=us-east-1',
    `account=${MEMBER}&account=${MEMBER}`, 'region=us-east-1&region=us-east-1',
  ])('rejects conflicting/ambiguous cleanup selectors: %s', async search => {
    const { resolveEksClusterForRemoval } = await import('./eks-context');
    expect(() => resolveEksClusterForRemoval(ARN, new URLSearchParams(search)))
      .toThrow(expect.objectContaining({ status: 400 }));
    expect(getAccount).not.toHaveBeenCalled();
    expect(listScanScope).not.toHaveBeenCalled();
  });
});
