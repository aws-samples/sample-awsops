import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const listRules = vi.fn();

vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/sg-rules', async () => {
  const actual = await vi.importActual<typeof import('@/lib/sg-rules')>('@/lib/sg-rules');
  return { ...actual, listRules: (...a: unknown[]) => listRules(...a) };
});

const req = (qs = '', cookie = 'awsops_token=t') =>
  new Request(`http://x/api/sg/rules${qs}`, { headers: { cookie } });

beforeEach(() => { verifyUser.mockReset(); listRules.mockReset(); });

describe('GET /api/sg/rules', () => {
  it('401 unauthenticated', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    const res = await GET(req() as any);
    expect(res.status).toBe(401);
  });

  it('400 on an invalid accountId (defense before it reaches listRules)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u-1' });
    const { GET } = await import('./route');
    const res = await GET(req('?accountId=not-an-account') as any);
    expect(res.status).toBe(400);
    expect(listRules).not.toHaveBeenCalled();
  });

  it('200 with rows/total for an authenticated user', async () => {
    verifyUser.mockResolvedValue({ sub: 'u-1' });
    listRules.mockResolvedValue({ rows: [], total: 0 });
    const { GET } = await import('./route');
    const res = await GET(req() as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toEqual([]);
  });

  it('exports CSV when format=csv', async () => {
    verifyUser.mockResolvedValue({ sub: 'u-1' });
    listRules.mockResolvedValue({
      rows: [{
        account_id: '123456789012', region: 'ap-northeast-2', rule_id: 'sgr-1', group_id: 'sg-1',
        is_egress: false, protocol: 'tcp', from_port: 443, to_port: 443, peer_kind: 'cidr',
        peer_value: '10.0.0.0/8', description: null, compatible_match_count: 0, overlap_match_count: 0,
        last_observed_at: null, status: 'not_configured',
      }], total: 1,
    });
    const { GET } = await import('./route');
    const res = await GET(req('?format=csv') as any);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const text = await res.text();
    expect(text).toContain('sgr-1');
  });

  it('gap 5: passes vpcId through to listRules as a filter', async () => {
    verifyUser.mockResolvedValue({ sub: 'u-1' });
    listRules.mockResolvedValue({ rows: [], total: 0 });
    const { GET } = await import('./route');
    await GET(req('?vpcId=vpc-aaa111') as any);
    expect(listRules).toHaveBeenCalledWith(expect.objectContaining({ vpcId: 'vpc-aaa111' }));
  });
});
