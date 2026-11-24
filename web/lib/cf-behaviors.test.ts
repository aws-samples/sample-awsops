import { describe, it, expect } from 'vitest';
import { cloudFrontBehaviors, cloudFrontOrigins, matchBehavior } from './cf-behaviors';

const items = [
  { PathPattern: '/api/*', TargetOriginId: 'api-dynamic' },
  { PathPattern: '/static/*', TargetOriginId: 's3-static' },
];
const shop = {
  cache_behaviors: { Quantity: 2, Items: items },
  default_cache_behavior: { TargetOriginId: 's3-static' },
};

describe('cloudFrontBehaviors', () => {
  it('parses the shop shape with default last', () => {
    const b = cloudFrontBehaviors(shop);
    expect(b).toHaveLength(3);
    expect(b.map((x) => x.targetOriginId)).toEqual(['api-dynamic', 's3-static', 's3-static']);
    expect(b[0]).toMatchObject({ pathPattern: '/api/*', order: 0, isDefault: false });
    expect(b[2]).toMatchObject({ pathPattern: '*', order: Infinity, isDefault: true });
  });

  it('parses array and JSON-string forms identically', () => {
    const base = cloudFrontBehaviors(shop);
    expect(cloudFrontBehaviors({ ...shop, cache_behaviors: items })).toEqual(base);
    expect(cloudFrontBehaviors({
      cache_behaviors: JSON.stringify({ Quantity: 2, Items: items }),
      default_cache_behavior: JSON.stringify({ TargetOriginId: 's3-static' }),
    })).toEqual(base);
    expect(cloudFrontBehaviors({ ...shop, cache_behaviors: JSON.stringify(items) })).toEqual(base);
  });

  it('tolerates garbage without throwing', () => {
    expect(cloudFrontBehaviors({ cache_behaviors: 5 })).toEqual([]);
    expect(cloudFrontBehaviors({})).toEqual([]);
    expect(cloudFrontBehaviors({ cache_behaviors: '{bad', default_cache_behavior: '{bad' })).toEqual([]);
    expect(cloudFrontBehaviors({ cache_behaviors: items, default_cache_behavior: {} })).toEqual([]);
    const noDefault = cloudFrontBehaviors({ cache_behaviors: items });
    expect(noDefault).toHaveLength(2);
    expect(noDefault.some((x) => x.isDefault)).toBe(false);
  });
  it('absent or empty cache_behaviors means default only', () => {
    const def = { default_cache_behavior: { TargetOriginId: 'o' } };
    for (const cache_behaviors of [undefined, null, { Quantity: 0 }, { Quantity: 0, Items: null }, { Quantity: 0, Items: [] }, [],
      JSON.stringify({ Quantity: 0, Items: null })]) {
      const onlyDefault = cloudFrontBehaviors({ ...def, cache_behaviors });
      expect(onlyDefault).toHaveLength(1);
      expect(onlyDefault[0].isDefault).toBe(true);
    }
  });
  it('a present but malformed cache_behaviors container yields [] for the whole row', () => {
    const def = { default_cache_behavior: { TargetOriginId: 'o' } };
    for (const cache_behaviors of [5, '{bad', { Quantity: 2 }, { Quantity: 2, Items: 'x' }, { Quantity: 2, Items: [items[0]] },
      { Items: 'x' }, {}, true, JSON.stringify({ Quantity: 3, Items: items })]) {
      expect(cloudFrontBehaviors({ ...def, cache_behaviors })).toEqual([]);
    }
  });
});

describe('matchBehavior', () => {
  const b = cloudFrontBehaviors(shop);
  it('matches by CloudFront semantics', () => {
    expect(matchBehavior(b, '/api/products/PROD-0101')?.targetOriginId).toBe('api-dynamic');
    expect(matchBehavior(b, '/products/PROD-0101')?.isDefault).toBe(true);
    expect(matchBehavior(b, '/API/x')?.isDefault).toBe(true);
    expect(matchBehavior(b, '/api')?.isDefault).toBe(true);
    expect(matchBehavior(b, '/api/x?y=1')?.targetOriginId).toBe('api-dynamic');
    expect(matchBehavior(b, '/static/a/b.js')?.targetOriginId).toBe('s3-static');
    expect(matchBehavior(b, 'api/x#frag')?.targetOriginId).toBe('api-dynamic');
  });
  it('? matches exactly one char', () => {
    const q = cloudFrontBehaviors({
      cache_behaviors: [{ PathPattern: '/v?/x', TargetOriginId: 'v' }],
      default_cache_behavior: { TargetOriginId: 'd' },
    });
    expect(matchBehavior(q, '/v1/x')?.targetOriginId).toBe('v');
    expect(matchBehavior(q, '/v10/x')?.targetOriginId).toBe('d');
  });
  it('returns null when nothing matches and no default', () => {
    expect(matchBehavior([], '/x')).toBeNull();
  });
  it('tries overlapping patterns in listed order', () => {
    const def = { TargetOriginId: 'd' };
    const v1 = { PathPattern: '/api/v1/*', TargetOriginId: 'v1' };
    const all = { PathPattern: '/api/*', TargetOriginId: 'all' };
    const a = cloudFrontBehaviors({ cache_behaviors: [v1, all], default_cache_behavior: def });
    expect(matchBehavior(a, '/api/v1/x')?.targetOriginId).toBe('v1');
    const b = cloudFrontBehaviors({ cache_behaviors: [all, v1], default_cache_behavior: def });
    expect(matchBehavior(b, '/api/v1/x')?.targetOriginId).toBe('all');
  });
  it('escapes regex metacharacters in patterns', () => {
    const b = cloudFrontBehaviors({
      cache_behaviors: [{ PathPattern: '*.jpg', TargetOriginId: 'img' }],
      default_cache_behavior: { TargetOriginId: 'd' },
    });
    expect(matchBehavior(b, '/a/b.jpg')?.targetOriginId).toBe('img');
    expect(matchBehavior(b, '/xjpg')?.targetOriginId).toBe('d');
  });
  it('matches a pattern without a leading slash', () => {
    const b = cloudFrontBehaviors({
      cache_behaviors: [{ PathPattern: 'api/*', TargetOriginId: 'api' }],
      default_cache_behavior: { TargetOriginId: 'd' },
    });
    expect(matchBehavior(b, '/api/x')?.targetOriginId).toBe('api');
  });
});

describe('malformed rows are all-or-nothing', () => {
  const def = { TargetOriginId: 'd' };
  it('returns [] for a missing PathPattern or empty TargetOriginId', () => {
    expect(cloudFrontBehaviors({
      cache_behaviors: [items[0], { TargetOriginId: 'x' }], default_cache_behavior: def,
    })).toEqual([]);
    expect(cloudFrontBehaviors({
      cache_behaviors: [items[0], { PathPattern: '/x/*', TargetOriginId: '' }], default_cache_behavior: def,
    })).toEqual([]);
  });
});

describe('matchBehavior with a pathological pattern', () => {
  it('a 255-character `*a*a…*b` pattern against a 2048-character path completes quickly', () => {
    const pattern = `${'*a'.repeat(127)}b`; // 255 characters
    expect(pattern.length).toBe(255);
    const behaviors = cloudFrontBehaviors({ cache_behaviors: [{ PathPattern: pattern, TargetOriginId: 'x' }], default_cache_behavior: { TargetOriginId: 'd' } });
    const t0 = performance.now();
    expect(matchBehavior(behaviors, `/${'a'.repeat(2047)}`)?.targetOriginId).toBe('d'); // no match: the default
    expect(performance.now() - t0).toBeLessThan(50);
  });
});

describe('cloudFrontBehaviors pattern cap', () => {
  it('a PathPattern over 255 characters makes the row malformed', () => {
    const row = (n: number) => ({ cache_behaviors: [{ PathPattern: `/${'a'.repeat(n - 1)}`, TargetOriginId: 'o' }], default_cache_behavior: { TargetOriginId: 'o' } });
    expect(cloudFrontBehaviors(row(255))).toHaveLength(2);
    expect(cloudFrontBehaviors(row(256))).toEqual([]);
  });
});

describe('cloudFrontOrigins', () => {
  it('normalizes OriginPath; an unreadable path or a duplicated Id is unknown; a malformed container is null', () => {
    const o = cloudFrontOrigins({ origins: JSON.stringify({ Quantity: 5, Items: [
      { Id: 'a', DomainName: 'x.example.com', OriginPath: 'v1/' }, { Id: 'b', DomainName: 'y.example.com' },
      { Id: 'c', DomainName: 'z.example.com', OriginPath: 7 }, { Id: 'd', DomainName: 'd1', OriginPath: '/' }, { Id: 'b', DomainName: 'w' },
    ] }) });
    expect(o?.get('a')).toEqual({ domainName: 'x.example.com', originPath: '/v1' });
    expect(o?.get('c')).toEqual({ domainName: 'z.example.com', originPath: null });
    expect(o?.get('d')).toEqual({ domainName: 'd1', originPath: '' });
    expect(o?.get('b')).toEqual({ domainName: '', originPath: null });
    expect(cloudFrontOrigins({ origins: { Quantity: 2, Items: [] } })).toBeNull();
    expect(cloudFrontOrigins({})?.size).toBe(0);
  });
});
