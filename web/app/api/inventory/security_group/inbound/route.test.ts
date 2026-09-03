import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const query = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));

const req = (qs: string) =>
  new Request(`http://x/api/inventory/security_group/inbound?${qs}`, { headers: { cookie: 'awsops_token=t' } });

beforeEach(() => { verifyUser.mockReset(); query.mockReset(); });

describe('GET /api/inventory/security_group/inbound (gap L154)', () => {
  it('401 unauth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req('ids=sg-11112222'))).status).toBe(401);
  });

  it('parses PascalCase ip_permissions: port range, all-traffic, CIDR desc, SG pair, prefix list', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValue({ rows: [{
      resource_id: 'sg-11112222',
      data: {
        group_name: 'db-sg',
        ip_permissions: [
          { IpProtocol: 'tcp', FromPort: 5432, ToPort: 5432,
            IpRanges: [{ CidrIp: '10.0.0.0/16', Description: 'vpc internal' }],
            UserIdGroupPairs: [{ GroupId: 'sg-33334444', Description: 'app tier' }] },
          { IpProtocol: 'tcp', FromPort: 1024, ToPort: 65535, PrefixListIds: [{ PrefixListId: 'pl-aaaa1111' }] },
          { IpProtocol: '-1' },
        ],
      },
    }] });
    const { GET } = await import('./route');
    const body = await (await GET(req('ids=sg-11112222'))).json();
    const g = body.groups[0];
    expect(g).toMatchObject({ sgId: 'sg-11112222', found: true, groupName: 'db-sg' });
    expect(g.rules[0]).toEqual({
      protocol: 'tcp', portRange: '5432',
      sources: [
        { kind: 'cidr', value: '10.0.0.0/16', description: 'vpc internal' },
        { kind: 'sg', value: 'sg-33334444', description: 'app tier' },
      ],
    });
    expect(g.rules[1].portRange).toBe('1024-65535');
    expect(g.rules[1].sources).toEqual([{ kind: 'pl', value: 'pl-aaaa1111', description: undefined }]);
    expect(g.rules[2]).toMatchObject({ protocol: 'all', portRange: 'all' });
  });

  it('ICMP renders type/code, never a garbled "8--1" port range', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValue({ rows: [{
      resource_id: 'sg-11112222',
      data: { ip_permissions: [
        { IpProtocol: 'icmp', FromPort: 8, ToPort: -1, IpRanges: [{ CidrIp: '10.0.0.0/8' }] },
        { IpProtocol: 'icmp', FromPort: -1, ToPort: -1, IpRanges: [{ CidrIp: '10.0.0.0/8' }] },
        { IpProtocol: 'icmp', FromPort: 3, ToPort: 4, IpRanges: [{ CidrIp: '10.0.0.0/8' }] },
      ] },
    }] });
    const { GET } = await import('./route');
    const body = await (await GET(req('ids=sg-11112222'))).json();
    expect(body.groups[0].rules.map((r: { portRange: string }) => r.portRange))
      .toEqual(['type 8', 'all types', 'type 3/code 4']);
  });

  it("numeric protocols normalize ('1'→icmp with type/code, '6'→tcp) — AWS returns them verbatim", async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValue({ rows: [{
      resource_id: 'sg-11112222',
      data: { ip_permissions: [
        { IpProtocol: '1', FromPort: 8, ToPort: -1, IpRanges: [{ CidrIp: '10.0.0.0/8' }] },
        { IpProtocol: '6', FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: '10.0.0.0/8' }] },
      ] },
    }] });
    const { GET } = await import('./route');
    const body = await (await GET(req('ids=sg-11112222'))).json();
    expect(body.groups[0].rules[0]).toMatchObject({ protocol: 'icmp', portRange: 'type 8' });
    expect(body.groups[0].rules[1]).toMatchObject({ protocol: 'tcp', portRange: '443' });
  });

  it('snake_case JSONB (plugin casing drift) parses identically', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValue({ rows: [{
      resource_id: 'sg-11112222',
      data: { ip_permissions: [{ ip_protocol: 'tcp', from_port: 443, to_port: 443, ip_ranges: [{ cidr_ip: '0.0.0.0/0' }] }] },
    }] });
    const { GET } = await import('./route');
    const body = await (await GET(req('ids=sg-11112222'))).json();
    expect(body.groups[0].rules[0]).toMatchObject({ protocol: 'tcp', portRange: '443' });
    expect(body.groups[0].rules[0].sources[0]).toMatchObject({ kind: 'cidr', value: '0.0.0.0/0' });
  });

  it('an SG absent from inventory → found:false (not an empty-rules claim); empty perms → rules []', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    query.mockResolvedValue({ rows: [{ resource_id: 'sg-11112222', data: { ip_permissions: [] } }] });
    const { GET } = await import('./route');
    const body = await (await GET(req('ids=sg-11112222,sg-99998888'))).json();
    expect(body.groups[0]).toMatchObject({ sgId: 'sg-11112222', found: true, rules: [] });
    expect(body.groups[1]).toMatchObject({ sgId: 'sg-99998888', found: false });
  });

  it('400 on malformed ids, >20 ids, bad account, bad region', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    const { GET } = await import('./route');
    expect((await GET(req("ids=sg-1;drop"))).status).toBe(400);
    expect((await GET(req(''))).status).toBe(400);
    const many = Array.from({ length: 21 }, (_, i) => `sg-${String(i).padStart(8, '0')}`).join(',');
    expect((await GET(req(`ids=${many}`))).status).toBe(400);
    expect((await GET(req('ids=sg-11112222&account=abc'))).status).toBe(400);
    expect((await GET(req('ids=sg-11112222&region=US!'))).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('normalizes the host account to the self sentinel and narrows by region', async () => {
    verifyUser.mockResolvedValue({ sub: 'u' });
    process.env.AWS_ACCOUNT_ID = '123456789012';
    query.mockResolvedValue({ rows: [] });
    const { GET } = await import('./route');
    await GET(req('ids=sg-11112222&account=123456789012&region=ap-northeast-2'));
    const [sql, params] = query.mock.calls[0];
    expect(params[0]).toBe('self');
    expect(sql).toMatch(/AND region = \$3/);
    expect(params[2]).toBe('ap-northeast-2');
  });
});
