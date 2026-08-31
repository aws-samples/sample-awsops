import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const verifyUser = vi.fn();
const query = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));

const req = (qs = '') => new Request(`http://x/api/finops/findings${qs}`, { headers: { cookie: 'awsops_token=t' } });

beforeEach(() => {
  verifyUser.mockReset();
  query.mockReset();
  delete process.env.FINOPS_BASELINE_ENABLED;
});
afterEach(() => {
  delete process.env.FINOPS_BASELINE_ENABLED;
});

describe('GET /api/finops/findings', () => {
  it('401 when unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it('flag OFF -> enabled:false, no DB query', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ enabled: false, findings: [], lastRun: null });
    expect(query).not.toHaveBeenCalled();
  });

  it('flag ON -> maps findings + latest run', async () => {
    process.env.FINOPS_BASELINE_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    query
      .mockResolvedValueOnce({
        rows: [{
          id: 1, rule_id: 'ebs_unattached', account_id: 'self', region: 'ap-northeast-2',
          resource_id: 'vol-1', title: 'Unattached EBS',
          category: 'storage', status: 'active', monthly_savings_usd: '9.12', evidence: { size_gib: 100 },
          guard_hits: [], explanation_ko: '설명', first_seen_at: '2026-01-01', last_seen_at: '2026-01-02',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 5, started_at: '2026-01-02T00:00:00Z', finished_at: '2026-01-02T00:05:00Z',
                 status: 'succeeded', rules_evaluated: 2, findings_count: 1, ce_api_calls: 0, error: null }],
      });
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0].monthlySavingsUsd).toBeCloseTo(9.12);
    expect(body.findings[0].resourceId).toBe('vol-1');
    expect(body.findings[0].accountId).toBe('self');
    expect(body.findings[0].region).toBe('ap-northeast-2');
    expect(body.lastRun.status).toBe('succeeded');
    expect(body.lastRun.rulesEvaluated).toBe(2);
  });

  it('flag ON, no findings and no run yet -> empty arrays, null lastRun', async () => {
    process.env.FINOPS_BASELINE_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const { GET } = await import('./route');
    const body = await (await GET(req())).json();
    expect(body).toEqual({
      enabled: true, findings: [], lastRun: null, accountFilter: null,
      coRightsizingScope: { accountId: 'self', region: 'ap-northeast-2' },
    });
  });

  it('?account=<id> scopes the SQL WHERE clause and echoes accountFilter', async () => {
    process.env.FINOPS_BASELINE_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const { GET } = await import('./route');
    const body = await (await GET(req('?account=222222222222'))).json();
    expect(body.accountFilter).toBe('222222222222');
    const [findingsSql, findingsParams] = query.mock.calls[0];
    expect(findingsSql).toMatch(/account_id = \$1/);
    expect(findingsParams).toEqual(['222222222222']);
  });

  it('?account=__all__ is treated as fleet-wide, not a literal filter value', async () => {
    process.env.FINOPS_BASELINE_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const { GET } = await import('./route');
    const body = await (await GET(req('?account=__all__'))).json();
    expect(body.accountFilter).toBeNull();
    const [findingsSql, findingsParams] = query.mock.calls[0];
    expect(findingsSql).not.toMatch(/account_id = \$1/);
    expect(findingsParams).toEqual([]);
  });

  it('null monthly_savings_usd stays null (never coerced to 0)', async () => {
    process.env.FINOPS_BASELINE_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    query
      .mockResolvedValueOnce({
        rows: [{ id: 1, rule_id: 'r', resource_id: 'x', title: 't', category: 'c', status: 'active',
                 monthly_savings_usd: null, evidence: {}, guard_hits: [], explanation_ko: null,
                 first_seen_at: 'a', last_seen_at: 'b' }],
      })
      .mockResolvedValueOnce({ rows: [] });
    const { GET } = await import('./route');
    const body = await (await GET(req())).json();
    expect(body.findings[0].monthlySavingsUsd).toBeNull();
  });

  it('500 on db error', async () => {
    process.env.FINOPS_BASELINE_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockRejectedValue(new Error('boom'));
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(500);
  });
});
