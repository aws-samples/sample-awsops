interface PlacementNode { id: string; kind: string; label: string; meta?: Record<string, unknown> }
interface PlacementEdge { source: string; target: string; rel: string }
const CONTEXT = new Set(['vpc', 'subnet', 'sg']);
const PLACEMENT = new Set(['infra:in_vpc', 'infra:in_subnet', 'infra:uses_sg']);
export const INFRA_PAGE_SIZE = 4;

/** Display-only pages of resources plus their exact saved placement targets.
 * Never walk backwards through a shared subnet/SG into sibling resources. */
export function infraGraphPage<N extends PlacementNode, E extends PlacementEdge>(
  graph: { nodes: N[]; edges: E[] },
  options: { vpc?: string; subnet?: string; kind?: string; query?: string; page?: number; pageSize?: number; showSecurityGroups?: boolean } = {},
) {
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const outgoing = new Map<string, E[]>();
  for (const e of graph.edges) {
    if (!PLACEMENT.has(e.rel) || !byId.has(e.source) || !byId.has(e.target)) continue;
    const targets = outgoing.get(e.source) ?? [];
    targets.push(e);
    outgoing.set(e.source, targets);
  }
  const needle = options.query?.trim().toLowerCase() ?? '';
  const matches = (n: N) => !needle || [n.id, n.kind, n.label, JSON.stringify(n.meta ?? {})]
    .some(value => value.toLowerCase().includes(needle));
  const candidates = graph.nodes.filter(n => {
    if (CONTEXT.has(n.kind)) return false;
    const targets = outgoing.get(n.id) ?? [];
    if (options.vpc && !targets.some(e => e.rel === 'infra:in_vpc' && e.target === options.vpc)) return false;
    if (options.subnet && !targets.some(e => e.rel === 'infra:in_subnet' && e.target === options.subnet)) return false;
    if (options.kind && n.kind !== options.kind) return false;
    return matches(n) || targets.some(e => matches(byId.get(e.target)!));
  });
  const pageSize = Number.isFinite(options.pageSize)
    ? Math.max(1, Math.min(INFRA_PAGE_SIZE, Math.floor(options.pageSize!))) : INFRA_PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(candidates.length / pageSize));
  const requested = Number.isFinite(options.page) ? Math.floor(options.page!) : 0;
  const page = Math.max(0, Math.min(pages - 1, requested));
  const resources = candidates.slice(page * pageSize, (page + 1) * pageSize);
  const keep = new Set(resources.map(n => n.id));
  for (const id of [options.vpc, options.subnet]) if (id && byId.has(id)) keep.add(id);
  for (const n of resources) for (const e of outgoing.get(n.id) ?? []) {
    if (e.rel !== 'infra:uses_sg' || options.showSecurityGroups) keep.add(e.target);
  }
  return {
    nodes: graph.nodes.filter(n => keep.has(n.id)),
    edges: graph.edges.filter(e => PLACEMENT.has(e.rel) && keep.has(e.source) && keep.has(e.target)),
    resources, totalResources: candidates.length, page, pages,
  };
}
