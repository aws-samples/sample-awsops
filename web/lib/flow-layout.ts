// Dagre layered auto-layout for the request-flow graph. Produces a clean left→right
// ranked arrangement (CF → ALB/NLB → TG → target) so the whole graph appears at once,
// Datadog-style, rather than crude manual column placement. Pure / testable.
import dagre from '@dagrejs/dagre';
import type { FlowGraph } from './flow-topology';

export interface Positioned { id: string; x: number; y: number }

const NODE_W = 220;
const NODE_H = 44;

/** Lay the graph out left→right (rankdir LR). Returns React-Flow top-left positions. */
export function layoutFlow(graph: FlowGraph, opts?: { rankdir?: 'LR' | 'TB' }): Positioned[] {
  if (graph.nodes.length === 0) return [];
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: opts?.rankdir ?? 'LR', ranksep: 90, nodesep: 24, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of graph.nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  const present = new Set(graph.nodes.map((n) => n.id));
  for (const e of graph.edges) if (present.has(e.source) && present.has(e.target)) g.setEdge(e.source, e.target);

  dagre.layout(g);

  // dagre returns node centers; React Flow positions are top-left.
  return graph.nodes.map((n) => {
    const p = g.node(n.id);
    return { id: n.id, x: (p?.x ?? 0) - NODE_W / 2, y: (p?.y ?? 0) - NODE_H / 2 };
  });
}
