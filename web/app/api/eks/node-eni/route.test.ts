import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyUser, query, traffic, resolve, allowed } = vi.hoisted(() => ({
  verifyUser: vi.fn(), query: vi.fn(), traffic: vi.fn(), resolve: vi.fn(), allowed: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ verifyUser }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query }) }));
vi.mock('@/lib/metrics', () => ({ ec2DiagFleetLive: traffic }));
vi.mock('@/lib/eks-registry', () => ({ isAllowed: allowed }));
vi.mock('@/lib/eks-context', () => ({
  resolveEksCluster: resolve,
  EksScopeError: class extends Error { constructor(message: string, public status: number) { super(message); } },
}));

const ARN = 'arn:aws:eks:us-west-2:222222222222:cluster/shared';
const NODE = 'ip-10-0-1-10.internal';
const request = (extra = '') => new Request(`http://local/api/eks/node-eni?node=${NODE}${extra}`);

beforeEach(() => {
  vi.stubEnv('AWS_REGION', 'ap-northeast-2');
  vi.clearAllMocks();
  verifyUser.mockResolvedValue({ sub: 'u' });
  allowed.mockResolvedValue(true);
  resolve.mockReset().mockResolvedValue({ id: ARN, name: 'shared', accountId: '222222222222', region: 'us-west-2' });
  query.mockReset().mockResolvedValue({ rows: [] });
  traffic.mockResolvedValue({});
});
afterEach(() => vi.unstubAllEnvs());

describe('node ENI identity', () => {
  it.each(['error', 'string', 'object'])('does not expose an upstream %s or its credentials', async kind => {
    const sentinel = 'arn:aws:iam::222222222222:role/private-role ExternalId=private-external SessionToken=private-session';
    const failure = kind === 'error' ? Object.assign(new Error(sentinel), { stack: sentinel, $metadata: { requestId: sentinel } })
      : kind === 'string' ? sentinel : { message: sentinel, status: 403, toString: () => sentinel };
    query.mockRejectedValue(failure);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnLog = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { GET } = await import('./route');
      const res = await GET(request(`&cluster=${encodeURIComponent(ARN)}`));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ status: 'error', message: 'Node ENI details are unavailable.', reason: 'upstream-error' });
      expect(errorLog).not.toHaveBeenCalled();
      expect(warnLog).toHaveBeenCalledWith({ operation: 'node-eni', reason: 'upstream-error', status: 500 });
      expect(JSON.stringify(warnLog.mock.calls)).not.toContain('private');
    } finally { errorLog.mockRestore(); warnLog.mockRestore(); }
  });

  it('preserves a safe typed scope error before inventory is read', async () => {
    const { EksScopeError } = await import('@/lib/eks-context');
    resolve.mockRejectedValue(new EksScopeError('EKS account is disabled', 403));
    const { GET } = await import('./route');
    const res = await GET(request(`&cluster=${encodeURIComponent(ARN)}`));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ status: 'error', message: 'EKS account is disabled', reason: 'denied' });
    expect(query).not.toHaveBeenCalled();
  });

  it('keeps found inventory and omits traffic when the optional metric read fails', async () => {
    query.mockResolvedValue({ rows: [{ id: 'i-member', data: { network_interfaces: [] } }] });
    traffic.mockRejectedValue(new Error('private ExternalId and SessionToken'));
    const { GET } = await import('./route');
    const res = await GET(request(`&cluster=${encodeURIComponent(ARN)}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ found: true, instanceId: 'i-member', traffic: null });
  });

  it('never matches same-DNS host inventory for a member cluster', async () => {
    // Simulate two synchronized EC2 rows sharing private DNS. Only a complete scope can select the member.
    query.mockImplementation(async (sql: string, values: unknown[]) => {
      const scoped = /account_id\s*=\s*\$2/.test(sql) && /region\s*=\s*\$3/.test(sql);
      return { rows: scoped && values[1] === '222222222222' && values[2] === 'us-west-2'
        ? [{ id: 'i-member', data: { instance_type: 'm5.large', region: 'wrong-data-region', network_interfaces: [] } }]
        : [{ id: 'i-host', data: { instance_type: 'm5.large', network_interfaces: [] } }] };
    });
    const { GET } = await import('./route');
    const res = await GET(request(`&cluster=${encodeURIComponent(ARN)}`));
    expect(res.status).toBe(200);
    expect((await res.json()).instanceId).toBe('i-member');
    expect(query.mock.calls[0][1]).toEqual([NODE, '222222222222', 'us-west-2']);
    expect(allowed).toHaveBeenCalledWith(ARN);
    expect(traffic).toHaveBeenCalledWith(['i-member'], 'us-west-2', 3600, true, '222222222222');
  });

  it('does not fall back to same-DNS host data when member inventory is absent', async () => {
    const { GET } = await import('./route');
    const res = await GET(request(`&cluster=${encodeURIComponent(ARN)}`));
    expect(await res.json()).toEqual({ found: false });
    expect(query.mock.calls[0][1]).toEqual([NODE, '222222222222', 'us-west-2']);
    expect(traffic).not.toHaveBeenCalled();
  });

  it('keeps legacy callers restricted to host inventory in the default region', async () => {
    const { GET } = await import('./route');
    expect((await GET(request())).status).toBe(200);
    expect(query.mock.calls[0][1]).toEqual([NODE, 'self', 'ap-northeast-2']);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('requires a cluster ID for explicit scope on legacy requests', async () => {
    const { GET } = await import('./route');
    expect((await GET(request('&account=222222222222'))).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('resolves explicit scope before the allowlist check', async () => {
    const { GET } = await import('./route');
    await GET(request('&cluster=shared&account=222222222222&region=us-west-2'));
    expect(resolve).toHaveBeenCalledWith('shared', expect.any(URLSearchParams));
    expect(allowed).toHaveBeenCalledWith(ARN);
  });

  it('denies an unregistered cluster before reading inventory or metrics', async () => {
    allowed.mockResolvedValue(false);
    const { GET } = await import('./route');
    expect((await GET(request(`&cluster=${encodeURIComponent(ARN)}`))).status).toBe(404);
    expect(query).not.toHaveBeenCalled();
    expect(traffic).not.toHaveBeenCalled();
  });

  it('preserves authentication before resolving scope', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(request(`&cluster=${encodeURIComponent(ARN)}`))).status).toBe(401);
    expect(resolve).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});
