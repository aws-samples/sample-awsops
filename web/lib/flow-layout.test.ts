import { describe, it, expect } from 'vitest';
import { layoutFlow } from './flow-layout';
import type { FlowGraph } from './flow-topology';

const graph: FlowGraph = {
  nodes: [
    { id: 'cf:D1', kind: 'cloudfront', label: 'D1' },
    { id: 'alb:web', kind: 'alb', label: 'web' },
    { id: 'tg:t1', kind: 'tg', label: 'tg' },
    { id: 'target:t1:10.0.0.1', kind: 'target', label: '10.0.0.1' },
  ],
  edges: [
    { id: 'e1', source: 'cf:D1', target: 'alb:web', confidence: 'observed' },
    { id: 'e2', source: 'alb:web', target: 'tg:t1', confidence: 'observed' },
    { id: 'e3', source: 'tg:t1', target: 'target:t1:10.0.0.1', confidence: 'observed' },
  ],
};

describe('layoutFlow (dagre LR)', () => {
  it('positions every node with finite x/y', () => {
    const pos = layoutFlow(graph);
    expect(pos.length).toBe(4);
    for (const p of pos) {
      expect(Number.isFinite(p.x), p.id).toBe(true);
      expect(Number.isFinite(p.y), p.id).toBe(true);
    }
  });

  it('ranks left→right: CF < ALB < TG < target on the x axis', () => {
    const x = Object.fromEntries(layoutFlow(graph).map((p) => [p.id, p.x]));
    expect(x['cf:D1']).toBeLessThan(x['alb:web']);
    expect(x['alb:web']).toBeLessThan(x['tg:t1']);
    expect(x['tg:t1']).toBeLessThan(x['target:t1:10.0.0.1']);
  });

  it('handles an empty graph without throwing', () => {
    expect(layoutFlow({ nodes: [], edges: [] })).toEqual([]);
  });
});
