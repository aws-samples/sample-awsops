// Offline synthetic measurement using the production cache and only Node built-ins.
// Run with the project's Node version: node scripts/v2/benchmark-observation-cache.mjs
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';
import { BoundedTtlCache } from '../../web/lib/bounded-cache.ts';

const REQUESTS = 2000;
const UNIQUE_KEYS = 32;
const WINDOW = Object.freeze({
  startTime: '2026-11-05T11:00:00.000Z',
  endTime: '2026-11-05T12:00:00.000Z',
  observedAt: '2026-11-05T12:00:00.000Z',
});

async function measure(name, useCache, concurrent = false) {
  const cache = new BoundedTtlCache({ ttlMs: 4 * 60_000, maxEntries: 128, maxInFlight: 32 });
  let loaderCalls = 0;
  const load = async (key) => {
    loaderCalls += 1;
    await setImmediate();
    return Object.freeze({ key, ...WINDOW });
  };
  const read = (key) => useCache ? cache.get(key, () => load(key)) : load(key);
  const started = performance.now();
  let last;
  if (concurrent) {
    const results = await Promise.all(Array.from({ length: REQUESTS }, () => read('same-scope')));
    last = results.at(-1);
  } else {
    for (let i = 0; i < REQUESTS; i += 1) last = await read(`synthetic-scope-${i % UNIQUE_KEYS}`);
  }
  const elapsedMs = performance.now() - started;
  assert.equal(last.observedAt, '2026-11-05T12:00:00.000Z');
  assert.equal(loaderCalls, concurrent ? 1 : useCache ? 32 : 2000);
  return { name, requests: REQUESTS, loaderCalls, elapsedMs: Number(elapsedMs.toFixed(3)) };
}

console.log(JSON.stringify({
  kind: 'synthetic offline cache benchmark',
  limitation: 'Local fake-loader timings only; no AWS or network calls, production latency or shared-cache savings claims.',
  cache: { ttlMs: 240000, maxEntries: 128, maxInFlight: 32 },
  scenarios: [
    await measure('uncached repeated reads', false),
    await measure('cached repeated reads including initial misses', true),
    await measure('concurrent same-key deduplication', true, true),
  ],
}, null, 2));
