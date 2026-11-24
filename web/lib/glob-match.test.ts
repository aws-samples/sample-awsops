import { describe, it, expect } from 'vitest';
import { globMatch } from './glob-match';

describe('globMatch', () => {
  it('anchored, case-sensitive, `*` any run including `/`, `?` one character', () => {
    expect(globMatch('/api/*', '/api/x/y')).toBe(true);
    expect(globMatch('/api/*', '/api/')).toBe(true);
    expect(globMatch('/api/*', '/API/x')).toBe(false);
    expect(globMatch('/api/*', 'x/api/x')).toBe(false);
    expect(globMatch('*.jpg', '/a/b.jpg')).toBe(true);
    expect(globMatch('*.jpg', '/a/b.jpgx')).toBe(false);
    expect(globMatch('/adm?n', '/admin')).toBe(true);
    expect(globMatch('/adm?n', '/admn')).toBe(false);
    expect(globMatch('*', '')).toBe(true);
    expect(globMatch('', '')).toBe(true);
    expect(globMatch('', 'a')).toBe(false);
    expect(globMatch('a*b*c', 'axxbyyc')).toBe(true);
    expect(globMatch('a*b*c', 'axxbyy')).toBe(false);
    expect(globMatch('/x.y', '/x-y')).toBe(false); // regex metacharacters are literal
    expect(globMatch('/?', '/😀')).toBe(true); // one code point
  });
  it('a pathological `*a*a…*b` pattern against a long mismatching path completes quickly', () => {
    const p255 = `${'*a'.repeat(127)}b`, text = 'a'.repeat(2048); // 255 characters
    expect(p255.length).toBe(255);
    const t0 = performance.now();
    expect(globMatch(p255, text)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});
