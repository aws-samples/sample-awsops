import { INFRA_CONTEXT_KINDS, INFRA_PLACEMENT_RELATIONS } from './infra-topology';

interface PlacementNode { id: string; kind: string; label: string; meta?: Record<string, unknown> }
interface PlacementEdge { source: string; target: string; rel: string }
const CONTEXT = new Set<string>(INFRA_CONTEXT_KINDS);
const PLACEMENT = new Set<string>(Object.values(INFRA_PLACEMENT_RELATIONS));
export const INFRA_PAGE_SIZE = 4;
const PAGE_NODE_BUDGET = 8;

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
  const pinned = [options.vpc, options.subnet].filter((id): id is string => !!id && byId.has(id));
  const includeResource = (ids: Set<string>, n: N) => {
    ids.add(n.id);
    for (const e of outgoing.get(n.id) ?? []) {
      if (e.rel !== INFRA_PLACEMENT_RELATIONS.sg || options.showSecurityGroups) ids.add(e.target);
    }
  };
  // Pack by both resources and context. A single high-fanout resource retains
  // every saved target; its canvas grows instead of silently dropping links.
  const groups: N[][] = [];
  let group: N[] = [];
  let groupIds = new Set(pinned);
  for (const n of candidates) {
    const nextIds = new Set(groupIds);
    includeResource(nextIds, n);
    if (group.length && (group.length >= pageSize || nextIds.size > PAGE_NODE_BUDGET)) {
      groups.push(group);
      group = [];
      groupIds = new Set(pinned);
    }
    group.push(n);
    includeResource(groupIds, n);
  }
  if (group.length) groups.push(group);
  const pages = Math.max(1, groups.length);
  const requested = Number.isFinite(options.page) ? Math.floor(options.page!) : 0;
  const page = Math.max(0, Math.min(pages - 1, requested));
  const resources = groups[page] ?? [];
  const keep = new Set(pinned);
  for (const n of resources) includeResource(keep, n);
  return {
    nodes: graph.nodes.filter(n => keep.has(n.id)),
    edges: graph.edges.filter(e => PLACEMENT.has(e.rel) && keep.has(e.source) && keep.has(e.target)),
    resources, totalResources: candidates.length, page, pages,
  };
}
