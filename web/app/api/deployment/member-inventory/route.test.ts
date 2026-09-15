import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ verifyUser: vi.fn(), query: vi.fn() }));
vi.mock('@/lib/auth', () => ({ verifyUser: mocks.verifyUser }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: mocks.query }) }));
import { GET } from './route';

const accountId = '222222222222';
const resourceId = 'i-0123456789abcdef0';
const proof = {
  account_id: accountId, resource_type: 'ec2', resource_id: resourceId,
  region: 'ap-northeast-2', captured_at: '2026-09-15T09:00:00+00:00', observed_id: resourceId,
};
const scope = {
  account_id: accountId, enabled: true, is_host: false, role_name: 'AWSopsReadOnlyRole',
  scan_enabled: true, resources: [proof],
};
const request = (changes: Record<string, string> = {}) => {
  const params = new URLSearchParams({ accountId, type: 'ec2', resourceId, ...changes });
  return new Request(`https://app.test/api/deployment/member-inventory?${params}`, { headers: { cookie: 'awsops_token=test' } });
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('HOST_ACCOUNT_ID', '111111111111');
  vi.stubEnv('INVENTORY_TARGET_ACCOUNT_IDS', JSON.stringify([accountId]));
  mocks.verifyUser.mockResolvedValue({ sub: 'verifier', groups: ['deployment-verifiers'] });
  mocks.query.mockResolvedValue({ rows: [scope] });
});
afterEach(() => vi.unstubAllEnvs());

describe('GET /api/deployment/member-inventory', () => {
  it('returns only bounded identity evidence from one exact lookup', async () => {
    mocks.query.mockResolvedValue({ rows: [{ ...scope, resources: [{ ...proof, data: 'private'.repeat(100_000) }] }] });
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const body = await response.json();
    expect(body).toEqual({
      schemaVersion: 1, status: 'verified', accountId, type: 'ec2', resourceId,
      region: 'ap-northeast-2', capturedAt: '2026-09-15T09:00:00.000Z',
    });
    expect(JSON.stringify(body).length).toBeLessThan(1000);
    expect(mocks.query).toHaveBeenCalledOnce();
    const [sql, values] = mocks.query.mock.calls[0];
    expect(values).toEqual([accountId, 'ec2', resourceId, 'instance_id']);
    expect(sql).toContain('ir.resource_id = $3');
    expect(sql).toContain('ir.account_id = $1');
    expect(sql).toContain('LIMIT 2');
    expect(sql).not.toMatch(/SELECT\s+\*/i);
  });

  it('requires authentication before reading the deployment scope or database', async () => {
    mocks.verifyUser.mockResolvedValue(null);
    expect((await GET(request())).status).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it.each([
    { accountId: '111111111111' }, { accountId: '333333333333' },
  ])('rejects an account outside the applied member scope', async (patch) => {
    expect((await GET(request(patch))).status).toBe(403);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it.each([
    { accountId: 'not-an-account' }, { type: 's3' }, { resourceId: '' },
    { resourceId: 'x'.repeat(2049) }, { resourceId: 'bad\nid' },
  ])('rejects malformed or unsupported input before querying', async (patch) => {
    expect((await GET(request(patch))).status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('fails closed when member scope configuration is missing or malformed', async () => {
    vi.stubEnv('INVENTORY_TARGET_ACCOUNT_IDS', '');
    expect((await GET(request())).status).toBe(403);
    vi.stubEnv('INVENTORY_TARGET_ACCOUNT_IDS', '{}');
    expect((await GET(request())).status).toBe(503);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it.each([
    { enabled: false }, { is_host: true }, { role_name: 'DifferentRole' }, { scan_enabled: false },
  ])('does not certify an unusable registered account %j', async (patch) => {
    mocks.query.mockResolvedValue({ rows: [{ ...scope, ...patch }] });
    expect(await (await GET(request())).json()).toMatchObject({ status: 'not_ready' });
  });

  it('does not certify missing, duplicate or mismatched resource evidence', async () => {
    for (const resources of [[], [proof, { ...proof, region: 'us-east-1' }], [{ ...proof, account_id: '333333333333' }],
      [{ ...proof, observed_id: 'i-different' }], [{ ...proof, captured_at: 'invalid' }]]) {
      mocks.query.mockResolvedValue({ rows: [{ ...scope, resources }] });
      expect(await (await GET(request())).json()).toMatchObject({ status: 'not_ready' });
    }
  });

  it('uses the CloudFront identifier without requiring a regional resource label', async () => {
    mocks.query.mockResolvedValue({ rows: [{ ...scope, resources: [{
      ...proof, resource_type: 'cloudfront', resource_id: 'EEXAMPLE123', observed_id: 'EEXAMPLE123', region: 'global',
    }] }] });
    expect(await (await GET(request({ type: 'cloudfront', resourceId: 'EEXAMPLE123' }))).json()).toMatchObject({
      status: 'verified', type: 'cloudfront', resourceId: 'EEXAMPLE123', region: 'global',
    });
    expect(mocks.query.mock.calls[0][1][3]).toBe('id');
  });

  it('does not expose database exception text', async () => {
    mocks.query.mockRejectedValue(new Error('private database connection string'));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private database');
  });
});
