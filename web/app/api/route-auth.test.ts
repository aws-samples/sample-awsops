import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it, expect } from 'vitest';

// Auth is enforced per route (middleware.ts only caps body size), so a new handler that forgets
// verifyUser() fails open behind the edge. Lock the contract at the source level: every exported
// HTTP handler must call an auth helper unless its path is deliberately public.
const api = new URL('.', import.meta.url).pathname;
const edgeSrc = readFileSync(
  join(api, '..', '..', '..', 'terraform', 'foundation', 'edge-lambda', 'cognito_edge.py.tftpl'),
  'utf8',
);

// Routes that authenticate some other way. Each must also be public at the edge.
const PUBLIC: Record<string, string> = {
  '/api/health': 'load balancer and container health check',
  '/api/auth/login': 'login entry point (no session yet)',
  '/api/incidents/webhook': 'ADR-013 machine ingress, verified by HMAC/SNS signature',
};
const AUTH_CALL = /\bverifyUser(ForSignout)?\(/;
const TOP_FN = /^(export )?(?:async )?function (\w+)/gm;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

function routes(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return routes(p);
    return e.name === 'route.ts' ? [p] : [];
  });
}

const all = routes(api).map((file) => ({
  file,
  path: '/api/' + relative(api, file).replace(/\/?route\.ts$/, ''),
  src: readFileSync(file, 'utf8'),
}));

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
function unauthenticated(src: string): string[] {
  const fns = functions(src);
  const guards = fns.filter((f) => !f.exported && AUTH_CALL.test(f.body)).map((f) => f.name);
  return fns
    .filter((f) => f.exported && METHODS.has(f.name))
    .filter((f) => !AUTH_CALL.test(f.body) && !guards.some((g) => new RegExp(`\\b${g}\\(`).test(f.body)))
    .map((f) => f.name);
}

describe('API route auth contract', () => {
  it('finds the route tree', () => {
    expect(all.length).toBeGreaterThan(50);
  });

  it('every exported handler outside the public list calls verifyUser', () => {
    const missing = all
      .filter((r) => !(r.path in PUBLIC))
      .flatMap((r) => unauthenticated(r.src).map((m) => `${m} ${r.path}`));
    expect(missing).toEqual([]);
  });

  it('declares handlers as functions (the check above cannot see `export const GET =`)', () => {
    const constHandlers = all.filter((r) => /^export (const|let) (GET|POST|PUT|PATCH|DELETE)\b|^export \{/m.test(r.src));
    expect(constHandlers.map((r) => r.path)).toEqual([]);
  });

  it('every public route exists and is also public at the edge', () => {
    for (const p of Object.keys(PUBLIC)) {
      expect(all.some((r) => r.path === p), `${p} has no route.ts`).toBe(true);
      expect(edgeSrc, `edge allowlist missing ${p}`).toContain(`'${p}'`);
    }
  });
});
