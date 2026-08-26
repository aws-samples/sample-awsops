import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

const moduleDir = new URL('.', import.meta.url).pathname;
const repoRoot = path.resolve(moduleDir, '../..');

function readRepoFile(...parts: string[]): string {
  return readFileSync(path.join(repoRoot, ...parts), 'utf8');
}

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

function quotedValues(src: string): string[] {
  return [...src.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function literalBody(src: string, name: string, open: string, close: string): string {
  const assignment = new RegExp(
    `^\\s*(?:export\\s+)?(?:(?:const|let|var)\\s+)?${escapeRegExp(name)}\\b(?:\\s*:[^=\\n]*)?\\s*=`,
    'm',
  );
  const match = assignment.exec(src);
  if (!match) return '';
  const equalsAt = match.index + match[0].lastIndexOf('=');
  const openAt = src.indexOf(open, equalsAt);
  if (openAt < 0) return '';
  let depth = 0;
  for (let i = openAt; i < src.length; i += 1) {
    if (src[i] === open) depth += 1;
    if (src[i] === close) {
      depth -= 1;
      if (depth === 0) return src.slice(openAt + 1, i);
    }
  }
  return '';
}

function keyValues(src: string): string[] {
  return uniq([...src.matchAll(/\bkey:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]));
}

export function readCatalogGateways(): string[] {
  const src = readRepoFile('scripts/v2/agentcore/catalog.py');
  return quotedValues(literalBody(src, 'GATEWAYS', '[', ']'));
}

export function readSectionKeys(): string[] {
  const src = readRepoFile('web/lib/sections.ts');
  return keyValues(literalBody(src, 'SECTIONS', '[', ']'));
}

export function readRouteRuleKeys(): string[] {
  const src = readRepoFile('web/lib/route.ts');
  return keyValues(literalBody(src, 'RULES', '[', ']'));
}

export function readAgentAlias(): Record<string, string> {
  const src = readRepoFile('agent/agent.py');
  const body = literalBody(src, '_GATEWAY_ALIAS', '{', '}');
  return Object.fromEntries(
    [...body.matchAll(/["']([^"']+)["']\s*:\s*["']([^"']+)["']/g)].map((m) => [m[1], m[2]]),
  );
}

function scanFile(file: string): string[] {
  const rel = path.relative(repoRoot, file);
  const hits: string[] = [];
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (/["'`]\/awsops\//.test(lines[i])) hits.push(`${rel}:${i + 1}`);
  }
  return hits;
}

function scanDir(dir: string): string[] {
  const hits: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) hits.push(...scanDir(full));
    if (entry.isFile() && /\.tsx?$/.test(entry.name)) hits.push(...scanFile(full));
  }
  return hits;
}

export function scanV1PathLeak(): string[] {
  const excluded = new Set([
    path.join(repoRoot, 'web/lib/merge-invariants.ts'),
    path.join(repoRoot, 'web/lib/merge-invariants.test.ts'),
  ]);
  const roots = ['web/app', 'web/lib', 'web/components'].map((p) => path.join(repoRoot, p));
  const middleware = path.join(repoRoot, 'web/middleware.ts');
  const files = existsSync(middleware) ? [middleware] : [];

  const hits = roots.flatMap((root) => scanDir(root));
  for (const file of files) {
    if (!excluded.has(file)) hits.push(...scanFile(file));
  }
  return hits.filter((hit) => {
    const file = path.join(repoRoot, hit.split(':')[0]);
    return !excluded.has(file);
  });
}
