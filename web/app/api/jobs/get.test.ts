import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const query = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));
const req = (cookie = 'awsops_token=t') => new Request('http://x/api/jobs', { headers: { cookie } });
beforeEach(() => { verifyUser.mockReset(); query.mockReset(); });

describe('GET /api/jobs', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(401);
  });
  it('200 with jobs list', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValue({ rows: [{ job_id: 'j1', type: 'noop', status: 'succeeded', runtime: 'lambda', error: null, created_at: 't', updated_at: 't' }] });
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).jobs[0].job_id).toBe('j1');
  });
});
