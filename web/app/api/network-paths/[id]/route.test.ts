import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const getCheck = vi.fn();
const updateCheck = vi.fn();
const softDeleteCheck = vi.fn();

vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/network-path', async () => {
  const actual = await vi.importActual<typeof import('@/lib/network-path')>('@/lib/network-path');
  return {
    ...actual,
    getCheck: (...a: unknown[]) => getCheck(...a),
    updateCheck: (...a: unknown[]) => updateCheck(...a),
    softDeleteCheck: (...a: unknown[]) => softDeleteCheck(...a),
  };
});

const params = { id: 'chk-1' };
const getReq = () => new Request('http://x/api/network-paths/chk-1', { headers: { cookie: 'awsops_token=t' } });
const patchReq = (body: unknown) =>
  new Request('http://x/api/network-paths/chk-1', {
    method: 'PATCH', headers: { cookie: 'awsops_token=t', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const deleteReq = () =>
  new Request('http://x/api/network-paths/chk-1', { method: 'DELETE', headers: { cookie: 'awsops_token=t' } });

beforeEach(() => {
  verifyUser.mockReset();
  getCheck.mockReset();
  updateCheck.mockReset();
  softDeleteCheck.mockReset();
  process.env.NETWORK_PATH_CHECK_ENABLED = 'true';
});

describe('GET /api/network-paths/[id]', () => {
  it('401 unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    const res = await GET(getReq() as any, { params });
    expect(res.status).toBe(401);
  });

  it('404 when soft-deleted', async () => {
    verifyUser.mockResolvedValue({ sub: 'u-1' });
    getCheck.mockResolvedValue({ id: 'chk-1', deleted_at: '2026-01-01T00:00:00Z' });
    const { GET } = await import('./route');
    const res = await GET(getReq() as any, { params });
    expect(res.status).toBe(404);
  });

  it('200 for a visible check', async () => {
    verifyUser.mockResolvedValue({ sub: 'u-1' });
    getCheck.mockResolvedValue({ id: 'chk-1', deleted_at: null });
    const { GET } = await import('./route');
    const res = await GET(getReq() as any, { params });
    expect(res.status).toBe(200);
  });
});

describe('PATCH /api/network-paths/[id] — creator-or-admin only', () => {
  it('403 when a non-owner, non-admin edits', async () => {
    verifyUser.mockResolvedValue({ sub: 'u-2' });
    const { ForbiddenError } = await import('@/lib/network-path');
    updateCheck.mockRejectedValue(new ForbiddenError());
    const { PATCH } = await import('./route');
    const res = await PATCH(patchReq({ name: 'new' }) as any, { params });
    expect(res.status).toBe(403);
  });

  it('200 when the creator edits', async () => {
    verifyUser.mockResolvedValue({ sub: 'u-1' });
    updateCheck.mockResolvedValue({ id: 'chk-1', name: 'new' });
    const { PATCH } = await import('./route');
    const res = await PATCH(patchReq({ name: 'new' }) as any, { params });
    expect(res.status).toBe(200);
  });

  it('404 when the check does not exist', async () => {
    verifyUser.mockResolvedValue({ sub: 'u-1' });
    const { NotFoundError } = await import('@/lib/network-path');
    updateCheck.mockRejectedValue(new NotFoundError());
    const { PATCH } = await import('./route');
    const res = await PATCH(patchReq({ name: 'new' }) as any, { params });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/network-paths/[id] — creator-or-admin only, soft delete', () => {
  it('403 when a non-owner, non-admin deletes', async () => {
    verifyUser.mockResolvedValue({ sub: 'u-2' });
    const { ForbiddenError } = await import('@/lib/network-path');
    softDeleteCheck.mockRejectedValue(new ForbiddenError());
    const { DELETE } = await import('./route');
    const res = await DELETE(deleteReq() as any, { params });
    expect(res.status).toBe(403);
  });

  it('200 when the creator deletes', async () => {
    verifyUser.mockResolvedValue({ sub: 'u-1' });
    softDeleteCheck.mockResolvedValue(undefined);
    const { DELETE } = await import('./route');
    const res = await DELETE(deleteReq() as any, { params });
    expect(res.status).toBe(200);
  });
});
