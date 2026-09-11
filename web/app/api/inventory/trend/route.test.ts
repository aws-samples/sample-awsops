import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const query = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));
const req = (path = '/api/inventory/trend', cookie = 'awsops_token=t') =>
  new Request(`http://x${path}`, { headers: { cookie } });
beforeEach(() => { verifyUser.mockReset(); query.mockReset(); });

describe('GET /api/inventory/trend', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(401);
  });

  it('200 sums per-day totals and picks out the ec2 series', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValueOnce({ rows: [
      { d: '2026-07-01', resource_type: 'ec2', n: 5 },
      { d: '2026-07-01', resource_type: 'lambda', n: 12 },
      { d: '2026-07-02', resource_type: 'ec2', n: 6 },
      { d: '2026-07-02', resource_type: 'lambda', n: 12 },
      { d: '2026-07-02', resource_type: 's3', n: 3 },
    ] });
    query.mockResolvedValue({ rows: [] }); // coverage query
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    // Each point now also carries every resource type as a column (multi-line chart) and the
    // response lists types ranked by latest count.
    expect(body.trend).toEqual([
      { date: '2026-07-01', total: 17, ec2: 5, lambda: 12 },
      { date: '2026-07-02', total: 21, ec2: 6, lambda: 12, s3: 3 },
    ]);
    expect(body.types).toEqual(['lambda', 'ec2', 's3']);
  });

  it('a failed type slice leaves its key ABSENT from the day (never a fabricated 0) and ranks below present types', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValueOnce({ rows: [
      { d: '2026-07-01', resource_type: 'ec2', n: 500 },
      { d: '2026-07-01', resource_type: 'lambda', n: 12 },
      // 07-02: the ec2 slice failed — no snapshot row was written
      { d: '2026-07-02', resource_type: 'lambda', n: 12 },
    ] });
    query.mockResolvedValue({ rows: [] }); // coverage query
    const { GET } = await import('./route');
    const body = await (await GET(req())).json();
    // ec2 key absent (coverage signal for the client's parity check), not 0
    expect(Object.prototype.hasOwnProperty.call(body.trend[1], 'ec2')).toBe(false);
    // absent from the LATEST day only = in-flight (mid-fan-out tolerance) → keeps its rank
    expect(body.types).toEqual(['ec2', 'lambda']);
  });

  it('a type absent from BOTH of the last two days ranks below every recent type', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValueOnce({ rows: [
      { d: '2026-07-01', resource_type: 'ec2', n: 500 }, // dead since 07-01
      { d: '2026-07-02', resource_type: 'lambda', n: 12 },
      { d: '2026-07-03', resource_type: 'lambda', n: 12 },
    ] });
    query.mockResolvedValue({ rows: [] }); // coverage query
    const { GET } = await import('./route');
    const body = await (await GET(req())).json();
    expect(body.types).toEqual(['lambda', 'ec2']);
  });

  // every request issues 2 data queries (trend GROUP BY + per-day account coverage);
  // '__all__' prepends the accounts-table resolution query
  it('clamps days into [1, 90] and defaults to 14 (accounts default: self)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValue({ rows: [] });
    const { GET } = await import('./route');
    await GET(req());
    expect(query.mock.calls[0][1]).toEqual([14, ['self']]);
    await GET(req('/api/inventory/trend?days=9999'));
    expect(query.mock.calls[2][1]).toEqual([90, ['self']]);
    await GET(req('/api/inventory/trend?days=-5'));
    expect(query.mock.calls[4][1]).toEqual([1, ['self']]);
  });

  it('accounts scope (gap L124): CSV validated, __all__ resolves to self+enabled members (never an unfiltered read), all-invalid falls back to self', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValue({ rows: [] });
    const { GET } = await import('./route');
    await GET(req('/api/inventory/trend?accounts=self,222233334444'));
    expect(query.mock.calls[0][1]).toEqual([14, ['self', '222233334444']]);
    // account_id is parameterized (= ANY), never inlined — on the trend AND coverage queries
    expect(String(query.mock.calls[0][0])).toContain('account_id = ANY($2::text[])');
    expect(String(query.mock.calls[1][0])).toContain('account_id = ANY($2::text[])');
    query.mockReset();
    // __all__ resolves SERVER-SIDE to self + enabled member accounts — the filter is never
    // lifted (an unfiltered read would sum the v1 backfill's 'aggregate' rows and offboarded
    // accounts' history; inventory_snapshots has no prune)
    query.mockResolvedValueOnce({ rows: [{ account_id: '222233334444' }] }); // accounts table
    query.mockResolvedValue({ rows: [] });
    await GET(req('/api/inventory/trend?accounts=__all__'));
    // scan-scope predicate, not bare enabled — an enabled account with zero enabled regions
    // never snapshots (sync_lambda's phantom-account rule) and must not enter the scope
    expect(String(query.mock.calls[0][0])).toContain('a.enabled AND NOT a.is_host');
    expect(String(query.mock.calls[0][0])).toContain('a.all_regions OR EXISTS');
    expect(query.mock.calls[1][1]).toEqual([14, ['self', '222233334444']]);
    query.mockReset();
    // an all-invalid list must scope down to self, never widen to an unscoped read
    query.mockResolvedValue({ rows: [] });
    await GET(req("/api/inventory/trend?accounts=bogus,1234'"));
    expect(query.mock.calls[0][1]).toEqual([14, ['self']]);
  });

  it('__all__ falls back to self-only when the accounts table is unavailable — with degraded disclosed', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockRejectedValueOnce(new Error('no accounts table'));
    query.mockResolvedValue({ rows: [] });
    const { GET } = await import('./route');
    const res = await GET(req('/api/inventory/trend?accounts=__all__'));
    expect(res.status).toBe(200);
    expect(query.mock.calls[1][1]).toEqual([14, ['self']]);
    // this narrowing is invisible to coverage (computed against the fallen-back scope) —
    // the response must say so
    expect((await res.json()).degraded).toBe(true);
  });

  it('returns PER-TYPE per-day account coverage + the resolved scope (the client parity guards depend on both)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValueOnce({ rows: [
      { d: '2026-07-01', resource_type: 'ec2', n: 5 },
    ] });
    // the sync runs per type: account B synced lambda but not ec2 that day — the coverage
    // must expose exactly that (day, type) gap, not a merged day-level set
    query.mockResolvedValueOnce({ rows: [
      { d: '2026-07-01', resource_type: 'ec2', account_id: 'self' },
      { d: '2026-07-01', resource_type: 'lambda', account_id: '222233334444' },
      { d: '2026-07-01', resource_type: 'lambda', account_id: 'self' },
    ] });
    const { GET } = await import('./route');
    const body = await (await GET(req('/api/inventory/trend?accounts=self,%20222233334444'))).json();
    expect(body.coverage).toEqual({
      '2026-07-01': { ec2: ['self'], lambda: ['222233334444', 'self'] },
    });
    // resolved scope disclosed (and CSV entries are trimmed — '%20' before the member id)
    expect(body.accounts).toEqual(['self', '222233334444']);
  });

  it('legacy v1 backfill label series are excluded from both queries (snake_case charset guard)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValue({ rows: [] });
    const { GET } = await import('./route');
    await GET(req());
    // 'EC2 Instances'-style label keys (v1 backfill under member accounts) would render as
    // split series and dodge the derived-type total exclusion
    expect(String(query.mock.calls[0][0])).toContain("resource_type ~ '^[a-z0-9_]+$'");
    expect(String(query.mock.calls[1][0])).toContain("resource_type ~ '^[a-z0-9_]+$'");
  });

  it('derived security series (gap L129) are chart series but never add to total', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValueOnce({ rows: [
      { d: '2026-07-01', resource_type: 'ebs_volume', n: 10 },
      // derived from ebs_volume — counting it into total would double-count the volumes
      { d: '2026-07-01', resource_type: 'unencrypted_ebs', n: 4 },
    ] });
    query.mockResolvedValue({ rows: [] }); // coverage query
    const { GET } = await import('./route');
    const body = await (await GET(req())).json();
    expect(body.trend).toEqual([
      { date: '2026-07-01', total: 10, ebs_volume: 10, unencrypted_ebs: 4 },
    ]);
    expect(body.types).toContain('unencrypted_ebs');
  });

  it('500 on db error', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockRejectedValue(new Error('no db'));
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(500);
  });
});
