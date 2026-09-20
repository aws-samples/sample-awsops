import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Keep registry, account/region readers, scope resolution, and routes real. Only
// external SQL/auth/provider boundaries are replaced, so swallowed SQL failures
// cannot be hidden by a mock that makes getAllowedClusters reject directly.
const query = vi.fn();
const listInCluster = vi.fn();
const listClusterInventory = vi.fn();
vi.mock('./db', () => ({ getPool: () => ({ query: (...args: unknown[]) => query(...args) }) }));
vi.mock('./auth', () => ({ verifyUser: async () => ({ sub: 'reader' }) }));
vi.mock('./admin', () => ({ isAdmin: async () => false }));
vi.mock('./aws', () => ({ listClusterInventory: (...args: unknown[]) => listClusterInventory(...args) }));
vi.mock('./eks-access', () => ({
  hasAccessEntry: async () => true,
  onboardingGuide: async () => ({ commands: [], note: '' }),
}));
vi.mock('./eks-incluster', () => ({
  listInCluster: (...args: unknown[]) => listInCluster(...args),
  isKind: (kind: string) => kind === 'pods',
}));

const HOST = '111111111111';
const MEMBER = '222222222222';
const REGION = 'ap-northeast-2';
const MEMBER_ID = `arn:aws:eks:${REGION}:${MEMBER}:cluster/shared`;
const sqlFailureDetail = 'private registration database diagnostic';
let failRegistrationRead = true;

const accountRows = [
  {
    account_id: HOST, alias: 'Host', region: REGION, is_host: true, role_name: '',
    external_id: null, enabled: true, status: 'verified', last_verified_at: null,
  },
  {
    account_id: MEMBER, alias: 'Member', region: REGION, is_host: false, role_name: 'AWSopsReadOnlyRole',
    external_id: null, enabled: true, status: 'verified', last_verified_at: null,
  },
];

beforeEach(async () => {
  vi.stubEnv('HOST_ACCOUNT_ID', HOST);
  vi.stubEnv('AWS_REGION', REGION);
  vi.stubEnv('AURORA_ENDPOINT', 'configured-db');
  vi.stubEnv('ONBOARDED_EKS_CLUSTERS', 'shared');
  failRegistrationRead = true;
  listInCluster.mockReset().mockResolvedValue([]);
  listClusterInventory.mockReset().mockResolvedValue({ clusters: [], region: REGION, truncated: false });
  query.mockReset().mockImplementation(async (sql: string, values: unknown[] = []) => {
    if (sql === 'SELECT cluster_name FROM eks_registrations') {
      if (failRegistrationRead) throw new Error(sqlFailureDetail);
      return { rows: [{ cluster_name: MEMBER_ID }] };
    }
    if (sql.includes('FROM eks_registrations WHERE auth IS NOT NULL')) return { rows: [] };
    if (sql.includes('FROM accounts a')) {
      return { rows: accountRows.map(row => ({ ...row, all_regions: row.is_host, regions: [REGION] })) };
    }
    if (sql.includes('FROM account_regions')) {
      return { rows: accountRows.map(row => ({ account_id: row.account_id, region: REGION, enabled: true })) };
    }
    if (sql === 'SELECT * FROM accounts ORDER BY is_host DESC, alias ASC') return { rows: accountRows };
    if (sql === 'SELECT * FROM accounts WHERE account_id = $1') {
      return { rows: accountRows.filter(row => row.account_id === values[0]) };
    }
    throw new Error(`Unexpected test SQL: ${sql}`);
  });
  const { _resetForTests } = await import('./eks-registry');
  _resetForTests();
});
afterEach(() => vi.unstubAllEnvs());

async function collectionResponse(route: string, search: string): Promise<Response> {
  const request = new Request(`http://x/api/eks${route === 'list' ? '' : `/${route}`}?${search}`);
  if (route === 'fleet') return (await import('../app/api/eks/fleet/route')).GET(request);
  if (route === 'summary') return (await import('../app/api/eks/summary/route')).GET(request);
  return (await import('../app/api/eks/route')).GET(request);
}

describe('strict registration evidence through real EKS routes', () => {
  for (const route of ['list', 'fleet', 'summary']) {
    it.each([false, true])(`${route} reports a failed registration SELECT as 503 (legacy cache warmed: %s)`, async warmLegacy => {
      if (warmLegacy) {
        const { getAllowedClusters } = await import('./eks-registry');
        expect(await getAllowedClusters()).toEqual(new Set(['shared']));
      }
      const response = await collectionResponse(route, `account=${MEMBER}`);
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.status).toBe('error');
      expect(JSON.stringify(body)).not.toContain(sqlFailureDetail);
      expect(query.mock.calls.filter(([sql]) => sql === 'SELECT cluster_name FROM eks_registrations')).toHaveLength(1);
      expect(listInCluster).not.toHaveBeenCalled();
      expect(listClusterInventory).not.toHaveBeenCalled();
    });
  }

  it.each(['fleet', 'summary'])('does not report a partial mixed-account %s as a complete success', async route => {
    const response = await collectionResponse(route, `accounts=self,${MEMBER}&regions=${REGION}`);
    expect(response.status).toBe(503);
    expect((await response.json()).status).toBe('error');
    expect(listInCluster).not.toHaveBeenCalled();
  });

  it.each(['list', 'fleet', 'summary'])('keeps legitimate host env-only %s available without Aurora', async route => {
    delete process.env.AURORA_ENDPOINT;
    expect((await collectionResponse(route, '')).status).toBe(200);
    expect(query).not.toHaveBeenCalled();
  });

  it('still reads a registered member fleet when registration SQL succeeds', async () => {
    failRegistrationRead = false;
    const response = await collectionResponse('fleet', `account=${MEMBER}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.clusters).toHaveLength(1);
    expect(body.clusters[0]).toMatchObject({ id: MEMBER_ID, accountId: MEMBER, name: 'shared', reachable: true });
    expect(listInCluster).toHaveBeenCalledWith(MEMBER_ID, 'pods');
    expect(listInCluster).not.toHaveBeenCalledWith('shared', expect.anything());
  });
});

describe('single-cluster routes reject collection selectors before host data access', () => {
  it.each([
    `accounts=${MEMBER}`,
    'accounts=member',
    'regions=us-west-2',
    `account=self&accounts=${MEMBER}`,
    `accounts=${MEMBER}&accounts=${MEMBER}`,
    'account=self&account=self',
    `region=${REGION}&region=${REGION}`,
  ])('returns 400 for %s even when the host bare name is registered', async search => {
    const { GET } = await import('../app/api/eks/[cluster]/incluster/route');
    const response = await GET(
      new Request(`http://x/api/eks/shared/incluster?kind=pods&${search}`),
      { params: { cluster: 'shared' } },
    );
    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
    expect(listInCluster).not.toHaveBeenCalled();
  });
});
