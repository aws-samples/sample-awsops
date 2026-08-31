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
  // pentest-remediation P1-2 (Finding 4): reject the newline-injected key at save time (400), not
  // just at render time — so a bad config never reaches storage in the first place.
  it('400 on a newline-injected override key, without ever calling upsertOpencostConfig', async () => {
    const { PUT } = await import('./route');
    const res = await PUT(
      req('PUT', { chartVersion: '1.0', config: { override: { 'key\nmalicious_key: injected_value': 'test' } } }),
      P,
    );
    expect(res.status).toBe(400);
    expect(upsertOpencostConfig).not.toHaveBeenCalled();
  });
  it('200 accepts an IRSA-style override key containing a slash', async () => {
    upsertOpencostConfig.mockResolvedValue(true);
    const { PUT } = await import('./route');
    const res = await PUT(
      req('PUT', { config: { override: { serviceAccount: { annotations: { 'eks.amazonaws.com/role-arn': 'arn:aws:iam::123:role/x' } } } } }),
      P,
    );
    expect(res.status).toBe(200);
  });
  // pentest-remediation P1-2 follow-up: chartVersion used to only be validated at bundle-render
  // time (renderInstallSh), so a bad value saved fine and permanently 500'd the bundle route later.
  it('400 on an unsafe chartVersion, without ever calling upsertOpencostConfig', async () => {
    const { PUT } = await import('./route');
    const res = await PUT(req('PUT', { chartVersion: '1.0;curl evil', config: {} }), P);
    expect(res.status).toBe(400);
    expect(upsertOpencostConfig).not.toHaveBeenCalled();
  });
  it('400 when config is not a plain object', async () => {
    const { PUT } = await import('./route');
    const res = await PUT(req('PUT', { config: 'not-an-object' as any }), P);
    expect(res.status).toBe(400);
    expect(upsertOpencostConfig).not.toHaveBeenCalled();
  });
  // pentest-remediation P1-2 round 2: RegExp.test() coerces its argument to a string, so
  // assertSafeName('chartVersion', ['1.0']) would silently pass (String(['1.0']) === '1.0') and
  // store the array — later rendering as a Postgres array literal that fails assertSafeName at
  // bundle-download time. Reject non-string chartVersion before it ever reaches assertSafeName.
  it('400 when chartVersion is an array, without ever calling upsertOpencostConfig', async () => {
    const { PUT } = await import('./route');
    const res = await PUT(req('PUT', { chartVersion: ['1.0'] as any, config: {} }), P);
    expect(res.status).toBe(400);
    expect(upsertOpencostConfig).not.toHaveBeenCalled();
  });
  it('400 when chartVersion is an object, without ever calling upsertOpencostConfig', async () => {
    const { PUT } = await import('./route');
    const res = await PUT(req('PUT', { chartVersion: { evil: 1 } as any, config: {} }), P);
    expect(res.status).toBe(400);
    expect(upsertOpencostConfig).not.toHaveBeenCalled();
  });
});
