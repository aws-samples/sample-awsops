import type { NetworkTopology } from './network-topology-types';

/** Display projection only; retain parent containers and source completeness metadata. */
export function networkDisplay(topology: NetworkTopology, query: string, connectedOnly: boolean): NetworkTopology {
  const needle = query.trim().toLowerCase();
  if (!needle && !connectedOnly) return topology;
  const endpoints = new Set(topology.edges.flatMap(edge => [edge.source, edge.target]));
  const matches = topology.nodes.filter(node =>
    !['account', 'region', 'az', 'subnet'].includes(node.kind)
    && (!connectedOnly || endpoints.has(node.id))
    && (!needle || [node.label, node.sub, node.resourceId, node.accountId, node.region]
      .some(value => value?.toLowerCase().includes(needle))));
  const keep = new Set(matches.map(node => node.id));
  if (needle) {
    // One adjacent connection provides counterpart context without spreading across a fleet.
    const seeds = new Set(keep);
    for (const edge of topology.edges) if (seeds.has(edge.source) || seeds.has(edge.target)) {
      keep.add(edge.source); keep.add(edge.target);
    }
  }
  const byId = new Map(topology.nodes.map(node => [node.id, node]));
  for (const id of [...keep]) {
    const visited = new Set<string>();
    let parent = byId.get(id)?.parent;
    while (parent && !visited.has(parent)) {
      visited.add(parent);
      keep.add(parent);
      parent = byId.get(parent)?.parent;
    }
  }
  return { ...topology, nodes: topology.nodes.filter(node => keep.has(node.id)),
    edges: topology.edges.filter(edge => keep.has(edge.source) && keep.has(edge.target)) };
}
