import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolve, allowed, readConfig, saveConfig, allocation, installStatus } = vi.hoisted(() => ({
  resolve: vi.fn(), allowed: vi.fn(), readConfig: vi.fn(), saveConfig: vi.fn(), allocation: vi.fn(), installStatus: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ verifyUser: async () => ({ sub: 'u' }) }));
vi.mock('@/lib/admin', () => ({ isAdmin: async () => true }));
vi.mock('@/lib/eks-context', () => ({
  resolveEksCluster: resolve,
  EksScopeError: class extends Error { constructor(message: string, public status: number) { super(message); } },
}));
vi.mock('@/lib/opencost-allowlist', () => ({ isClusterOnboarded: allowed }));
vi.mock('@/lib/eks-registry', () => ({ getAllowedClusters: async () => new Set(['shared']) }));
vi.mock('@/lib/opencost-config', () => ({ getOpencostConfig: readConfig, upsertOpencostConfig: saveConfig }));
vi.mock('@/lib/opencost-allocation', () => ({ getAllocation: allocation }));
vi.mock('@/lib/opencost-status', () => ({ detectOpencostInstall: installStatus }));

const ARN = 'arn:aws:eks:us-west-2:222222222222:cluster/shared';
const search = 'account=222222222222&region=us-west-2';
const params = { params: { cluster: 'shared' } };
const routes = [
  { name: 'config', load: () => import('./route'), read: readConfig, fallback: 500, message: 'OpenCost configuration is unavailable.' },
  { name: 'status', load: () => import('./status/route'), read: installStatus, fallback: 500, message: 'OpenCost status is unavailable.' },
  { name: 'allocation', load: () => import('./allocation/route'), read: allocation, fallback: 200, message: 'OpenCost allocation is unavailable.' },
  { name: 'bundle', load: () => import('./bundle/route'), read: readConfig, fallback: 500, message: 'OpenCost bundle is unavailable.' },
];
const SENTINEL = 'arn:aws:iam::222222222222:role/private-role ExternalId=private-external SessionToken=private-session';

beforeEach(() => {
  vi.clearAllMocks();
  resolve.mockReset().mockResolvedValue({ id: ARN, name: 'shared', accountId: '222222222222', region: 'us-west-2' });
  allowed.mockResolvedValue(true);
  readConfig.mockResolvedValue(null); saveConfig.mockResolvedValue(true);
  allocation.mockResolvedValue({ available: true }); installStatus.mockResolvedValue({ installed: true });
});

describe.each(routes)('OpenCost $name scope', route => {
  it.each(['error', 'string', 'object'])('sanitizes a returned upstream %s failure without logging it', async kind => {
    route.read.mockRejectedValue(kind === 'error' ? Object.assign(new Error(SENTINEL), { stack: SENTINEL, $metadata: { requestId: SENTINEL } })
      : kind === 'string' ? SENTINEL : { message: SENTINEL, status: 403, toString: () => SENTINEL });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { GET } = await route.load();
      const response = await GET(new Request(`http://local/?${search}`), params);
      expect(response.status).toBe(route.fallback);
      expect(await response.json()).toEqual(route.name === 'allocation'
        ? { available: false, message: route.message } : { status: 'error', message: route.message });
      expect(log).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled();
    } finally { log.mockRestore(); warn.mockRestore(); }
  });

  it('sanitizes an unexpected scope-resolution error', async () => {
    resolve.mockRejectedValue(new Error(SENTINEL));
    const { GET } = await route.load();
    const response = await GET(new Request(`http://local/?${search}`), params);
    expect(response.status).toBe(route.fallback);
    expect((await response.json()).message).toBe(route.message);
    expect(route.read).not.toHaveBeenCalled();
  });

  it('uses canonical registry/storage/proxy identity for explicit account and region', async () => {
    const { GET } = await route.load();
    const response = await GET(new Request(`http://local/?${search}`), params);
    expect(response.status).toBe(200);
    expect(resolve).toHaveBeenCalledWith('shared', new URLSearchParams(search));
    expect(allowed).toHaveBeenCalledWith(ARN);
    expect(route.read).toHaveBeenCalledWith(ARN);
  });

  it('cannot use a namesake host registration', async () => {
    allowed.mockImplementation(async id => id === 'shared');
    const { GET } = await route.load();
    const response = await GET(new Request(`http://local/?${search}`), params);
    if (route.name === 'allocation') expect(await response.json()).toMatchObject({ available: false });
    else expect(response.status).toBe(404);
    expect(route.read).not.toHaveBeenCalled();
  });

  it.each([400, 403, 503])('preserves scope rejection %s without reading data', async status => {
    const { EksScopeError } = await import('@/lib/eks-context');
    resolve.mockRejectedValue(new EksScopeError('invalid scope', status));
    const { GET } = await route.load();
    const response = await GET(new Request(`http://local/?${search}`), params);
    expect(response.status).toBe(status);
    expect((await response.json()).message).toBe('invalid scope');
    expect(route.read).not.toHaveBeenCalled();
  });
});

it.each(['scope', 'save'])('sanitizes an unexpected PUT %s error', async stage => {
  (stage === 'scope' ? resolve : saveConfig).mockRejectedValue(new Error(SENTINEL));
  const { PUT } = await import('./route');
  const response = await PUT(new Request(`http://local/?${search}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"config":{}}',
  }), params);
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ status: 'error', message: 'OpenCost configuration is unavailable.' });
});

it('keeps PUT validation errors fixed instead of reflecting input embedded in an exception', async () => {
  const { PUT } = await import('./route');
  const response = await PUT(new Request(`http://local/?${search}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ config: {}, chartVersion: SENTINEL }),
  }), params);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ status: 'error', message: 'invalid config' });
  expect(saveConfig).not.toHaveBeenCalled();
});

it('saves config only under the canonical ID', async () => {
  const { PUT } = await import('./route');
  const request = new Request(`http://local/?${search}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config: {} }),
  });
  expect((await PUT(request, params)).status).toBe(200);
  expect(allowed).toHaveBeenCalledWith(ARN);
  expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ cluster: ARN }));
});

it('renders member bundle with the real name, target region and an account guard', async () => {
  const { GET } = await import('./bundle/route');
  const response = await GET(new Request(`http://local/?${search}`), params);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.valuesYaml).toContain('defaultClusterId: shared');
  expect(body.valuesYaml).toContain('service_account_region: us-west-2');
  expect(body.installSh).toContain('aws eks update-kubeconfig --name shared --region us-west-2');
  expect(body.installSh).toContain('aws sts get-caller-identity');
  expect(body.installSh).toContain('222222222222');
  expect(body.installSh).not.toContain('--name arn:');
  expect(body.installSh).not.toContain('cluster/arn:');
});
