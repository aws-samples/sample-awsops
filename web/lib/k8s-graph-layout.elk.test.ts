// ELK loading/failure behaviour of k8s-graph-layout (the real elk run is covered in k8s-graph-layout.test.ts).
import { describe, expect, it, vi } from 'vitest';
import type { ELK } from 'elkjs/lib/elk-api';
import type { ServiceGraph } from './k8s-service-graph';

const elk = vi.hoisted(() => ({ layout: vi.fn() }));
vi.mock('elkjs/lib/elk.bundled.js', () => ({ default: class { layout = (...a: unknown[]) => elk.layout(...a); } }));

import { createElkLoader, layoutServiceGraph } from './k8s-graph-layout';

const fakeElk = { layout: vi.fn() } as unknown as ELK;
const module = { default: function FakeElk() { return fakeElk; } as unknown as new () => ELK };

describe('createElkLoader', () => {
  it('retries the import after a rejected import instead of caching the failure', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('ChunkLoadError: Loading chunk 123 failed (https://x/_next/static/chunks/svc:prod/api.js)'))
      .mockResolvedValueOnce(module);
    const getElk = createElkLoader(load);
    const failure = await getElk().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('Service graph layout engine could not be loaded.');
    expect((failure as Error).message).not.toMatch(/svc:|chunk 123/);
    await expect(getElk()).resolves.toBe(fakeElk);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shares one import between concurrent callers and caches a successful one', async () => {
    const load = vi.fn().mockResolvedValue(module);
    const getElk = createElkLoader(load);
    const [a, b] = await Promise.all([getElk(), getElk()]);
    expect(a).toBe(b);
    await getElk();
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('layoutServiceGraph ELK failures', () => {
  const graph: ServiceGraph = {
    namespaces: [{ name: 'prod', serviceIds: ['svc:prod/api'], system: false }],
    nodes: [{ id: 'svc:prod/api', kind: 'service', label: 'api', namespace: 'prod', meta: {} }],
    edges: [], notes: [],
  };

  it('wraps an ELK layout rejection in a stable generic error without node ids or values', async () => {
    elk.layout.mockRejectedValueOnce(new Error('UnsupportedConfigurationException: node svc:prod/api has secret=abc'));
    const failure = await layoutServiceGraph(graph, { collapsed: new Set(), vertical: false }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('Service graph layout failed.');
    expect(String(failure)).not.toMatch(/svc:prod|secret/);
  });

  it('lays out again on the next call after a failed one', async () => {
    elk.layout.mockRejectedValueOnce(new Error('boom'));
    await expect(layoutServiceGraph(graph, { collapsed: new Set(), vertical: false })).rejects.toThrow('Service graph layout failed.');
    elk.layout.mockResolvedValueOnce({ id: '__root__', children: [{ id: 'ns:prod', x: 0, y: 0, width: 10, height: 10, children: [{ id: 'svc:prod/api', x: 1, y: 2, width: 3, height: 4 }] }], edges: [] });
    const laid = await layoutServiceGraph(graph, { collapsed: new Set(), vertical: false });
    expect(laid.nodes).toEqual([{ id: 'svc:prod/api', x: 1, y: 2, width: 3, height: 4, parentId: 'ns:prod' }]);
  });
});
