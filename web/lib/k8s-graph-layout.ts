// Hierarchical (namespace-boxed) layout for the K8s service graph: dagre (MIT) for the call order
// INSIDE each namespace box, plus hand-written column placement around it.
// Columns (left→right, or top→bottom when vertical): DNS | Gateway | namespace boxes | datastores.
// React-free and deterministic: inputs are sorted by id before layout and the input is never mutated.
//
// Coordinate contract (React Flow style, top-left origin):
//  - `groups[]`  — one per EXPANDED namespace that has services; x/y are ROOT (canvas) coordinates.
//  - `nodes[]`   — with `parentId` (a service inside an expanded namespace): x/y are RELATIVE to that
//                  group's top-left, so they map 1:1 onto React Flow `parentId` + `position`.
//                  Without `parentId` (DNS, gateway, datastore, collapsed-namespace leaf, or a service
//                  whose namespace is not listed): ROOT coordinates.
//                  A collapsed namespace is ONE leaf node whose id is `ns:<name>` (same as `groupId`);
//                  a namespace is either a group or a leaf, never both.
//  - `edges[]`   — `sections` is always undefined: no route is precomputed, the canvas draws each edge
//                  itself between the node handles. Edges touching a collapsed namespace are re-pointed
//                  to its leaf and merged per (source box, target box) pair: id `agg:<source>-><target>`,
//                  `count` = underlying edges, `evidence` = their union (trace > config > routing),
//                  `edgeIds` = the underlying edge ids. Edges between two services of the same collapsed
//                  namespace (and self-loops) are dropped. Untouched edges keep their original id with
//                  `count: 1`. Edges with an endpoint that is not a graph node are skipped.
//
// Algorithm (all in a "flow frame": the main axis runs across the columns, the cross axis stacks
// items within a column; vertical only swaps which physical axis is which):
//  1. Inner layout per expanded namespace. Services joined by intra-namespace edges are laid out per
//     connected component with dagre (plain, NON-compound graphs: dagre's cluster mode breaks the column
//     order and does not scale); services with no intra-namespace edge go into a near-square grid. dagre's
//     cost grows quickly with dense meshes, so the components of ALL expanded namespaces share one budget:
//     they are taken in ascending edge count (ties: namespace name, then smallest service id), a component
//     above DAGRE_MAX_EDGES_PER_COMPONENT edges or one that no longer fits in the remaining
//     DAGRE_MAX_EDGES_TOTAL joins its namespace's grid instead. Small call graphs therefore get dagre no
//     matter which other namespaces are expanded. The blocks are shelf-packed into a near-square area
//     inside GROUP_PADDING (top = label header).
// Duplicate ids (in `graph.nodes` or in a namespace's `serviceIds`) are ignored: the first one wins.
//  2. Column ordering: items start in id order; side columns (gateway, DNS, datastores), then the
//     services column, then the side columns again are reordered by the barycenter of their neighbours
//     in the other columns (positions normalised to the column extent, ties broken by id).
//  3. Placement: the services column is stacked first; every other column places each item at the
//     mean cross position of its neighbours in already-placed columns, pushed down to keep order and gaps.
//     Column main offsets come from the widest item of each preceding column plus COLUMN_GAP.
import dagre from '@dagrejs/dagre';
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
const COLUMN: Record<GKind, number> = { dns: 0, gateway: 1, service: 2, datastore: 3 };
const SERVICES_COLUMN = COLUMN.service;
const COLUMN_COUNT = 4;
const MARGIN = 16; // around the whole drawing
const COLUMN_GAP = 80; // between columns (main axis)
const STACK_GAP = 24; // between items of one column (cross axis)
const INNER_GAP = 24; // between services / blocks inside a namespace box
const INNER_RANK_GAP = 60; // between dagre ranks inside a namespace box
/** dagre budget (main-thread time): ~150 random-mesh edges lay out in ~0.2 s, 900 in ~10 s. */
const DAGRE_MAX_EDGES_PER_COMPONENT = 150;
const DAGRE_MAX_EDGES_TOTAL = 600;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const LAYOUT_FAILED = 'Service graph layout failed.';

interface Point { x: number; y: number }
interface Size { width: number; height: number }
/** A box placed in one column: a leaf node, a collapsed namespace or an expanded namespace group. */
interface Item extends Size {
  id: string;
  col: number;
  group: boolean;
  /** Visible node id → its centre relative to the item's top-left (physical axes). */
  centers: Map<string, Point>;
  /** Service top-left positions relative to the group (groups only). */
  children: { id: string; x: number; y: number }[];
}
interface Link { other: Item; otherCenter: Point; ownCenter: Point }

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

interface Block extends Size { pos: Map<string, Point> }

/** One connected component of intra-namespace calls, laid out by dagre along the flow direction. */
function dagreBlock(ids: readonly string[], edges: readonly [string, string][], vertical: boolean): Block {
  const size = SERVICE_GRAPH_NODE_SIZE.service;
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: vertical ? 'TB' : 'LR', ranksep: INNER_RANK_GAP, nodesep: INNER_GAP, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const id of ids) g.setNode(id, { width: size.width, height: size.height });
  for (const [s, t] of edges) g.setEdge(s, t);
  dagre.layout(g);
  const raw = ids.map((id) => {
    const p = g.node(id);
    return { id, x: p.x - size.width / 2, y: p.y - size.height / 2 };
  });
  const minX = Math.min(...raw.map((p) => p.x));
  const minY = Math.min(...raw.map((p) => p.y));
  const pos = new Map(raw.map((p) => [p.id, { x: p.x - minX, y: p.y - minY }]));
  return {
    pos,
    width: Math.max(...[...pos.values()].map((p) => p.x)) + size.width,
    height: Math.max(...[...pos.values()].map((p) => p.y)) + size.height,
  };
}

/** Services without intra-namespace calls: a grid whose column count keeps it roughly square. */
function gridBlock(ids: readonly string[]): Block {
  const { width, height } = SERVICE_GRAPH_NODE_SIZE.service;
  const cellW = width + INNER_GAP;
  const cellH = height + INNER_GAP;
  const cols = Math.max(1, Math.ceil(Math.sqrt((ids.length * cellH) / cellW)));
  const rows = Math.ceil(ids.length / cols);
  const pos = new Map(ids.map((id, i) => [id, { x: (i % cols) * cellW, y: Math.floor(i / cols) * cellH }]));
  return { pos, width: Math.min(cols, ids.length) * cellW - INNER_GAP, height: rows * cellH - INNER_GAP };
}

interface Component { ns: string; root: string; ids: string[]; edges: [string, string][] }

/** Connected components (size ≥ 2) of one namespace's intra-namespace edges, in service-id order. */
function components(ns: string, serviceIds: readonly string[], intra: readonly [string, string][]): Component[] {
  const root = new Map(serviceIds.map((id) => [id, id]));
  const find = (id: string): string => {
    let r = id;
    while (root.get(r) !== r) r = root.get(r)!;
    root.set(id, r);
    return r;
  };
  for (const [s, t] of intra) {
    const a = find(s); const b = find(t);
    if (a !== b) root.set(a < b ? b : a, a < b ? a : b); // smallest id is the representative
  }
  const linked = new Set(intra.flat());
  const byRoot = new Map<string, Component>();
  for (const id of serviceIds) {
    if (!linked.has(id)) continue;
    const r = find(id);
    const c = byRoot.get(r);
    if (c) c.ids.push(id); else byRoot.set(r, { ns, root: r, ids: [id], edges: [] });
  }
  for (const e of intra) byRoot.get(find(e[0]))!.edges.push(e);
  return [...byRoot.values()];
}

/**
 * Lays out the services of one expanded namespace; positions are relative to the content origin.
 * `dagreComps` are the components granted dagre; every other service goes into the grid.
 */
function packNamespace(serviceIds: readonly string[], dagreComps: readonly Component[], vertical: boolean): Block {
  const blocks: Block[] = [...dagreComps]
    .sort((a, b) => b.ids.length - a.ids.length || cmp(a.root, b.root))
    .map((c) => dagreBlock(c.ids, c.edges, vertical));
  const inDagre = new Set(dagreComps.flatMap((c) => c.ids));
  const gridded = serviceIds.filter((id) => !inDagre.has(id)); // keeps id order
  if (gridded.length > 0) blocks.push(gridBlock(gridded));

  // Shelf packing (left→right rows, wrapping downwards) into a roughly square area.
  const area = blocks.reduce((s, b) => s + (b.width + INNER_GAP) * (b.height + INNER_GAP), 0);
  const targetW = Math.max(...blocks.map((b) => b.width), Math.sqrt(area));
  const pos = new Map<string, Point>();
  let x = 0; let y = 0; let rowH = 0; let width = 0;
  for (const b of blocks) {
    if (x > 0 && x + b.width > targetW) { x = 0; y += rowH + INNER_GAP; rowH = 0; }
    for (const [id, p] of b.pos) pos.set(id, { x: x + p.x, y: y + p.y });
    width = Math.max(width, x + b.width);
    rowH = Math.max(rowH, b.height);
    x += b.width + INNER_GAP;
  }
  return { pos, width, height: y + rowH };
}

/**
 * Grants dagre to components across ALL expanded namespaces, cheapest first (ties: namespace name,
 * then smallest service id), within the per-component and layout-wide edge caps.
 */
function dagreGrants(comps: readonly Component[]): Set<Component> {
  const granted = new Set<Component>();
  let left = DAGRE_MAX_EDGES_TOTAL;
  const sorted = [...comps].sort((a, b) => a.edges.length - b.edges.length || cmp(a.ns, b.ns) || cmp(a.root, b.root));
  for (const c of sorted) {
    if (c.edges.length > DAGRE_MAX_EDGES_PER_COMPONENT || c.edges.length > left) continue;
    left -= c.edges.length;
    granted.add(c);
  }
  return granted;
}

function compute(graph: ServiceGraph, opts: LayoutOptionsInput): LaidOut {
  // Duplicate node ids: the first one wins (the stable sort keeps input order among equal ids).
  const graphNodes = [...graph.nodes].sort((a, b) => cmp(a.id, b.id)).filter((n, i, all) => i === 0 || all[i - 1].id !== n.id);
  const kindById = new Map(graphNodes.map((n) => [n.id, n.kind]));
  const namespaces = graph.namespaces
    .map((ns) => ({ name: ns.name, serviceIds: [...new Set(ns.serviceIds)].filter((id) => kindById.get(id) === 'service').sort(cmp) }))
    .sort((a, b) => cmp(a.name, b.name));

  const boxOf = new Map<string, string>(); // hidden service id → collapsed leaf id
  const parentOf = new Map<string, string>(); // visible service id → group id
  const owned = new Map<string, string[]>(); // namespace → its services (a service belongs to its first namespace)
  for (const ns of namespaces) {
    const ids = ns.serviceIds.filter((id) => !boxOf.has(id) && !parentOf.has(id));
    if (ids.length === 0) continue;
    owned.set(ns.name, ids);
    for (const id of ids) (opts.collapsed.has(ns.name) ? boxOf : parentOf).set(id, groupId(ns.name));
  }

  const edges = visibleEdges(graph, new Set(kindById.keys()), boxOf);
  const { vertical } = opts;

  // ---- items -------------------------------------------------------------------------------------
  const items: Item[] = [];
  const leafItem = (id: string, col: number, size: Size): Item =>
    ({ id, col, group: false, ...size, centers: new Map([[id, { x: size.width / 2, y: size.height / 2 }]]), children: [] });
  for (const n of graphNodes) {
    if (!boxOf.has(n.id) && !parentOf.has(n.id)) items.push(leafItem(n.id, COLUMN[n.kind], SERVICE_GRAPH_NODE_SIZE[n.kind]));
  }
  const intraOf = new Map<string, [string, string][]>();
  for (const e of edges) {
    const g = parentOf.get(e.source);
    if (!g || g !== parentOf.get(e.target)) continue;
    const list = intraOf.get(g);
    if (list) list.push([e.source, e.target]); else intraOf.set(g, [[e.source, e.target]]);
  }
  const svc = SERVICE_GRAPH_NODE_SIZE.service;
  const p = GROUP_PADDING;
  const compsOf = new Map<string, Component[]>();
  for (const [name, ids] of owned) {
    if (!opts.collapsed.has(name)) compsOf.set(name, components(name, ids, intraOf.get(groupId(name)) ?? []));
  }
  const granted = dagreGrants([...compsOf.values()].flat());
  for (const [name, ids] of owned) {
    const id = groupId(name);
    if (opts.collapsed.has(name)) { items.push(leafItem(id, SERVICES_COLUMN, SERVICE_GRAPH_NODE_SIZE.namespace)); continue; }
    const inner = packNamespace(ids, compsOf.get(name)!.filter((c) => granted.has(c)), vertical);
    const children = ids.map((sid) => ({ id: sid, x: p.left + inner.pos.get(sid)!.x, y: p.top + inner.pos.get(sid)!.y }));
    items.push({
      id, col: SERVICES_COLUMN, group: true,
      width: p.left + inner.width + p.right, height: p.top + inner.height + p.bottom,
      centers: new Map(children.map((c) => [c.id, { x: c.x + svc.width / 2, y: c.y + svc.height / 2 }])),
      children,
    });
  }
  if (items.length === 0) return { nodes: [], groups: [], edges: [] };
  items.sort((a, b) => cmp(a.id, b.id));

  // ---- flow frame helpers ------------------------------------------------------------------------
  const mainExt = (it: Size) => (vertical ? it.height : it.width);
  const crossExt = (it: Size) => (vertical ? it.width : it.height);
  const crossOf = (pt: Point) => (vertical ? pt.x : pt.y);

  const itemOf = new Map<string, Item>();
  for (const it of items) for (const id of it.centers.keys()) itemOf.set(id, it);
  const links = new Map<Item, Link[]>(items.map((it) => [it, []]));
  for (const e of edges) {
    const a = itemOf.get(e.source); const b = itemOf.get(e.target);
    if (!a || !b || a.col === b.col) continue;
    const ca = a.centers.get(e.source)!; const cb = b.centers.get(e.target)!;
    links.get(a)!.push({ other: b, otherCenter: cb, ownCenter: ca });
    links.get(b)!.push({ other: a, otherCenter: ca, ownCenter: cb });
  }

  // ---- column ordering (barycenter) --------------------------------------------------------------
  const order: Item[][] = Array.from({ length: COLUMN_COUNT }, (_, c) => items.filter((it) => it.col === c));
  const start = new Map<Item, number>(); // cross-axis start of each item
  const extent: number[] = new Array(COLUMN_COUNT).fill(1);
  const stack = (c: number) => {
    let cursor = 0;
    for (const it of order[c]) { start.set(it, cursor); cursor += crossExt(it) + STACK_GAP; }
    extent[c] = Math.max(1, cursor - STACK_GAP);
  };
  for (let c = 0; c < COLUMN_COUNT; c++) stack(c);
  const reorder = (c: number) => {
    const key = new Map<Item, number>();
    for (const it of order[c]) {
      const ls = links.get(it)!;
      key.set(it, ls.length
        ? ls.reduce((s, l) => s + (start.get(l.other)! + crossOf(l.otherCenter)) / extent[l.other.col], 0) / ls.length
        : (start.get(it)! + crossExt(it) / 2) / extent[c]);
    }
    order[c] = [...order[c]].sort((a, b) => key.get(a)! - key.get(b)! || cmp(a.id, b.id));
    stack(c);
  };
  const sides = [COLUMN.gateway, COLUMN.dns, COLUMN.datastore];
  for (const c of sides) reorder(c);
  reorder(SERVICES_COLUMN);
  for (const c of sides) reorder(c);

  // ---- placement ---------------------------------------------------------------------------------
  const placed = new Set<number>();
  for (const c of [SERVICES_COLUMN, COLUMN.gateway, COLUMN.datastore, COLUMN.dns]) {
    let prevEnd: number | null = null;
    for (const it of order[c]) {
      const ls = links.get(it)!.filter((l) => placed.has(l.other.col));
      let s = ls.length
        ? Math.max(0, ls.reduce((sum, l) => sum + start.get(l.other)! + crossOf(l.otherCenter) - crossOf(l.ownCenter), 0) / ls.length)
        : 0;
      if (prevEnd !== null) s = Math.max(s, prevEnd + STACK_GAP);
      start.set(it, s);
      prevEnd = s + crossExt(it);
    }
    placed.add(c);
  }
  const colExt = order.map((col) => Math.max(0, ...col.map(mainExt)));
  const colStart: number[] = [];
  let cursor = 0;
  for (let c = 0; c < COLUMN_COUNT; c++) {
    colStart[c] = cursor;
    if (order[c].length > 0) cursor += colExt[c] + COLUMN_GAP;
  }

  const nodes: LaidOutNode[] = [];
  const groups: LaidOutGroup[] = [];
  for (const it of items) {
    const main = MARGIN + colStart[it.col] + (colExt[it.col] - mainExt(it)) / 2;
    const cross = MARGIN + start.get(it)!;
    const box = { x: vertical ? cross : main, y: vertical ? main : cross, width: it.width, height: it.height };
    if (!it.group) { nodes.push({ id: it.id, ...box }); continue; }
    groups.push({ id: it.id, label: it.id.slice('ns:'.length), ...box });
    for (const ch of it.children) nodes.push({ id: ch.id, x: ch.x, y: ch.y, width: svc.width, height: svc.height, parentId: it.id });
  }

  return {
    nodes: nodes.sort((a, b) => cmp(a.id, b.id)),
    groups: groups.sort((a, b) => cmp(a.id, b.id)),
    edges,
  };
}

/** Async for the canvas (which awaits it); rejects with a stable generic message on any failure. */
export async function layoutServiceGraph(graph: ServiceGraph, opts: LayoutOptionsInput): Promise<LaidOut> {
  try {
    return compute(graph, opts);
  } catch {
    // Errors can name nodes (graph ids): never pass them on.
    throw new Error(LAYOUT_FAILED);
  }
}
