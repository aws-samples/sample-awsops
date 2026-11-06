export interface BoundedTtlCacheOptions {
  ttlMs: number;
  maxEntries: number;
  maxInFlight: number;
  /** Per-load deadline; a hung loader is rejected and frees its in-flight slot. */
  loadTimeoutMs?: number;
  now?: () => number;
}

/** Transient cache saturation or a load deadline: callers report it as retryable, never as absence. */
export class CacheUnavailableError extends Error {
  constructor(readonly reason: 'capacity' | 'deadline') {
    super(reason === 'capacity' ? 'Cache in-flight capacity reached' : 'Cache load deadline exceeded');
    this.name = 'CacheUnavailableError';
  }
}

export class BoundedTtlCache<T> {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxInFlight: number;
  private readonly loadTimeoutMs: number;
  private readonly now: () => number;
  private readonly values = new Map<string, { expiresAt: number; value: T }>();
  private readonly pending = new Map<string, Promise<T>>();
  private activeLoads = 0;
  private generation = 0;

  constructor(options: BoundedTtlCacheOptions) {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0
      || !Number.isSafeInteger(options.maxEntries) || options.maxEntries <= 0
      || !Number.isSafeInteger(options.maxInFlight) || options.maxInFlight <= 0
      || !Number.isFinite(options.loadTimeoutMs ?? 60_000) || (options.loadTimeoutMs ?? 60_000) <= 0) {
      throw new RangeError('Cache TTL and capacities must be finite positive values; capacities must be integers');
    }
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries;
    this.maxInFlight = options.maxInFlight;
    this.loadTimeoutMs = options.loadTimeoutMs ?? 60_000;
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
      return Promise.reject(new CacheUnavailableError('capacity'));
    }

    const generation = this.generation;
    this.activeLoads += 1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CacheUnavailableError('deadline')), this.loadTimeoutMs);
    });
    const promise = Promise.race([Promise.resolve().then(loader), deadline]).then((value) => {
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
      clearTimeout(timer);
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
