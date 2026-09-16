import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { Sha256 } from '@aws-crypto/sha256-js';

const getAccount = vi.fn();
const getClusterAuth = vi.fn();
const assumedClient = vi.fn();
const hostSend = vi.fn();
const memberSend = vi.fn();
const stsSend = vi.fn();
const request = vi.fn();

vi.mock('./accounts', () => ({ getAccount: (...args: unknown[]) => getAccount(...args) }));
vi.mock('./account-regions', () => ({ listScanScope: async () => [{ accountId: '222222222222', regions: ['*'] }] }));
vi.mock('./eks-registry', () => ({ getClusterAuth: (...args: unknown[]) => getClusterAuth(...args) }));
vi.mock('./aws-assume', () => ({ assumedClient: (...args: unknown[]) => assumedClient(...args) }));
vi.mock('@aws-sdk/client-eks', () => ({
  EKSClient: class { send = (...args: unknown[]) => hostSend(...args); },
  DescribeClusterCommand: class { constructor(public input: unknown) {} },
  DescribeAccessEntryCommand: class { constructor(public input: unknown) {} },
}));
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class { send = (...args: unknown[]) => stsSend(...args); },
  AssumeRoleCommand: class { constructor(public input: unknown) {} },
  GetCallerIdentityCommand: class { constructor(public input: unknown) {} },
}));
vi.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: () => async () => ({
    accessKeyId: 'HOST_TASK_KEY', secretAccessKey: 'host-test-secret', sessionToken: 'host-session',
  }),
}));
vi.mock('node:https', () => ({
  default: {
    Agent: class { constructor(public options: unknown) {} },
    request: (...args: unknown[]) => request(...args),
  },
}));

const MEMBER_ID = 'arn:aws:eks:us-east-1:222222222222:cluster/shared';
const HOST_OTHER_REGION = 'arn:aws:eks:us-east-1:111111111111:cluster/shared';
const caData = Buffer.from('test-ca').toString('base64');
const decode = (token: string) => new URL(Buffer.from(token.slice('k8s-aws-v1.'.length), 'base64url').toString());

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('HOST_ACCOUNT_ID', '111111111111');
  vi.stubEnv('AWS_REGION', 'ap-northeast-2');
  getAccount.mockReset().mockResolvedValue({
    accountId: '222222222222', isHost: false, enabled: true, region: 'us-east-1',
  });
  getClusterAuth.mockReset().mockResolvedValue(null);
  hostSend.mockReset().mockResolvedValue({
    cluster: { endpoint: 'https://host.eks.amazonaws.com', certificateAuthority: { data: caData } },
  });
  memberSend.mockReset().mockResolvedValue({
    cluster: { endpoint: 'https://member.eks.amazonaws.com', certificateAuthority: { data: caData } },
  });
  assumedClient.mockReset().mockImplementation(async (id: string) => ({ send: id === 'self' ? hostSend : memberSend }));
  stsSend.mockReset().mockResolvedValue({
    Credentials: { AccessKeyId: 'OVERRIDE_KEY', SecretAccessKey: 'override-test-secret', SessionToken: 'override-session' },
  });
  request.mockReset().mockImplementation((_options, callback) => {
    const outgoing = new EventEmitter() as EventEmitter & { setTimeout: () => void; end: () => void };
    outgoing.setTimeout = vi.fn();
    outgoing.end = () => {
      const response = new EventEmitter() as EventEmitter & { statusCode: number };
      response.statusCode = 200;
      callback(response);
      response.emit('data', Buffer.from('{"items":[]}'));
      response.emit('end');
    };
    return outgoing;
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('EKS scoped connections and token identity', () => {
  it('discovers target endpoint and CA with the member role and raw cluster name', async () => {
    const { clusterConn } = await import('./eks-incluster');
    expect(await clusterConn(MEMBER_ID)).toEqual({
      endpoint: 'https://member.eks.amazonaws.com', caPem: Buffer.from('test-ca'),
    });
    expect(assumedClient).toHaveBeenCalledWith('222222222222', expect.anything(), { region: 'us-east-1' });
    expect(memberSend.mock.calls[0][0].input).toEqual({ name: 'shared' });
    expect(hostSend).not.toHaveBeenCalled();
  });

  it('keeps endpoint caches distinct for the same raw name in three scopes', async () => {
    const { clusterConn } = await import('./eks-incluster');
    const host = await clusterConn('shared');
    const member = await clusterConn(MEMBER_ID);
    await clusterConn(HOST_OTHER_REGION);
    expect(host.endpoint).toBe('https://host.eks.amazonaws.com');
    expect(member.endpoint).toBe('https://member.eks.amazonaws.com');
    await clusterConn(MEMBER_ID);
    expect(memberSend).toHaveBeenCalledTimes(1);
    expect(hostSend).toHaveBeenCalledTimes(2);
  });

  it('rejects a disabled member before returning an already cached connection', async () => {
    const { clusterConn } = await import('./eks-incluster');
    await clusterConn(MEMBER_ID);
    getAccount.mockResolvedValue({ accountId: '222222222222', enabled: false });
    await expect(clusterConn(MEMBER_ID)).rejects.toMatchObject({ status: 403 });
    expect(memberSend).toHaveBeenCalledTimes(1);
    expect(hostSend).not.toHaveBeenCalled();
  });

  it('signs the raw name and target region with HOST task credentials by default', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-09-16T00:00:00Z'));
    const { eksToken } = await import('./eks-incluster');
    const url = decode(await eksToken(MEMBER_ID, 'us-east-1'));
    expect(url.hostname).toBe('sts.us-east-1.amazonaws.com');
    expect(url.searchParams.get('X-Amz-Credential')).toContain('HOST_TASK_KEY/');
    const expected = await new SignatureV4({
      region: 'us-east-1', service: 'sts', sha256: Sha256,
      credentials: { accessKeyId: 'HOST_TASK_KEY', secretAccessKey: 'host-test-secret', sessionToken: 'host-session' },
    }).presign(new HttpRequest({
      method: 'GET', protocol: 'https:', hostname: 'sts.us-east-1.amazonaws.com', path: '/',
      headers: { host: 'sts.us-east-1.amazonaws.com', 'x-k8s-aws-id': 'shared' },
      query: { Action: 'GetCallerIdentity', Version: '2011-06-15' },
    }), { expiresIn: 60 });
    expect(url.searchParams.get('X-Amz-Signature')).toBe(expected.query?.['X-Amz-Signature']);
    expect(getClusterAuth).toHaveBeenCalledWith(MEMBER_ID);
    expect(assumedClient).not.toHaveBeenCalled();
    expect(stsSend).not.toHaveBeenCalled();
  });

  it('rejects a token region that conflicts with the ARN', async () => {
    const { eksToken } = await import('./eks-incluster');
    await expect(eksToken(MEMBER_ID, 'us-west-2')).rejects.toMatchObject({ status: 400 });
  });

  it('uses target-region tokens for every in-cluster GET entry point', async () => {
    const { listInCluster, describeInCluster, k8sGetPath, listK8sgptResults } = await import('./eks-incluster');
    await listInCluster(MEMBER_ID, 'pods');
    await describeInCluster(MEMBER_ID, 'nodes', 'node-1');
    await k8sGetPath(MEMBER_ID, '/api/v1/nodes');
    await listK8sgptResults(MEMBER_ID);
    expect(request).toHaveBeenCalledTimes(4);
    for (const [options] of request.mock.calls) {
      expect(options.hostname).toBe('member.eks.amazonaws.com');
      expect(options.method).toBe('GET');
      const url = decode(options.headers.Authorization.slice('Bearer '.length));
      expect(url.hostname).toBe('sts.us-east-1.amazonaws.com');
      expect(url.searchParams.get('X-Amz-Credential')).toContain('HOST_TASK_KEY/');
    }
  });

  it('keeps saved assume-role identity separate and includes ExternalId in credential cache keys', async () => {
    const { eksToken } = await import('./eks-incluster');
    const roleArn = 'arn:aws:iam::222222222222:role/ExplicitKubernetesReader';
    getClusterAuth.mockResolvedValue({ mode: 'assume-role', roleArn, externalId: 'first' });
    expect(decode(await eksToken(MEMBER_ID, 'us-east-1')).searchParams.get('X-Amz-Credential')).toContain('OVERRIDE_KEY/');
    await eksToken(MEMBER_ID, 'us-east-1');
    expect(stsSend).toHaveBeenCalledTimes(1);
    getClusterAuth.mockResolvedValue({ mode: 'assume-role', roleArn, externalId: 'second' });
    await eksToken(MEMBER_ID, 'us-east-1');
    expect(stsSend).toHaveBeenCalledTimes(2);
    expect(stsSend.mock.calls[1][0].input).toMatchObject({ RoleArn: roleArn, ExternalId: 'second' });
  });

  it('never falls back to task-role identity when an explicit saved role fails', async () => {
    getClusterAuth.mockResolvedValue({
      mode: 'assume-role', roleArn: 'arn:aws:iam::222222222222:role/ExplicitKubernetesReader',
    });
    stsSend.mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
    const { eksToken } = await import('./eks-incluster');
    await expect(eksToken(MEMBER_ID, 'us-east-1')).rejects.toMatchObject({ status: 403 });
  });

  it('does not return even a saved service-account token for a disabled target', async () => {
    getClusterAuth.mockResolvedValue({ mode: 'sa-token', token: 'saved-token' });
    getAccount.mockResolvedValue({ accountId: '222222222222', enabled: false });
    const { eksToken } = await import('./eks-incluster');
    await expect(eksToken(MEMBER_ID, 'us-east-1')).rejects.toMatchObject({ status: 403 });
    expect(getClusterAuth).not.toHaveBeenCalled();
  });
});
