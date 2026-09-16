import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Exercise the real account reader, registry, credsForAccount, and token signer.
// Mock only SQL, STS, and the local host provider; no AWS calls leave this test.
const query = vi.fn();
const stsSend = vi.fn();
const hostProvider = vi.fn();
vi.mock('./db', () => ({ getPool: () => ({ query: (...args: unknown[]) => query(...args) }) }));
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class { send = (...args: unknown[]) => stsSend(...args); },
  AssumeRoleCommand: class AssumeRoleCommand { constructor(public input: unknown) {} },
  GetCallerIdentityCommand: class GetCallerIdentityCommand { constructor(public input: unknown) {} },
}));
vi.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: () => hostProvider(),
}));

const MEMBER_ID = 'arn:aws:eks:us-east-1:222222222222:cluster/shared';
let enabled = true;
let savedAuth: { mode: 'assume-role'; roleArn: string } | null = null;
const decode = (token: string) => new URL(Buffer.from(token.slice('k8s-aws-v1.'.length), 'base64url').toString());

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('HOST_ACCOUNT_ID', '111111111111');
  vi.stubEnv('AWS_REGION', 'us-east-1');
  vi.stubEnv('AURORA_ENDPOINT', 'mock-db');
  enabled = true;
  savedAuth = null;
  query.mockReset().mockImplementation(async (sql: string, values: unknown[] = []) => {
    if (sql === 'SELECT * FROM accounts WHERE account_id = $1') {
      expect(values).toEqual(['222222222222']);
      return { rows: [{
        account_id: '222222222222', alias: 'Member', region: 'us-east-1', is_host: false,
        role_name: 'RegisteredTenantReader', external_id: 'tenant-binding', enabled,
        status: 'verified', last_verified_at: null,
      }] };
    }
    if (sql.includes('FROM accounts a')) {
      return { rows: enabled ? [{
        account_id: '222222222222', all_regions: false, is_host: false, regions: ['us-east-1'],
      }] : [] };
    }
    if (sql === 'SELECT auth FROM eks_registrations WHERE cluster_name = $1') {
      return { rows: values[0] === MEMBER_ID && savedAuth ? [{ auth: savedAuth }] : [] };
    }
    throw new Error(`Unexpected test SQL: ${sql}`);
  });
  stsSend.mockReset().mockResolvedValue({ Credentials: {
    AccessKeyId: 'MEMBER_STS_KEY', SecretAccessKey: 'member-test-secret', SessionToken: 'member-session',
  } });
  hostProvider.mockReset().mockReturnValue(async () => ({
    accessKeyId: 'HOST_TASK_KEY', secretAccessKey: 'host-test-secret', sessionToken: 'host-session',
  }));
});
afterEach(() => vi.unstubAllEnvs());

describe('member token isolation through the real credential helper', () => {
  it('derives member credentials from its registered role and ExternalId; a same-name host uses different credentials', async () => {
    const { eksToken } = await import('./eks-incluster');
    const member = decode(await eksToken(MEMBER_ID));
    expect(hostProvider).not.toHaveBeenCalled();
    expect(stsSend).toHaveBeenCalledTimes(1);
    expect(stsSend.mock.calls[0][0].constructor.name).toBe('AssumeRoleCommand');
    expect(stsSend.mock.calls[0][0].input).toEqual({
      RoleArn: 'arn:aws:iam::222222222222:role/RegisteredTenantReader',
      RoleSessionName: 'awsops-web', ExternalId: 'tenant-binding', DurationSeconds: 3600,
    });
    const host = decode(await eksToken('shared'));
    expect(member.searchParams.get('X-Amz-Credential')).toContain('MEMBER_STS_KEY/');
    expect(host.searchParams.get('X-Amz-Credential')).toContain('HOST_TASK_KEY/');
    expect(member.hostname).toBe('sts.us-east-1.amazonaws.com');
    expect(member.searchParams.get('X-Amz-SignedHeaders')).toContain('x-k8s-aws-id');
    expect(stsSend).toHaveBeenCalledTimes(1); // no host self-assume or caller-identity lookup
    expect(hostProvider).toHaveBeenCalledTimes(1);
  });

  it('checks member enabled state before credentials cached by the real helper are reused', async () => {
    const { eksToken } = await import('./eks-incluster');
    await eksToken(MEMBER_ID);
    await eksToken(MEMBER_ID);
    expect(stsSend).toHaveBeenCalledTimes(1);
    enabled = false;
    await expect(eksToken(MEMBER_ID)).rejects.toMatchObject({ status: 403 });
    expect(hostProvider).not.toHaveBeenCalled();
    expect(stsSend).toHaveBeenCalledTimes(1);
  });

  it('rejects a foreign-role override read from the real registry before making any STS request', async () => {
    savedAuth = { mode: 'assume-role', roleArn: 'arn:aws:iam::111111111111:role/HostReader' };
    const { eksToken } = await import('./eks-incluster');
    await expect(eksToken(MEMBER_ID)).rejects.toMatchObject({ status: 403 });
    expect(stsSend).not.toHaveBeenCalled();
    expect(hostProvider).not.toHaveBeenCalled();
  });

  it('fails closed when the real member AssumeRole operation returns no credentials', async () => {
    stsSend.mockResolvedValue({});
    const { eksToken } = await import('./eks-incluster');
    await expect(eksToken(MEMBER_ID)).rejects.toMatchObject({
      status: 503, message: 'EKS authentication unavailable',
    });
    expect(hostProvider).not.toHaveBeenCalled();
  });
});
