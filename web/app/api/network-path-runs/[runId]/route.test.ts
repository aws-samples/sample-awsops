import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const getRunDetail = vi.fn();

vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/network-path', async () => {
  const actual = await vi.importActual<typeof import('@/lib/network-path')>('@/lib/network-path');
  return { ...actual, getRunDetail: (...a: unknown[]) => getRunDetail(...a) };
});

const params = { runId: 'run-1' };
const req = () => new Request('http://x/api/network-path-runs/run-1', { headers: { cookie: 'awsops_token=t' } });

beforeEach(() => {
  verifyUser.mockReset();
  getRunDetail.mockReset();
  process.env.NETWORK_PATH_CHECK_ENABLED = 'true';
});

describe('GET /api/network-path-runs/[runId]', () => {
  it('401 unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    const res = await GET(req() as any, { params });
    expect(res.status).toBe(401);
  });

  it('503 unconfigured when the feature flag is off', async () => {
    delete process.env.NETWORK_PATH_CHECK_ENABLED;
    verifyUser.mockResolvedValue({ sub: 'u-1' });
    const { GET } = await import('./route');
    const res = await GET(req() as any, { params });
    expect(res.status).toBe(503);
  });

  it('404 for an unknown run', async () => {
    verifyUser.mockResolvedValue({ sub: 'u-1' });
    getRunDetail.mockResolvedValue(null);
    const { GET } = await import('./route');
    const res = await GET(req() as any, { params });
    expect(res.status).toBe(404);
  });

  it('200 with candidates/steps for any authenticated viewer', async () => {
    verifyUser.mockResolvedValue({ sub: 'someone-else' });
    getRunDetail.mockResolvedValue({
      id: 'run-1', status: 'succeeded', overall_status: 'allowed', candidates: [], steps: [],
    });
    const { GET } = await import('./route');
    const res = await GET(req() as any, { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run.overall_status).toBe('allowed');
  });
});
