import { describe, expect, it, vi } from 'vitest';
import { BoundedTtlCache, CacheUnavailableError } from './bounded-cache';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('BoundedTtlCache', () => {
  it('retains the source observation unchanged until the TTL boundary', async () => {
    let now = 0;
    let loads = 0;
    const cache = new BoundedTtlCache<{ observedAt: string }>({
      ttlMs: 100, maxEntries: 2, maxInFlight: 2, now: () => now,
    });
    const load = async () => ({ observedAt: `source-${++loads}` });
    expect(await cache.get('window', load)).toEqual({ observedAt: 'source-1' });
    now = 99;
    expect(await cache.get('window', load)).toEqual({ observedAt: 'source-1' });
    now = 100;
    expect(await cache.get('window', load)).toEqual({ observedAt: 'source-2' });
  });

  it('starts retention when a slow load completes', async () => {
    let now = 0;
    const cache = new BoundedTtlCache<string>({
      ttlMs: 100, maxEntries: 2, maxInFlight: 2, now: () => now,
    });
    const slow = deferred<string>();
    const pending = cache.get('slow', () => slow.promise);
    now = 200;
    slow.resolve('observation');
    await pending;
    now = 299;
    expect(await cache.get('slow', async () => 'too early')).toBe('observation');
    now = 300;
    expect(await cache.get('slow', async () => 'refreshed')).toBe('refreshed');
  });

  it('prunes expired entries before they can evict a still-live value', async () => {
    let now = 0;
    const cache = new BoundedTtlCache<string>({
      ttlMs: 100, maxEntries: 2, maxInFlight: 2, now: () => now,
    });
    await cache.get('expired-first', async () => 'old');
    now = 50;
    await cache.get('still-live', async () => 'live');
    now = 75;
    await cache.get('expired-first', async () => 'unexpected');
    now = 100;
    await cache.get('new', async () => 'new');
    expect(await cache.get('still-live', async () => 'wrong eviction')).toBe('live');
  });

  it('evicts the least recently used value when retained capacity is full', async () => {
    const cache = new BoundedTtlCache<string>({ ttlMs: 1000, maxEntries: 2, maxInFlight: 2 });
    await cache.get('a', async () => 'a1');
    await cache.get('b', async () => 'b1');
    await cache.get('a', async () => 'unexpected');
    await cache.get('c', async () => 'c1');
    expect(await cache.get('a', async () => 'wrong eviction')).toBe('a1');
    expect(await cache.get('b', async () => 'b2')).toBe('b2');
  });

  it('shares a same-key pending load even when new keys are at capacity', async () => {
    const cache = new BoundedTtlCache<string>({ ttlMs: 1000, maxEntries: 2, maxInFlight: 1 });
    const load = deferred<string>();
    const first = cache.get('a', () => load.promise);
    const second = cache.get('a', async () => 'duplicate');
    await expect(cache.get('b', async () => 'over capacity')).rejects.toThrow(/in-flight capacity/);
    load.resolve('shared');
    expect(await first).toBe('shared');
    expect(await second).toBe('shared');
    expect(await cache.get('b', async () => 'admitted')).toBe('admitted');
  });

  it('retries a rejected load instead of retaining its failure', async () => {
    const cache = new BoundedTtlCache<string>({ ttlMs: 1000, maxEntries: 2, maxInFlight: 1 });
    const failure = deferred<string>();
    const first = cache.get('a', () => failure.promise);
    const duplicate = cache.get('a', async () => 'duplicate');
    const both = Promise.allSettled([first, duplicate]);
    failure.reject(new Error('source unavailable'));
    expect(await both).toEqual([
      { status: 'rejected', reason: new Error('source unavailable') },
      { status: 'rejected', reason: new Error('source unavailable') },
    ]);
    expect(await cache.get('a', async () => 'recovered')).toBe('recovered');
  });

  it('releases capacity after a synchronous loader exception', async () => {
    const cache = new BoundedTtlCache<string>({ ttlMs: 1000, maxEntries: 2, maxInFlight: 1 });
    await expect(cache.get('a', () => { throw new Error('bad source'); })).rejects.toThrow('bad source');
    expect(await cache.get('a', async () => 'recovered')).toBe('recovered');
  });

  it('clear removes retained observations', async () => {
    const cache = new BoundedTtlCache<string>({ ttlMs: 1000, maxEntries: 2, maxInFlight: 2 });
    await cache.get('a', async () => 'old');
    cache.clear();
    expect(await cache.get('a', async () => 'new')).toBe('new');
  });

  it('clear invalidates old completion without deleting a replacement pending load', async () => {
    const cache = new BoundedTtlCache<string>({ ttlMs: 1000, maxEntries: 2, maxInFlight: 2 });
    const old = deferred<string>();
    const fresh = deferred<string>();
    const oldRequest = cache.get('a', () => old.promise);
    cache.clear();
    const freshRequest = cache.get('a', () => fresh.promise);
    old.resolve('stale');
    expect(await oldRequest).toBe('stale');
    const duplicate = cache.get('a', async () => 'unexpected replacement');
    fresh.resolve('fresh');
    expect(await freshRequest).toBe('fresh');
    expect(await duplicate).toBe('fresh');
    expect(await cache.get('a', async () => 'unexpected load')).toBe('fresh');
  });

  it('an invalidated slow completion cannot overwrite a newer retained value', async () => {
    const cache = new BoundedTtlCache<string>({ ttlMs: 1000, maxEntries: 2, maxInFlight: 2 });
    const old = deferred<string>();
    const oldRequest = cache.get('a', () => old.promise);
    cache.clear();
    await cache.get('a', async () => 'fresh');
    old.resolve('stale');
    await oldRequest;
    expect(await cache.get('a', async () => 'unexpected load')).toBe('fresh');
  });

  it('clear keeps unfinished loads counted against the concurrency limit', async () => {
    const cache = new BoundedTtlCache<string>({ ttlMs: 1000, maxEntries: 2, maxInFlight: 2 });
    const old = deferred<string>();
    const fresh = deferred<string>();
    const oldRequest = cache.get('a', () => old.promise);
    cache.clear();
    const freshRequest = cache.get('a', () => fresh.promise);
    await expect(cache.get('b', async () => 'over capacity')).rejects.toThrow(/in-flight capacity/);
    old.resolve('old');
    await oldRequest;
    expect(await cache.get('b', async () => 'admitted')).toBe('admitted');
    fresh.resolve('fresh');
    await freshRequest;
  });

  it('a never-settling load hits its deadline and frees the slot for later keys', async () => {
    vi.useFakeTimers();
    try {
      const cache = new BoundedTtlCache<string>({ ttlMs: 1000, maxEntries: 2, maxInFlight: 1, loadTimeoutMs: 50 });
      const hung = cache.get('hung', () => new Promise<string>(() => {}));
      await expect(cache.get('b', async () => 'blocked')).rejects.toThrow(/in-flight capacity/);
      await expect(cache.get('b', async () => 'blocked')).rejects.toBeInstanceOf(CacheUnavailableError);
      const expectation = expect(hung).rejects.toSatisfy(
        (e: unknown) => e instanceof CacheUnavailableError && e.reason === 'deadline' && /deadline/.test(e.message));
      await vi.advanceTimersByTimeAsync(50);
      await expectation;
      expect(await cache.get('b', async () => 'admitted')).toBe('admitted');
      expect(await cache.get('hung', async () => 'retried')).toBe('retried');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { ttlMs: 0, maxEntries: 1, maxInFlight: 1 },
    { ttlMs: Infinity, maxEntries: 1, maxInFlight: 1 },
    { ttlMs: 100, maxEntries: 0, maxInFlight: 1 },
    { ttlMs: 100, maxEntries: 1.5, maxInFlight: 1 },
    { ttlMs: 100, maxEntries: 1, maxInFlight: 0 },
    { ttlMs: 100, maxEntries: 1, maxInFlight: Infinity },
    { ttlMs: 100, maxEntries: 1, maxInFlight: 1, loadTimeoutMs: 0 },
  ])('rejects nonpositive or unbounded cache options: %j', (options) => {
    expect(() => new BoundedTtlCache<string>(options)).toThrow(RangeError);
  });
});
