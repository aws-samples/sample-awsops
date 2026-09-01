import { describe, it, expect, vi, beforeEach } from 'vitest';
const verifyUser = vi.fn();
const query = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));
const req = (q = '', cookie = 'awsops_token=t') => new Request(`http://x/api/inventory/summary${q}`, { headers: { cookie } });
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
        { k: 'lambda_runtimes', n: 3 },
        { k: 'lambda_long_timeout', n: 2 },
        { k: 'ebs_total_gb', n: 500 },
        { k: 'ecr_scan_on_push', n: 4 },
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
      // gap L82 micro-stat splits — mapped when the UNION-ALL row is present, zero otherwise
      lambdaRuntimes: 3,
      lambdaLongTimeout: 2,
      ebsTotalGb: 500,
      rdsMultiAz: 0,
      rdsUnencrypted: 0,
      ecrScanOnPush: 4,
      ecrImmutable: 0,
      s3VersioningOff: 0,
      cloudfrontEnabled: 0,
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
    // gap L82: micro-stat aggregates ride the same single UNION-ALL round trip
    for (const k of ['lambda_runtimes', 'lambda_long_timeout', 'ebs_total_gb', 'rds_multi_az', 'ecr_scan_on_push', 's3_versioning_off', 'cloudfront_enabled']) {
      expect(splitsSql).toContain(k);
    }
    // The ECR regex must reach Postgres with REAL \s escapes — a single backslash in the
    // template literal collapses to a bare 's' and the aggregate silently reports 0 forever.
    expect(splitsSql).toContain('\\s*:\\s*');
    // container-image (null-runtime) functions count as the 'custom' runtime (v1 COALESCE parity)
    expect(splitsSql).toContain("COALESCE(NULLIF(data->>'runtime',''),'custom')");
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
    // splits FAILED → null, never fabricated zeros (false-clean security sublines)
    expect(body.splits).toBeNull();
  });
  it('500 on byType db error', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockRejectedValue(new Error('no db'));
    const { GET } = await import('./route');
    expect((await GET(req())).status).toBe(500);
  });
});

describe('GET /api/inventory/summary — region scope (gap L110)', () => {
  it('applies the regions/includeGlobal contract to the counts (matches the rows route)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValue({ rows: [] });
    const { GET } = await import('./route');
    await GET(req('?regions=ap-northeast-2,us-east-1&includeGlobal=0'));
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("region IN ('ap-northeast-2','us-east-1')");
    expect(sql).not.toContain("'global'");
  });
  it('includeGlobal folds global into the allowed set; absent regions stays unfiltered', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValue({ rows: [] });
    const { GET } = await import('./route');
    await GET(req('?regions=ap-northeast-2'));
    expect(String(query.mock.calls[0][0])).toContain("region IN ('ap-northeast-2','global')");
    query.mockClear();
    query.mockResolvedValue({ rows: [] });
    await GET(req());
    expect(String(query.mock.calls[0][0])).toContain('(TRUE)');
  });
  it('an explicitly empty region selection yields an empty result, never an unfiltered count', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValue({ rows: [] });
    const { GET } = await import('./route');
    await GET(req('?regions=&includeGlobal=0'));
    expect(String(query.mock.calls[0][0])).toContain('(FALSE)');
  });
  it('rejects a malformed region token instead of inlining it (strict charset)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValue({ rows: [] });
    const { GET } = await import('./route');
    await GET(req("?regions=ap-northeast-2,bad'--&includeGlobal=0"));
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("region IN ('ap-northeast-2')");
    expect(sql).not.toContain('bad');
  });
});
