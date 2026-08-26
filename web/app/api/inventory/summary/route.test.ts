import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const query = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));
const req = (cookie = 'awsops_token=t') => new Request('http://x/api/inventory/summary', { headers: { cookie } });
beforeEach(() => { verifyUser.mockReset(); query.mockReset(); });

describe('GET /api/inventory/summary', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(401);
  });
  it('200 returns byType/byCategory/total + splits', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query
      .mockResolvedValueOnce({ rows: [
        { resource_type: 'ec2', n: 5 },
        { resource_type: 'lambda', n: 12 },
        { resource_type: 's3', n: 3 },
      ] })
      .mockResolvedValueOnce({ rows: [
        { k: 'ec2_running', n: 4 },
        { k: 'ec2_stopped', n: 1 },
        { k: 'ebs_unencrypted', n: 2 },
        { k: 'iam_user_no_mfa', n: 3 },
        { k: 'sg_open_ingress', n: 1 },
        { k: 's3_public', n: 1 },
      ] })
      .mockResolvedValueOnce({ rows: [
        { t: 't3.medium', n: 3 },
        { t: 't3.large', n: 1 },
      ] });
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    // sorted desc by count
    expect(body.byType[0]).toEqual({ type: 'lambda', label: 'Lambda Functions', count: 12 });
    expect(body.total).toBe(20);
    // ec2+lambda are Compute (17), s3 is Storage & DB (3)
    const compute = body.byCategory.find((c: { group: string }) => c.group === 'Compute');
    expect(compute.count).toBe(17);
    const storage = body.byCategory.find((c: { group: string }) => c.group === 'Storage & DB');
    expect(storage.count).toBe(3);
    // splits mapped from UNION-ALL k→n rows
    expect(body.splits).toEqual({
      ec2Running: 4,
      ec2Stopped: 1,
      ebsUnencrypted: 2,
      iamUserNoMfa: 3,
      sgOpenIngress: 1,
      s3Public: 1,
      cwAlarm: 0,
    });
    expect(body.ec2Types).toEqual([
      { name: 't3.medium', count: 3 },
      { name: 't3.large', count: 1 },
    ]);
    // public-S3 split must use the BROAD predicate shared with /security (PUBLIC_S3_WHERE),
    // not just policy-public — else a Block-Public-Access-off bucket false-negatives.
    const splitsSql = query.mock.calls[1][0] as string;
    expect(splitsSql).toContain('block_public_acls');
    expect(splitsSql).toContain('block_public_policy');
  });

  it('degrades ec2Types to [] when its aggregation query fails (byType still returns)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query
      .mockResolvedValueOnce({ rows: [{ resource_type: 'ec2', n: 2 }] })   // byType
      .mockResolvedValueOnce({ rows: [] })                                  // splits
      .mockRejectedValueOnce(new Error('ec2types boom'));                   // ec2Types
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ec2Types).toEqual([]);
    expect(body.byType[0]).toMatchObject({ type: 'ec2', count: 2 });
  });
  it('splits failure degrades to zeros without failing byType', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query
      .mockResolvedValueOnce({ rows: [{ resource_type: 'ec2', n: 5 }] })
      .mockRejectedValueOnce(new Error('splits boom'));
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.byType[0]).toEqual({ type: 'ec2', label: 'EC2 Instances', count: 5 });
    expect(body.total).toBe(5);
    expect(body.splits).toEqual({
      ec2Running: 0,
      ec2Stopped: 0,
      ebsUnencrypted: 0,
      iamUserNoMfa: 0,
      sgOpenIngress: 0,
      s3Public: 0,
      cwAlarm: 0,
    });
  });
  it('500 on byType db error', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockRejectedValue(new Error('no db'));
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(500);
  });
});
