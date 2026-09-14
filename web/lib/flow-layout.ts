// Dagre layered auto-layout for the request-flow graph. Produces a clean left→right
// ranked arrangement (CF → ALB/NLB → TG → target) so the whole graph appears at once,
// Datadog-style, rather than crude manual column placement. Pure / testable.
import dagre from '@dagrejs/dagre';
import type { FlowGraph } from './flow-topology';

export interface Positioned { id: string; x: number; y: number }

export const NODE_W = 220;
export const NODE_H = 44;

/**
 * Lay the graph out left→right (rankdir LR). Returns React-Flow top-left positions.
 *
 * `opts.nodeSize` lets a caller override the per-node width/height dagre reserves — it MUST match
 * whatever width/height the caller actually renders that node at (e.g. PolicyGraph.tsx), or dagre's
 * spacing decisions are made against dimensions the DOM doesn't use, which is exactly how long
 * labels end up overflowing into — or overlapping — a neighboring node. When omitted, every node
 * uses the module default (NODE_W x NODE_H), same as before this option existed.
 */
export function layoutFlow(
  graph: FlowGraph,
  opts?: { rankdir?: 'LR' | 'TB'; nodeSize?: (id: string) => { width: number; height: number } },
): Positioned[] {
  if (graph.nodes.length === 0) return [];
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: opts?.rankdir ?? 'LR', ranksep: 90, nodesep: 24, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of graph.nodes) {
    const size = opts?.nodeSize?.(n.id) ?? { width: NODE_W, height: NODE_H };
    g.setNode(n.id, size);
  }
  const present = new Set(graph.nodes.map((n) => n.id));
  for (const e of graph.edges) if (present.has(e.source) && present.has(e.target)) g.setEdge(e.source, e.target);

  dagre.layout(g);

  // dagre returns node centers; React Flow positions are top-left. Must offset by the SAME
  // width/height passed to setNode above for this node, not the module default, or a custom-sized
  // node's top-left corner is computed against the wrong half-extent.
  return graph.nodes.map((n) => {
    const p = g.node(n.id);
    const size = opts?.nodeSize?.(n.id) ?? { width: NODE_W, height: NODE_H };
    return { id: n.id, x: (p?.x ?? 0) - size.width / 2, y: (p?.y ?? 0) - size.height / 2 };
  });
}
