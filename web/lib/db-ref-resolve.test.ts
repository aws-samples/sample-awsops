import { describe, it, expect, vi } from 'vitest';
import { resolveDbHosts } from './db-ref-resolve';

type Rows = Record<string, Record<string, unknown>[]>;
const RUN = { status: 'succeeded', finished_at: '2026-11-18T00:00:00.000Z', last_success_at: '2026-11-18T00:00:00.000Z', row_count: 3 };
// `runs` overrides the ledger per type (a present key wins, including null).
function reader(byType: Rows, runs: Record<string, unknown> = {}) {
  return vi.fn(async (type: string, opts: { limit: number; offset: number }) => ({
    rows: (byType[type] ?? []).slice(opts.offset, opts.offset + opts.limit),
    run: type in runs ? runs[type] : RUN, consistency: 'statement-snapshot' as const,
  }));
}
const row = (resource_id: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ resource_id, region: 'ap-northeast-2', account_id: '111111111111', data, ...extra });
const filler = (n: number) => Array.from({ length: n }, (_, i) => row(`x${i}`, {}));
const callsFor = (read: { mock: { calls: unknown[][] } }, type: string) => read.mock.calls.filter((c) => c[0] === type);
const RDS_HOST = 'db-1.abc.ap-northeast-2.rds.amazonaws.com';
const MISSING_RDS = 'missing.zzz.ap-northeast-2.rds.amazonaws.com';

describe('resolveDbHosts', () => {
  it('matches hosts across inventory types, case-insensitively, scoped to one account', async () => {
    const read = reader({
      rds: [row('db-1', { endpoint_address: 'DB-1.abc.ap-northeast-2.rds.amazonaws.com' })],
      rds_cluster: [row('aurora-1', { endpoint: 'aurora-1.cluster-x.ap-northeast-2.rds.amazonaws.com', reader_endpoint: 'aurora-1.cluster-ro-x.ap-northeast-2.rds.amazonaws.com' })],
      rds_proxy: [row('proxy-1', { endpoint: 'proxy-1.proxy-x.ap-northeast-2.rds.amazonaws.com' })],
      opensearch: [row('dom-1', { endpoint: 'search-dom-1-x.ap-northeast-2.es.amazonaws.com', endpoints: { vpc: 'vpc-dom-1-x.ap-northeast-2.es.amazonaws.com' } })],
      elasticache: [row('cache-1', { cache_nodes: [{ Endpoint: { Address: 'cache-1.x.0001.apn2.cache.amazonaws.com', Port: 6379 } }] })],
    });
    const hosts = [
      'db-1.abc.ap-northeast-2.rds.amazonaws.com',
      'aurora-1.cluster-ro-x.ap-northeast-2.rds.amazonaws.com',
      'proxy-1.proxy-x.ap-northeast-2.rds.amazonaws.com',
      'vpc-dom-1-x.ap-northeast-2.es.amazonaws.com',
      'cache-1.x.0001.apn2.cache.amazonaws.com',
      'unknown.zzz.ap-northeast-2.rds.amazonaws.com',
    ];
    const result = await resolveDbHosts(hosts, '111111111111', read as never);
    const { map } = result;
    expect(result.capped).toBe(false);
    expect(result.incomplete).toBe(false);
    expect(map.get(hosts[0])).toEqual({ type: 'rds', id: 'db-1', region: 'ap-northeast-2', accountId: '111111111111' });
    expect(map.get(hosts[1])?.type).toBe('rds_cluster');
    expect(map.get(hosts[2])?.type).toBe('rds_proxy');
    expect(map.get(hosts[3])?.id).toBe('dom-1');
    expect(map.get(hosts[4])?.type).toBe('elasticache');
    expect(map.has(hosts[5])).toBe(false);
    for (const call of read.mock.calls) expect((call[1] as unknown as { accounts: string[] }).accounts).toEqual(['111111111111']);
  });

  it('uses the self scope for the host account', async () => {
    const read = reader({ rds: [row('db-1', { endpoint_address: 'db-1.a.rds.amazonaws.com' }, { account_id: 'self' })] });
    const { map } = await resolveDbHosts(['db-1.a.rds.amazonaws.com'], 'self', read as never);
    expect(map.get('db-1.a.rds.amazonaws.com')?.accountId).toBe('self');
    expect((read.mock.calls[0][1] as unknown as { accounts: string[] }).accounts).toEqual(['self']);
  });

  it('skips inventory reads when there are no hosts', async () => {
    const read = reader({});
    expect(await resolveDbHosts([], 'self', read as never)).toEqual({ map: new Map(), capped: false, incomplete: false });
    expect(read).not.toHaveBeenCalled();
  });

  it('reads only the types of a wanted kind, 5 pages of 500 each, and flags the cap', async () => {
    const read = vi.fn(async () => ({ rows: filler(500), run: RUN, consistency: 'statement-snapshot' as const }));
    const r = await resolveDbHosts(['a.rds.amazonaws.com'], 'self', read as never);
    for (const t of ['rds', 'rds_cluster', 'rds_proxy']) expect(callsFor(read, t)).toHaveLength(5);
    expect(read).toHaveBeenCalledTimes(15);
    expect(r).toEqual({ map: new Map(), capped: true, incomplete: false });
    read.mockClear();
    await resolveDbHosts(['a.rds.amazonaws.com', 'b.cache.amazonaws.com', 'c.es.amazonaws.com'], 'self', read as never);
    expect(read).toHaveBeenCalledTimes(30);
  });

  it('stops paging once every host a type could resolve is found, and skips other kinds', async () => {
    const read = reader({ rds: [row('db-1', { endpoint_address: RDS_HOST }), ...filler(900)] });
    const r = await resolveDbHosts([RDS_HOST], '111111111111', read as never);
    expect(r.map.get(RDS_HOST)?.id).toBe('db-1');
    expect(r).toMatchObject({ capped: false, incomplete: false });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0][0]).toBe('rds');
  });

  it('reads nothing for hosts no inventory type can carry (MSK)', async () => {
    const read = reader({});
    const r = await resolveDbHosts(['b-1.demo.abc123.c2.kafka.ap-northeast-2.amazonaws.com'], 'self', read as never);
    expect(read).not.toHaveBeenCalled();
    expect(r).toEqual({ map: new Map(), capped: false, incomplete: false });
  });

  it('checks an unclassifiable host against every type', async () => {
    const read = reader({});
    const r = await resolveDbHosts(['db.internal.example'], 'self', read as never);
    expect(read).toHaveBeenCalledTimes(6);
    expect(r).toEqual({ map: new Map(), capped: false, incomplete: false });
  });

  it.each([
    ['no ledger', null],
    ['a running sweep', { ...RUN, status: 'running', finished_at: null }],
    ['a partial sweep', { ...RUN, status: 'partial' }],
    ['a failed sweep', { ...RUN, status: 'failed' }],
    ['no finish time', { ...RUN, finished_at: null }],
    ['an unparsable last success', { ...RUN, last_success_at: 'nope' }],
    ['a negative row count', { ...RUN, row_count: -1 }],
    ['no row count', { ...RUN, row_count: null }],
  ])('withholds a type with %s and flags incomplete', async (_label, run) => {
    const read = reader({ rds: [row('db-1', { endpoint_address: RDS_HOST })] }, { rds: run });
    const r = await resolveDbHosts([RDS_HOST], '111111111111', read as never);
    expect(r.map.has(RDS_HOST)).toBe(false);
    expect(r).toMatchObject({ capped: false, incomplete: true });
    expect(callsFor(read, 'rds')).toHaveLength(1); // no further page of an unproven type is read
  });

  it('withholds a type whose page lacks the statement-snapshot marker', async () => {
    const read = vi.fn(async (type: string) => ({
      rows: type === 'rds' ? [row('db-1', { endpoint_address: RDS_HOST })] : [],
      run: RUN, consistency: type === 'rds' ? 'unknown' : 'statement-snapshot',
    }));
    const r = await resolveDbHosts([RDS_HOST], '111111111111', read as never);
    expect(r.map.size).toBe(0);
    expect(r.incomplete).toBe(true);
  });

  it('withholds matches already found when the ledger version changes between pages', async () => {
    const rds = [row('db-1', { endpoint_address: RDS_HOST }), ...filler(700)];
    const later = { ...RUN, finished_at: '2026-11-18T00:05:00.000Z', last_success_at: '2026-11-18T00:05:00.000Z' };
    const read = vi.fn(async (type: string, opts: { limit: number; offset: number }) => ({
      rows: type === 'rds' ? rds.slice(opts.offset, opts.offset + opts.limit) : [],
      run: type === 'rds' && opts.offset > 0 ? later : RUN, consistency: 'statement-snapshot' as const,
    }));
    const r = await resolveDbHosts([RDS_HOST, MISSING_RDS], '111111111111', read as never);
    expect(callsFor(read, 'rds')).toHaveLength(2);
    expect(r.map.has(RDS_HOST)).toBe(false);
    expect(r).toMatchObject({ capped: false, incomplete: true });
  });

  it('keeps a clean type when another type is incomplete', async () => {
    const cluster = 'aurora-1.cluster-x.ap-northeast-2.rds.amazonaws.com';
    const read = reader({ rds: [row('db-1', { endpoint_address: RDS_HOST })], rds_cluster: [row('aurora-1', { endpoint: cluster })] }, { rds: null });
    const r = await resolveDbHosts([RDS_HOST, cluster], '111111111111', read as never);
    expect(r.map.has(RDS_HOST)).toBe(false);
    expect(r.map.get(cluster)?.type).toBe('rds_cluster');
    expect(r.incomplete).toBe(true);
  });

  it('withholds a capped type: a full fifth page with a wanted host still unresolved', async () => {
    const read = reader({ rds: [row('db-1', { endpoint_address: RDS_HOST }), ...filler(2499)] });
    const r = await resolveDbHosts([RDS_HOST, MISSING_RDS], '111111111111', read as never);
    expect(callsFor(read, 'rds')).toHaveLength(5);
    expect(r.map.has(RDS_HOST)).toBe(false);
    expect(r).toMatchObject({ capped: true, incomplete: false });
  });

  it('does not flag the cap when the fifth page is short', async () => {
    const read = reader({ rds: [row('db-1', { endpoint_address: RDS_HOST }), ...filler(2400)] });
    const r = await resolveDbHosts([RDS_HOST, MISSING_RDS], '111111111111', read as never);
    expect(r.map.get(RDS_HOST)?.id).toBe('db-1');
    expect(r).toMatchObject({ capped: false, incomplete: false });
  });

  it('resolves ElastiCache replication-group primary and reader endpoints', async () => {
    const read = reader({ elasticache_replication_group: [row('sessions', { node_groups: [{
      NodeGroupId: '0001',
      PrimaryEndpoint: { Address: 'Master.sessions.abc123.apn2.cache.amazonaws.com', Port: 6379 },
      ReaderEndpoint: { Address: 'replica.sessions.abc123.apn2.cache.amazonaws.com', Port: 6379 },
    }] })] });
    const primary = 'master.sessions.abc123.apn2.cache.amazonaws.com';
    const replica = 'replica.sessions.abc123.apn2.cache.amazonaws.com';
    const { map } = await resolveDbHosts([primary, replica], '111111111111', read as never);
    const expected = { type: 'elasticache_replication_group', id: 'sessions', region: 'ap-northeast-2', accountId: '111111111111' };
    expect(map.get(primary)).toEqual(expected);
    expect(map.get(replica)).toEqual(expected);
  });

  it('leaves configuration endpoints and malformed node groups unresolved without throwing', async () => {
    const read = reader({ elasticache_replication_group: [
      row('cme', { node_groups: [{ NodeGroupId: '0001', Slots: '0-8191' }] }),
      row('bad-1', { node_groups: 'nope' }),
      row('bad-2', { node_groups: [null, 'x', { PrimaryEndpoint: null }, { PrimaryEndpoint: { Address: 7 } }] }),
      row('bad-3', {}),
    ] });
    const host = 'clustercfg.cme.abc123.apn2.cache.amazonaws.com';
    const { map } = await resolveDbHosts([host], '111111111111', read as never);
    expect(map.has(host)).toBe(false);
  });
});
