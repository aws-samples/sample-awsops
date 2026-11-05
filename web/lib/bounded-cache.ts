export interface BoundedTtlCacheOptions {
  ttlMs: number;
  maxEntries: number;
  maxInFlight: number;
  now?: () => number;
}

export class BoundedTtlCache<T> {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxInFlight: number;
  private readonly now: () => number;
  private readonly values = new Map<string, { expiresAt: number; value: T }>();
  private readonly pending = new Map<string, Promise<T>>();
  private activeLoads = 0;
  private generation = 0;

  constructor(options: BoundedTtlCacheOptions) {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0
      || !Number.isSafeInteger(options.maxEntries) || options.maxEntries <= 0
      || !Number.isSafeInteger(options.maxInFlight) || options.maxInFlight <= 0) {
      throw new RangeError('Cache TTL and capacities must be finite positive values; capacities must be integers');
    }
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries;
    this.maxInFlight = options.maxInFlight;
    this.now = options.now ?? (() => Date.now());
  }

  get(key: string, loader: () => Promise<T>): Promise<T> {
    this.pruneExpired(this.now());
    const hit = this.values.get(key);
    if (hit) {
      // Promote access without changing either the TTL or the source value.
      this.values.delete(key);
      this.values.set(key, hit);
      return Promise.resolve(hit.value);
    }
    const running = this.pending.get(key);
    if (running) return running;
    if (this.activeLoads >= this.maxInFlight) {
      return Promise.reject(new Error('Cache in-flight capacity reached'));
    }

    const generation = this.generation;
    this.activeLoads += 1;
    const promise = Promise.resolve().then(loader).then((value) => {
      if (generation === this.generation) {
        const now = this.now();
        this.pruneExpired(now);
        while (this.values.size >= this.maxEntries) {
          this.values.delete(this.values.keys().next().value!);
        }
        this.values.set(key, { expiresAt: now + this.ttlMs, value });
      }
      return value;
    }).finally(() => {
      this.activeLoads -= 1;
      // A clear may have admitted a replacement load under this same key.
      if (this.pending.get(key) === promise) this.pending.delete(key);
    });
    this.pending.set(key, promise);
    return promise;
  }

  clear(): void {
    this.generation += 1;
    this.values.clear();
    this.pending.clear();
    // Old loads still occupy capacity until they finish; their values are invalid.
  }

  private pruneExpired(now: number): void {
    for (const [key, entry] of this.values) {
      if (entry.expiresAt <= now) this.values.delete(key);
    }
  }
}
