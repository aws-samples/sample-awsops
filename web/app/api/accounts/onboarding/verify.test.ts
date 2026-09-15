import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyUser: vi.fn(), isAdmin: vi.fn(), getTaskRoleArn: vi.fn(), verifyAccountConnection: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ verifyUser: mocks.verifyUser }));
vi.mock('@/lib/admin', () => ({ isAdmin: mocks.isAdmin }));
vi.mock('@/lib/eks-access', () => ({ getTaskRoleArn: mocks.getTaskRoleArn }));
vi.mock('@/lib/account-connection', () => ({ verifyAccountConnection: mocks.verifyAccountConnection }));
import * as route from './route';

const input = { accountId: '222222222222', region: 'ap-northeast-2', externalId: 'private-external-id', firstParty: false };
const diagnostic = {
  checkId: '01234567-89ab-cdef-0123-456789abcdef', checkedAt: '2026-09-15T08:00:00.000Z',
  accountId: input.accountId, region: input.region, roleArn: 'arn:aws:iam::222222222222:role/AWSopsReadOnlyRole',
  hostTaskRoleArn: 'arn:aws:iam::111111111111:role/awsops-dev-task', externalIdProvided: true,
  stage: 'get_caller_identity', code: 'verified', awsRequestId: null, durationMs: 25, verified: true,
  registrationEnabled: false,
};
const request = (body: unknown = input, headers: Record<string, string> = {}) => new Request('https://app.test/api/accounts/onboarding', {
  method: 'POST', headers: { cookie: 'awsops_token=test', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('HOST_ACCOUNT_ID', '111111111111');
  vi.stubEnv('INVENTORY_HOST_ONLY', 'true');
  mocks.verifyUser.mockResolvedValue({ sub: 'admin' });
  mocks.isAdmin.mockResolvedValue(true);
  mocks.verifyAccountConnection.mockResolvedValue(diagnostic);
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('POST /api/accounts/onboarding', () => {
  it('supports a read-only connection check independently of registration', async () => {
    expect(route).toHaveProperty('POST');
    const response = await route.POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ ok: true, diagnostic });
    expect(mocks.verifyAccountConnection).toHaveBeenCalledWith(input, {
      hostAccountId: '111111111111', registrationEnabled: false,
    });
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(input.externalId);
  });

  it('requires administrator authentication before AWS calls', async () => {
    mocks.verifyUser.mockResolvedValue(null);
    expect((await route.POST(request())).status).toBe(401);
    mocks.verifyUser.mockResolvedValue({ sub: 'viewer' });
    mocks.isAdmin.mockResolvedValue(false);
    expect((await route.POST(request())).status).toBe(403);
    expect(mocks.verifyAccountConnection).not.toHaveBeenCalled();
  });

  it('allows diagnosis outside the registration scope while marking registration unavailable', async () => {
    vi.stubEnv('INVENTORY_HOST_ONLY', 'false');
    vi.stubEnv('INVENTORY_TARGET_ACCOUNT_IDS', '["333333333333"]');
    expect((await route.POST(request())).status).toBe(200);
    expect(mocks.verifyAccountConnection).toHaveBeenCalledWith(input, {
      hostAccountId: '111111111111', registrationEnabled: false,
    });
  });

  it.each([
    { accountId: 'invalid' },
    { accountId: '111111111111' },
    { accountId: 222222222222 },
    { externalId: '', firstParty: false },
    { externalId: '', firstParty: 'true' },
    { region: 'https://untrusted.test' },
    { externalId: 'bad value' },
    { externalId: 'x'.repeat(1225) },
  ])('rejects invalid verification input %j without AWS calls', async (patch) => {
    expect((await route.POST(request({ ...input, ...patch }))).status).toBe(400);
    expect(mocks.verifyAccountConnection).not.toHaveBeenCalled();
  });

  it('rejects oversized bodies before verification', async () => {
    expect((await route.POST(request(input, { 'content-length': '100000' }))).status).toBe(413);
    expect(mocks.verifyAccountConnection).not.toHaveBeenCalled();
  });

  it.each([
    ['access_denied', 400], ['timeout', 504], ['throttled', 503], ['host_identity_unavailable', 503],
  ])('returns a structured %s failure', async (code, status) => {
    mocks.verifyAccountConnection.mockResolvedValue({ ...diagnostic, verified: false, code, stage: 'assume_role' });
    const response = await route.POST(request());
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ ok: false, diagnostic: { code, verified: false } });
  });
});
