import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => vi.fn());
const query = vi.hoisted(() => vi.fn());
const listAccounts = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth', () => ({ verifyUser: auth }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query }) }));
vi.mock('@/lib/accounts', () => ({ listAccounts }));
import { GET } from './route';

const A = '111111111111', B = '222222222222', R = 'ap-northeast-2';
const att = (account_id: string, id: string, vpc: string, vpcOwner: string) => ({
  resource_type: 'transit_gateway_attachment', account_id, region: R, resource_id: id, captured_at: new Date('2026-11-06T10:00:00Z'),
  data: { transit_gateway_id: 'tgw-0123456789abcdef0', transit_gateway_owner_id: A, attached_resource_type: 'vpc',
    attached_resource_id: vpc, resource_owner_id: vpcOwner, state: 'available' },
});
const fleetRows = [
  { resource_type: 'vpc', account_id: 'self', region: R, resource_id: 'vpc-aaaaaaaa', data: { owner_id: A, name: 'hub' }, captured_at: null },
  { resource_type: 'vpc', account_id: B, region: R, resource_id: 'vpc-bbbbbbbb', data: { owner_id: B, name: 'spoke' }, captured_at: null },
  att('self', 'tgw-attach-0000000000000000b', 'vpc-bbbbbbbb', B),
  att(B, 'tgw-attach-0000000000000000b', 'vpc-bbbbbbbb', B),
].map((r) => ({ ...r, part: 'fleet' }));
const get = (qs: string) => GET(new Request(`http://localhost/api/network-topology${qs}`));

describe('GET /api/network-topology', () => {
  beforeEach(() => {
    auth.mockReset().mockResolvedValue({ sub: 'user' });
    query.mockReset().mockResolvedValue({ rows: fleetRows });
    listAccounts.mockReset().mockResolvedValue([
      { accountId: A, alias: 'host', isHost: true, enabled: true },
      { accountId: B, alias: 'member', isHost: false, enabled: true },
    ]);
  });

  it('401 without a user', async () => {
    auth.mockResolvedValue(null);
    expect((await get('')).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it('400 for a malformed vpc key', async () => {
    const res = await get('?vpcs=self/ap-northeast-2/vpc-zz');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ status: 'error', message: 'invalid_request' });
    expect(query).not.toHaveBeenCalled();
  });

  it('400 for five vpc keys', async () => {
    const keys = Array.from({ length: 5 }, (_, i) => `${A}/${R}/vpc-0000000${i}`).join(',');
    expect((await get(`?vpcs=${keys}`)).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('400 for more than 100 accounts', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => String(100000000000 + i)).join(',');
    expect((await get(`?accounts=${ids}`)).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('dedupes repeated vpc keys', async () => {
    const res = await get(`?vpcs=${A}/${R}/vpc-aaaaaaaa,${A}/${R}/vpc-aaaaaaaa`);
    expect(res.status).toBe(200);
    expect(query.mock.calls[0][1][2]).toEqual(['vpc-aaaaaaaa']);
  });

  it('400 when a scope parameter repeats', async () => {
    expect((await get(`?accounts=${A}&accounts=${B}`)).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('marks every reply private and uncacheable', async () => {
    expect((await get('')).headers.get('cache-control')).toBe('private, no-store');
    expect((await get('?accounts=bad')).headers.get('cache-control')).toBe('private, no-store');
  });

  it('400 for a malformed account', async () => {
    expect((await get('?accounts=12345')).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns fleet topology for __all__', async () => {
    const res = await get('?accounts=__all__');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.level).toBe('fleet');
    expect(body.edges).toEqual([expect.objectContaining({ kind: 'tgw', recordId: 'tgw-attach-0000000000000000b', crossAccount: true })]);
    expect(body.nodes.find((n: { id: string }) => n.id === `account:${A}`)).toMatchObject({ label: 'host' });
    expect(body.truncated).toBe(false);
    const [sql, params] = query.mock.calls[0];
    expect(query).toHaveBeenCalledTimes(1);
    expect(sql).toContain('LIMIT 20001');
    expect(sql).not.toContain('LIMIT 8001');
    expect(sql).toContain("CASE WHEN resource_type IN ('transit_gateway_attachment', 'vpc_peering_connection', 'transit_gateway') THEN 0 ELSE 1 END");
    expect(params).toHaveLength(1);
  });

  it('issues one statement with both limits when vpcs are selected', async () => {
    const res = await get(`?vpcs=${A}/${R}/vpc-aaaaaaaa,self/${R}/vpc-cccccccc`);
    expect(res.status).toBe(200);
    expect((await res.json()).level).toBe('detail');
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('LIMIT 20001');
    expect(sql).toContain('LIMIT 8001');
    expect(sql).toContain('UNION ALL');
    expect(params[2]).toEqual(['vpc-aaaaaaaa', 'vpc-cccccccc']);
    expect(sql).toContain("WHEN resource_type = 'vpc' AND resource_id = ANY($3) THEN 1");
    // Structural rows sort ahead of tiles so the detail cap never drops the AZ/subnet skeleton.
    expect(sql).toMatch(/ORDER BY \(resource_type NOT IN \('subnet', 'route_table', 'internet_gateway', 'nat_gateway'\)\), resource_type/);
  });

  it('flags truncation when fleet rows exceed the cap', async () => {
    const many = Array.from({ length: 20001 }, (_, i) => ({ resource_type: 'vpc', account_id: B, region: R,
      resource_id: `vpc-${String(i).padStart(8, '0')}`, data: { owner_id: B }, captured_at: null, part: 'fleet' }));
    query.mockResolvedValue({ rows: many });
    const body = await (await get('')).json();
    expect(body.truncated).toBe(true);
    expect(body.nodes.filter((n: { kind: string }) => n.kind === 'vpc')).toHaveLength(20000);
  });

  it('503 without raw error text when the query throws', async () => {
    query.mockRejectedValue(new Error('relation "secret_table" does not exist'));
    const res = await get('');
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toContain('secret_table');
    expect(JSON.parse(text)).toEqual({ status: 'error', message: 'network_topology_unavailable' });
  });
});
