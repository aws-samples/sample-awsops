// Hierarchical (namespace-boxed) layout for the K8s service graph, computed with elkjs `layered`.
// Columns (left→right, or top→bottom when vertical): DNS | Gateway | namespace boxes | datastores.
// React-free and deterministic: inputs are sorted by id before layout and the input is never mutated.
//
// Coordinate contract (React Flow style, top-left origin):
//  - `groups[]`  — one per EXPANDED namespace that has services; x/y are ROOT (canvas) coordinates.
//  - `nodes[]`   — with `parentId` (a service inside an expanded namespace): x/y are RELATIVE to that
//                  group's top-left, so they map 1:1 onto React Flow `parentId` + `position`.
//                  Without `parentId` (DNS, gateway, datastore, collapsed-namespace leaf): ROOT coordinates.
//                  A collapsed namespace is ONE leaf node whose id is `ns:<name>` (same as `groupId`);
//                  a namespace is either a group or a leaf, never both.
//  - `edges[]`   — `sections` are elk edge sections (startPoint/bendPoints/endPoint) in ROOT coordinates.
//                  Edges touching a collapsed namespace are re-pointed to its leaf and merged per
//                  (source box, target box) pair: id `agg:<source>-><target>`, `count` = underlying edges,
//                  `evidence` = their union (trace > config > routing), `edgeIds` = the underlying edge ids.
//                  Edges between two services of the same collapsed namespace (and self-loops) are dropped.
//                  Untouched edges keep their original id with `count: 1`.
//
// Column order is guaranteed by elk partitioning (dns 0, gateway 1, namespaces 2, datastores 3).
// `layerConstraint` FIRST/LAST is added for DNS/datastores only where elk accepts it: elk rejects a FIRST node
// with an incoming edge (so gateways, which DNS points at, cannot also be FIRST) and a LAST node with an outgoing one.
//
// elkjs is ~1.6 MB; it is loaded lazily on the first layout call (`import('elkjs/lib/elk.bundled.js')`,
// the worker-free bundle), so importing this module for types/helpers does not pull it into a chunk eagerly.
import type { ELK, ElkExtendedEdge, ElkNode, LayoutOptions } from 'elkjs/lib/elk-api';
import type { Evidence, GKind, ServiceGraph } from './k8s-service-graph';

export interface LaidOutNode { id: string; x: number; y: number; width: number; height: number; parentId?: string }
export interface LaidOutGroup { id: string; label: string; x: number; y: number; width: number; height: number }
export interface LaidOutEdge {
  id: string; source: string; target: string; sections?: unknown;
  evidence: Evidence[]; count: number; edgeIds: string[];
}
export interface LaidOut { nodes: LaidOutNode[]; groups: LaidOutGroup[]; edges: LaidOutEdge[] }
export interface LayoutOptionsInput { collapsed: ReadonlySet<string>; vertical: boolean }

/** Rendered sizes the layout reserves; the canvas must render nodes at the returned width/height. */
export const SERVICE_GRAPH_NODE_SIZE: Readonly<Record<GKind | 'namespace', { width: number; height: number }>> = {
  dns: { width: 180, height: 44 },
  gateway: { width: 180, height: 44 },
  service: { width: 200, height: 48 },
  datastore: { width: 200, height: 48 },
  namespace: { width: 220, height: 56 }, // collapsed namespace leaf
};
/** Inner padding of a namespace box; `top` leaves room for the namespace label. */
export const GROUP_PADDING = { top: 36, left: 16, bottom: 16, right: 16 } as const;

export const groupId = (namespace: string) => `ns:${namespace}`;
export const collapsedNodeId = groupId;

const EVIDENCE_ORDER: Evidence[] = ['trace', 'config', 'routing'];
const PARTITION: Record<GKind, number> = { dns: 0, gateway: 1, service: 2, datastore: 3 };
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const LOAD_FAILED = 'Service graph layout engine could not be loaded.';
const LAYOUT_FAILED = 'Service graph layout failed.';

/**
 * Memoized ELK loader: concurrent callers share one import and a successful one is kept, but a
 * REJECTED import (e.g. a transient chunk-load error) is forgotten so the next call retries it —
 * the canvas's retry button would otherwise never recover without a page reload. The rejection is
 * replaced by a stable generic Error (the raw one can carry URLs or ids).
 */
export function createElkLoader(load: () => Promise<{ default: new () => ELK }>): () => Promise<ELK> {
  let pending: Promise<ELK> | null = null;
  return () => {
    pending ??= load().then((m) => new m.default()).catch(() => {
      pending = null;
      throw new Error(LOAD_FAILED);
    });
    return pending;
  };
}
const getElk = createElkLoader(() => import('elkjs/lib/elk.bundled.js'));

/** Remaps edges onto visible boxes, merging the ones that touch collapsed namespaces. */
function visibleEdges(graph: ServiceGraph, present: ReadonlySet<string>, boxOf: ReadonlyMap<string, string>): LaidOutEdge[] {
  const out = new Map<string, LaidOutEdge>();
  for (const e of [...graph.edges].sort((a, b) => cmp(a.id, b.id))) {
    if (!present.has(e.source) || !present.has(e.target)) continue;
    const source = boxOf.get(e.source) ?? e.source;
    const target = boxOf.get(e.target) ?? e.target;
    if (source === target) continue;
    if (source === e.source && target === e.target) {
      out.set(e.id, { id: e.id, source, target, evidence: [...e.evidence], count: 1, edgeIds: [e.id] });
      continue;
    }
    const id = `agg:${source}->${target}`;
    const agg = out.get(id);
    if (!agg) { out.set(id, { id, source, target, evidence: EVIDENCE_ORDER.filter((x) => e.evidence.includes(x)), count: 1, edgeIds: [e.id] }); continue; }
    agg.count += 1;
    agg.edgeIds.push(e.id);
    agg.evidence = EVIDENCE_ORDER.filter((x) => agg.evidence.includes(x) || e.evidence.includes(x));
  }
  return [...out.values()].sort((a, b) => cmp(a.id, b.id));
}

export async function layoutServiceGraph(graph: ServiceGraph, opts: LayoutOptionsInput): Promise<LaidOut> {
  const kindById = new Map(graph.nodes.map((n) => [n.id, n.kind]));
  const namespaces = graph.namespaces
    .map((ns) => ({ name: ns.name, serviceIds: ns.serviceIds.filter((id) => kindById.get(id) === 'service').sort(cmp) }))
    .filter((ns) => ns.serviceIds.length > 0)
    .sort((a, b) => cmp(a.name, b.name));

  const boxOf = new Map<string, string>(); // hidden service id → collapsed leaf id
  const parentOf = new Map<string, string>(); // visible service id → group id
  for (const ns of namespaces) {
    for (const id of ns.serviceIds) (opts.collapsed.has(ns.name) ? boxOf : parentOf).set(id, groupId(ns.name));
  }

  const edges = visibleEdges(graph, new Set(kindById.keys()), boxOf);
  const hasIncoming = new Set(edges.map((e) => e.target));
  const hasOutgoing = new Set(edges.map((e) => e.source));

  const leaf = (id: string, kind: GKind | 'namespace'): ElkNode => {
    const layoutOptions: LayoutOptions = { 'elk.partitioning.partition': String(kind === 'namespace' ? PARTITION.service : PARTITION[kind]) };
    if (kind === 'dns' && !hasIncoming.has(id)) layoutOptions['elk.layered.layering.layerConstraint'] = 'FIRST';
    if (kind === 'datastore' && !hasOutgoing.has(id)) layoutOptions['elk.layered.layering.layerConstraint'] = 'LAST';
    return { id, ...SERVICE_GRAPH_NODE_SIZE[kind], layoutOptions };
  };

  const children: ElkNode[] = [];
  const nodesSorted = [...graph.nodes].sort((a, b) => cmp(a.id, b.id));
  // Root-level leaves: everything except services owned by a listed namespace.
  for (const n of nodesSorted) if (!boxOf.has(n.id) && !parentOf.has(n.id)) children.push(leaf(n.id, n.kind));
  const groupIds = new Set<string>();
  for (const ns of namespaces) {
    const id = groupId(ns.name);
    if (opts.collapsed.has(ns.name)) { children.push(leaf(id, 'namespace')); continue; }
    groupIds.add(id);
    const p = GROUP_PADDING;
    children.push({
      id,
      layoutOptions: {
        'elk.partitioning.partition': String(PARTITION.service),
        'elk.padding': `[top=${p.top},left=${p.left},bottom=${p.bottom},right=${p.right}]`,
      },
      children: ns.serviceIds.map((sid) => leaf(sid, 'service')),
    });
  }
  if (children.length === 0) return { nodes: [], groups: [], edges: [] };
  children.sort((a, b) => cmp(a.id, b.id));

  const root: ElkNode = {
    id: '__root__',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': opts.vertical ? 'DOWN' : 'RIGHT',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.partitioning.activate': 'true',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': '24',
      'elk.layered.spacing.nodeNodeBetweenLayers': '80',
      'elk.padding': '[top=16,left=16,bottom=16,right=16]',
      'elk.json.shapeCoords': 'PARENT',
      'elk.json.edgeCoords': 'ROOT',
    },
    children,
    edges: edges.map((e): ElkExtendedEdge => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };

  const engine = await getElk();
  let res: ElkNode;
  try {
    res = await engine.layout(root);
  } catch {
    // ELK messages name nodes/options (graph ids): never pass them on.
    throw new Error(LAYOUT_FAILED);
  }

  const nodes: LaidOutNode[] = [];
  const groups: LaidOutGroup[] = [];
  const sections = new Map<string, unknown>();
  const collectEdges = (n: ElkNode) => {
    for (const e of n.edges ?? []) sections.set(e.id, e.sections);
    for (const c of n.children ?? []) collectEdges(c);
  };
  collectEdges(res);
  const box = (n: ElkNode) => ({ x: n.x ?? 0, y: n.y ?? 0, width: n.width ?? 0, height: n.height ?? 0 });
  for (const c of res.children ?? []) {
    if (!groupIds.has(c.id)) { nodes.push({ id: c.id, ...box(c) }); continue; }
    groups.push({ id: c.id, label: c.id.slice('ns:'.length), ...box(c) });
    for (const s of c.children ?? []) nodes.push({ id: s.id, ...box(s), parentId: c.id });
  }

  return {
    nodes: nodes.sort((a, b) => cmp(a.id, b.id)),
    groups: groups.sort((a, b) => cmp(a.id, b.id)),
    edges: edges.map((e) => ({ ...e, sections: sections.get(e.id) })),
  };
}
