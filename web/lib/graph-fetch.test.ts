import { afterEach, expect, it, vi } from 'vitest';
import { fetchGraph } from './graph-fetch';
afterEach(() => vi.unstubAllGlobals());
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
  const controller = new AbortController(), error = new Error('aborted'); controller.abort();
  const fetch = vi.fn(async () => { throw error; }); vi.stubGlobal('fetch', fetch);
  await expect(fetchGraph('/api/graph', controller.signal)).rejects.toBe(error);
  expect(fetch).toHaveBeenCalledWith('/api/graph', { signal: controller.signal });
});
