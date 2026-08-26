import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const isAdmin = vi.fn();
const isClusterOnboarded = vi.fn();
const getOpencostConfig = vi.fn();
const upsertOpencostConfig = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/opencost-allowlist', () => ({ isClusterOnboarded: (...a: unknown[]) => isClusterOnboarded(...a) }));
vi.mock('@/lib/opencost-config', () => ({
  getOpencostConfig: (...a: unknown[]) => getOpencostConfig(...a),
  upsertOpencostConfig: (...a: unknown[]) => upsertOpencostConfig(...a),
}));

const req = (method = 'GET', body?: unknown) =>
  new Request('http://x/api/opencost/c1', { method, headers: { cookie: 'awsops_token=t', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const P = { params: { cluster: 'c1' } };

beforeEach(() => {
  vi.clearAllMocks();
  isClusterOnboarded.mockReturnValue(true);
  verifyUser.mockResolvedValue({ sub: 'u', email: 'a@x', groups: ['admins'] });
  isAdmin.mockResolvedValue(true);
});

describe('GET /api/opencost/[cluster]', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req(), P)).status).toBe(401);
  });
  it('404 when not onboarded', async () => {
    isClusterOnboarded.mockReturnValue(false);
    const { GET } = await import('./route');
    expect((await GET(req(), P)).status).toBe(404);
  });
  it('200 with config (null when none saved)', async () => {
    getOpencostConfig.mockResolvedValue(null);
    const { GET } = await import('./route');
    const res = await GET(req(), P);
    expect(res.status).toBe(200);
    expect((await res.json())).toEqual({ cluster: 'c1', config: null });
  });
});

describe('PUT /api/opencost/[cluster]', () => {
  it('403 non-admin', async () => {
    isAdmin.mockResolvedValue(false);
    const { PUT } = await import('./route');
    expect((await PUT(req('PUT', { config: {} }), P)).status).toBe(403);
  });
  it('404 not onboarded', async () => {
    isClusterOnboarded.mockReturnValue(false);
    const { PUT } = await import('./route');
    expect((await PUT(req('PUT', { config: {} }), P)).status).toBe(404);
  });
  it('200 upserts as the user', async () => {
    upsertOpencostConfig.mockResolvedValue(true);
    const { PUT } = await import('./route');
    const res = await PUT(req('PUT', { chartVersion: '1.0', config: { values: { defaultClusterId: 'c1' } } }), P);
    expect(res.status).toBe(200);
    expect(upsertOpencostConfig).toHaveBeenCalledWith(expect.objectContaining({ cluster: 'c1', chartVersion: '1.0', updatedBy: 'u' }));
  });
  it('503 when storage unavailable', async () => {
    upsertOpencostConfig.mockResolvedValue(false);
    const { PUT } = await import('./route');
    expect((await PUT(req('PUT', { config: {} }), P)).status).toBe(503);
  });
});
