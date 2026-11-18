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

  describe('hardening', () => {
    const host = (h: string) => extractManagedDbHosts(h).map((x) => x.host);

    it('detects aoss, kafka-serverless and .cn partitions', () => {
      expect(extractManagedDbHosts('col1.us-east-1.aoss.amazonaws.com')).toEqual([{ host: 'col1.us-east-1.aoss.amazonaws.com', kind: 'opensearch' }]);
      expect(extractManagedDbHosts('boot-ab.c2.kafka-serverless.us-east-1.amazonaws.com:9098'))
        .toEqual([{ host: 'boot-ab.c2.kafka-serverless.us-east-1.amazonaws.com', kind: 'msk' }]);
      expect(extractManagedDbHosts('db1.abc.cn-north-1.rds.amazonaws.com.cn:3306'))
        .toEqual([{ host: 'db1.abc.cn-north-1.rds.amazonaws.com.cn', kind: 'rds' }]);
      expect(extractManagedDbHosts('c1.abc.cnn1.cache.amazonaws.com.cn')).toEqual([{ host: 'c1.abc.cnn1.cache.amazonaws.com.cn', kind: 'elasticache' }]);
    });

    it('drops host-like credentials in JDBC query strings and keeps the real host', () => {
      const v = 'jdbc:postgresql://orders.abc.us-east-1.rds.amazonaws.com:5432/orders?user=app&password=leak.x.us-east-1.rds.amazonaws.com&sslmode=require';
      expect(host(v)).toEqual(['orders.abc.us-east-1.rds.amazonaws.com']);
      expect(JSON.stringify(extractManagedDbHosts(v))).not.toContain('leak');
    });

    it('never returns a host-like value assigned to a credential key', () => {
      for (const v of [
        'password=abc.rds.amazonaws.com',
        'DB_PASSWORD=abc.rds.amazonaws.com',
        'redis.auth-token = "abc.cache.amazonaws.com"',
        '{"secret": "abc.rds.amazonaws.com"}',
        'pwd: abc.rds.amazonaws.com',
        'apiKey=abc.es.amazonaws.com',
        'passwd=\'abc.rds.amazonaws.com\'',
      ]) expect(extractManagedDbHosts(v)).toEqual([]);
      // A non-credential key keeps its host.
      expect(host('DB_HOST=orders.abc.us-east-1.rds.amazonaws.com')).toEqual(['orders.abc.us-east-1.rds.amazonaws.com']);
    });

    it('never returns userinfo, with multiple @ or a numeric or host-like password', () => {
      expect(host('postgres://u:p@ss@real.abc.us-east-1.rds.amazonaws.com/db')).toEqual(['real.abc.us-east-1.rds.amazonaws.com']);
      expect(host('postgres://u:x@leak.rds.amazonaws.com@real.abc.us-east-1.rds.amazonaws.com/db'))
        .toEqual(['real.abc.us-east-1.rds.amazonaws.com']);
      expect(host('mysql://admin:12345@real.abc.us-east-1.rds.amazonaws.com:3306/app')).toEqual(['real.abc.us-east-1.rds.amazonaws.com']);
      expect(host('postgres://leak.abc.us-east-1.rds.amazonaws.com:5432@real.abc.us-east-1.rds.amazonaws.com/db'))
        .toEqual(['real.abc.us-east-1.rds.amazonaws.com']);
      expect(host('postgres://p.w.db1.abc.us-east-1.rds.amazonaws.com@real.abc.us-east-1.rds.amazonaws.com'))
        .toEqual(['real.abc.us-east-1.rds.amazonaws.com']);
    });

    it('rejects empty, malformed and overlong labels', () => {
      for (const v of ['a..rds.amazonaws.com', 'a.-b.rds.amazonaws.com', 'a.b-.rds.amazonaws.com', '.rds.amazonaws.com',
        `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.rds.amazonaws.com`]) {
        expect(extractManagedDbHosts(v)).toEqual([]);
      }
    });

    it('accepts a 63-character label and rejects a 64-character one', () => {
      const ok = `${'a'.repeat(63)}.x.us-east-1.rds.amazonaws.com`;
      expect(host(ok)).toEqual([ok]);
      expect(extractManagedDbHosts(`${'a'.repeat(64)}.x.us-east-1.rds.amazonaws.com`)).toEqual([]);
    });

    it('finds a host followed by & or prefixed by a tcp:/ssl:/rediss: scheme', () => {
      expect(host('host=orders.abc.us-east-1.rds.amazonaws.com&sslmode=require')).toEqual(['orders.abc.us-east-1.rds.amazonaws.com']);
      expect(host('tcp:orders.abc.us-east-1.rds.amazonaws.com:5432')).toEqual(['orders.abc.us-east-1.rds.amazonaws.com']);
      expect(host('ssl:b-1.x.kafka.us-east-1.amazonaws.com:9094')).toEqual(['b-1.x.kafka.us-east-1.amazonaws.com']);
      expect(host('rediss:cart.abc.use1.cache.amazonaws.com:6379')).toEqual(['cart.abc.use1.cache.amazonaws.com']);
    });
  });
});

