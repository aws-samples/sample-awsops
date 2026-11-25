import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ROUTE_CACHE_TTL_MS, ROUTE_SOURCE_DEADLINE_MS, cachedRouteRead, clearRouteCache, createRouteCache, routeCacheKey,
} from './site-routes-cache';
import type { RouteRead } from './trace-routes';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const ok = (service = 'frontend'): RouteRead =>
  ({ status: 'ok', reasons: [], routes: [{ service, route: '/api/orders/{id}', calls: 3, next: [] }] });
const partial: RouteRead = { status: 'partial', reasons: ['capped'], routes: [] };
const unavailable: RouteRead = { status: 'unavailable', reasons: ['query_failed'], routes: [] };
const KEY = routeCacheKey(7, 'SELECT 1', 60);

afterEach(() => {
  clearRouteCache();
  vi.useRealTimers();
});

describe('routeCacheKey', () => {
  it('separates source instance, registry template and window', () => {
    const keys = [
      routeCacheKey(7, 'SELECT 1', 60), routeCacheKey(8, 'SELECT 1', 60), routeCacheKey(7, 'SELECT 2', 60),
      routeCacheKey(7, 'SELECT 1', 15), routeCacheKey(7, undefined, 60), routeCacheKey(undefined, 'SELECT 1', 60),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(routeCacheKey(7, 'SELECT 1', 60)).toBe(KEY);
  });
});

describe('createRouteCache', () => {
  it('serves an ok or partial read again within the TTL and reads again once it expires', async () => {
    let now = 0;
    const cache = createRouteCache({ now: () => now });
    const load = vi.fn(async () => ok());
    expect(await cache.read(KEY, load)).toEqual(ok());
    now = ROUTE_CACHE_TTL_MS - 1;
    expect(await cache.read(KEY, load)).toEqual(ok());
    expect(load).toHaveBeenCalledTimes(1);
    now = ROUTE_CACHE_TTL_MS;
    await cache.read(KEY, load);
    expect(load).toHaveBeenCalledTimes(2);

    const partialLoad = vi.fn(async () => partial);
    const other = routeCacheKey(8, 'SELECT 1', 60);
    expect(await cache.read(other, partialLoad)).toEqual(partial);
    expect(await cache.read(other, partialLoad)).toEqual(partial);
    expect(partialLoad).toHaveBeenCalledTimes(1);
  });

  it('keeps keys isolated: another source, template or window is another read', async () => {
    const cache = createRouteCache();
    const load = vi.fn(async () => ok());
    for (const key of [KEY, routeCacheKey(8, 'SELECT 1', 60), routeCacheKey(7, 'SELECT 2', 60), routeCacheKey(7, 'SELECT 1', 15)]) {
      await cache.read(key, load);
    }
    expect(load).toHaveBeenCalledTimes(4);
    await cache.read(KEY, load);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('single-flight: concurrent callers for one key share one read, including an uncached result', async () => {
    const cache = createRouteCache();
    const gate = deferred<RouteRead>();
    const load = vi.fn(() => gate.promise);
    const reads = [cache.read(KEY, load), cache.read(KEY, load), cache.read(KEY, load)];
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    gate.resolve(unavailable);
    expect(await Promise.all(reads)).toEqual([unavailable, unavailable, unavailable]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('never keeps an unavailable result or a rejection: the next caller reads again', async () => {
    const cache = createRouteCache();
    const load = vi.fn<(signal: AbortSignal) => Promise<RouteRead>>()
      .mockResolvedValueOnce(unavailable)
      .mockRejectedValueOnce(new Error('upstream'))
      .mockResolvedValueOnce(ok());
    expect(await cache.read(KEY, load)).toEqual(unavailable);
    await expect(cache.read(KEY, load)).rejects.toThrow('upstream');
    expect(await cache.read(KEY, load)).toEqual(ok());
    expect(await cache.read(KEY, load)).toEqual(ok());
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('rejects a load past the per-source deadline as unavailable deadline and aborts its signal', async () => {
    vi.useFakeTimers();
    const cache = createRouteCache();
    let signal!: AbortSignal;
    const load = vi.fn((s: AbortSignal) => { signal = s; return new Promise<RouteRead>(() => {}); });
    const pending = cache.read(KEY, load);
    await vi.advanceTimersByTimeAsync(ROUTE_SOURCE_DEADLINE_MS);
    expect(await pending).toEqual({ status: 'unavailable', reasons: ['deadline'], routes: [] });
    expect(signal.aborted).toBe(true);
  });

  it('caps loads in flight: a caller past the cap gets unavailable query_failed and starts no read', async () => {
    const cache = createRouteCache({ maxInFlight: 2 });
    const gates = [deferred<RouteRead>(), deferred<RouteRead>()];
    const a = cache.read(routeCacheKey(1, 'SELECT 1', 60), () => gates[0].promise);
    const b = cache.read(routeCacheKey(2, 'SELECT 1', 60), () => gates[1].promise);
    const third = vi.fn(async () => ok());
    expect(await cache.read(routeCacheKey(3, 'SELECT 1', 60), third))
      .toEqual({ status: 'unavailable', reasons: ['query_failed'], routes: [] });
    expect(third).not.toHaveBeenCalled();
    // A caller of a key already in flight still joins it.
    const joined = cache.read(routeCacheKey(1, 'SELECT 1', 60), third);
    gates[0].resolve(ok('a'));
    gates[1].resolve(ok('b'));
    expect(await Promise.all([a, b, joined])).toEqual([ok('a'), ok('b'), ok('a')]);
    // Slots free once the loads settle.
    expect(await cache.read(routeCacheKey(3, 'SELECT 1', 60), third)).toEqual(ok());
    expect(third).toHaveBeenCalledTimes(1);
  });

  it('bounds retained entries, evicting the least recently used', async () => {
    const cache = createRouteCache({ maxEntries: 2 });
    const load = vi.fn(async () => ok());
    const [k1, k2, k3] = [1, 2, 3].map((id) => routeCacheKey(id, 'SELECT 1', 60));
    await cache.read(k1, load);
    await cache.read(k2, load);
    await cache.read(k1, load); // k1 is now the most recently used
    await cache.read(k3, load); // evicts k2
    expect(load).toHaveBeenCalledTimes(3);
    await cache.read(k1, load);
    await cache.read(k3, load);
    expect(load).toHaveBeenCalledTimes(3);
    await cache.read(k2, load);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('clear drops retained reads', async () => {
    const cache = createRouteCache();
    const load = vi.fn(async () => ok());
    await cache.read(KEY, load);
    cache.clear();
    await cache.read(KEY, load);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('cachedRouteRead (module instance)', () => {
  it('reuses a read per key and is reset by clearRouteCache', async () => {
    const load = vi.fn(async (_signal: AbortSignal) => ok());
    await cachedRouteRead(KEY, load);
    await cachedRouteRead(KEY, load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
    clearRouteCache();
    await cachedRouteRead(KEY, load);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
