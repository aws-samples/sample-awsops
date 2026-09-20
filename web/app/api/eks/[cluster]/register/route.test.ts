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
const stsSend = vi.fn();

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
    send = (...args: unknown[]) => stsSend(...args);
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
const params = (cluster: string) => ({ params: Promise.resolve({ cluster }) });

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('HOST_ACCOUNT_ID', '111111111111');
  vi.stubEnv('AWS_REGION', 'ap-northeast-2');
  vi.stubEnv('AURORA_ENDPOINT', 'test-db');
  vi.stubEnv('ONBOARDED_EKS_CLUSTERS', '');
  rows.clear();
  stsSend.mockReset().mockResolvedValue({ Arn: 'arn:aws:sts::111111111111:assumed-role/awsops-v2-task/session' });
  verifyUser.mockReset().mockResolvedValue({ sub: 'admin-sub' });
  isAdmin.mockReset().mockResolvedValue(true);
  getAccount.mockReset().mockResolvedValue({
    accountId: '222222222222', enabled: true, isHost: false, region: 'us-east-1',
    roleName: 'TenantEksReader',
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
    'registers %s in the member account using direct Describe and its registered role principal', async (id, search) => {
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
        ['DescribeAccessEntryCommand', { clusterName: 'shared', principalArn: 'arn:aws:iam::222222222222:role/TenantEksReader' }],
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
    expect(await result.json()).toEqual({ registered: true, authMode: 'assume-role' });
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
      const { POST } = await import('./route');
      expect((await POST(request(MEMBER_ID), params(MEMBER_ID))).status).toBe(403);
      const { isAllowed } = await import('@/lib/eks-registry');
      await expect(isAllowed(MEMBER_ID)).rejects.toMatchObject({ status: 403 });
      const { GET } = await import('../incluster/route');
      expect((await GET(
        new Request(`http://x/api/eks/${encodeURIComponent(MEMBER_ID)}/incluster?kind=pods`),
        params(MEMBER_ID),
      )).status).toBe(403);
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

  it('returns 409 with a target-role guide when the member only trusts the old host principal', async () => {
    memberSend.mockImplementation(async command => {
      if (command.constructor.name === 'DescribeClusterCommand') return { cluster: { name: 'shared' } };
      if (command.input.principalArn === 'arn:aws:iam::111111111111:role/awsops-v2-task') {
        return { accessEntry: { type: 'STANDARD' } };
      }
      throw Object.assign(new Error('entry missing'), { name: 'ResourceNotFoundException' });
    });
    const { POST } = await import('./route');
    const result = await POST(request(MEMBER_ID), params(MEMBER_ID));
    expect(result.status).toBe(409);
    const body = await result.json();
    expect(body).toMatchObject({ registered: false, cluster: MEMBER_ID, access: 'no-entry' });
    expect(body.guide.commands[0]).toContain('--cluster-name shared --region us-east-1');
    expect(body.guide.commands[0]).toContain('--principal-arn arn:aws:iam::222222222222:role/TenantEksReader');
    expect(rows.size).toBe(0);
  });

  it.each(['111111111111', '333333333333'])(
    'rejects a member authentication override from account %s without saving or echoing it', async accountId => {
      const { POST } = await import('./route');
      const roleArn = `arn:aws:iam::${accountId}:role/PrivateRoleName`;
      const result = await POST(request(MEMBER_ID, '', 'POST', {
        auth: { mode: 'assume-role', roleArn, externalId: 'private-external-id' },
      }), params(MEMBER_ID));
      expect(result.status).toBe(403);
      const body = await result.text();
      expect(body).not.toContain(roleArn);
      expect(body).not.toContain('private-external-id');
      expect(rows.size).toBe(0);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it('continues accepting user-provided member SA auth without returning the token', async () => {
    const { POST } = await import('./route');
    const result = await POST(request(MEMBER_ID, '', 'POST', {
      auth: { mode: 'sa-token', token: 'private-member-token' },
    }), params(MEMBER_ID));
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ registered: true, authMode: 'sa-token' });
    expect(rows.get(MEMBER_ID)).toEqual({ mode: 'sa-token', token: 'private-member-token' });
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

describe('admin EKS registration cleanup', () => {
  it.each([401, 403])('requires authentication and admin authority before cleanup: %s', async status => {
    if (status === 401) verifyUser.mockResolvedValue(null);
    else isAdmin.mockResolvedValue(false);
    rows.set(MEMBER_ID, { mode: 'sa-token', token: 'obsolete-token' });
    const { DELETE } = await import('./route');
    expect((await DELETE(request(MEMBER_ID, '', 'DELETE'), params(MEMBER_ID))).status).toBe(status);
    expect(rows.has(MEMBER_ID)).toBe(true);
    expect(query).not.toHaveBeenCalled();
    expect(getAccount).not.toHaveBeenCalled();
  });

  it.each([undefined, { accountId: '222222222222', enabled: false }])(
    'deletes auth rows for removed or disabled members without account/scope/AWS calls', async account => {
      rows.set(MEMBER_ID, { mode: 'sa-token', token: 'obsolete-token' });
      rows.set('shared', null);
      getAccount.mockResolvedValue(account);
      const { DELETE } = await import('./route');
      const response = await DELETE(request(MEMBER_ID, '', 'DELETE'), params(MEMBER_ID));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ unregistered: true });
      expect([...rows.keys()]).toEqual(['shared']);
      expect(getAccount).not.toHaveBeenCalled();
      expect(listScanScope).not.toHaveBeenCalled();
      expect(assumedClient).not.toHaveBeenCalled();
      expect(hostSend).not.toHaveBeenCalled();
      expect(memberSend).not.toHaveBeenCalled();
      expect(stsSend).not.toHaveBeenCalled();
    },
  );

  it('clears cached registrations and auth after disabled-account cleanup', async () => {
    rows.set(MEMBER_ID, { mode: 'sa-token', token: 'cached-token' });
    const registry = await import('@/lib/eks-registry');
    expect((await registry.getAllowedClusters()).has(MEMBER_ID)).toBe(true);
    expect(await registry.getClusterAuth(MEMBER_ID)).toEqual({ mode: 'sa-token', token: 'cached-token' });
    getAccount.mockRejectedValue(new Error('account registry no longer reachable'));
    getAccount.mockClear();
    listScanScope.mockClear();
    const { DELETE } = await import('./route');
    expect((await DELETE(request(MEMBER_ID, '', 'DELETE'), params(MEMBER_ID))).status).toBe(200);
    expect(getAccount).not.toHaveBeenCalled();
    expect(listScanScope).not.toHaveBeenCalled();
    expect((await registry.getAllowedClusters()).has(MEMBER_ID)).toBe(false);
    getAccount.mockResolvedValue({
      accountId: '222222222222', enabled: true, isHost: false, region: 'us-east-1',
    });
    expect(await registry.getClusterAuth(MEMBER_ID)).toBeNull();
  });

  it('removes exactly the selected member account/region when a bare name is supplied', async () => {
    rows.set(MEMBER_ID, { mode: 'sa-token', token: 'obsolete' });
    const otherRegion = 'arn:aws:eks:us-west-2:222222222222:cluster/shared';
    rows.set(otherRegion, null);
    getAccount.mockResolvedValue(undefined);
    const { DELETE } = await import('./route');
    expect((await DELETE(request('shared', memberQuery, 'DELETE'), params('shared'))).status).toBe(200);
    expect([...rows.keys()]).toEqual([otherRegion]);
    expect(getAccount).not.toHaveBeenCalled();
    expect(listScanScope).not.toHaveBeenCalled();
  });

  it('requires a region for member-name cleanup rather than guessing among stored registrations', async () => {
    rows.set(MEMBER_ID, null);
    rows.set('arn:aws:eks:us-west-2:222222222222:cluster/shared', null);
    const { DELETE } = await import('./route');
    const response = await DELETE(request('shared', 'account=222222222222', 'DELETE'), params('shared'));
    expect(response.status).toBe(400);
    expect((await response.json()).message).toMatch(/region/i);
    expect(rows.size).toBe(2);
    expect(query).not.toHaveBeenCalled();
    expect(getAccount).not.toHaveBeenCalled();
  });

  it.each([
    ['bad/../cluster', ''], [MEMBER_ID, 'account=self'], [MEMBER_ID, 'region=us-west-2'],
    [MEMBER_ID, 'accounts=222222222222'], [MEMBER_ID, 'region=us-east-1&region=us-east-1'],
  ])('blocks invalid or conflicting cleanup scope: %s %s', async (id, search) => {
    const { DELETE } = await import('./route');
    expect((await DELETE(request(id, search, 'DELETE'), params(id))).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
    expect(getAccount).not.toHaveBeenCalled();
    expect(listScanScope).not.toHaveBeenCalled();
  });

  it.each(['shared', HOST_ARN])('keeps Terraform-managed host registration %s undeletable', async id => {
    vi.stubEnv('ONBOARDED_EKS_CLUSTERS', 'shared');
    rows.set('shared', null);
    const { DELETE } = await import('./route');
    expect((await DELETE(request(id, '', 'DELETE'), params(id))).status).toBe(400);
    expect(rows.has('shared')).toBe(true);
    expect(query).not.toHaveBeenCalled();
  });

  it('distinguishes missing rows from storage failure even when the account was removed', async () => {
    getAccount.mockResolvedValue(undefined);
    const { DELETE } = await import('./route');
    expect((await DELETE(request(MEMBER_ID, '', 'DELETE'), params(MEMBER_ID))).status).toBe(404);
    query.mockRejectedValue(new Error('private database diagnostic'));
    const response = await DELETE(request(MEMBER_ID, '', 'DELETE'), params(MEMBER_ID));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private database diagnostic');
    expect(getAccount).not.toHaveBeenCalled();
  });
});
