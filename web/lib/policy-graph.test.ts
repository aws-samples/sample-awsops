import { describe, it, expect } from 'vitest';
import { boundGraph, policyNodeId, policyEdgeId, type PolicyGraphNode, type PolicyGraphEdge } from './policy-graph';

function pad(n: number): string {
  return String(n).padStart(3, '0');
}

/** nodeCount nodes (ids node-000..node-{nodeCount-1}); edgeCount edges chained/wrapped only among
 * the FIRST `edgeUniverse` nodes so truncating to fewer nodes never orphans an edge in these tests. */
function makeGraph(nodeCount: number, edgeCount: number, edgeUniverse = nodeCount): {
  version: 1; capturedAt: string; nodes: PolicyGraphNode[]; edges: PolicyGraphEdge[];
} {
  const nodes: PolicyGraphNode[] = Array.from({ length: nodeCount }, (_, i) => ({
    id: policyNodeId('node', pad(i)),
    kind: 'node',
    label: `node ${i}`,
    status: 'allowed',
  }));
  const edges: PolicyGraphEdge[] = Array.from({ length: edgeCount }, (_, i) => {
    const source = policyNodeId('node', pad(i % edgeUniverse));
    const target = policyNodeId('node', pad((i + 1) % edgeUniverse));
    return { id: policyEdgeId(source, target, String(i)), source, target, relation: 'related', status: 'allowed' as const };
  });
  return { version: 1, capturedAt: '2026-08-19T00:00:00Z', nodes, edges };
}

describe('boundGraph', () => {
  it('passes an under-cap graph through unchanged', () => {
    const graph = makeGraph(3, 2);
    const bounded = boundGraph(graph, { nodes: 250, edges: 400 });
    expect(bounded.nodes).toHaveLength(3);
    expect(bounded.edges).toHaveLength(2);
    expect(bounded.truncated).toBe(false);
    expect(bounded.pathTruncated).toBe(false);
    expect(bounded.omitted).toEqual({ nodes: 0, edges: 0 });
  });

  it('caps persisted graphs and records omitted counts (decorative-only, not path-truncated)', () => {
    // 410 edges all reference only the first 250 nodes, so the node cap never orphans an edge —
    // the edge count below is driven purely by the edge cap, isolating the two limits.
    const graph = makeGraph(260, 410, 250);
    const bounded = boundGraph(graph, { nodes: 250, edges: 400 });
    expect(bounded.nodes).toHaveLength(250);
    expect(bounded.edges).toHaveLength(400);
    expect(bounded.truncated).toBe(true);
    expect(bounded.pathTruncated).toBe(false);
    expect(bounded.omitted).toEqual({ nodes: 10, edges: 10 });
  });

  it('drops and counts edges left dangling by the node cap, even under the edge cap', () => {
    // edgeUniverse === nodeCount here: every node index appears as a source/target, so cutting
    // node-005..node-009 orphans every edge touching them.
    const graph = makeGraph(10, 10);
    const bounded = boundGraph(graph, { nodes: 5, edges: 400 });
    expect(bounded.nodes).toHaveLength(5);
    for (const e of bounded.edges) {
      expect(bounded.nodes.some((n) => n.id === e.source)).toBe(true);
      expect(bounded.nodes.some((n) => n.id === e.target)).toBe(true);
    }
    expect(bounded.omitted.nodes).toBe(5);
    expect(bounded.omitted.edges).toBeGreaterThan(0);
    expect(bounded.truncated).toBe(true);
  });

  it('sorts nodes and edges by id before truncating, deterministically across calls', () => {
    const graph = makeGraph(5, 5);
    const shuffled = { ...graph, nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() };
    const a = boundGraph(graph, { nodes: 3, edges: 2 });
    const b = boundGraph(shuffled, { nodes: 3, edges: 2 });
    expect(a.nodes.map((n) => n.id)).toEqual(b.nodes.map((n) => n.id));
    expect(a.edges.map((e) => e.id)).toEqual(b.edges.map((e) => e.id));
  });

  it('never drops a resolved-path node in favor of an unrelated node with an earlier id', () => {
    // path-01's own nodes/edges sort AFTER the decorative candidate nodes alphabetically —
    // a naive id-sort-then-slice would silently sever the resolved path while keeping unrelated
    // exploration nodes, which for a security decision graph is actively misleading, not just lossy.
    const pathNodes: PolicyGraphNode[] = [
      { id: 'zz-source', kind: 'eni', label: 'source', status: 'allowed', pathIds: ['path-01'] },
      { id: 'zz-target', kind: 'listener', label: 'destination', status: 'blocked', pathIds: ['path-01'] },
    ];
    const pathEdge: PolicyGraphEdge = {
      id: 'zz-source->zz-target', source: 'zz-source', target: 'zz-target', relation: 'routed-to', status: 'blocked', pathIds: ['path-01'],
    };
    const decorativeNodes: PolicyGraphNode[] = Array.from({ length: 5 }, (_, i) => ({
      id: `aa-candidate-${i}`, kind: 'candidate', label: `candidate ${i}`, status: 'not_applicable',
    }));
    const graph = {
      version: 1 as const,
      capturedAt: '2026-08-19T00:00:00Z',
      nodes: [...decorativeNodes, ...pathNodes],
      edges: [pathEdge],
    };

    const bounded = boundGraph(graph, { nodes: 3, edges: 1 });

    expect(bounded.nodes).toHaveLength(3);
    expect(bounded.nodes.some((n) => n.id === 'zz-source')).toBe(true);
    expect(bounded.nodes.some((n) => n.id === 'zz-target')).toBe(true);
    // the resolved-path edge must survive intact, not be orphaned by a naive alphabetical cut
    expect(bounded.edges.some((e) => e.id === 'zz-source->zz-target')).toBe(true);
  });

  it('excludes an oversized resolved path WHOLLY rather than rendering a disconnected fragment', () => {
    // A 4-hop resolved path (4 nodes, 3 edges) with caps far below that. A naive slice-to-cap would
    // keep e.g. 2 of the 4 nodes with 0 or 1 surviving edges — a disconnected fragment that still
    // LOOKS like a small complete result. That is worse than an honest gap for a security decision
    // graph, so the whole cluster must be excluded together: either all of it renders, or none of it.
    const ids = ['path-a', 'path-b', 'path-c', 'path-d'];
    const pathNodes: PolicyGraphNode[] = ids.map((id) => ({ id, kind: 'hop', label: id, status: 'allowed', pathIds: ['path-01'] }));
    const pathEdges: PolicyGraphEdge[] = [0, 1, 2].map((i) => ({
      id: `${ids[i]}->${ids[i + 1]}`, source: ids[i], target: ids[i + 1], relation: 'routed-to', status: 'allowed', pathIds: ['path-01'],
    }));
    const graph = { version: 1 as const, capturedAt: '2026-08-19T00:00:00Z', nodes: pathNodes, edges: pathEdges };

    const bounded = boundGraph(graph, { nodes: 2, edges: 1 });

    expect(bounded.nodes).toHaveLength(0);
    expect(bounded.edges).toHaveLength(0);
    expect(bounded.truncated).toBe(true);
    expect(bounded.pathTruncated).toBe(true);
    expect(bounded.omitted).toEqual({ nodes: 4, edges: 3 });
  });

  it('admits one whole independent path and excludes the other whole, never a mix of both', () => {
    const path1Nodes: PolicyGraphNode[] = ['p1-a', 'p1-b'].map((id) => ({ id, kind: 'hop', label: id, status: 'allowed', pathIds: ['path-01'] }));
    const path1Edges: PolicyGraphEdge[] = [{ id: 'p1-a->p1-b', source: 'p1-a', target: 'p1-b', relation: 'routed-to', status: 'allowed', pathIds: ['path-01'] }];
    const path2Nodes: PolicyGraphNode[] = ['p2-a', 'p2-b', 'p2-c'].map((id) => ({ id, kind: 'hop', label: id, status: 'allowed', pathIds: ['path-02'] }));
    const path2Edges: PolicyGraphEdge[] = [
      { id: 'p2-a->p2-b', source: 'p2-a', target: 'p2-b', relation: 'routed-to', status: 'allowed', pathIds: ['path-02'] },
      { id: 'p2-b->p2-c', source: 'p2-b', target: 'p2-c', relation: 'routed-to', status: 'allowed', pathIds: ['path-02'] },
    ];
    const graph = {
      version: 1 as const, capturedAt: '2026-08-19T00:00:00Z',
      nodes: [...path1Nodes, ...path2Nodes], edges: [...path1Edges, ...path2Edges],
    };

    // Room for exactly one of the two clusters (2 nodes/1 edge fits; 3 nodes/2 edges does not).
    const bounded = boundGraph(graph, { nodes: 2, edges: 1 });

    const keptIds = new Set(bounded.nodes.map((n) => n.id));
    const path1Present = path1Nodes.every((n) => keptIds.has(n.id));
    const path2Present = path2Nodes.every((n) => keptIds.has(n.id));
    // exactly one path is present in full; the other is entirely absent — never a partial mix
    expect(path1Present !== path2Present).toBe(true);
    if (path1Present) {
      expect(bounded.nodes).toHaveLength(2);
      expect(bounded.edges.map((e) => e.id)).toEqual(['p1-a->p1-b']);
    } else {
      // path-02 doesn't fit the 2-node/1-edge budget either, so this branch shouldn't be reached
      // by this fixture, but if caps changed, it must still be all-or-nothing.
      expect(bounded.nodes.map((n) => n.id).sort()).toEqual(['p2-a', 'p2-b', 'p2-c']);
    }
    expect(bounded.pathTruncated).toBe(true);
  });

  it('treats two path ids sharing a node as one cluster (union-find over shared pathIds)', () => {
    // A shared upstream node belongs to both path-01 and path-02 — they must be admitted/excluded
    // together, never independently, since the shared node ties their fates.
    const shared: PolicyGraphNode = { id: 'shared-hop', kind: 'hop', label: 'shared', status: 'allowed', pathIds: ['path-01', 'path-02'] };
    const branch1: PolicyGraphNode = { id: 'branch-1', kind: 'hop', label: 'b1', status: 'allowed', pathIds: ['path-01'] };
    const branch2: PolicyGraphNode = { id: 'branch-2', kind: 'hop', label: 'b2', status: 'allowed', pathIds: ['path-02'] };
    const graph = {
      version: 1 as const, capturedAt: '2026-08-19T00:00:00Z',
      nodes: [shared, branch1, branch2], edges: [],
    };

    // Cap fits the shared node + exactly one branch (2 of the 3), which is NOT enough to admit the
    // whole merged cluster (3 nodes) — so the cluster must be excluded entirely, not partially.
    const bounded = boundGraph(graph, { nodes: 2, edges: 400 });

    expect(bounded.nodes).toHaveLength(0);
    expect(bounded.pathTruncated).toBe(true);
    expect(bounded.omitted.nodes).toBe(3);
  });

  it('still drops decorative nodes in favor of the path when the path itself fits the cap', () => {
    const pathNodes: PolicyGraphNode[] = ['path-a', 'path-b', 'path-c'].map((id) => ({
      id, kind: 'hop', label: id, status: 'allowed', pathIds: ['path-01'],
    }));
    const decorativeNodes: PolicyGraphNode[] = ['aa-decor-0', 'aa-decor-1'].map((id) => ({
      id, kind: 'candidate', label: id, status: 'not_applicable',
    }));
    const graph = {
      version: 1 as const, capturedAt: '2026-08-19T00:00:00Z',
      nodes: [...decorativeNodes, ...pathNodes], edges: [],
    };

    const bounded = boundGraph(graph, { nodes: 3, edges: 400 });

    expect(bounded.nodes).toHaveLength(3);
    for (const n of pathNodes) expect(bounded.nodes.some((k) => k.id === n.id)).toBe(true);
    expect(bounded.omitted.nodes).toBe(2);
    expect(bounded.truncated).toBe(true);
    // the path itself fit within the cap — only decorative nodes were cut, so this is not a
    // path-integrity emergency and callers should not treat it as one.
    expect(bounded.pathTruncated).toBe(false);
  });

  it('never drops a resolved-path edge to an untagged boundary node without flagging pathTruncated', () => {
    // The path's own edge terminates at an "unknown boundary" node that itself carries no pathIds
    // (matches the design's own on-prem/unknown-boundary node). A pile of decorative candidates
    // sorts ahead of that boundary node alphabetically — if the boundary node were left to compete
    // for the ordinary decorative budget instead of being reserved as part of the path's own cost,
    // it would lose, silently dropping the path's own edge while pathTruncated stayed false.
    const pathNode: PolicyGraphNode = { id: 'zz-source', kind: 'eni', label: 'source', status: 'allowed', pathIds: ['path-01'] };
    const boundaryNode: PolicyGraphNode = { id: 'zz-boundary', kind: 'boundary', label: 'unknown boundary', status: 'unknown' };
    const pathEdge: PolicyGraphEdge = {
      id: 'zz-source->zz-boundary', source: 'zz-source', target: 'zz-boundary', relation: 'routed-to', status: 'unknown', pathIds: ['path-01'],
    };
    const decorativeNodes: PolicyGraphNode[] = Array.from({ length: 5 }, (_, i) => ({
      id: `aa-candidate-${i}`, kind: 'candidate', label: `candidate ${i}`, status: 'not_applicable',
    }));
    const graph = {
      version: 1 as const,
      capturedAt: '2026-08-19T00:00:00Z',
      nodes: [...decorativeNodes, pathNode, boundaryNode],
      edges: [pathEdge],
    };

    // Enough total node budget for the path (2 nodes incl. boundary) + some decorative filler.
    const bounded = boundGraph(graph, { nodes: 4, edges: 1 });

    expect(bounded.nodes.some((n) => n.id === 'zz-source')).toBe(true);
    expect(bounded.nodes.some((n) => n.id === 'zz-boundary')).toBe(true);
    expect(bounded.edges.some((e) => e.id === 'zz-source->zz-boundary')).toBe(true);
    expect(bounded.pathTruncated).toBe(false);
  });

  it('flags pathTruncated when a path plus its required boundary node cannot both fit', () => {
    // Same shape as above, but the cap is only large enough for the path's OWN tagged node — not
    // its required (untagged) boundary node too. The cluster's true cost is 2 nodes, so it must be
    // excluded wholly (per the atomic-cluster rule), not admitted while losing just the boundary
    // half of its one edge.
    const pathNode: PolicyGraphNode = { id: 'zz-source', kind: 'eni', label: 'source', status: 'allowed', pathIds: ['path-01'] };
    const boundaryNode: PolicyGraphNode = { id: 'zz-boundary', kind: 'boundary', label: 'unknown boundary', status: 'unknown' };
    const pathEdge: PolicyGraphEdge = {
      id: 'zz-source->zz-boundary', source: 'zz-source', target: 'zz-boundary', relation: 'routed-to', status: 'unknown', pathIds: ['path-01'],
    };
    const graph = {
      version: 1 as const, capturedAt: '2026-08-19T00:00:00Z',
      nodes: [pathNode, boundaryNode], edges: [pathEdge],
    };

    const bounded = boundGraph(graph, { nodes: 1, edges: 400 });

    // The cluster (source + its required boundary node) doesn't fit and is excluded wholly, so
    // the path's own source node and its edge must both be gone — a lone, edgeless boundary node
    // may still surface as ordinary decorative filler (harmless on its own), but the path is not.
    expect(bounded.nodes.some((n) => n.id === 'zz-source')).toBe(false);
    expect(bounded.edges).toHaveLength(0);
    expect(bounded.pathTruncated).toBe(true);
  });

  it('does not double-charge a boundary node shared by two independent clusters against the cap', () => {
    // Two independent resolved paths terminate at the SAME untagged boundary node. Each cluster's
    // own required-node cost is 2 (its own source + the shared boundary), so a naive per-cluster
    // sum would compute 2 + 2 = 4 and falsely conclude the true distinct total (3: two sources +
    // one shared boundary) doesn't fit a cap of exactly 3.
    const boundary: PolicyGraphNode = { id: 'zz-shared-boundary', kind: 'boundary', label: 'shared boundary', status: 'unknown' };
    const src1: PolicyGraphNode = { id: 'path-01-src', kind: 'eni', label: 'src1', status: 'allowed', pathIds: ['path-01'] };
    const src2: PolicyGraphNode = { id: 'path-02-src', kind: 'eni', label: 'src2', status: 'allowed', pathIds: ['path-02'] };
    const edge1: PolicyGraphEdge = { id: 'path-01-src->zz-shared-boundary', source: 'path-01-src', target: 'zz-shared-boundary', relation: 'routed-to', status: 'unknown', pathIds: ['path-01'] };
    const edge2: PolicyGraphEdge = { id: 'path-02-src->zz-shared-boundary', source: 'path-02-src', target: 'zz-shared-boundary', relation: 'routed-to', status: 'unknown', pathIds: ['path-02'] };
    const graph = {
      version: 1 as const, capturedAt: '2026-08-19T00:00:00Z',
      nodes: [boundary, src1, src2], edges: [edge1, edge2],
    };

    const bounded = boundGraph(graph, { nodes: 3, edges: 2 });

    expect(bounded.nodes.map((n) => n.id).sort()).toEqual(['path-01-src', 'path-02-src', 'zz-shared-boundary']);
    expect(bounded.edges.map((e) => e.id).sort()).toEqual(['path-01-src->zz-shared-boundary', 'path-02-src->zz-shared-boundary']);
    expect(bounded.truncated).toBe(false);
    expect(bounded.pathTruncated).toBe(false);
  });

  it('preserves capturedAt', () => {
    const graph = makeGraph(1, 0);
    const bounded = boundGraph(graph, { nodes: 250, edges: 400 });
    expect(bounded.capturedAt).toBe('2026-08-19T00:00:00Z');
  });
});

describe('policyNodeId / policyEdgeId', () => {
  it('derives stable ids from kind/resourceId', () => {
    expect(policyNodeId('eni', 'eni-123')).toBe('eni:eni-123');
  });

  it('derives an edge id from source/target, optionally suffixed', () => {
    expect(policyEdgeId('eni:eni-123', 'sg:sg-123')).toBe('eni:eni-123->sg:sg-123');
    expect(policyEdgeId('eni:eni-123', 'sg:sg-123', '0')).toBe('eni:eni-123->sg:sg-123#0');
  });
});
