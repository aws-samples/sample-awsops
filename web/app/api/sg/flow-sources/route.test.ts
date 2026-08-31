import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const isAdmin = vi.fn();
const listFlowSources = vi.fn();
const upsertFlowSource = vi.fn();
const validateFlowSourceViaBroker = vi.fn();

vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/sg-rules', async () => {
  const actual = await vi.importActual<typeof import('@/lib/sg-rules')>('@/lib/sg-rules');
  return {
    ...actual,
    listFlowSources: (...a: unknown[]) => listFlowSources(...a),
    upsertFlowSource: (...a: unknown[]) => upsertFlowSource(...a),
    validateFlowSourceViaBroker: (...a: unknown[]) => validateFlowSourceViaBroker(...a),
  };
});

const req = (method: string, body?: unknown, cookie = 'awsops_token=t') =>
  new Request('http://x/api/sg/flow-sources', {
    method, headers: { cookie, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  verifyUser.mockReset(); isAdmin.mockReset(); listFlowSources.mockReset();
  upsertFlowSource.mockReset(); validateFlowSourceViaBroker.mockReset();
});

describe('GET /api/sg/flow-sources', () => {
  it('401 unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    const res = await GET(req('GET') as any);
    expect(res.status).toBe(401);
  });

  it('200 for any authenticated user (read, no admin gate)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u-1' });
    listFlowSources.mockResolvedValue([]);
    const { GET } = await import('./route');
    const res = await GET(req('GET') as any);
    expect(res.status).toBe(200);
  });
});

describe('PUT /api/sg/flow-sources', () => {
  it('401 unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { PUT } = await import('./route');
    const res = await PUT(req('PUT', {}) as any);
    expect(res.status).toBe(401);
  });

  it('403 authenticated but not admin', async () => {
    verifyUser.mockResolvedValue({ sub: 'u-1' });
    isAdmin.mockResolvedValue(false);
    const { PUT } = await import('./route');
    const res = await PUT(req('PUT', {}) as any);
    expect(res.status).toBe(403);
    expect(upsertFlowSource).not.toHaveBeenCalled();
  });

  it('400 on a non-allowlisted identifier, before any validation/DB call', async () => {
    verifyUser.mockResolvedValue({ sub: 'u-1' });
    isAdmin.mockResolvedValue(true);
    const { PUT } = await import('./route');
    const res = await PUT(req('PUT', {
      accountId: '123456789012', region: 'ap-northeast-2', workgroup: 'ok',
      databaseName: 'db; DROP TABLE x', tableName: 'ok',
    }) as any);
    expect(res.status).toBe(400);
    expect(validateFlowSourceViaBroker).not.toHaveBeenCalled();
    expect(upsertFlowSource).not.toHaveBeenCalled();
  });

  it('200 for an admin with valid input', async () => {
    verifyUser.mockResolvedValue({ sub: 'admin-1' });
    isAdmin.mockResolvedValue(true);
    validateFlowSourceViaBroker.mockResolvedValue({ ok: false, status: 'unconfigured', checkedAt: 'now' });
    upsertFlowSource.mockResolvedValue({ id: 1 });
    const { PUT } = await import('./route');
    const res = await PUT(req('PUT', {
      accountId: '123456789012', region: 'ap-northeast-2', workgroup: 'primary',
      databaseName: 'db1', tableName: 'tbl1',
    }) as any);
    expect(res.status).toBe(200);
    expect(upsertFlowSource).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: '123456789012' }), 'admin-1', expect.any(Object),
    );
  });

  it('persists partitionKeyTypes from the broker validation result', async () => {
    verifyUser.mockResolvedValue({ sub: 'admin-1' });
    isAdmin.mockResolvedValue(true);
    validateFlowSourceViaBroker.mockResolvedValue({
      ok: true, status: 'valid', partitionKeys: ['dt'], partitionKeyTypes: ['date'], checkedAt: 'now',
    });
    upsertFlowSource.mockResolvedValue({ id: 1 });
    const { PUT } = await import('./route');
    const res = await PUT(req('PUT', {
      accountId: '123456789012', region: 'ap-northeast-2', workgroup: 'primary',
      databaseName: 'db1', tableName: 'tbl1',
    }) as any);
    expect(res.status).toBe(200);
    expect(upsertFlowSource).toHaveBeenCalledWith(
      expect.anything(), 'admin-1',
      expect.objectContaining({ partitionKeys: ['dt'], partitionKeyTypes: ['date'] }),
    );
  });

  it('persists scopeResolution/scannedUnscoped from the broker validation result (item 1 follow-up fix)', async () => {
    verifyUser.mockResolvedValue({ sub: 'admin-1' });
    isAdmin.mockResolvedValue(true);
    validateFlowSourceViaBroker.mockResolvedValue({
      ok: true, status: 'valid', partitionKeys: ['dt'], partitionKeyTypes: ['date'],
      scopeResolution: { account_id: null, region: null }, scannedUnscoped: true, checkedAt: 'now',
    });
    upsertFlowSource.mockResolvedValue({ id: 1 });
    const { PUT } = await import('./route');
    const res = await PUT(req('PUT', {
      accountId: '123456789012', region: 'ap-northeast-2', workgroup: 'primary',
      databaseName: 'db1', tableName: 'tbl1',
    }) as any);
    expect(res.status).toBe(200);
    expect(upsertFlowSource).toHaveBeenCalledWith(
      expect.anything(), 'admin-1',
      expect.objectContaining({
        scopeResolution: { account_id: null, region: null }, scannedUnscoped: true,
      }),
    );
  });
});
