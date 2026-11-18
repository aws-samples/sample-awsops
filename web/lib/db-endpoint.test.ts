import { describe, it, expect } from 'vitest';
import { extractManagedDbHosts } from '@/lib/db-endpoint';

describe('extractManagedDbHosts', () => {
  it('extracts an RDS host from a connection string without leaking credentials', () => {
    const r = extractManagedDbHosts(
      'postgres://app:s3cret@orders.cluster-abc.ap-northeast-2.rds.amazonaws.com:5432/orders',
    );
    expect(r).toEqual([{ host: 'orders.cluster-abc.ap-northeast-2.rds.amazonaws.com', kind: 'rds' }]);
    const s = JSON.stringify(r);
    expect(s).not.toContain('s3cret');
    expect(s).not.toContain('app:');
    expect(s).not.toContain('5432');
    expect(s).not.toContain('/orders');
  });

  it('detects ElastiCache host:port', () => {
    expect(extractManagedDbHosts('cart.abc.apne2.cache.amazonaws.com:6379')).toEqual([
      { host: 'cart.abc.apne2.cache.amazonaws.com', kind: 'elasticache' },
    ]);
  });

  it('splits comma-separated MSK bootstrap servers', () => {
    const r = extractManagedDbHosts(
      'b-1.x.kafka.ap-northeast-2.amazonaws.com:9094,b-2.x.kafka.ap-northeast-2.amazonaws.com:9094',
    );
    expect(r).toEqual([
      { host: 'b-1.x.kafka.ap-northeast-2.amazonaws.com', kind: 'msk' },
      { host: 'b-2.x.kafka.ap-northeast-2.amazonaws.com', kind: 'msk' },
    ]);
  });

  it('detects OpenSearch and lower-cases / dedupes', () => {
    const r = extractManagedDbHosts(
      'https://Search-X.ap-northeast-2.es.amazonaws.com/_dashboards search-x.ap-northeast-2.es.amazonaws.com',
    );
    expect(r).toEqual([{ host: 'search-x.ap-northeast-2.es.amazonaws.com', kind: 'opensearch' }]);
  });

  it('returns [] for non-managed or junk input', () => {
    for (const v of ['example.com', 'localhost', '10.0.1.5:5432', '', 'x'.repeat(10240)]) {
      expect(extractManagedDbHosts(v)).toEqual([]);
    }
    expect(extractManagedDbHosts(undefined as unknown as string)).toEqual([]);
    expect(extractManagedDbHosts(42 as unknown as string)).toEqual([]);
    expect(extractManagedDbHosts({} as unknown as string)).toEqual([]);
  });

  it('only inspects the first 4096 chars and caps results at 20', () => {
    const many = Array.from({ length: 30 }, (_, i) => `h${i}.x.rds.amazonaws.com`).join(',');
    expect(extractManagedDbHosts(many)).toHaveLength(20);
    const late = 'a'.repeat(4100) + ',late.x.rds.amazonaws.com';
    expect(extractManagedDbHosts(late)).toEqual([]);
  });
});
