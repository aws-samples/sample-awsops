// In-process reuse of per-source trace route reads for GET /api/topology/site-routes (server-only).
// Each site-flow load with a path reads every ClickHouse trace source; route aggregates are path-independent, so one
// read per (source instance, registry template, window) per TTL serves every caller. Built on BoundedTtlCache
// (web/lib/CLAUDE.md): single-flight per key, at most ROUTE_MAX_ENTRIES retained reads (least recently used evicted),
// at most ROUTE_MAX_IN_FLIGHT loads outstanding, and each load aborted (its AbortSignal fires) after
// ROUTE_SOURCE_DEADLINE_MS. Only `ok`/`partial` results are kept: an `unavailable` result is handed to every caller
// of that load but never retained, and a rejection is never retained, so the next caller reads again. Callers must
// not mutate the shared RouteRead (the route's merge builds new objects).
import { BoundedTtlCache, CacheUnavailableError } from '@/lib/bounded-cache';
import type { RouteRead } from '@/lib/trace-routes';

export const ROUTE_CACHE_TTL_MS = 60_000;
/** Per-source read deadline: the cache load timeout and the route's per-source cap. */
export const ROUTE_SOURCE_DEADLINE_MS = 8_000;
/** Keys are bounded by the registry (sources × 3 windows); the cap only guards against a churning registry. */
const ROUTE_MAX_ENTRIES = 64;
/** Two requests' worth of the route's 4 lanes over distinct keys. */
const ROUTE_MAX_IN_FLIGHT = 8;

export type RouteLoader = (signal: AbortSignal) => Promise<RouteRead>;
export interface RouteCache {
  read(key: string, load: RouteLoader): Promise<RouteRead>;
  clear(): void;
}

const DEADLINE: RouteRead = { status: 'unavailable', reasons: ['deadline'], routes: [] };
// Past the in-flight cap no read is started; reported as the read failing (fail-closed, never cached).
const CAPACITY: RouteRead = { status: 'unavailable', reasons: ['query_failed'], routes: [] };

/** Carries a settled read that must not be retained: BoundedTtlCache keeps every fulfilled value and no rejection. */
class Uncached extends Error {
  readonly read: RouteRead;
  constructor(read: RouteRead) {
    super('route read not retained');
    this.read = read;
  }
}

export function createRouteCache(options: {
  ttlMs?: number; maxEntries?: number; maxInFlight?: number; loadTimeoutMs?: number; now?: () => number;
} = {}): RouteCache {
  const cache = new BoundedTtlCache<RouteRead>({
    ttlMs: options.ttlMs ?? ROUTE_CACHE_TTL_MS,
    maxEntries: options.maxEntries ?? ROUTE_MAX_ENTRIES,
    maxInFlight: options.maxInFlight ?? ROUTE_MAX_IN_FLIGHT,
    loadTimeoutMs: options.loadTimeoutMs ?? ROUTE_SOURCE_DEADLINE_MS,
    ...(options.now ? { now: options.now } : {}),
  });
  return {
    read: (key, load) => cache.get(key, async (signal) => {
      const read = await load(signal);
      if (read.status === 'ok' || read.status === 'partial') return read;
      throw new Uncached(read);
    }).catch((e: unknown) => {
      if (e instanceof Uncached) return e.read;
      if (e instanceof CacheUnavailableError) return e.reason === 'deadline' ? DEADLINE : CAPACITY;
      throw e;
    }),
    clear: () => cache.clear(),
  };
}

const shared = createRouteCache();

export function routeCacheKey(instanceId: number | undefined, template: string | undefined, windowMins: number): string {
  return JSON.stringify([instanceId ?? null, template ?? null, windowMins]);
}

/** The cached or in-flight read for `key`, else `load(signal)` (started once, shared by concurrent callers). */
export function cachedRouteRead(key: string, load: RouteLoader): Promise<RouteRead> {
  return shared.read(key, load);
}

/** Drop every retained read (tests). Loads still in flight keep their in-flight slots until they settle. */
export function clearRouteCache(): void {
  shared.clear();
}
