import { afterEach, expect, it, vi } from 'vitest';
import { fetchGraph, GraphFetchError } from './graph-fetch';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
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


const busyResponse = () => Response.json({ collection: { readStatus: 'unavailable', readReason: 'busy' } }, { status: 503 });
it('bounds persistent typed busy recovery to five requests without certifying empty data', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async () => busyResponse()); vi.stubGlobal('fetch', fetch);
  const pending = fetchGraph('/api/graph', new AbortController().signal);
  await vi.runAllTimersAsync();
  const result = await pending;
  expect(result.collection).toMatchObject({ status: 'unknown', readStatus: 'unavailable', readReason: 'busy' });
  expect(fetch).toHaveBeenCalledTimes(5);
});
it('cancels a pending busy retry when its scope is abandoned', async () => {
  vi.useFakeTimers();
  const controller = new AbortController(), fetch = vi.fn(async () => busyResponse()); vi.stubGlobal('fetch', fetch);
  const result = fetchGraph('/api/graph', controller.signal);
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  setTimeout(() => controller.abort(), 50);
  await vi.runAllTimersAsync();
  await rejected;
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('bounds a stuck request by the ten-second recovery deadline', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
  })));
  const pending = fetchGraph('/api/graph', new AbortController().signal);
  await vi.advanceTimersByTimeAsync(10000);
  const result = await pending;
  expect(result.collection).toMatchObject({ status: 'unknown', readStatus: 'unavailable', readReason: 'timeout' });
});
it('recovers from typed busy and returns the actual subsequent graph', async () => {
  const graph = { nodes: [{ id: 'one', kind: 'vpc', label: 'One' }], edges: [], captured_at: null };
  const fetch = vi.fn().mockResolvedValueOnce(busyResponse()).mockResolvedValueOnce(Response.json(graph)); vi.stubGlobal('fetch', fetch);
  expect(await fetchGraph('/api/graph', new AbortController().signal)).toEqual(graph);
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('keeps observed busy evidence when slow busy reads exhaust the overall deadline', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(init.signal!.reason); };
    const timer = setTimeout(() => { init.signal!.removeEventListener('abort', abort); resolve(busyResponse()); }, 1800);
    init.signal!.addEventListener('abort', abort, { once: true });
  }));
  vi.stubGlobal('fetch', fetch);
  const pending = fetchGraph('/api/graph', new AbortController().signal);
  await vi.advanceTimersByTimeAsync(10000);
  expect((await pending).collection).toMatchObject({ readStatus: 'unavailable', readReason: 'busy' });
  expect(fetch.mock.calls.length).toBeGreaterThan(1);
  expect(fetch.mock.calls.length).toBeLessThanOrEqual(5);
});
it('honors the server numeric retry delay without exceeding the recovery budget', async () => {
  vi.useFakeTimers();
  const graph = { nodes: [], edges: [], captured_at: null };
  const fetch = vi.fn().mockResolvedValueOnce(Response.json(
    { collection: { readStatus: 'unavailable', readReason: 'busy' } },
    { status: 503, headers: { 'Retry-After': '1' } })).mockResolvedValueOnce(Response.json(graph));
  vi.stubGlobal('fetch', fetch);
  const pending = fetchGraph('/api/graph', new AbortController().signal);
  await vi.advanceTimersByTimeAsync(999);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toEqual(graph);
  expect(fetch).toHaveBeenCalledTimes(2);
});
