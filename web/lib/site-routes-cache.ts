// In-process reuse of per-source trace route reads for GET /api/topology/site-routes (server-only).
// Each site-flow load with a path reads every ClickHouse trace source; route aggregates are path-independent, so one
// read per (source instance, registry template, window) per TTL serves every caller. Single-flight: callers arriving
// while a read for the same key is in flight share it. Only `ok`/`partial` results are kept; an `unavailable` result
// or a rejection is dropped as soon as it settles, so the next caller reads again. Callers must not mutate the shared
// RouteRead (the route's merge builds new objects).
import type { RouteRead } from '@/lib/trace-routes';

export const ROUTE_CACHE_TTL_MS = 60_000;
/** Keys are bounded by the registry (sources × 3 windows); the cap only guards against a churning registry. */
const MAX_ENTRIES = 64;

/** `expires` null = still in flight. */
interface Entry { read: Promise<RouteRead>; expires: number | null }
const entries = new Map<string, Entry>();

export function routeCacheKey(instanceId: number | undefined, template: string | undefined, windowMins: number): string {
  return JSON.stringify([instanceId ?? null, template ?? null, windowMins]);
}

/** The cached or in-flight read for `key`, else `read()` (started once, shared by concurrent callers). */
export function cachedRouteRead(key: string, read: () => Promise<RouteRead>): Promise<RouteRead> {
  const now = Date.now();
  for (const [k, e] of entries) if (e.expires !== null && e.expires <= now) entries.delete(k);
  const hit = entries.get(key);
  if (hit) return hit.read;
  const entry: Entry = { read: Promise.resolve().then(read), expires: null };
  entries.set(key, entry);
  entry.read.then((r) => {
    if (entries.get(key) !== entry) return; // cleared meanwhile
    if (r.status !== 'ok' && r.status !== 'partial') { entries.delete(key); return; }
    entry.expires = Date.now() + ROUTE_CACHE_TTL_MS;
    for (const [k, e] of entries) {
      if (entries.size <= MAX_ENTRIES) break;
      if (e.expires !== null && k !== key) entries.delete(k); // oldest settled entries first (insertion order)
    }
  }, () => { if (entries.get(key) === entry) entries.delete(key); });
  return entry.read;
}

/** Drop every entry (tests). */
export function clearRouteCache(): void {
  entries.clear();
}
