import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const listChecks = vi.fn();
const createCheck = vi.fn();

vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/network-path', async () => {
  const actual = await vi.importActual<typeof import('@/lib/network-path')>('@/lib/network-path');
  return {
    ...actual,
    listChecks: (...a: unknown[]) => listChecks(...a),
    createCheck: (...a: unknown[]) => createCheck(...a),
  };
});

const getReq = (cookie = 'awsops_token=t') => new Request('http://x/api/network-paths', { headers: { cookie } });
const postReq = (body: unknown, cookie = 'awsops_token=t') =>
  new Request('http://x/api/network-paths', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

beforeEach(() => {
  verifyUser.mockReset();
  listChecks.mockReset();
  createCheck.mockReset();
  delete process.env.NETWORK_PATH_CHECK_ENABLED;
});

describe('GET /api/network-paths', () => {
  it('401 unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    const res = await GET(getReq() as any);
    expect(res.status).toBe(401);
  });

  it('503 unconfigured when the feature flag is off (fail closed)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u-1' });
    const { GET } = await import('./route');
    const res = await GET(getReq() as any);
    expect(res.status).toBe(503);
    expect(listChecks).not.toHaveBeenCalled();
  });

  it('200 with checks when enabled', async () => {
    process.env.NETWORK_PATH_CHECK_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u-1' });
    listChecks.mockResolvedValue([{ id: 'c1' }]);
    const { GET } = await import('./route');
    const res = await GET(getReq() as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.checks).toEqual([{ id: 'c1' }]);
  });
});

describe('POST /api/network-paths', () => {
  it('401 unauthenticated — never reaches createCheck', async () => {
    verifyUser.mockResolvedValue(null);
    const { POST } = await import('./route');
    const res = await POST(postReq({}) as any);
    expect(res.status).toBe(401);
    expect(createCheck).not.toHaveBeenCalled();
  });

  it('503 unconfigured when the feature flag is off', async () => {
    verifyUser.mockResolvedValue({ sub: 'u-1' });
    const { POST } = await import('./route');
    const res = await POST(postReq({ name: 'x' }) as any);
    expect(res.status).toBe(503);
    expect(createCheck).not.toHaveBeenCalled();
  });

  it('201 with the created check when enabled', async () => {
    process.env.NETWORK_PATH_CHECK_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u-1' });
    createCheck.mockResolvedValue({ id: 'c1', name: 'x' });
    const { POST } = await import('./route');
    const res = await POST(postReq({ name: 'x' }) as any);
    expect(res.status).toBe(201);
  });

  it('400 on a validation error from the lib layer', async () => {
    process.env.NETWORK_PATH_CHECK_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u-1' });
    const { ValidationError } = await import('@/lib/network-path');
    createCheck.mockRejectedValue(new ValidationError('name is required'));
    const { POST } = await import('./route');
    const res = await POST(postReq({}) as any);
    expect(res.status).toBe(400);
  });
});
