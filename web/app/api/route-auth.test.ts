import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

// Auth is enforced per route (middleware.ts only caps body size), so a new handler that forgets
// verifyUser() fails open behind the edge. Lock the contract at the source level: every exported
// HTTP handler must call an auth helper unless its path is a documented exception.
const api = fileURLToPath(new URL('.', import.meta.url));

// Routes that authenticate some other way. Each must also be public at the edge.
const PUBLIC: Record<string, string> = {
  '/api/health': 'load balancer and container health check',
  '/api/auth/login': 'login entry point (no session yet)',
  '/api/incidents/webhook': 'ADR-013 machine ingress, verified by HMAC/SNS signature',
};
// Routes that rely on edge authentication alone. Each must NOT be public at the edge.
const EDGE_ONLY: Record<string, string> = {
  '/api/db': 'ADR-002 §2-4: edge-authenticated Aurora ping; returns only status, a public-table count and UTC database time',
};
// The only route allowed to satisfy the contract with verifyUserForSignout.
const SIGNOUT = '/api/auth/signout';
const AUTH_CALL = /\bverifyUser(ForSignout)?\(/;
const USER_CALL = /\bverifyUser\(/;
const TOP_FN = /^(export )?(?:async )?function (\w+)/gm;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

// Blank out comments and string/template literal contents, preserving newlines and offsets.
// Limitation: nested template literals (`${`...`}` inside a template) are not tokenised, so keep handler declarations and auth calls out of nested templates.
function code(src: string): string {
  return src.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g,
    (m) => m.replace(/[^\n]/g, ' '),
  );
}

function routes(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return routes(p);
    return e.name === 'route.ts' || e.name === 'route.tsx' ? [p] : [];
  });
}

const all = routes(api).map((file) => ({
  file,
  path: '/api/' + relative(api, file).replace(/\/?route\.tsx?$/, ''),
  src: code(readFileSync(file, 'utf8')),
}));

// Public exact-match entries and `startswith` prefixes of `def is_public` in the edge Lambda template.
function edgePublic(): { exact: Set<string>; prefixes: string[] } {
  const src = readFileSync(
    join(api, '..', '..', '..', 'terraform', 'foundation', 'edge-lambda', 'cognito_edge.py.tftpl'),
    'utf8',
  );
  const rest = src.slice(src.indexOf('def is_public'));
  const end = rest.indexOf('\ndef ', 1);
  const fn = end === -1 ? rest : rest.slice(0, end);
  const tuple = /\buri in \(([\s\S]*?)\)/.exec(fn)?.[1] ?? '';
  return {
    exact: new Set([...tuple.matchAll(/'([^']*)'/g)].map((m) => m[1])),
    prefixes: [...fn.matchAll(/startswith\('([^']*)'\)/g)].map((m) => m[1]),
  };
}

// Top-level functions in a route file, each sliced up to the next top-level function.
function functions(src: string): { exported: boolean; name: string; body: string }[] {
  const starts = [...src.matchAll(TOP_FN)];
  return starts.map((m, i) => ({
    exported: !!m[1],
    name: m[2],
    body: src.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : src.length),
  }));
}

// Handlers that neither call an auth helper nor delegate to a same-file helper that does
// (e.g. a local `gate()` or `loadMutable()`).
function unauthenticated(src: string, auth: RegExp): string[] {
  const fns = functions(src);
  const guards = fns.filter((f) => !f.exported && auth.test(f.body)).map((f) => f.name);
  return fns
    .filter((f) => f.exported && METHODS.has(f.name))
    .filter((f) => !auth.test(f.body) && !guards.some((g) => new RegExp(`\\b${g}\\(`).test(f.body)))
    .map((f) => f.name);
}

describe('API route auth contract', () => {
  it('finds the route tree', () => {
    expect(all.length).toBeGreaterThanOrEqual(100);
  });

  it('every exported handler outside the documented exceptions calls verifyUser', () => {
    const missing = all
      .filter((r) => !(r.path in PUBLIC) && !(r.path in EDGE_ONLY))
      .flatMap((r) => unauthenticated(r.src, r.path === SIGNOUT ? AUTH_CALL : USER_CALL).map((m) => `${m} ${r.path}`));
    expect(missing).toEqual([]);
  });

  it('declares handlers as functions (the check above cannot see `export const GET =`)', () => {
    const constHandlers = all.filter((r) =>
      /^export (const|let) (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b|^export \{/m.test(r.src));
    expect(constHandlers.map((r) => r.path)).toEqual([]);
  });

  it('every public route exists and is also public at the edge', () => {
    const edge = edgePublic().exact;
    expect(edge.size).toBeGreaterThan(0);
    for (const p of Object.keys(PUBLIC)) {
      expect(all.some((r) => r.path === p), `${p} has no route.ts`).toBe(true);
      expect(edge.has(p), `edge allowlist missing ${p}`).toBe(true);
    }
  });

  it('every edge-only route exists and is not public at the edge', () => {
    const edge = edgePublic().exact;
    expect(edge.size).toBeGreaterThan(0);
    for (const p of Object.keys(EDGE_ONLY)) {
      expect(all.some((r) => r.path === p), `${p} has no route.ts`).toBe(true);
      expect(edge.has(p), `${p} is edge-only but public at the edge`).toBe(false);
    }
  });

  it('every API path public at the edge is declared in PUBLIC', () => {
    const { exact: edge, prefixes } = edgePublic();
    expect(edge.size).toBeGreaterThan(0);
    for (const p of edge) {
      if (!p.startsWith('/api/')) continue;
      expect(p in PUBLIC || p === SIGNOUT, `${p} is public at the edge but not declared in PUBLIC`).toBe(true);
    }
    expect(prefixes.filter((p) => p.startsWith('/api')), 'edge public prefix under /api').toEqual([]);
  });
});
