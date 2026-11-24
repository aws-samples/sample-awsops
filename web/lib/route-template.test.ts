import { describe, expect, it } from 'vitest';
import { inferApiRoutes, templateMatches } from './route-template';

describe('templateMatches', () => {
  it('matches {x} and :x params as exactly one segment', () => {
    expect(templateMatches('/api/products/{id}', '/api/products/PROD-0101')).toBe(true);
    expect(templateMatches('/api/products/:id', '/api/products/PROD-0101')).toBe(true);
    expect(templateMatches('/api/products/*', '/api/products/1')).toBe(true);
    expect(templateMatches('/api/products/{id}', '/api/products')).toBe(false);
    expect(templateMatches('/api/products/{id}', '/api/products/1/reviews')).toBe(false);
  });
  it('matches the rest with ** and trailing /*', () => {
    expect(templateMatches('/api/**', '/api/a/b/c')).toBe(true);
    expect(templateMatches('/api/**', '/api')).toBe(true);
    expect(templateMatches('/api/*', '/api/a/b')).toBe(true);
    expect(templateMatches('/api/*', '/api')).toBe(false);
  });
  it('ignores trailing slash and query, is case-sensitive', () => {
    expect(templateMatches('/api/products/', '/api/products?x=1')).toBe(true);
    expect(templateMatches('/api/products', '/api/products/')).toBe(true);
    expect(templateMatches('/api/Products', '/api/products')).toBe(false);
  });
});

describe('inferApiRoutes', () => {
  const r = (route: string, service = 'api-gateway') => ({ service, route });
  it('infers a single match', () => {
    const out = inferApiRoutes('/products/PROD-0101', '/api', [r('/api/products/{id}'), r('/api/orders/{id}')]);
    expect(out.matches).toEqual([r('/api/products/{id}')]);
    expect(out.ambiguous).toBe(false);
  });
  it('prefers the literal-heavier route', () => {
    const out = inferApiRoutes('/products/PROD-0101', '/api', [r('/api/{kind}/{id}'), r('/api/products/{id}')]);
    expect(out.matches[0]).toEqual(r('/api/products/{id}'));
    expect(out.ambiguous).toBe(false);
  });
  it('ranks a rest wildcard below an equal-literal template', () => {
    const out = inferApiRoutes('/products/x', '/api', [r('/api/products/**'), r('/api/products/{id}')]);
    expect(out.matches[0]).toEqual(r('/api/products/{id}'));
    expect(out.ambiguous).toBe(false);
  });
  it('matches routes whose prefix-stripped form matches the page path', () => {
    const out = inferApiRoutes('/products/1', '/api', [r('/api/products/{id}')]);
    expect(out.matches).toHaveLength(1);
  });
  it('ignores routes outside the API prefix', () => {
    const out = inferApiRoutes('/products/1', '/api', [{ service: 'product-service', route: '/products/{id}' }]);
    expect(out).toEqual({ matches: [], ambiguous: false });
  });
  it('empty prefix qualifies every route', () => {
    expect(inferApiRoutes('/products/1', '', [r('/products/{id}')]).matches).toHaveLength(1);
  });
  it('a unique best with more than 3 hits is not ambiguous; at most 3 matches, best first', () => {
    const c = [...['a', 'b', 'c'].map((s) => r('/api/{k}/{id}', s)), r('/api/products/{id}', 'best')];
    const out = inferApiRoutes('/products/1', '/api', c);
    expect(out.matches).toHaveLength(3);
    expect(out.matches[0].service).toBe('best');
    expect(out.ambiguous).toBe(false);
  });
  it('unique best with lower-ranked hits is not ambiguous', () => {
    const out = inferApiRoutes('/products/1', '/api', [r('/api/{k}/{id}', 'low'), r('/api/products/{id}', 'best')]);
    expect(out.matches.map((m) => m.service)).toEqual(['best', 'low']);
    expect(out.ambiguous).toBe(false);
  });
  it('dedupes by service+route', () => {
    const out = inferApiRoutes('/products/1', '/api', [r('/api/products/{id}'), r('/api/products/{id}')]);
    expect(out.matches).toHaveLength(1);
    expect(out.ambiguous).toBe(false);
  });
  it('reports ambiguity and caps at 3', () => {
    const c = ['a', 'b', 'c', 'd'].map((s) => r('/api/products/{id}', s));
    const out = inferApiRoutes('/products/1', '/api', c);
    expect(out.matches).toHaveLength(3);
    expect(out.ambiguous).toBe(true);
  });
  it('ambiguous when two share the best rank', () => {
    const out = inferApiRoutes('/products/1', '/api', [r('/api/products/{id}', 'a'), r('/api/products/:id', 'b')]);
    expect(out.ambiguous).toBe(true);
  });
  it('returns nothing when no route matches', () => {
    expect(inferApiRoutes('/x', '/api', [r('/api/y')])).toEqual({ matches: [], ambiguous: false });
  });
});
