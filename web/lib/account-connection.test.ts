import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const aws = vi.hoisted(() => ({
  send: vi.fn(), destroy: vi.fn(), configurations: [] as unknown[], requestRegions: [] as unknown[],
}));
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    constructor(private options: { region?: unknown }) { aws.configurations.push(options); }
    send(command: unknown, options: unknown) {
      aws.requestRegions.push(this.options.region);
      return aws.send(command, options);
    }
    destroy = aws.destroy;
  },
  GetCallerIdentityCommand: class { constructor(public input: unknown) {} },
  AssumeRoleCommand: class { constructor(public input: unknown) {} },
}));
import { verifyAccountConnection } from './account-connection';

const input = { accountId: '222222222222', region: 'ap-northeast-2', externalId: 'keep-this-value-private', firstParty: false };
const settings = { hostAccountId: '111111111111', registrationEnabled: false };
const host = { Account: settings.hostAccountId, Arn: 'arn:aws:sts::111111111111:assumed-role/awsops-dev-task/task-id' };
const credentials = { AccessKeyId: 'access-key-private', SecretAccessKey: 'secret-key-private', SessionToken: 'session-token-private' };
const requestId = '01234567-89ab-cdef-0123-456789abcdef';

beforeEach(() => {
  vi.resetAllMocks();
  aws.configurations.length = 0;
  aws.requestRegions.length = 0;
  aws.send.mockResolvedValueOnce(host)
    .mockResolvedValueOnce({ Credentials: credentials })
    .mockResolvedValueOnce({ Account: input.accountId, $metadata: { requestId } });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('account connection verification', () => {
  it.each(['ap-east-1', 'zz-unavailable-1'])('pins STS to the deployment region while retaining requested %s metadata', async region => {
    vi.stubEnv('AWS_REGION', 'us-west-2');
    vi.resetModules();
    const { verifyAccountConnection: verify } = await import('./account-connection');
    const result = await verify({ ...input, region }, settings);
    expect(result).toMatchObject({ verified: true, region, stsRegion: 'us-west-2' });
    expect(aws.configurations).toHaveLength(2);
    for (const configuration of aws.configurations) expect(configuration).toMatchObject({ region: 'us-west-2' });
  });
  it.each([
    ['ap-northeast-2', 'ap-east-1'],
    ['ap-northeast-2', 'xx-nonexistent-1'],
    ['eu-west-1', 'ap-east-1'],
    [undefined, 'ap-east-1'],
    ['', 'xx-nonexistent-1'],
  ])('uses deployment region %s for all STS stages while retaining selected region %s', async (deploymentRegion, selectedRegion) => {
    vi.stubEnv('AWS_REGION', deploymentRegion);
    const result = await verifyAccountConnection({ ...input, region: selectedRegion! }, settings);
    const expected = deploymentRegion || 'ap-northeast-2';
    expect(aws.configurations).toEqual([
      { region: expected, maxAttempts: 2 },
      { region: expected, maxAttempts: 2, credentials: {
        accessKeyId: credentials.AccessKeyId, secretAccessKey: credentials.SecretAccessKey,
        sessionToken: credentials.SessionToken,
      } },
    ]);
    expect(aws.requestRegions).toEqual([expected, expected, expected]);
    expect(result).toMatchObject({ verified: true, region: selectedRegion, stage: 'get_caller_identity' });
    expect(aws.destroy).toHaveBeenCalledTimes(2);
  });

  it('verifies the real web role and target even while registration is host-only', async () => {
    const result = await verifyAccountConnection(input, settings);
    expect(result).toMatchObject({
      verified: true, code: 'verified', stage: 'get_caller_identity', registrationEnabled: false,
      accountId: input.accountId, roleArn: 'arn:aws:iam::222222222222:role/AWSopsReadOnlyRole',
      hostTaskRoleArn: 'arn:aws:iam::111111111111:role/awsops-dev-task',
      externalIdProvided: true, awsRequestId: requestId,
    });
    expect(result.checkId).toMatch(/^[a-f0-9-]{36}$/);
    expect(Number.isFinite(Date.parse(result.checkedAt))).toBe(true);
    expect(aws.send.mock.calls[1][0].input).toMatchObject({
      RoleArn: result.roleArn, ExternalId: input.externalId, DurationSeconds: 900,
    });
    expect(aws.send.mock.calls[2][0].input).toEqual({});
    const output = JSON.stringify(result);
    for (const secret of [input.externalId, ...Object.values(credentials)]) expect(output).not.toContain(secret);
    expect(aws.destroy).toHaveBeenCalledTimes(2);
  });

  it('reports AccessDenied at the assume stage without exposing AWS error text', async () => {
    aws.send.mockReset().mockResolvedValueOnce(host).mockRejectedValueOnce(Object.assign(
      new Error(`ExternalId=${input.externalId}; ${credentials.SessionToken}`),
      { name: 'AccessDenied', $metadata: { requestId } },
    ));
    const result = await verifyAccountConnection(input, settings);
    expect(result).toMatchObject({ verified: false, stage: 'assume_role', code: 'access_denied', awsRequestId: requestId });
    expect(aws.send).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain(input.externalId);
    expect(JSON.stringify(result)).not.toContain(credentials.SessionToken);
  });

  it('does not assume any target if the web identity is from a different account', async () => {
    aws.send.mockReset().mockResolvedValueOnce({ ...host, Account: '333333333333' });
    expect(await verifyAccountConnection(input, settings)).toMatchObject({
      verified: false, stage: 'host_identity', code: 'host_identity_unavailable', hostTaskRoleArn: null,
    });
    expect(aws.send).toHaveBeenCalledTimes(1);
  });

  it('rejects host identity that is not a matching assumed role', async () => {
    aws.send.mockReset().mockResolvedValueOnce({ ...host, Arn: 'arn:aws:iam::111111111111:root' });
    expect(await verifyAccountConnection(input, settings)).toMatchObject({ code: 'host_identity_unavailable' });
    expect(aws.send).toHaveBeenCalledTimes(1);
  });

  it('fails if STS does not return all three temporary credential fields', async () => {
    aws.send.mockReset().mockResolvedValueOnce(host).mockResolvedValueOnce({ Credentials: { AccessKeyId: 'incomplete' } });
    expect(await verifyAccountConnection(input, settings)).toMatchObject({
      verified: false, stage: 'assume_role', code: 'invalid_response',
    });
    expect(aws.send).toHaveBeenCalledTimes(2);
  });

  it('does not certify a different target account', async () => {
    aws.send.mockReset().mockResolvedValueOnce(host).mockResolvedValueOnce({ Credentials: credentials })
      .mockResolvedValueOnce({ Account: '333333333333' });
    expect(await verifyAccountConnection(input, settings)).toMatchObject({
      verified: false, stage: 'get_caller_identity', code: 'identity_mismatch',
    });
  });

  it.each([
    ['ExpiredTokenException', 'expired_credentials'],
    ['InvalidClientTokenId', 'invalid_credentials'],
    ['ThrottlingException', 'throttled'],
    ['AbortError', 'timeout'],
    ['untrusted-value-with-private-token', 'aws_error'],
  ])('classifies %s without reflecting an arbitrary upstream name', async (name, code) => {
    aws.send.mockReset().mockResolvedValueOnce(host).mockRejectedValueOnce(
      Object.assign(new Error('private'), { name, $metadata: { requestId: 'not-a-request-id/private' } }),
    );
    expect(await verifyAccountConnection(input, settings)).toMatchObject({
      verified: false, stage: 'assume_role', code, awsRequestId: null,
    });
  });

  it('bounds all STS stages by the same abort deadline and destroys clients', async () => {
    vi.useFakeTimers();
    aws.send.mockReset().mockResolvedValueOnce(host).mockImplementationOnce((_command, options) => new Promise((_resolve, reject) => {
      options.abortSignal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const pending = verifyAccountConnection(input, settings);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toMatchObject({ verified: false, stage: 'assume_role', code: 'timeout' });
    expect(aws.send.mock.calls[0][1].abortSignal).toBe(aws.send.mock.calls[1][1].abortSignal);
    expect(aws.destroy).toHaveBeenCalledTimes(1);
  });

  it('returns a timeout even if credential resolution never observes the abort signal', async () => {
    vi.useFakeTimers();
    aws.send.mockReset().mockImplementationOnce(() => new Promise(() => {}));
    const pending = verifyAccountConnection(input, settings);
    await vi.advanceTimersByTimeAsync(15_001);
    const result = await Promise.race([pending, Promise.resolve('still-pending')]);
    expect(result).toMatchObject({ verified: false, stage: 'host_identity', code: 'timeout' });
  });

  it('omits ExternalId only for explicit first-party verification', async () => {
    const result = await verifyAccountConnection({ ...input, externalId: '', firstParty: true }, settings);
    expect(result.verified).toBe(true);
    expect(aws.send.mock.calls[1][0].input).not.toHaveProperty('ExternalId');
  });
});
