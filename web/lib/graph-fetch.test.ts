import { afterEach, expect, it, vi } from 'vitest';
import { fetchGraph, GraphFetchError } from './graph-fetch';
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it.each(['busy','timeout','query_failed'] as const)('retains safe %s read evidence without error-body data', async reason => {
  vi.stubGlobal('fetch', async () => Response.json({ nodes: [{ label: 'PRIVATE' }], message: 'PRIVATE',
    collection: { status: 'error', secret: 'PRIVATE', readReason: reason } }, { status: 503 }));
  const body = await fetchGraph('/api/graph', new AbortController().signal);
  expect(body).toMatchObject({ nodes: [], edges: [], captured_at: null,
    collection: { status: 'unknown', readStatus: 'unavailable', readReason: reason } });
  expect(JSON.stringify(body)).not.toContain('PRIVATE');
});
it('preserves successful partial graph and source evidence', async () => {
  const body = { nodes: [{ id: 'one', label: 'One', kind: 'vpc' }], edges: [], captured_at: null,
    collection: { status: 'partial', stale: true, readTruncated: true } };
  vi.stubGlobal('fetch', async () => Response.json(body));
  expect(await fetchGraph('/api/graph', new AbortController().signal)).toEqual(body);
});
it('makes malformed/non-JSON and network failures unavailable, not empty collection', async () => {
  for (const response of [Response.json({}), new Response('PRIVATE', { status: 500 })]) {
    vi.stubGlobal('fetch', async () => response);
    expect((await fetchGraph('/api/graph', new AbortController().signal)).collection?.status).toBe('unknown');
  }
  vi.stubGlobal('fetch', async () => { throw new Error('PRIVATE'); });
  expect((await fetchGraph('/api/graph', new AbortController().signal)).collection?.readStatus).toBe('unavailable');
});
it('propagates cancellation so an obsolete request cannot become a visible failure', async () => {
  const controller = new AbortController(), error = new Error('aborted'); controller.abort(error);
  const fetch = vi.fn(async () => { throw error; }); vi.stubGlobal('fetch', fetch);
  await expect(fetchGraph('/api/graph', controller.signal)).rejects.toBe(error);
  expect(fetch).not.toHaveBeenCalled();
});

it.each([[401,'unauthenticated'],[403,'forbidden'],[400,'rejected'],[404,'rejected']] as const)('keeps HTTP%s distinct from a read outage', async (status, reason) => {
  vi.stubGlobal('fetch', async () => new Response('PRIVATE', { status }));
  await expect(fetchGraph('/api/graph', new AbortController().signal)).rejects.toMatchObject({ reason });
});
it('recognizes a followed login redirect without parsing or exposing its HTML', async () => {
  const response = new Response('PRIVATE login HTML');
  Object.defineProperties(response, { redirected: { value: true }, url: { value: 'https://fixture.invalid/login?returnTo=graph' } });
  vi.stubGlobal('fetch', async () => response);
  await expect(fetchGraph('/api/graph', new AbortController().signal)).rejects.toBeInstanceOf(GraphFetchError);
});


const busyResponse = (retryAfter = '1'): Response => ({
  status: 503, ok: false, headers: new Headers({ 'Retry-After': retryAfter }),
  json: async () => ({ collection: { readStatus: 'unavailable', readReason: 'busy' } }),
  clone() { return this; },
} as Response);
function virtualTime() {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2026-09-15T00:00:00Z'));
  vi.spyOn(Math, 'random').mockReturnValue(0);
}
it('bounds persistent typed busy recovery to five requests without certifying empty data', async () => {
  virtualTime();
  const fetch = vi.fn(async () => busyResponse()); vi.stubGlobal('fetch', fetch);
  const pending = fetchGraph('/api/graph', new AbortController().signal);
  await vi.runAllTimersAsync();
  const result = await pending;
  expect(result.collection).toMatchObject({ status: 'unknown', readStatus: 'unavailable', readReason: 'busy' });
  expect(fetch).toHaveBeenCalledTimes(5);
  expect(vi.getTimerCount()).toBe(0);
});
it('cancels a pending busy retry when its scope is abandoned', async () => {
  virtualTime();
  const controller = new AbortController(), fetch = vi.fn(async () => busyResponse()); vi.stubGlobal('fetch', fetch);
  const result = fetchGraph('/api/graph', controller.signal);
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(50);
  controller.abort();
  await rejected;
  await vi.advanceTimersByTimeAsync(10000);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it('bounds a stuck request by the ten-second recovery deadline', async () => {
  virtualTime();
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
  })));
  const pending = fetchGraph('/api/graph', new AbortController().signal);
  await vi.advanceTimersByTimeAsync(10000);
  const result = await pending;
  expect(result.collection).toMatchObject({ status: 'unknown', readStatus: 'unavailable', readReason: 'timeout' });
  expect(vi.getTimerCount()).toBe(0);
});
it('recovers from typed busy and returns the actual subsequent graph', async () => {
  virtualTime();
  const graph = { nodes: [{ id: 'one', kind: 'vpc', label: 'One' }], edges: [], captured_at: null };
  const fetch = vi.fn().mockResolvedValueOnce(busyResponse()).mockResolvedValueOnce(Response.json(graph)); vi.stubGlobal('fetch', fetch);
  const pending = fetchGraph('/api/graph', new AbortController().signal);
  await vi.runAllTimersAsync();
  expect(await pending).toEqual(graph);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('preserves confirmed busy evidence when slow round trips exhaust recovery room', async () => {
  virtualTime();
  const start = Date.now();
  const fetch = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 1800)); return busyResponse(); });
  vi.stubGlobal('fetch', fetch);
  let finished = 0;
  const pending = fetchGraph('/api/graph', new AbortController().signal).then(result => { finished = Date.now(); return result; });
  await vi.runAllTimersAsync();
  expect((await pending).collection?.readReason).toBe('busy');
  expect(fetch.mock.calls.length).toBeLessThan(5);
  expect(finished - start).toBeLessThanOrEqual(10000);
});

it('keeps the last confirmed busy cause when the following request stalls', async () => {
  virtualTime();
  const fetch = vi.fn().mockResolvedValueOnce(busyResponse()).mockImplementation(
    (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
  vi.stubGlobal('fetch', fetch);
  const pending = fetchGraph('/api/graph', new AbortController().signal);
  await vi.runAllTimersAsync();
  expect((await pending).collection).toMatchObject({ status: 'unknown', readReason: 'busy' });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each(['seconds', 'date'])('honors Retry-After %s and bounded jitter before retrying', async kind => {
  virtualTime();
  vi.mocked(Math.random).mockReturnValue(.5);
  const header = kind === 'seconds' ? '2' : new Date(Date.now() + 2000).toUTCString();
  const graph = { nodes: [], edges: [], captured_at: null };
  const fetch = vi.fn().mockResolvedValueOnce(busyResponse(header)).mockResolvedValueOnce(Response.json(graph));
  vi.stubGlobal('fetch', fetch);
  const pending = fetchGraph('/api/graph', new AbortController().signal);
  await vi.advanceTimersByTimeAsync(1999);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(125);
  expect(await pending).toEqual(graph);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('does not shorten a server delay that cannot fit the recovery budget', async () => {
  virtualTime();
  const fetch = vi.fn(async () => busyResponse('60')); vi.stubGlobal('fetch', fetch);
  const pending = fetchGraph('/api/graph', new AbortController().signal);
  await vi.runAllTimersAsync();
  expect((await pending).collection?.readReason).toBe('busy');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('consumes an error body once without cloning or exposing it', async () => {
  const response = Response.json({ message: 'PRIVATE' }, { status: 503 });
  const clone = vi.spyOn(response, 'clone'), json = vi.spyOn(response, 'json');
  vi.stubGlobal('fetch', async () => response);
  expect((await fetchGraph('/api/graph', new AbortController().signal)).collection?.readReason).toBe('query_failed');
  expect(json).toHaveBeenCalledTimes(1);
  expect(clone).not.toHaveBeenCalled();
  expect(response.bodyUsed).toBe(true);
});
