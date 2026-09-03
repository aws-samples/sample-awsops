import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const isAdmin = vi.fn();
const query = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));

const get = () => new Request('http://x/api/diagnosis/notify', { headers: { cookie: 'awsops_token=t' } });
const put = (body: unknown) => new Request('http://x/api/diagnosis/notify', {
  method: 'PUT', headers: { cookie: 'awsops_token=t', 'content-type': 'application/json' }, body: JSON.stringify(body),
});

beforeEach(() => { verifyUser.mockReset(); isAdmin.mockReset(); query.mockReset(); });

describe('GET/PUT /api/diagnosis/notify (gap L178)', () => {
  it('401 unauth (both methods)', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET, PUT } = await import('./route');
    expect((await GET(get())).status).toBe(401);
    expect((await PUT(put({ paused: true }))).status).toBe(401);
  });

  it('GET: absent key reads not-paused (today behavior, zero backfill); canManage from isAdmin', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    isAdmin.mockResolvedValue(false);
    query.mockResolvedValue({ rows: [] });
    const { GET } = await import('./route');
    const body = await (await GET(get())).json();
    expect(body).toEqual({ paused: false, canManage: false });
  });

  it('GET: stored true reads paused', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    isAdmin.mockResolvedValue(true);
    query.mockResolvedValue({ rows: [{ value: 'true' }] });
    const { GET } = await import('./route');
    expect(await (await GET(get())).json()).toEqual({ paused: true, canManage: true });
  });

  it('PUT: admin-only (403 for non-admins, before any write)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    isAdmin.mockResolvedValue(false);
    const { PUT } = await import('./route');
    expect((await PUT(put({ paused: true }))).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it('PUT: upserts the flag; non-boolean body → 400', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    isAdmin.mockResolvedValue(true);
    query.mockResolvedValue({ rows: [] });
    const { PUT } = await import('./route');
    const res = await PUT(put({ paused: true }));
    expect(await res.json()).toEqual({ paused: true });
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toContain('ON CONFLICT (key) DO UPDATE');
    expect(params).toEqual(['diagnosis_notify_paused', 'true', 'u']); // actor sub audited
    expect((await PUT(put({ paused: 'yes' }))).status).toBe(400);
  });
});
