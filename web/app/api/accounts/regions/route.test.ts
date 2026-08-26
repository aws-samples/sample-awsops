import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const isAdmin = vi.fn();
const listAccountRegions = vi.fn();
const upsertAccountRegion = vi.fn();
const disableAccountRegion = vi.fn();
const getAccount = vi.fn();
const getHostAccount = vi.fn();
const readJsonBounded = vi.fn();

vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/accounts', () => ({
  getAccount: (...a: unknown[]) => getAccount(...a),
  getHostAccount: (...a: unknown[]) => getHostAccount(...a),
  // Mirror the REAL validateAccountId (12-digit only) — do NOT fake-accept 'self' here; the route
  // resolves 'self' to the host id via getHostAccount, and that path is exercised below.
  validateAccountId: (id: string) => /^\d{12}$/.test(id),
}));
vi.mock('@/lib/account-regions', () => ({
  listAccountRegions: (...a: unknown[]) => listAccountRegions(...a),
  upsertAccountRegion: (...a: unknown[]) => upsertAccountRegion(...a),
  disableAccountRegion: (...a: unknown[]) => disableAccountRegion(...a),
  validateRegion: (r: string) => /^[a-z]{2}-[a-z]+-\d+$/.test(r),
}));
vi.mock('@/lib/http-body', () => ({ readJsonBounded: (...a: unknown[]) => readJsonBounded(...a) }));

const req = (method = 'GET', url = 'http://x/api/accounts/regions', cookie = 'awsops_token=t') =>
  new Request(url, { method, headers: { cookie } });

beforeEach(() => {
  vi.resetModules();
  verifyUser.mockReset(); isAdmin.mockReset(); listAccountRegions.mockReset();
  upsertAccountRegion.mockReset(); disableAccountRegion.mockReset(); getAccount.mockReset();
  getHostAccount.mockReset(); readJsonBounded.mockReset();
  verifyUser.mockResolvedValue({ email: 'admin@example.com', groups: ['admins'] });
  isAdmin.mockResolvedValue(true);
  listAccountRegions.mockResolvedValue([{ accountId: '111122223333', region: 'ap-northeast-2', enabled: true }]);
  getAccount.mockResolvedValue({ accountId: '210987654321', isHost: false });
  getHostAccount.mockResolvedValue({ accountId: '111122223333', isHost: true });
  readJsonBounded.mockResolvedValue({ accountId: '210987654321', region: 'us-east-1' });
});

describe('GET /api/accounts/regions', () => {
  it('401 unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(401);
  });

  it('lists configured regions', async () => {
    const { GET } = await import('./route');
    const body = await (await GET(req())).json();
    expect(body.regions).toEqual([{ accountId: '111122223333', region: 'ap-northeast-2', enabled: true }]);
  });
});

describe('POST /api/accounts/regions', () => {
  it('401 unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { POST } = await import('./route');
    expect((await POST(req('POST'))).status).toBe(401);
    expect(upsertAccountRegion).not.toHaveBeenCalled();
  });

  it('403 for non-admin', async () => {
    isAdmin.mockResolvedValue(false);
    const { POST } = await import('./route');
    expect((await POST(req('POST'))).status).toBe(403);
    expect(upsertAccountRegion).not.toHaveBeenCalled();
  });

  it('400 for an accountId that is neither self nor 12 digits', async () => {
    readJsonBounded.mockResolvedValue({ accountId: 'bogus', region: 'us-east-1' });
    const { POST } = await import('./route');
    expect((await POST(req('POST'))).status).toBe(400);
    expect(upsertAccountRegion).not.toHaveBeenCalled();
  });

  it("resolves 'self' to the host account id before upsert", async () => {
    readJsonBounded.mockResolvedValue({ accountId: 'self', region: 'us-east-1' });
    getAccount.mockResolvedValue({ accountId: '111122223333', isHost: true });
    const { POST } = await import('./route');
    expect((await POST(req('POST'))).status).toBe(200);
    expect(upsertAccountRegion).toHaveBeenCalledWith('111122223333', 'us-east-1');
  });

  it('400 for invalid region', async () => {
    readJsonBounded.mockResolvedValue({ accountId: '210987654321', region: 'global' });
    const { POST } = await import('./route');
    expect((await POST(req('POST'))).status).toBe(400);
  });

  it('404 for unknown account', async () => {
    getAccount.mockResolvedValue(undefined);
    const { POST } = await import('./route');
    expect((await POST(req('POST'))).status).toBe(404);
  });

  it('adds an enabled region', async () => {
    const { POST } = await import('./route');
    expect((await POST(req('POST'))).status).toBe(200);
    expect(upsertAccountRegion).toHaveBeenCalledWith('210987654321', 'us-east-1');
  });
});

describe('DELETE /api/accounts/regions', () => {
  const delReq = (qs = 'accountId=210987654321&region=us-east-1') =>
    req('DELETE', `http://x/api/accounts/regions?${qs}`);

  it('401 unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { DELETE } = await import('./route');
    expect((await DELETE(delReq())).status).toBe(401);
    expect(disableAccountRegion).not.toHaveBeenCalled();
  });

  it('403 for non-admin', async () => {
    isAdmin.mockResolvedValue(false);
    const { DELETE } = await import('./route');
    expect((await DELETE(delReq())).status).toBe(403);
    expect(disableAccountRegion).not.toHaveBeenCalled();
  });

  it('disables a configured region', async () => {
    const { DELETE } = await import('./route');
    expect((await DELETE(delReq())).status).toBe(200);
    expect(disableAccountRegion).toHaveBeenCalledWith('210987654321', 'us-east-1');
  });

  it("resolves 'self' to the host account id before disabling", async () => {
    getAccount.mockResolvedValue({ accountId: '111122223333', isHost: true });
    const { DELETE } = await import('./route');
    expect((await DELETE(delReq('accountId=self&region=us-east-1'))).status).toBe(200);
    expect(disableAccountRegion).toHaveBeenCalledWith('111122223333', 'us-east-1');
  });
});
