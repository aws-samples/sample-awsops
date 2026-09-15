import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ verifyUser: vi.fn(), isAdmin: vi.fn(), getTaskRoleArn: vi.fn() }));
vi.mock('@/lib/auth', () => ({ verifyUser: mocks.verifyUser }));
vi.mock('@/lib/admin', () => ({ isAdmin: mocks.isAdmin }));
vi.mock('@/lib/eks-access', () => ({ getTaskRoleArn: mocks.getTaskRoleArn }));
import { GET } from './route';

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('HOST_ACCOUNT_ID', '111111111111');
  vi.stubEnv('INVENTORY_HOST_ONLY', 'false');
  mocks.verifyUser.mockResolvedValue({ sub: 'admin' });
  mocks.isAdmin.mockResolvedValue(true);
  mocks.getTaskRoleArn.mockResolvedValue('arn:aws:iam::111111111111:role/awsops-dev-task');
});
afterEach(() => vi.unstubAllEnvs());
const request = () => new Request('https://app.test/api/accounts/onboarding', { headers: { cookie: 'awsops_token=test' } });

describe('GET /api/accounts/onboarding', () => {
  it('verifies authentication and admin status before resolving any AWS identity', async () => {
    mocks.verifyUser.mockResolvedValue(null);
    expect((await GET(request())).status).toBe(401);
    expect(mocks.isAdmin).not.toHaveBeenCalled();
    mocks.verifyUser.mockResolvedValue({ sub: 'viewer' });
    mocks.isAdmin.mockResolvedValue(false);
    expect((await GET(request())).status).toBe(403);
    expect(mocks.getTaskRoleArn).not.toHaveBeenCalled();
  });
  it('returns the actual task role and prevents caching', async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.json()).toMatchObject({
      hostAccountId: '111111111111', hostTaskRoleArn: 'arn:aws:iam::111111111111:role/awsops-dev-task',
      registrationEnabled: true,
    });
    expect(mocks.verifyUser).toHaveBeenCalledWith('awsops_token=test');
  });
  it('discloses host-only mode without enabling registration', async () => {
    vi.stubEnv('INVENTORY_HOST_ONLY', 'true');
    expect(await (await GET(request())).json()).toMatchObject({ registrationEnabled: false });
  });
  it.each(['arn:aws:iam::111111111111:root', 'arn:aws:iam::222222222222:role/task', ''])('fails closed for an invalid host identity %s', async (arn) => {
    mocks.getTaskRoleArn.mockResolvedValue(arn);
    expect((await GET(request())).status).toBe(503);
  });
  it('reports discovery failure without exposing upstream diagnostics', async () => {
    mocks.getTaskRoleArn.mockRejectedValue(new Error('private diagnostics'));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private diagnostics');
  });
  it('returns the configured collector principal only from the verified host account', async () => {
    const inventoryTaskRoleArn = 'arn:aws:iam::111111111111:role/awsops-dev-steampipe-task';
    vi.stubEnv('INVENTORY_TASK_ROLE_ARN', inventoryTaskRoleArn);
    expect(await (await GET(request())).json()).toMatchObject({ inventoryTaskRoleArn });
    vi.stubEnv('INVENTORY_TASK_ROLE_ARN', 'arn:aws:iam::222222222222:role/other');
    expect((await GET(request())).status).toBe(503);
  });
  it('discloses the applied account allowlist and rejects malformed scope', async () => {
    vi.stubEnv('INVENTORY_TARGET_ACCOUNT_IDS', '["222222222222"]');
    expect(await (await GET(request())).json()).toMatchObject({ registrationTargetAccountIds: ['222222222222'] });
    vi.stubEnv('INVENTORY_TARGET_ACCOUNT_IDS', '{}');
    expect((await GET(request())).status).toBe(503);
  });
});
