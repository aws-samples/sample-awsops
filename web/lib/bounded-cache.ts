export interface BoundedTtlCacheOptions {
  ttlMs: number;
  maxEntries: number;
  maxInFlight: number;
  /**
   * Per-load deadline: the caller is rejected and the loader's AbortSignal fires. The in-flight
   * slot stays held until the loader itself settles, so maxInFlight bounds real outstanding work.
   */
  loadTimeoutMs?: number;
  now?: () => number;
}

const TRANSIENT_NAMES = new Set([
  'CacheUnavailableError', 'TimeoutError', 'RequestTimeout', 'RequestTimeoutException',
  'ThrottlingException', 'Throttling', 'TooManyRequestsException', 'RequestLimitExceeded',
  'ServiceUnavailable', 'ServiceUnavailableException', 'InternalServerException', 'InternalFailure',
]);

/**
 * Cache saturation/deadline, SDK timeout, throttling or a service 5xx: retry later, never treat
 * the read as proof of absence. Permanent errors (AccessDenied, validation) return false.
 */
export function isTransientRead(error: unknown): boolean {
  if (error instanceof CacheUnavailableError) return true;
  if (!error || typeof error !== 'object') return false;
  const e = error as { name?: unknown; $retryable?: { throttling?: unknown }; $metadata?: { httpStatusCode?: unknown } };
  if (typeof e.name === 'string' && TRANSIENT_NAMES.has(e.name)) return true;
  if (e.$retryable && typeof e.$retryable === 'object' && e.$retryable.throttling === true) return true;
  const status = e.$metadata?.httpStatusCode;
  return typeof status === 'number' && (status === 429 || status >= 500);
}

/** setTimeout that rejects with the signal's reason once the cache deadline aborts the loader. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const onAbort = () => { clearTimeout(timer); reject(signal!.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class CacheUnavailableError extends Error {
  // Explicit field (no parameter property): Node's strip-only TypeScript can import this file.
  readonly reason: 'capacity' | 'deadline';
  constructor(reason: 'capacity' | 'deadline') {
    super(reason === 'capacity' ? 'Cache in-flight capacity reached' : 'Cache load deadline exceeded');
    this.reason = reason;
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

  get(key: string, loader: (signal: AbortSignal) => Promise<T>): Promise<T> {
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
    const controller = new AbortController();
    this.activeLoads += 1;
    const work = Promise.resolve().then(() => loader(controller.signal));
    // Release the slot only when the loader settles (not at the caller deadline), so a slow
    // source cannot accumulate unbounded background work behind rejected callers.
    work.then(() => undefined, () => undefined).then(() => { this.activeLoads -= 1; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new CacheUnavailableError('deadline');
        controller.abort(error);
        reject(error);
      }, this.loadTimeoutMs);
    });
    const promise = Promise.race([work, deadline]).then((value) => {
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
