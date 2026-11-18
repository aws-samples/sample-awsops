import { describe, it, expect, vi } from 'vitest';
import { resolveDbHosts } from './db-ref-resolve';

type Rows = Record<string, Record<string, unknown>[]>;
function reader(byType: Rows) {
  return vi.fn(async (type: string, opts: { limit: number; offset: number }) => ({
    rows: (byType[type] ?? []).slice(opts.offset, opts.offset + opts.limit),
    run: null, consistency: 'statement-snapshot' as const,
  }));
}
const row = (resource_id: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ resource_id, region: 'ap-northeast-2', account_id: '111111111111', data, ...extra });

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
    const map = await resolveDbHosts(hosts, '111111111111', read as never);
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
    const map = await resolveDbHosts(['db-1.a.rds.amazonaws.com'], 'self', read as never);
    expect(map.get('db-1.a.rds.amazonaws.com')?.accountId).toBe('self');
    expect((read.mock.calls[0][1] as unknown as { accounts: string[] }).accounts).toEqual(['self']);
  });

  it('skips inventory reads when there are no hosts', async () => {
    const read = reader({});
    expect((await resolveDbHosts([], 'self', read as never)).size).toBe(0);
    expect(read).not.toHaveBeenCalled();
  });

  it('caps paging at 5 pages of 500 per type', async () => {
    const read = vi.fn(async () => ({ rows: Array.from({ length: 500 }, (_, i) => row(`x${i}`, {})), run: null, consistency: 'statement-snapshot' as const }));
    await resolveDbHosts(['a.rds.amazonaws.com'], 'self', read as never);
    const rdsCalls = (read.mock.calls as unknown as [string][]).filter(c => c[0] === 'rds');
    expect(rdsCalls).toHaveLength(5);
    const rgCalls = (read.mock.calls as unknown as [string][]).filter(c => c[0] === 'elasticache_replication_group');
    expect(rgCalls).toHaveLength(5);
    expect(read).toHaveBeenCalledTimes(30);
  });

  it('resolves ElastiCache replication-group primary and reader endpoints', async () => {
    const read = reader({ elasticache_replication_group: [row('sessions', { node_groups: [{
      NodeGroupId: '0001',
      PrimaryEndpoint: { Address: 'Master.sessions.abc123.apn2.cache.amazonaws.com', Port: 6379 },
      ReaderEndpoint: { Address: 'replica.sessions.abc123.apn2.cache.amazonaws.com', Port: 6379 },
    }] })] });
    const primary = 'master.sessions.abc123.apn2.cache.amazonaws.com';
    const replica = 'replica.sessions.abc123.apn2.cache.amazonaws.com';
    const map = await resolveDbHosts([primary, replica], '111111111111', read as never);
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
    const map = await resolveDbHosts([host], '111111111111', read as never);
    expect(map.has(host)).toBe(false);
  });
});
