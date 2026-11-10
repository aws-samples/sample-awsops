/** Bound a display after selection; reserve connections/endpoints before isolated context. */
export function boundGraphDisplay<N extends { id: string }, E extends { source: string; target: string }>(
  graph: { nodes: N[]; edges: E[] }, pinned: string[] = [],
) {
  const present = new Set(graph.nodes.map(n => n.id));
  const keep = new Set(pinned.filter(id => present.has(id)).slice(0, 350));
  const edges: E[] = [];
  for (const edge of graph.edges) {
    if (edges.length >= 700) break;
    if (!present.has(edge.source) || !present.has(edge.target)) continue;
    const additions = new Set([edge.source, edge.target].filter(id => !keep.has(id)));
    if (keep.size + additions.size > 350) continue;
    additions.forEach(id => keep.add(id));
    edges.push(edge);
  }
  for (const node of graph.nodes) {
    if (keep.size >= 350) break;
    keep.add(node.id);
  }
  const nodes = graph.nodes.filter(node => keep.has(node.id));
  return { nodes, edges, omitted: { nodes: graph.nodes.length - nodes.length, edges: graph.edges.length - edges.length } };
}

/** Display-only selection. Keeps original identity, metadata and edge evidence. */
export function selectGraphPaths<N extends { id: string }, E extends { source: string; target: string }>(
  graph: { nodes: N[]; edges: E[] }, seeds: string[], maxHops = Infinity,
): { nodes: N[]; edges: E[] } {
  const present = new Set(graph.nodes.map(n => n.id));
  const starts = seeds.filter(id => present.has(id));
  const keep = new Set(starts);
  // Separate directed walks avoid expanding siblings through a shared ancestor.
  for (const reverse of [false, true]) {
    const adjacent = new Map<string, string[]>();
    for (const edge of graph.edges) {
      if (!present.has(edge.source) || !present.has(edge.target)) continue;
      const from = reverse ? edge.target : edge.source, to = reverse ? edge.source : edge.target;
      const rows = adjacent.get(from) ?? [];
      rows.push(to);
      adjacent.set(from, rows);
    }
    const visited = new Set(starts);
    const queue = starts.map(id => ({ id, depth: 0 }));
    for (let i = 0; i < queue.length; i++) {
      const { id, depth } = queue[i];
      if (depth >= maxHops) continue;
      for (const next of adjacent.get(id) ?? []) if (!visited.has(next)) {
        visited.add(next); keep.add(next);
        queue.push({ id: next, depth: depth + 1 });
      }
    }
  }
  return {
    nodes: graph.nodes.filter(n => keep.has(n.id)),
    edges: graph.edges.filter(e => keep.has(e.source) && keep.has(e.target)),
  };
}

export function serviceOverview<
  N extends { id: string; kind: string }, E extends { source: string; target: string; rel: string },
>(graph: { nodes: N[]; edges: E[] }, showWorkloads: boolean) {
  if (showWorkloads) return graph;
  const callEndpoints = new Set(graph.edges.filter(e => e.rel !== 'runs_on').flatMap(e => [e.source, e.target]));
  const nodes = graph.nodes.filter(n => n.kind !== 'workload' || callEndpoints.has(n.id));
  const ids = new Set(nodes.map(n => n.id));
  return { nodes, edges: graph.edges.filter(e => ids.has(e.source) && ids.has(e.target)) };
}
