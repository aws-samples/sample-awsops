import { describe, it, expect, vi, beforeEach } from 'vitest';

const send = vi.fn();
const getAccount = vi.fn();
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn(() => ({ send })),
  AssumeRoleCommand: vi.fn((input: unknown) => ({ __cmd: 'AssumeRole', input })),
}));
vi.mock('@/lib/accounts', () => ({ getAccount: (...a: unknown[]) => getAccount(...a) }));
vi.mock('@/lib/account', () => ({ currentAccountId: () => '123456789012' }));

const HOST = '123456789012';
const TARGET = '210987654321';
const okCreds = { Credentials: { AccessKeyId: 'AKIA', SecretAccessKey: 'sk', SessionToken: 'tok', Expiration: new Date('2030-01-01') } };
const acct = (over = {}) => ({ accountId: TARGET, alias: 'P', region: 'ap-northeast-2', isHost: false, roleName: 'AWSopsReadOnlyRole', externalId: 'ext-1', enabled: true, status: 'verified', lastVerifiedAt: null, ...over });

beforeEach(() => { vi.resetModules(); send.mockReset(); send.mockResolvedValue(okCreds); getAccount.mockReset(); });

describe('credsForAccount', () => {
  it('host / self / empty → null, no AssumeRole', async () => {
    const { credsForAccount } = await import('./aws-assume');
    expect(await credsForAccount(HOST)).toBeNull();
    expect(await credsForAccount('self')).toBeNull();
    expect(await credsForAccount('')).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('target → AssumeRole with the AWSopsReadOnlyRole ARN + ExternalId', async () => {
    getAccount.mockResolvedValue(acct());
    const { credsForAccount } = await import('./aws-assume');
    const c = await credsForAccount(TARGET);
    expect(c).toMatchObject({ accessKeyId: 'AKIA', secretAccessKey: 'sk', sessionToken: 'tok' });
    expect(send).toHaveBeenCalledTimes(1);
    const input = (send.mock.calls[0][0] as { input: Record<string, unknown> }).input;
    expect(input.RoleArn).toBe(`arn:aws:iam::${TARGET}:role/AWSopsReadOnlyRole`);
    expect(input.ExternalId).toBe('ext-1');
  });

  it('target without ExternalId (1st-party) → AssumeRole omits ExternalId, still assumes', async () => {
    getAccount.mockResolvedValue(acct({ externalId: null }));
    const { credsForAccount } = await import('./aws-assume');
    const c = await credsForAccount(TARGET);
    expect(c).toMatchObject({ accessKeyId: 'AKIA', secretAccessKey: 'sk', sessionToken: 'tok' });
    expect(send).toHaveBeenCalledTimes(1);
    const input = (send.mock.calls[0][0] as { input: Record<string, unknown> }).input;
    expect(input.RoleArn).toBe(`arn:aws:iam::${TARGET}:role/AWSopsReadOnlyRole`);
    expect('ExternalId' in input).toBe(false);
  });

  it('no-ExternalId and with-ExternalId have distinct cache keys', async () => {
    getAccount.mockResolvedValueOnce(acct({ externalId: null })).mockResolvedValueOnce(acct({ externalId: 'ext-1' }));
    const { credsForAccount } = await import('./aws-assume');
    await credsForAccount(TARGET);
    await credsForAccount(TARGET);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('caches within TTL (one AssumeRole for repeated calls)', async () => {
    getAccount.mockResolvedValue(acct());
    const { credsForAccount } = await import('./aws-assume');
    await credsForAccount(TARGET);
    await credsForAccount(TARGET);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rotating the ExternalId busts the cache', async () => {
    getAccount.mockResolvedValueOnce(acct({ externalId: 'ext-1' })).mockResolvedValueOnce(acct({ externalId: 'ext-2' }));
    const { credsForAccount } = await import('./aws-assume');
    await credsForAccount(TARGET);
    await credsForAccount(TARGET);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('unknown account → throws', async () => {
    getAccount.mockResolvedValue(undefined);
    const { credsForAccount } = await import('./aws-assume');
    await expect(credsForAccount(TARGET)).rejects.toThrow();
  });
});

describe('assumedClient', () => {
  it('host → client built with default creds (no credentials option)', async () => {
    const { assumedClient } = await import('./aws-assume');
    const Ctor = vi.fn();
    await assumedClient(HOST, Ctor as never, { region: 'us-east-1' });
    expect(Ctor).toHaveBeenCalledWith({ region: 'us-east-1' });
  });

  it('target → client built with assumed credentials', async () => {
    getAccount.mockResolvedValue(acct());
    const { assumedClient } = await import('./aws-assume');
    const Ctor = vi.fn();
    await assumedClient(TARGET, Ctor as never, { region: 'us-east-1' });
    const arg = Ctor.mock.calls[0][0] as { credentials?: unknown };
    expect(arg.credentials).toMatchObject({ accessKeyId: 'AKIA' });
  });
});
