import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

// The route/page/component counts quoted in README and web/app/CLAUDE.md drifted repeatedly
// (99 vs 97 vs the real number). Derive them from the tree so a new route fails CI until the
// docs follow. Root CLAUDE.md's count sits in a sync-managed block and is not asserted here.
const web = fileURLToPath(new URL('..', import.meta.url));
const root = join(web, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

function walk(dir: string, match: (name: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(p, match);
    return match(e.name) ? [p] : [];
  });
}

const routes = walk(join(web, 'app/api'), (n) => n === 'route.ts')
  .map((p) => '/' + relative(join(web, 'app'), p).replace(/\/route\.ts$/, ''));
const pages = walk(join(web, 'app'), (n) => n === 'page.tsx').length;
const components = walk(join(web, 'components'), (n) => n.endsWith('.tsx') && !n.endsWith('.test.tsx')).length;

// Every number a doc quotes for `label`, e.g. all "<n> API routes" in README.
const quoted = (text: string, label: string) =>
  [...text.matchAll(new RegExp(`(?<![\\d.])(\\d+)(?:개)? ?${label}`, 'g'))].map((m) => Number(m[1]));

describe('documented web stats match the tree', () => {
  it('README quotes the actual page, route and component counts (English and Korean)', () => {
    const readme = read('README.md');
    expect(quoted(readme, 'API (?:routes|라우트)')).toEqual(Array(6).fill(routes.length));
    expect(quoted(readme, 'pages')).toEqual([pages, pages]);
    expect(quoted(readme, '페이지')).toEqual([pages, pages]);
    expect(quoted(readme, '(?:components|컴포넌트)')).toEqual(Array(4).fill(components));
  });

  it('web/app/CLAUDE.md quotes the actual page and route counts', () => {
    expect(read('web/app/CLAUDE.md')).toContain(`${pages} pages + ${routes.length} API routes`);
  });

  it('docs/api-reference.md documents exactly the existing routes', () => {
    const ref = read('docs/api-reference.md');
    const documented = new Set([...ref.matchAll(/^\| `(\/api[^`]*)`/gm)].map((m) => m[1]));
    expect(routes.filter((r) => !documented.has(r))).toEqual([]);
    expect([...documented].filter((r) => !routes.includes(r))).toEqual([]);
  });
});
