import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const verifyUser = vi.fn();

vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));

const req = () => new Request('http://x/api/stream', { headers: { cookie: 'awsops_token=t' } });

beforeEach(() => {
  vi.useFakeTimers();
  verifyUser.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('GET /api/stream', () => {
  it('returns 401 without a session', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(verifyUser).toHaveBeenCalledWith('awsops_token=t');
  });

  it('opens an event stream for a signed-in user', async () => {
    verifyUser.mockResolvedValue({ sub: 'u', email: 'a@b.c', groups: [] });
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(verifyUser).toHaveBeenCalledWith('awsops_token=t');
    await res.body?.cancel();
  });
});
