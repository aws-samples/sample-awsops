import { describe, it, expect, vi, beforeEach } from 'vitest';

const send = vi.fn();
vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class { send = (...a: unknown[]) => send(...a); },
  GetParameterCommand: class { constructor(public input: unknown) {} },
}));

import { isAdmin, _clearAdminCacheForTests } from './admin';

beforeEach(() => { send.mockReset(); _clearAdminCacheForTests(); delete process.env.ADMIN_GROUP; delete process.env.SSM_ADMIN_EMAILS_PARAM; });

describe('isAdmin', () => {
  it('true when cognito:groups contains the admin group', async () => {
    expect(await isAdmin({ sub: 'u', email: 'x@x', groups: ['admins'] })).toBe(true);
    expect(send).not.toHaveBeenCalled(); // group hit short-circuits SSM
  });
  it('true when email is in the SSM admin allowlist', async () => {
    process.env.SSM_ADMIN_EMAILS_PARAM = '/ops/awsops-v2/admin_emails';
    send.mockResolvedValue({ Parameter: { Value: 'a@x,b@x' } });
    expect(await isAdmin({ sub: 'u', email: 'b@x', groups: [] })).toBe(true);
  });
  it('false (fail-closed) when no group and email not listed', async () => {
    process.env.SSM_ADMIN_EMAILS_PARAM = '/ops/awsops-v2/admin_emails';
    send.mockResolvedValue({ Parameter: { Value: 'a@x' } });
    expect(await isAdmin({ sub: 'u', email: 'z@x', groups: [] })).toBe(false);
  });
  it('false (fail-closed) when SSM param is empty/missing and no group', async () => {
    process.env.SSM_ADMIN_EMAILS_PARAM = '/ops/awsops-v2/admin_emails';
    send.mockResolvedValue({ Parameter: { Value: '' } });
    expect(await isAdmin({ sub: 'u', email: 'z@x' })).toBe(false);
  });
  it('false when SSM param env not set and no group', async () => {
    expect(await isAdmin({ sub: 'u', email: 'z@x' })).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
