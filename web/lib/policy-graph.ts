// Shared PolicyGraph contract — the single graph DTO rendered by both Network Path Check and the
// Security Group Usage/Rules screens (docs/superpowers/specs/2026-08-13-network-path-check-design.md
// "Graph contract and UI"). Pure / React-independent so it can be unit-tested and reused by the
// worker (Python side keeps an equivalent shape; this is the TypeScript/BFF-and-UI side).
//
// `status` is a small, fixed visual vocabulary (icon + color + line style — never color alone).
// Domain evidence states (e.g. SG Rules' observed_compatible/overlapping/unassessable) map onto
// this vocabulary at the builder boundary; PolicyGraph itself stays domain-agnostic.
export type PolicyGraphStatus = 'allowed' | 'blocked' | 'unknown' | 'not_run' | 'not_applicable';

export interface PolicyGraphScope {
  accountId: string;
  region: string;
}

export interface PolicyGraphNode {
  id: string;
  kind: string;
  label: string;
  status: PolicyGraphStatus;
  resourceId?: string;
  scope?: PolicyGraphScope;
  pathIds?: string[];
}

export interface PolicyGraphEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  status: PolicyGraphStatus;
  label?: string;
  pathIds?: string[];
  stepOrdinals?: number[];
}

export interface PolicyGraphDto {
  version: 1;
  capturedAt: string;
  truncated: boolean;
  omitted: { nodes: number; edges: number };
  // True only when the node/edge cap had to cut into pathIds-tagged (resolved-path) structure —
  // i.e. `omitted` is not just decorative overflow, and the returned graph may misrepresent the
  // actual resolved path. Callers MUST treat this distinctly from ordinary decorative truncation:
  // do not present the graph as a confidently-truncated-but-fine path (e.g. surface the run as
  // failed/unknown per the design's own "execution-level failure -> failed" semantics) rather than
  // silently rendering a path that might be missing its own blocking step.
  pathTruncated: boolean;
  nodes: PolicyGraphNode[];
  edges: PolicyGraphEdge[];
}

export interface GraphCaps {
  nodes: number;
  edges: number;
}

/** Stable resource-derived node id, e.g. `eni:eni-123` — keeps nodes from moving between polls. */
export function policyNodeId(kind: string, resourceId: string): string {
  return `${kind}:${resourceId}`;
}

/** Stable edge id, e.g. `eni:eni-123->sg:sg-123` (optionally suffixed for parallel edges). */
export function policyEdgeId(source: string, target: string, suffix?: string): string {
  return suffix ? `${source}->${target}#${suffix}` : `${source}->${target}`;
}

function hasPathIds(x: { pathIds?: string[] }): boolean {
  return Array.isArray(x.pathIds) && x.pathIds.length > 0;
}

const byId = <T extends { id: string }>(a: T, b: T): number => a.id.localeCompare(b.id);

interface PathCluster {
  pathIds: Set<string>;
  minPathId: string;
  // Includes both pathIds-tagged nodes AND any node an edge in this cluster terminates at that is
  // NOT itself tagged (e.g. an on-prem/unknown boundary node per the design's own "nodes beyond
  // the AWS-visible boundary terminate at a dashed unknown boundary node" rule) — see the pull-in
  // step below. Counting these "required" nodes as part of the cluster's own cost, before the
  // admission decision, is what closes the gap where an edge could get silently dropped later.
  nodes: PolicyGraphNode[];
  edges: PolicyGraphEdge[];
}

/**
 * Groups path-tagged nodes/edges into connected clusters via union-find over shared `pathIds` —
 * two path ids are the same cluster the moment any single node or edge is tagged with both (a
 * shared segment between two equal-cost active paths). This is what lets `boundGraph` include or
 * exclude a whole resolved path atomically: slicing an arbitrary subset of one path's nodes can
 * leave a disconnected, misleadingly-plausible-looking fragment, but excluding/including an entire
 * cluster never can.
 *
 * `nodeById` resolves a cluster's edges' source/target ids even when the endpoint node itself
 * carries no `pathIds` — those "required" boundary nodes are pulled into the cluster (deduplicated
 * if two clusters share one) so its true node cost, and the admission decision that follows, both
 * account for them. Without this, a path edge could reference an untagged boundary node that later
 * loses out to unrelated decorative filler for the ordinary node budget, silently dropping the edge
 * without `pathTruncated` ever firing (that node's absence wasn't attributed to any excluded
 * cluster — it was just an accident of decorative competition).
 */
function buildPathClusters(
  pathNodes: PolicyGraphNode[],
  pathEdges: PolicyGraphEdge[],
  nodeById: Map<string, PolicyGraphNode>,
): PathCluster[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    return r;
  };
  const ensure = (id: string) => { if (!parent.has(id)) parent.set(id, id); };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const item of [...pathNodes, ...pathEdges]) {
    const ids = item.pathIds ?? [];
    ids.forEach(ensure);
    for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]);
  }

  const byRoot = new Map<string, PathCluster>();
  const clusterFor = (anyPathId: string): PathCluster => {
    const root = find(anyPathId);
    let c = byRoot.get(root);
    if (!c) { c = { pathIds: new Set(), minPathId: anyPathId, nodes: [], edges: [] }; byRoot.set(root, c); }
    return c;
  };

  for (const n of pathNodes) {
    const c = clusterFor(n.pathIds![0]);
    n.pathIds!.forEach((id) => c.pathIds.add(id));
    c.nodes.push(n);
  }
  for (const e of pathEdges) {
    const c = clusterFor(e.pathIds![0]);
    e.pathIds!.forEach((id) => c.pathIds.add(id));
    c.edges.push(e);
  }

  const clusters = [...byRoot.values()];
  for (const c of clusters) {
    const haveIds = new Set(c.nodes.map((n) => n.id));
    for (const e of c.edges) {
      for (const endpointId of [e.source, e.target]) {
        if (haveIds.has(endpointId)) continue;
        const boundary = nodeById.get(endpointId);
        if (boundary) { c.nodes.push(boundary); haveIds.add(endpointId); }
        // If the endpoint id resolves to no node at all, the input itself references a resource
        // that doesn't exist — nothing to pull in; boundGraph's final endpoint re-check still
        // drops that edge and (per its own contract) that now counts toward `pathTruncated` too.
      }
    }
    c.nodes.sort(byId);
    c.edges.sort(byId);
    c.minPathId = [...c.pathIds].sort()[0];
  }
  return clusters.sort((a, b) => a.minPathId.localeCompare(b.minPathId));
}

/**
 * Deterministically caps a raw graph to the given node/edge limits and reports what was hidden.
 * `caps.nodes`/`caps.edges` are ALWAYS enforced as hard maximums (the returned graph never exceeds
 * them) — they exist for real persistence/rendering safety reasons (bounded Aurora JSONB size,
 * bounded browser canvas cost), and a shared function silently exceeding them under some inputs
 * would reopen exactly the unbounded-write risk the cap exists to prevent.
 *
 * Within that hard limit, resolved-path structure (`pathIds` non-empty) is preferred over
 * decorative/candidate structure — a resolved-path graph's whole point is the path, so decorative
 * overflow is dropped first. Path structure is admitted in whole connected clusters (see
 * `buildPathClusters`), never as an arbitrary node-by-node slice: a cluster is either included with
 * ALL of its nodes and edges, or excluded entirely. Slicing partway through a path/cluster would
 * leave disconnected fragments that can look like a complete, if smaller, valid result — which for
 * a security decision graph is worse than an honest, visible gap. Clusters are tried in
 * deterministic order (by their smallest `pathIds` value) and admitted greedily while both the node
 * and edge budget allow; a cluster too big for the remaining budget is skipped for a later, smaller
 * one rather than trying to fit part of it. Any cluster left out sets `pathTruncated: true` — an
 * explicit, un-ignorable signal that `omitted` this time is resolved-path structure, not just
 * decoration, so a caller can react distinctly (e.g. treat the run as failed/unknown) rather than
 * present a confidently-truncated but incomplete path. In practice full exclusion should be rare —
 * the caps are generous specifically because domain builders are expected to have already collapsed
 * repeated targets/candidate branches into typed `+N` nodes before calling this (see
 * `web/lib/sg-policy-graph.ts`).
 *
 * Decorative nodes/edges are chosen for the remaining budget by sorting on id, so repeated calls
 * over the same input are stable across polls. Dangling edges (referencing a node the node cap cut)
 * are dropped and counted as omitted the same as edges cut purely by the edge cap.
 *
 * A path edge can terminate at a node that itself carries no `pathIds` — e.g. the design's own
 * on-prem/unknown boundary node, which is genuinely outside the resolved AWS-visible path. Such a
 * node is pulled into its cluster's own node cost up front (see `buildPathClusters`) rather than
 * left to compete for the ordinary decorative node budget, and `pathTruncated` also fires if an
 * admitted cluster's edge is still missing from the result for any reason — closing the gap where
 * a path edge could be silently dropped by decorative-budget competition while `pathTruncated`
 * stayed `false` because no whole cluster was ever excluded. That same boundary node can be shared
 * by two DIFFERENT clusters (e.g. two equal-cost active paths both terminating at the same unknown
 * boundary) — the admission loop below tracks the running set of already-admitted node/edge ids
 * and only charges a cluster for the ids it actually ADDS, so a shared node is never double-counted
 * against the budget (which would otherwise falsely report it exhausted and needlessly exclude an
 * entire second path that would, counted correctly, have fit).
 */
export function boundGraph(
  graph: { version: 1; capturedAt: string; nodes: PolicyGraphNode[]; edges: PolicyGraphEdge[] },
  caps: GraphCaps,
): PolicyGraphDto {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const pathNodes = graph.nodes.filter(hasPathIds);
  const pathEdges = graph.edges.filter(hasPathIds);

  const clusters = buildPathClusters(pathNodes, pathEdges, nodeById);
  // Admission is decided against the running set of DISTINCT node/edge ids already included, not
  // a per-cluster sum — a boundary node shared by two clusters (see buildPathClusters) must only
  // count once against the budget. Summing c.nodes.length across clusters would double-charge that
  // shared node, which can falsely report the budget exhausted and exclude a whole legitimate
  // second path that would, in reality, have fit.
  const includedClusters: PathCluster[] = [];
  const admittedNodeIds = new Set<string>();
  const admittedEdgeIds = new Set<string>();
  for (const c of clusters) {
    const newNodeCount = c.nodes.reduce((n, node) => n + (admittedNodeIds.has(node.id) ? 0 : 1), 0);
    const newEdgeCount = c.edges.reduce((n, edge) => n + (admittedEdgeIds.has(edge.id) ? 0 : 1), 0);
    if (admittedNodeIds.size + newNodeCount <= caps.nodes && admittedEdgeIds.size + newEdgeCount <= caps.edges) {
      includedClusters.push(c);
      c.nodes.forEach((n) => admittedNodeIds.add(n.id));
      c.edges.forEach((e) => admittedEdgeIds.add(e.id));
    }
    // else: the whole cluster is excluded — never a partial slice of it.
  }

  // Dedupe: an untagged boundary node shared by two clusters (see buildPathClusters) would
  // otherwise be pulled into each cluster's own `nodes` and appear twice once both are admitted.
  const keptPathNodes = [...new Map(includedClusters.flatMap((c) => c.nodes).map((n) => [n.id, n])).values()].sort(byId);
  const keptPathNodeIds = new Set(keptPathNodes.map((n) => n.id));

  // Decorative candidates exclude anything already required by an included cluster (whether it's
  // pathIds-tagged or a pulled-in untagged boundary node) — never let a node compete for both pools.
  const looseNodes = graph.nodes.filter((n) => !hasPathIds(n) && !keptPathNodeIds.has(n.id)).sort(byId);
  const looseEdges = graph.edges.filter((e) => !hasPathIds(e)).sort(byId);

  const looseNodeBudget = Math.max(0, caps.nodes - keptPathNodes.length);
  const keptNodes = [...keptPathNodes, ...looseNodes.slice(0, looseNodeBudget)].sort(byId);
  const keptNodeIds = new Set(keptNodes.map((n) => n.id));

  const rawPathEdges = [...new Map(includedClusters.flatMap((c) => c.edges).map((e) => [e.id, e])).values()];
  // Every endpoint of an included cluster's edge should already be in keptNodeIds — buildPathClusters
  // pulled in exactly those nodes as part of the cluster's own cost. This re-check only fires for a
  // genuinely malformed input (an edge endpoint that resolves to no node at all); when it does, that
  // loss is resolved-path structure too, so it feeds `pathTruncated` below, not just `omitted`.
  const keptPathEdges = rawPathEdges.filter((e) => keptNodeIds.has(e.source) && keptNodeIds.has(e.target)).sort(byId);
  const looseEdgeBudget = Math.max(0, caps.edges - keptPathEdges.length);
  const keptLooseEdges = looseEdges
    .filter((e) => keptNodeIds.has(e.source) && keptNodeIds.has(e.target))
    .slice(0, looseEdgeBudget);
  const keptEdges = [...keptPathEdges, ...keptLooseEdges].sort(byId);

  const omittedNodes = graph.nodes.length - keptNodes.length;
  const omittedEdges = graph.edges.length - keptEdges.length;
  const anyClusterExcluded = includedClusters.length !== clusters.length;
  const admittedPathEdgeStillDropped = rawPathEdges.length !== keptPathEdges.length;

  return {
    version: 1,
    capturedAt: graph.capturedAt,
    truncated: omittedNodes > 0 || omittedEdges > 0,
    omitted: { nodes: omittedNodes, edges: omittedEdges },
    pathTruncated: anyClusterExcluded || admittedPathEdgeStillDropped,
    nodes: keptNodes,
    edges: keptEdges,
  };
}
