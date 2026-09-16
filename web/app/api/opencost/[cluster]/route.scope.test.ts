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
  { name: 'config', load: () => import('./route'), read: readConfig },
  { name: 'status', load: () => import('./status/route'), read: installStatus },
  { name: 'allocation', load: () => import('./allocation/route'), read: allocation },
  { name: 'bundle', load: () => import('./bundle/route'), read: readConfig },
];

beforeEach(() => {
  vi.clearAllMocks();
  resolve.mockReset().mockResolvedValue({ id: ARN, name: 'shared', accountId: '222222222222', region: 'us-west-2' });
  allowed.mockResolvedValue(true);
  readConfig.mockResolvedValue(null); saveConfig.mockResolvedValue(true);
  allocation.mockResolvedValue({ available: true }); installStatus.mockResolvedValue({ installed: true });
});

describe.each(routes)('OpenCost $name scope', route => {
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
    expect((await GET(new Request(`http://local/?${search}`), params)).status).toBe(status);
    expect(route.read).not.toHaveBeenCalled();
  });
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
