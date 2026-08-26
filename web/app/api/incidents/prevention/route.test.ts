import { describe, it, expect, beforeEach, vi } from 'vitest';

const verifyUser = vi.fn();
const isAdmin = vi.fn();
const query = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));

function getReq(cookie = 'awsops_token=t') {
  return new Request('http://x/api/incidents/prevention', { method: 'GET', headers: { cookie } });
}

beforeEach(() => {
  verifyUser.mockReset(); isAdmin.mockReset(); query.mockReset();
  verifyUser.mockResolvedValue({ sub: 'a', email: 'admin@x', groups: ['admins'] });
  isAdmin.mockResolvedValue(true);
  query.mockResolvedValue({ rows: [] });
  process.env.AURORA_ENDPOINT = 'h';
});

describe('GET /api/incidents/prevention (read-only, admin-gated, degrade-safe)', () => {
  it('401 unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(getReq())).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it('403 non-admin', async () => {
    isAdmin.mockResolvedValue(false);
    const { GET } = await import('./route');
    expect((await GET(getReq())).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it('200 + {insights:[]} when Aurora unconfigured (degrade-safe, no query)', async () => {
    delete process.env.AURORA_ENDPOINT;
    const { GET } = await import('./route');
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ insights: [] });
    expect(query).not.toHaveBeenCalled();
  });

  it('200 + {insights:[]} when the table is empty', async () => {
    query.mockResolvedValue({ rows: [] });
    const { GET } = await import('./route');
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ insights: [] });
  });

  it('200 + open rows ordered by last_seen_at when present', async () => {
    const rows = [
      { id: 1, category: 'observability', scope_ref: 'rds::db-1', recommendation: 'add alarm',
        narration: null, recurrence_count: 3, source_incident_ids: [1, 2, 3], evidence: {},
        status: 'open', last_seen_at: '2026-06-11T00:00:00Z' },
    ];
    query.mockResolvedValue({ rows });
    const { GET } = await import('./route');
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ insights: rows });
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(/FROM prevention_insights/);
    expect(sql).toMatch(/status = 'open'/);
    expect(sql).toMatch(/ORDER BY last_seen_at DESC/);
    expect(sql).toMatch(/LIMIT 200/);
  });

  it('200 + {insights:[]} when the query throws (never 5xx the panel)', async () => {
    query.mockRejectedValue(new Error('aurora down'));
    const { GET } = await import('./route');
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ insights: [] });
  });
});
