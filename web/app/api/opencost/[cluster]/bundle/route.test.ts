import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const isClusterOnboarded = vi.fn();
const getOpencostConfig = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/opencost-allowlist', () => ({ isClusterOnboarded: (...a: unknown[]) => isClusterOnboarded(...a) }));
vi.mock('@/lib/opencost-config', () => ({ getOpencostConfig: (...a: unknown[]) => getOpencostConfig(...a) }));
// NOTE: @/lib/opencost (pure renderers) is intentionally NOT mocked — exercise the real output.

const req = () => new Request('http://x/api/opencost/fsi-demo-cluster/bundle', { headers: { cookie: 'awsops_token=t' } });
const P = { params: { cluster: 'fsi-demo-cluster' } };

beforeEach(() => {
  vi.clearAllMocks();
  isClusterOnboarded.mockReturnValue(true);
  verifyUser.mockResolvedValue({ sub: 'u' });
  getOpencostConfig.mockResolvedValue(null); // no saved config → defaults
});

describe('GET /api/opencost/[cluster]/bundle', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req(), P)).status).toBe(401);
  });
  it('404 not onboarded', async () => {
    isClusterOnboarded.mockReturnValue(false);
    const { GET } = await import('./route');
    expect((await GET(req(), P)).status).toBe(404);
  });
  it('200 returns values.yaml + install.sh built from defaults', async () => {
    const { GET } = await import('./route');
    const res = await GET(req(), P);
    expect(res.status).toBe(200);
    const { valuesYaml, installSh } = await res.json();
    expect(valuesYaml).toContain('defaultClusterId: fsi-demo-cluster');
    expect(valuesYaml).toContain('serviceName: prometheus-server');
    expect(installSh).toContain('aws eks update-kubeconfig --name fsi-demo-cluster');
    expect(installSh).toContain('helm upgrade --install opencost opencost/opencost -n opencost --create-namespace');
    expect(installSh).not.toContain('--version'); // no saved chart version → latest
  });
  it('uses a saved chart version when present', async () => {
    getOpencostConfig.mockResolvedValue({ cluster: 'fsi-demo-cluster', chartVersion: '1.42.0', config: {}, updatedBy: 'u', updatedAt: null });
    const { GET } = await import('./route');
    const { installSh } = await (await GET(req(), P)).json();
    expect(installSh).toContain('--version 1.42.0');
  });
});
