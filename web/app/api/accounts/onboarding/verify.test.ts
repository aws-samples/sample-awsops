import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyUser: vi.fn(), isAdmin: vi.fn(), getTaskRoleArn: vi.fn(), verifyAccountConnection: vi.fn(), getAccount: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ verifyUser: mocks.verifyUser }));
vi.mock('@/lib/admin', () => ({ isAdmin: mocks.isAdmin }));
vi.mock('@/lib/eks-access', () => ({ getTaskRoleArn: mocks.getTaskRoleArn }));
vi.mock('@/lib/account-connection', () => ({ verifyAccountConnection: mocks.verifyAccountConnection }));
vi.mock('@/lib/accounts', () => ({ getAccount: mocks.getAccount }));
let route: typeof import('./route');

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

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv('HOST_ACCOUNT_ID', '111111111111');
  vi.stubEnv('INVENTORY_HOST_ONLY', 'true');
  vi.stubEnv('INVENTORY_TARGET_ACCOUNT_IDS', '["222222222222"]');
  mocks.verifyUser.mockResolvedValue({ sub: 'admin' });
  mocks.isAdmin.mockResolvedValue(true);
  mocks.verifyAccountConnection.mockResolvedValue(diagnostic);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  route = await import('./route');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

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
    expect(JSON.parse(vi.mocked(console.info).mock.calls[0][0])).toMatchObject({ actor_sub: 'admin' });
  });

  it('requires administrator authentication before AWS calls', async () => {
    mocks.verifyUser.mockResolvedValue(null);
    expect((await route.POST(request())).status).toBe(401);
    mocks.verifyUser.mockResolvedValue({ sub: 'viewer' });
    mocks.isAdmin.mockResolvedValue(false);
    expect((await route.POST(request())).status).toBe(403);
    expect(mocks.verifyAccountConnection).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '   ', 'x'.repeat(129)])('requires a bounded immutable actor before probe admission: %s', async sub => {
    mocks.verifyUser.mockResolvedValue({ sub });
    expect((await route.POST(request())).status).toBe(401);
    expect(mocks.getAccount).not.toHaveBeenCalled();
    expect(mocks.verifyAccountConnection).not.toHaveBeenCalled();
  });

  it('rejects a probe outside the applied target scope before any AWS call', async () => {
    vi.stubEnv('INVENTORY_HOST_ONLY', 'false');
    vi.stubEnv('INVENTORY_TARGET_ACCOUNT_IDS', '["333333333333"]');
    const response = await route.POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'target_not_configured' });
    expect(mocks.verifyAccountConnection).not.toHaveBeenCalled();
  });

  it('does not open arbitrary cross-account probes in a host-only deployment', async () => {
    vi.stubEnv('INVENTORY_TARGET_ACCOUNT_IDS', '');
    const response = await route.POST(request());
    expect(response.status).toBe(409);
    expect(mocks.verifyAccountConnection).not.toHaveBeenCalled();
    expect(JSON.parse(vi.mocked(console.info).mock.calls[0][0])).toMatchObject({
      actor_sub: 'admin', accountId: input.accountId, code: 'target_not_configured',
    });
  });

  it('does not permit arbitrary new-target probes in legacy multi-account mode', async () => {
    vi.stubEnv('INVENTORY_HOST_ONLY', 'false');
    vi.stubEnv('INVENTORY_TARGET_ACCOUNT_IDS', '');
    expect((await route.POST(request())).status).toBe(409);
    expect(mocks.verifyAccountConnection).not.toHaveBeenCalled();
  });

  it.each(['', '[]', '["333333333333"]'])('permits an enabled registered target without broadening registration: %s', async targets => {
    vi.stubEnv('INVENTORY_TARGET_ACCOUNT_IDS', targets);
    mocks.getAccount.mockResolvedValue({ accountId: input.accountId, enabled: true, isHost: false });
    expect((await route.POST(request())).status).toBe(200);
    expect(mocks.verifyAccountConnection).toHaveBeenCalledOnce();
    expect(mocks.verifyAccountConnection.mock.calls[0][1].registrationEnabled).toBe(false);
  });

  it('does not turn an out-of-list registered probe into multi-account registration permission', async () => {
    vi.stubEnv('INVENTORY_HOST_ONLY', 'false');
    vi.stubEnv('INVENTORY_TARGET_ACCOUNT_IDS', '["333333333333"]');
    mocks.getAccount.mockResolvedValue({ accountId: input.accountId, enabled: true, isHost: false });
    expect((await route.POST(request())).status).toBe(200);
    expect(mocks.verifyAccountConnection.mock.calls[0][1].registrationEnabled).toBe(false);
  });

  it.each([undefined, { accountId: input.accountId, enabled: false, isHost: false },
    { accountId: input.accountId, enabled: true, isHost: true },
    { accountId: '333333333333', enabled: true, isHost: false }])('rejects absent or unusable registered approval: %j', async account => {
    vi.stubEnv('INVENTORY_TARGET_ACCOUNT_IDS', '');
    mocks.getAccount.mockResolvedValue(account);
    expect((await route.POST(request())).status).toBe(409);
    expect(mocks.verifyAccountConnection).not.toHaveBeenCalled();
  });

  it('fails closed on registry errors without exposing their contents', async () => {
    vi.stubEnv('INVENTORY_TARGET_ACCOUNT_IDS', '');
    mocks.getAccount.mockRejectedValue(new Error('PRIVATE registry failure'));
    const response = await route.POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'scope_unavailable' });
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain('PRIVATE');
    expect(mocks.verifyAccountConnection).not.toHaveBeenCalled();
  });

  it('holds single-flight during approval lookup and releases it after a rejected target', async () => {
    const started = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(started);
    vi.stubEnv('INVENTORY_TARGET_ACCOUNT_IDS', '');
    let finish!: (value: undefined) => void;
    mocks.getAccount.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = route.POST(request());
    await vi.waitFor(() => expect(mocks.getAccount).toHaveBeenCalledOnce());
    const second = await route.POST(request());
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ code: 'probe_in_flight' });
    expect(mocks.getAccount).toHaveBeenCalledOnce();
    finish(undefined);
    expect((await first).status).toBe(409);
    vi.stubEnv('INVENTORY_TARGET_ACCOUNT_IDS', '["222222222222"]');
    const coolingDown = await route.POST(request());
    expect(coolingDown.status).toBe(429);
    expect(await coolingDown.json()).toMatchObject({ code: 'probe_cooldown', retryAfterSeconds: 60 });
    vi.mocked(Date.now).mockReturnValue(started + 60_000);
    expect((await route.POST(request())).status).toBe(200);
  });

  it('bounds a never-settling registry lookup and admits an approved probe only after cooldown', async () => {
    vi.useFakeTimers();
    vi.stubEnv('INVENTORY_TARGET_ACCOUNT_IDS', '');
    mocks.getAccount.mockImplementationOnce(() => new Promise(() => {}));
    let response: Response | undefined;
    const first = route.POST(request()).then(result => { response = result; });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.getAccount).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2999);
    expect(response).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(response?.status).toBe(503);
    await first;
    expect(await response!.json()).toMatchObject({ code: 'scope_unavailable' });
    expect(response!.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mocks.getAccount.mock.calls[0][1]?.aborted).toBe(true);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(input.externalId);
    expect(mocks.verifyAccountConnection).not.toHaveBeenCalled();
    vi.stubEnv('INVENTORY_TARGET_ACCOUNT_IDS', '["222222222222"]');
    const coolingDown = await route.POST(request());
    expect(coolingDown.status).toBe(429);
    expect(await coolingDown.json()).toMatchObject({ code: 'probe_cooldown', retryAfterSeconds: 57 });
    await vi.advanceTimersByTimeAsync(57_000);
    expect((await route.POST(request())).status).toBe(200);
    expect(mocks.getAccount).toHaveBeenCalledOnce();
    expect(mocks.verifyAccountConnection).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores approval arriving after its lookup deadline without starting STS', async () => {
    vi.useFakeTimers();
    vi.stubEnv('INVENTORY_TARGET_ACCOUNT_IDS', '');
    let finish!: (value: unknown) => void;
    mocks.getAccount.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    let response: Response | undefined;
    const first = route.POST(request()).then(result => { response = result; });
    await vi.advanceTimersByTimeAsync(3000);
    expect(response?.status).toBe(503);
    await first;
    finish({ accountId: input.accountId, enabled: true, isHost: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.verifyAccountConnection).not.toHaveBeenCalled();
    expect((await route.POST(request())).status).toBe(429);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains the admission cooldown after a failed registry lookup', async () => {
    const started = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(started);
    vi.stubEnv('INVENTORY_TARGET_ACCOUNT_IDS', '');
    mocks.getAccount.mockRejectedValueOnce(new Error('PRIVATE registry failure'));
    expect((await route.POST(request())).status).toBe(503);
    const retry = await route.POST(request());
    expect(retry.status).toBe(429);
    expect(await retry.json()).toMatchObject({ code: 'probe_cooldown', retryAfterSeconds: 60 });
    expect(mocks.getAccount).toHaveBeenCalledOnce();
    expect(mocks.verifyAccountConnection).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain('PRIVATE');
  });

  it('limits repeated probes on the server and provides a retry delay', async () => {
    const started = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(started);
    expect((await route.POST(request())).status).toBe(200);
    const response = await route.POST(request());
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(await response.json()).toMatchObject({ code: 'probe_cooldown', retryAfterSeconds: 60 });
    expect(mocks.verifyAccountConnection).toHaveBeenCalledOnce();
    mocks.verifyUser.mockResolvedValue({ sub: 'another-admin' });
    vi.mocked(Date.now).mockReturnValue(started + 59_999);
    expect((await route.POST(request())).status).toBe(429);
    vi.mocked(Date.now).mockReturnValue(started + 60_001);
    expect((await route.POST(request())).status).toBe(200);
    expect(mocks.verifyAccountConnection).toHaveBeenCalledTimes(2);
  });

  it('permits only one in-flight probe even after the cooldown elapses', async () => {
    const started = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(started);
    let finish!: (value: typeof diagnostic) => void;
    mocks.verifyAccountConnection.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = route.POST(request());
    await vi.waitFor(() => expect(mocks.verifyAccountConnection).toHaveBeenCalledOnce());
    vi.mocked(Date.now).mockReturnValue(started + 61_000);
    const second = await route.POST(request());
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ code: 'probe_in_flight' });
    finish(diagnostic);
    expect((await first).status).toBe(200);
    expect((await route.POST(request())).status).toBe(200);
  });

  it('releases single-flight after an unexpected verifier failure while preserving its cooldown', async () => {
    const started = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(started);
    mocks.verifyAccountConnection.mockRejectedValueOnce(new Error('PRIVATE unexpected provider failure'));
    const response = await route.POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'check_failed' });
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain('PRIVATE');
    expect((await route.POST(request())).status).toBe(429);
    vi.mocked(Date.now).mockReturnValue(started + 60_001);
    expect((await route.POST(request())).status).toBe(200);
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
