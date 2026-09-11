// Gap L186/L206/L207/L254 (batch 40): the v1-gap audit flagged the inventory pages
// (cloudfront/dynamodb/waf render through the generic [type] page) and the datasources UI
// as hardcoded-Korean. The tt() mechanism only translates REGISTERED literals — an
// unregistered string passes through silently — so this lockstep test extracts the STATIC
// Korean tt() literals (single-quoted AND interpolation-free template literals, recursively
// under the surface directories) and asserts each resolves in en/zh/ja (TERMS or a RULE).
// SCOPE (round-1 correction — this is a RATCHET, not a completeness proof): most dynamic
// tt(variable) strings are covered by registering their finite catalogs (see the lockstep
// comments in i18n-terms.ts) — with ONE enforced exception: card_catalog.py titles are
// checked by the dedicated dashboard-card test below, which reads the Python catalog
// directly. Korean composed at runtime with interpolation relies on RULES. Column/spec labels are deliberately English (repo convention).
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { applyTerms } from './i18n-terms';

function tsxUnder(dir: string): string[] {
  // recursive readdir (repo precedent — avoids the fs.globSync Node/types floor question)
  return readdirSync(dir, { recursive: true, withFileTypes: false })
    .map((f) => join(dir, String(f)))
    .filter((f) => f.endsWith('.tsx') && !f.includes('.test.'));
}
const SURFACES = [
  'app/inventory/[type]/page.tsx',
  ...tsxUnder('app/integrations/datasources'),
  ...tsxUnder('components/datasources'),
];

function koreanTtLiterals(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of src.matchAll(/tt\('((?:[^'\\]|\\.)+)'\)/g)) {
    const lit = m[1].replace(/\\'/g, "'");
    if (/[가-힣]/.test(lit)) out.push(lit);
  }
  // interpolation-free template literals: tt(`...`) with no ${} — static in practice
  for (const m of src.matchAll(/tt\(`([^`$]+)`\)/g)) {
    if (/[가-힣]/.test(m[1])) out.push(m[1]);
  }
  return out;
}

function dashboardCardTitles(src: string): string[] {
  return [
    // dict-style: {"title": "..."} / {'title': '...'}
    ...[...src.matchAll(/["']title["']:\s*(["'])(.*?)\1/g)].map((m) => m[2]),
    // positional _row(card_key, title, ...) — the ClickHouse cards build rows directly
    ...[...src.matchAll(/_row\(\s*"[^"]*",\s*"([^"]*)"/g)].map((m) => m[1]),
  ];
}

describe('i18n coverage on the gap-audit surfaces (L186/L206/L207/L254)', () => {
  it('every Korean tt() literal on the inventory [type] page and datasources UI resolves in en/zh/ja', () => {
    const missing: string[] = [];
    let scanned = 0;
    for (const f of SURFACES) {
      for (const lit of koreanTtLiterals(f)) {
        scanned += 1;
        for (const lang of ['en', 'zh', 'ja'] as const) {
          const translated = applyTerms(lang, lit);
          // an unregistered literal passes through unchanged — that IS the failure
          if (translated === lit) { missing.push(`${f}: ${lit} [${lang}]`); break; }
        }
      }
    }
    expect(SURFACES.length).toBeGreaterThan(3); // the glob must actually find the surfaces
    expect(scanned).toBeGreaterThan(30);         // and real literals — an empty scan proves nothing
    expect(missing, `unregistered Korean literals:\n${missing.join('\n')}`).toEqual([]);
  });

  it('every dynamic dashboard-card title resolves in en/zh/ja', () => {
    const src = readFileSync('../scripts/v2/workers/card_catalog.py', 'utf8');
    const titles = dashboardCardTitles(src).filter((title) => /[가-힣]/.test(title));
    const missing = titles.filter((title) =>
      (['en', 'zh', 'ja'] as const).some((lang) => applyTerms(lang, title) === title));

    expect(titles.length).toBeGreaterThan(10);
    expect(missing, `unregistered dashboard-card titles:\n${missing.join('\n')}`).toEqual([]);
  });

  it('extracts both Python quote styles for the dynamic-title lockstep', () => {
    expect(dashboardCardTitles(`{"title": "더블"}, {'title': '싱글'}`)).toEqual(['더블', '싱글']);
  });
});
