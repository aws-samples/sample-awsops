import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const query = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));

const req = (url = 'http://x/api/ai-usage', cookie = 'awsops_token=t') =>
  new Request(url, { headers: { cookie } });

beforeEach(() => {
  verifyUser.mockReset();
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
});

describe('GET /api/ai-usage', () => {
  it('401 when unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it('defaults to 30d and queries 30 days on an unknown range', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    const { GET } = await import('./route');
    const res = await GET(req('http://x/api/ai-usage?range=bogus'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.range).toBe('30d');
    expect(query.mock.calls[0][1]).toEqual([30]); // bound param = days
  });

  it('prices the summed rows via bedrock pricing', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValue({
      rows: [
        { model: 'global.anthropic.claude-sonnet-4-6', input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
      ],
    });
    const { GET } = await import('./route');
    const res = await GET(req('http://x/api/ai-usage?range=7d'));
    const body = await res.json();
    expect(body.range).toBe('7d');
    expect(query.mock.calls[0][1]).toEqual([7]);
    expect(body.totalCost).toBeCloseTo(3, 6);
    expect(body.models).toHaveLength(1);
  });

  it('no rows → totalCost 0', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    const { GET } = await import('./route');
    const body = await (await GET(req())).json();
    expect(body.totalCost).toBe(0);
    expect(body.models).toEqual([]);
  });

  it('500 on db error', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockRejectedValue(new Error('boom'));
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(500);
  });
});
