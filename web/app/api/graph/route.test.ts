import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const query = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));

import { GET } from './route';

beforeEach(() => {
  verifyUser.mockReset(); query.mockReset();
  verifyUser.mockResolvedValue({ sub: 'a' });
  query.mockResolvedValue({ rows: [] });
});

describe('GET /api/graph', () => {
  it('401 when unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const r = await GET(new Request('http://x/api/graph'));
    expect(r.status).toBe(401);
  });

  it('returns the materialized graph shape, class-scoped (default flow)', async () => {
    const r = await GET(new Request('http://x/api/graph'));
    const j = await r.json();
    expect(j).toHaveProperty('nodes');
    expect(j).toHaveProperty('edges');
    expect(j.class).toBe('flow');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('class = $1'), ['flow', 'self']);
  });

  it('honors ?class=infra for the full graph', async () => {
    const r = await GET(new Request('http://x/api/graph?class=infra'));
    const j = await r.json();
    expect(j.class).toBe('infra');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('class = $1'), ['infra', 'self']);
  });

  it('honors ?class=trace (the third materialized layer)', async () => {
    const r = await GET(new Request('http://x/api/graph?class=trace'));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.class).toBe('trace');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('class = $1'), ['trace', 'self']);
  });

  it('400 on an unknown class (no silent fall-back to flow)', async () => {
    const r = await GET(new Request('http://x/api/graph?class=bogus'));
    expect(r.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('scopes to a 12-digit member account and rejects malformed ones', async () => {
    const ok = await GET(new Request('http://x/api/graph?class=infra&account=222233334444'));
    expect(ok.status).toBe(200);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('class = $1'), ['infra', '222233334444']);
    const all = await GET(new Request('http://x/api/graph?class=infra&account=__all__'));
    expect(all.status).toBe(200);
    const bad = await GET(new Request('http://x/api/graph?class=infra&account=abc'));
    expect(bad.status).toBe(400);
  });

  it('?from= returns the per-resource subgraph and runs the class+depth traversal', async () => {
    const r = await GET(new Request('http://x/api/graph?from=alb:lb&class=infra&depth=2'));
    const j = await r.json();
    expect(j.from).toBe('alb:lb');
    expect(j.class).toBe('infra');
    expect(j.depth).toBe(2);
    expect(j).toHaveProperty('nodes');
    expect(j).toHaveProperty('edges');
    expect(j).toHaveProperty('capped');
    // traversal issued with [id, class, depth, account]
    expect(query).toHaveBeenCalledWith(expect.stringContaining('WITH RECURSIVE'), ['alb:lb', 'infra', 2, 'self']);
  });
});
