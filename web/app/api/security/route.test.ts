import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const query = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));
const req = (cookie = 'awsops_token=t') => new Request('http://x/api/security', { headers: { cookie } });
beforeEach(() => { verifyUser.mockReset(); query.mockReset(); });

describe('GET /api/security', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(401);
  });
  it('enabled:false when no security inventory synced', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValueOnce({ rows: [{ n: 0 }] }); // presence probe → 0
    const { GET } = await import('./route');
    const body = await (await GET(req())).json();
    expect(body.enabled).toBe(false);
  });
  it('200 returns summary + findings per check', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query
      .mockResolvedValueOnce({ rows: [{ n: 4 }] }) // presence probe
      .mockResolvedValueOnce({ rows: [{ resource_id: 'b1', region: 'us-east-1', detail: { bucket_policy_is_public: true } }] }) // public_s3
      .mockResolvedValueOnce({ rows: [{ resource_id: 'sg-1', region: 'ap-northeast-2', detail: {} }] }) // open_sg
      .mockResolvedValueOnce({ rows: [] }) // unencrypted_ebs
      .mockResolvedValueOnce({ rows: [{ resource_id: 'alice', region: 'global', detail: {} }] }); // iam_no_mfa
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.summary).toEqual({ public_s3: 1, open_sg: 1, unencrypted_ebs: 0,
      ecr_cve: 0, iam_no_mfa: 1 });
    expect(body.findings.public_s3[0]).toMatchObject({ check: 'public_s3', resource_id: 'b1', severity: 'high' });
  });
  it('500 on db error', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockRejectedValue(new Error('no db'));
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(500);
  });
});
