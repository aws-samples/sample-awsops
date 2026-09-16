import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const verifyUser = vi.fn();
const isAdmin = vi.fn();
const getAccount = vi.fn();
const listScanScope = vi.fn();
const listClusters = vi.fn();
const hostSend = vi.fn();
const memberSend = vi.fn();
const assumedClient = vi.fn();
const query = vi.fn();

vi.mock('@/lib/auth', () => ({ verifyUser: (...args: unknown[]) => verifyUser(...args) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...args: unknown[]) => isAdmin(...args) }));
vi.mock('@/lib/accounts', () => ({ getAccount: (...args: unknown[]) => getAccount(...args) }));
vi.mock('@/lib/account-regions', () => ({ listScanScope: () => listScanScope() }));
vi.mock('@/lib/aws', () => ({ listClusters: (...args: unknown[]) => listClusters(...args) }));
vi.mock('@/lib/aws-assume', () => ({ assumedClient: (...args: unknown[]) => assumedClient(...args) }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...args: unknown[]) => query(...args) }) }));
vi.mock('@aws-sdk/client-eks', () => ({
  EKSClient: class { send = (...args: unknown[]) => hostSend(...args); },
  DescribeClusterCommand: class DescribeClusterCommand { constructor(public input: unknown) {} },
  DescribeAccessEntryCommand: class DescribeAccessEntryCommand { constructor(public input: unknown) {} },
}));
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    async send() { return { Arn: 'arn:aws:sts::111111111111:assumed-role/awsops-v2-task/session' }; }
  },
  GetCallerIdentityCommand: class { constructor(public input: unknown) {} },
}));

const MEMBER_ID = 'arn:aws:eks:us-east-1:222222222222:cluster/shared';
const HOST_ARN = 'arn:aws:eks:ap-northeast-2:111111111111:cluster/shared';
const memberQuery = 'account=222222222222&region=us-east-1';
const rows = new Map<string, unknown>();
const request = (id: string, search = '', method = 'POST', body?: unknown) =>
  new Request(`http://x/api/eks/${encodeURIComponent(id)}/register?${search}`, {
    method, headers: { cookie: 'awsops_token=t', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const params = (cluster: string) => ({ params: { cluster } });

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('HOST_ACCOUNT_ID', '111111111111');
  vi.stubEnv('AWS_REGION', 'ap-northeast-2');
  vi.stubEnv('AURORA_ENDPOINT', 'test-db');
  vi.stubEnv('ONBOARDED_EKS_CLUSTERS', '');
  rows.clear();
  verifyUser.mockReset().mockResolvedValue({ sub: 'admin-sub' });
  isAdmin.mockReset().mockResolvedValue(true);
  getAccount.mockReset().mockResolvedValue({
    accountId: '222222222222', enabled: true, isHost: false, region: 'us-east-1',
  });
  listScanScope.mockReset().mockResolvedValue([{ accountId: '222222222222', regions: ['us-east-1'] }]);
  listClusters.mockReset().mockResolvedValue([]); // valid cluster can be beyond the first 25
  const response = async (command: { constructor: { name: string }; input: { name: string } }) =>
    command.constructor.name === 'DescribeClusterCommand'
      ? { cluster: { name: command.input.name, status: 'ACTIVE' } }
      : { accessEntry: { type: 'STANDARD' } };
  hostSend.mockReset().mockImplementation(response);
  memberSend.mockReset().mockImplementation(response);
  assumedClient.mockReset().mockImplementation(async (accountId: string) => ({ send: accountId === 'self' ? hostSend : memberSend }));
  query.mockReset().mockImplementation(async (sql: string, values: unknown[] = []) => {
    const id = String(values[0]);
    if (sql.startsWith('INSERT')) {
      rows.set(id, values[2] ? JSON.parse(String(values[2])) : null);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('DELETE')) return { rows: [], rowCount: Number(rows.delete(id)) };
    if (sql.startsWith('SELECT auth')) return { rows: rows.has(id) ? [{ auth: rows.get(id) }] : [] };
    return { rows: Array.from(rows.keys(), cluster_name => ({ cluster_name })) };
  });
});
afterEach(() => vi.unstubAllEnvs());

describe('scoped EKS registration', () => {
  it.each([['shared', memberQuery], [MEMBER_ID, '']])(
    'registers %s in the member account using direct Describe and the HOST access principal', async (id, search) => {
      const { POST } = await import('./route');
      const result = await POST(request(id, search), params(id));
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({ registered: true });
      expect(rows.has(MEMBER_ID)).toBe(true);
      expect(rows.has('shared')).toBe(false);
      expect(listClusters).not.toHaveBeenCalled();
      expect(hostSend).not.toHaveBeenCalled();
      expect(assumedClient).toHaveBeenCalledWith('222222222222', expect.anything(), { region: 'us-east-1' });
      expect(memberSend.mock.calls.map(([command]) => [command.constructor.name, command.input])).toEqual([
        ['DescribeClusterCommand', { name: 'shared' }],
        ['DescribeAccessEntryCommand', { clusterName: 'shared', principalArn: 'arn:aws:iam::111111111111:role/awsops-v2-task' }],
      ]);
    },
  );

  it('registers a host cluster beyond the discovery list cap under the legacy bare key', async () => {
    const { POST } = await import('./route');
    expect((await POST(request(HOST_ARN), params(HOST_ARN))).status).toBe(200);
    expect(rows.has('shared')).toBe(true);
    expect(rows.has(HOST_ARN)).toBe(false);
    expect(listClusters).not.toHaveBeenCalled();
  });

  it('preserves same-name host and member registrations and removes only the selected member', async () => {
    rows.set('shared', null);
    const { POST, DELETE } = await import('./route');
    expect((await POST(request('shared', memberQuery), params('shared'))).status).toBe(200);
    expect([...rows.keys()].sort()).toEqual([MEMBER_ID, 'shared']);
    expect((await DELETE(request(MEMBER_ID, '', 'DELETE'), params(MEMBER_ID))).status).toBe(200);
    expect([...rows.keys()]).toEqual(['shared']);
  });

  it('does not treat a same-name Terraform host cluster as a member registration', async () => {
    vi.stubEnv('ONBOARDED_EKS_CLUSTERS', 'shared');
    const { POST } = await import('./route');
    const result = await POST(request('shared', memberQuery), params('shared'));
    expect(result.status).toBe(200);
    expect((await result.json()).managedBy).toBeUndefined();
    expect(rows.has(MEMBER_ID)).toBe(true);
  });

  it('stores explicit token auth only under the qualified registration ID', async () => {
    const { POST } = await import('./route');
    const result = await POST(request(MEMBER_ID, '', 'POST', {
      auth: { mode: 'assume-role', roleArn: 'arn:aws:iam::222222222222:role/KubernetesReader', externalId: 'tenant' },
    }), params(MEMBER_ID));
    expect(result.status).toBe(200);
    expect(rows.get(MEMBER_ID)).toEqual({
      mode: 'assume-role', roleArn: 'arn:aws:iam::222222222222:role/KubernetesReader', externalId: 'tenant',
    });
    expect(memberSend.mock.calls.map(([command]) => command.constructor.name)).toEqual(['DescribeClusterCommand']);
  });

  it.each([
    ['account=self', MEMBER_ID], ['region=us-west-2', MEMBER_ID], ['account=invalid', 'shared'],
    ['account=', 'shared'], ['region=', 'shared'], ['', 'bad/../cluster'],
  ])('returns 400 for invalid or conflicting scope %s %s', async (search, id) => {
    const { POST } = await import('./route');
    expect((await POST(request(id, search), params(id))).status).toBe(400);
    expect(hostSend).not.toHaveBeenCalled();
    expect(memberSend).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it.each([undefined, { accountId: '222222222222', enabled: false }])(
    'returns 403 for unknown/disabled targets without host discovery or persistence', async account => {
      getAccount.mockResolvedValue(account);
      const { POST, DELETE } = await import('./route');
      expect((await POST(request(MEMBER_ID), params(MEMBER_ID))).status).toBe(403);
      expect((await DELETE(request(MEMBER_ID, '', 'DELETE'), params(MEMBER_ID))).status).toBe(403);
      expect(hostSend).not.toHaveBeenCalled();
      expect(memberSend).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    },
  );

  it('returns 404 only when direct target DescribeCluster reports absence', async () => {
    memberSend.mockRejectedValue(Object.assign(new Error('missing'), { name: 'ResourceNotFoundException' }));
    const { POST } = await import('./route');
    expect((await POST(request('shared', memberQuery), params('shared'))).status).toBe(404);
    expect(rows.size).toBe(0);
    expect(hostSend).not.toHaveBeenCalled();
  });

  it('returns 409 with a target-scoped guide for a missing host-principal Access Entry', async () => {
    memberSend.mockImplementation(async command => {
      if (command.constructor.name === 'DescribeClusterCommand') return { cluster: { name: 'shared' } };
      throw Object.assign(new Error('entry missing'), { name: 'ResourceNotFoundException' });
    });
    const { POST } = await import('./route');
    const result = await POST(request(MEMBER_ID), params(MEMBER_ID));
    expect(result.status).toBe(409);
    const body = await result.json();
    expect(body).toMatchObject({ registered: false, cluster: MEMBER_ID, access: 'no-entry' });
    expect(body.guide.commands[0]).toContain('--cluster-name shared --region us-east-1');
    expect(rows.size).toBe(0);
  });

  it.each(['scope', 'write'])('returns 503 for %s registry failure', async boundary => {
    if (boundary === 'scope') getAccount.mockRejectedValue(new Error('database unavailable'));
    else query.mockRejectedValue(new Error('database unavailable'));
    const { POST } = await import('./route');
    expect((await POST(request(MEMBER_ID), params(MEMBER_ID))).status).toBe(503);
    expect(rows.size).toBe(0);
  });

  it('returns a typed denial when target AssumeRole fails and never retries as host', async () => {
    assumedClient.mockRejectedValue(Object.assign(new Error('sensitive upstream detail'), { name: 'AccessDenied' }));
    const { POST } = await import('./route');
    const result = await POST(request(MEMBER_ID), params(MEMBER_ID));
    expect(result.status).toBe(403);
    expect(await result.text()).not.toContain('sensitive upstream detail');
    expect(hostSend).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it.each([401, 403])('keeps authentication/admin checks ahead of scope and AWS work: %s', async status => {
    if (status === 401) verifyUser.mockResolvedValue(null);
    else isAdmin.mockResolvedValue(false);
    const { POST } = await import('./route');
    expect((await POST(request(MEMBER_ID), params(MEMBER_ID))).status).toBe(status);
    expect(getAccount).not.toHaveBeenCalled();
    expect(memberSend).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});
