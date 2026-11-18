// Failure behaviour of k8s-graph-layout (the real dagre run is covered in k8s-graph-layout.test.ts).
import { describe, expect, it, vi } from 'vitest';
import type { ServiceGraph } from './k8s-service-graph';

const dagreLayout = vi.hoisted(() => ({ fail: null as Error | null }));
vi.mock('@dagrejs/dagre', async (importOriginal) => {
  const actual = (await importOriginal<{ default: typeof import('@dagrejs/dagre') }>()).default;
  const layout: typeof actual.layout = (...args) => {
    const err = dagreLayout.fail;
    dagreLayout.fail = null;
    if (err) throw err;
    return actual.layout(...args);
  };
  return { default: { ...actual, layout } };
});

import { layoutServiceGraph } from './k8s-graph-layout';

// Two services with an intra-namespace call, so the inner layout runs dagre.
const graph: ServiceGraph = {
  namespaces: [{ name: 'prod', serviceIds: ['svc:prod/api', 'svc:prod/db'], system: false }],
  nodes: [
    { id: 'svc:prod/api', kind: 'service', label: 'api', namespace: 'prod', meta: {} },
    { id: 'svc:prod/db', kind: 'service', label: 'db', namespace: 'prod', meta: {} },
  ],
  edges: [{ id: 'svc:prod/api->svc:prod/db', source: 'svc:prod/api', target: 'svc:prod/db', evidence: ['trace'] }],
  notes: [],
};

describe('layoutServiceGraph failures', () => {
  it('rejects with a stable generic error that carries no node ids or values', async () => {
    dagreLayout.fail = new Error('TypeError: node svc:prod/api has secret=abc');
    const failure = await layoutServiceGraph(graph, { collapsed: new Set(), vertical: false }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('Service graph layout failed.');
    expect(String(failure)).not.toMatch(/svc:prod|secret/);
  });

  it('lays out again on the next call after a failed one (no cached failure)', async () => {
    dagreLayout.fail = new Error('boom');
    await expect(layoutServiceGraph(graph, { collapsed: new Set(), vertical: false })).rejects.toThrow('Service graph layout failed.');
    const laid = await layoutServiceGraph(graph, { collapsed: new Set(), vertical: false });
    expect(laid.nodes.map((n) => [n.id, n.parentId])).toEqual([['svc:prod/api', 'ns:prod'], ['svc:prod/db', 'ns:prod']]);
  });
});
