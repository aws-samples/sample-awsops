import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { verify, admin, resolve, allowed, list, detail, diagnosis, transfer } = vi.hoisted(() => ({
  verify: vi.fn(), admin: vi.fn(), resolve: vi.fn(), allowed: vi.fn(),
  list: vi.fn(), detail: vi.fn(), diagnosis: vi.fn(), transfer: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ verifyUser: verify }));
vi.mock('@/lib/admin', () => ({ isAdmin: admin }));
vi.mock('@/lib/eks-registry', () => ({ isAllowed: allowed }));
vi.mock('@/lib/eks-context', () => ({
  resolveEksCluster: resolve,
  EksScopeError: class extends Error { constructor(message: string, public status: number) { super(message); } },
}));
vi.mock('@/lib/eks-incluster', () => ({
  listInCluster: list, describeInCluster: detail,
  isKind: (kind: string) => kind === 'pods', isDescribableKind: (kind: string) => kind === 'pods',
}));
vi.mock('@/lib/k8sgpt', () => ({ getDiagnosis: diagnosis }));
vi.mock('@/lib/nfm', () => ({ nfmPodTransfer: transfer }));

const SENTINEL = 'arn:aws:iam::222222222222:role/private-role ExternalId=private-external-id SessionToken=private-session-token';
const MEMBER = { id: 'arn:aws:eks:us-west-2:222222222222:cluster/shared', name: 'shared', accountId: '222222222222', region: 'us-west-2' };
const HOST = { id: 'shared', name: 'shared', accountId: 'self', region: 'ap-northeast-2' };
const routes = [
  { name: 'incluster', operation: 'incluster-list', load: () => import('./route'), read: list, message: 'EKS resources are unavailable.', context: MEMBER },
  { name: 'describe', operation: 'incluster-describe', load: () => import('./describe/route'), read: detail, message: 'EKS resource details are unavailable.', context: MEMBER },
  { name: 'k8sgpt', operation: 'k8sgpt', load: () => import('../k8sgpt/route'), read: diagnosis, message: 'K8sGPT diagnosis is unavailable.', context: MEMBER },
  { name: 'pod-transfer', operation: 'pod-transfer', load: () => import('../pod-transfer/route'), read: transfer, message: 'Pod transfer metrics are unavailable.', context: HOST },
];
const request = () => new Request('http://local/?kind=pods&name=pod-a&namespace=default');
const failures = [
  { name: 'SDK Error', make: () => Object.assign(new Error(SENTINEL), { stack: SENTINEL, $metadata: { requestId: SENTINEL } }) },
  { name: 'plain string', make: () => SENTINEL },
  { name: 'plain object', make: () => ({ message: SENTINEL, status: 403, stack: SENTINEL, $metadata: { requestId: SENTINEL }, toString: () => SENTINEL }) },
];

beforeEach(() => {
  vi.stubEnv('K8SGPT_ENABLED', 'true');
  vi.stubEnv('AWS_REGION', 'ap-northeast-2');
  vi.clearAllMocks();
  verify.mockResolvedValue({ sub: 'u' }); admin.mockResolvedValue(true); allowed.mockResolvedValue(true);
  resolve.mockReset().mockResolvedValue(MEMBER);
  list.mockReset().mockResolvedValue([]); detail.mockReset().mockResolvedValue({});
  diagnosis.mockReset().mockResolvedValue({ enabled: true, findings: [] }); transfer.mockReset().mockResolvedValue({ available: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe.each(routes)('$name public error boundary', route => {
  it.each(failures)('keeps $name private while emitting controlled diagnostics', async failure => {
    resolve.mockResolvedValue(route.context);
    route.read.mockRejectedValue(failure.make());
    const { GET } = await route.load();
    const response = await GET(request(), { params: Promise.resolve({ cluster: route.context.id }) });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ status: 'error', message: route.message, reason: 'upstream-error' });
    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith({ operation: route.operation, reason: 'upstream-error', status: 502 });
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toMatch(/private|ExternalId|SessionToken/);
    expect(console.log).not.toHaveBeenCalled();
  });

  it('sanitizes an unexpected member-scope lookup failure', async () => {
    resolve.mockRejectedValue(new Error(SENTINEL));
    const { GET } = await route.load();
    const response = await GET(request(), { params: Promise.resolve({ cluster: MEMBER.id }) });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ status: 'error', message: route.message, reason: 'upstream-error' });
    expect(route.read).not.toHaveBeenCalled();
  });

  it.each([400, 403, 503])('preserves a safe typed scope message and status %s', async status => {
    const { EksScopeError } = await import('@/lib/eks-context');
    resolve.mockRejectedValue(new EksScopeError('EKS region is not enabled for this account', status));
    const { GET } = await route.load();
    const response = await GET(request(), { params: Promise.resolve({ cluster: MEMBER.id }) });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({
      status: 'error', message: 'EKS region is not enabled for this account', reason: status === 403 ? 'denied' : 'upstream-error',
    });
    expect(route.read).not.toHaveBeenCalled();
  });

  it.each([
    [{ statusCode: 403 }, 'denied', 'Access denied; check read permissions.'],
    [{ code: 'ETIMEDOUT' }, 'timeout', 'Request timed out; check connectivity and retry.'],
    [{ code: 'ECONNREFUSED' }, 'unreachable', 'Endpoint unreachable; check network connectivity and DNS.'],
    [{ code: 'ENOTFOUND' }, 'unreachable', 'Endpoint unreachable; check network connectivity and DNS.'],
    [{ statusCode: 503 }, 'upstream-error', ''],
  ])('exposes useful classification for %j', async (metadata, reason, phrase) => {
    resolve.mockResolvedValue(route.context);
    route.read.mockRejectedValue(Object.assign(new Error(SENTINEL), metadata));
    const { GET } = await route.load();
    const response = await GET(request(), { params: Promise.resolve({ cluster: route.context.id }) });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      status: 'error', message: route.message + (phrase ? ` ${phrase}` : ''), reason,
    });
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private');
  });

  it('retains the authentication and allowlist gates', async () => {
    const { GET } = await route.load();
    verify.mockResolvedValue(null);
    expect((await GET(request(), { params: Promise.resolve({ cluster: MEMBER.id }) })).status).toBe(401);
    expect(resolve).not.toHaveBeenCalled();
    verify.mockResolvedValue({ sub: 'u' });
    allowed.mockResolvedValue(false);
    expect((await GET(request(), { params: Promise.resolve({ cluster: MEMBER.id }) })).status).toBe(404);
    expect(route.read).not.toHaveBeenCalled();
  });
});
