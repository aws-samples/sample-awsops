import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it, expect } from 'vitest';

// The route/page/component counts quoted in README and CLAUDE.md drifted repeatedly (99 vs 97 vs
// the real number). Derive them from the tree so a new route fails CI until the docs follow.
const web = new URL('..', import.meta.url).pathname;
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

describe('documented web stats match the tree', () => {
  it('README quotes the actual page, route and component counts (English and Korean)', () => {
    const readme = read('README.md');
    expect(readme).toContain(`${pages} pages, ${routes.length} API routes, ${components} components`);
    expect(readme).toContain(`${pages} 페이지, ${routes.length} API 라우트, ${components} 컴포넌트`);
    expect(readme).toContain(`The ${routes.length} API routes live under`);
    expect(readme).toContain(`${routes.length}개 API 라우트`);
  });

  it('CLAUDE.md files quote the actual route count', () => {
    expect(read('CLAUDE.md')).toContain(`Full API index (${routes.length} routes)`);
    expect(read('web/app/CLAUDE.md')).toContain(`${pages} pages + ${routes.length} API routes`);
  });

  it('docs/api-reference.md has a row for every route', () => {
    const ref = read('docs/api-reference.md');
    const documented = new Set([...ref.matchAll(/^\| `(\/api[^`]*)`/gm)].map((m) => m[1]));
    expect(routes.filter((r) => !documented.has(r))).toEqual([]);
  });
});
