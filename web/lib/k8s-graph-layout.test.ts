import { describe, it, expect } from 'vitest';
import { layoutServiceGraph, collapsedNodeId, groupId, type LaidOut } from './k8s-graph-layout';
import type { Evidence, GEdge, GKind, GNode, ServiceGraph } from './k8s-service-graph';

const gnode = (id: string, kind: GKind, namespace: string | null = null): GNode => ({ id, kind, label: id, namespace, meta: {} });
const gedge = (source: string, target: string, evidence: Evidence[] = ['config']): GEdge => ({ id: `${source}->${target}`, source, target, evidence });

function graphOf(namespaces: Record<string, string[]>, extra: GNode[], edges: GEdge[]): ServiceGraph {
  const nodes = [...extra];
  for (const [ns, svcs] of Object.entries(namespaces)) for (const s of svcs) nodes.push(gnode(`svc:${ns}/${s}`, 'service', ns));
  return {
    namespaces: Object.entries(namespaces).map(([name, svcs]) => ({ name, serviceIds: svcs.map((s) => `svc:${name}/${s}`), system: name === 'kube-system' })),
    nodes, edges, notes: [],
  };
}

// 3 namespaces / 12 services, DNS → gateway → services → datastores, cross-namespace calls (incl. a back-edge).
function fixture(): ServiceGraph {
  return graphOf(
    { shop: ['api', 'cart', 'catalog', 'web', 'search'], payments: ['pay', 'ledger', 'fraud', 'notify'], 'kube-system': ['kube-dns', 'metrics', 'coredns'] },
    [gnode('dns:shop.example.com', 'dns'), gnode('gw:shop/web', 'gateway', 'shop'), gnode('gw:payments/pay', 'gateway', 'payments'),
      gnode('ds:rds:orders', 'datastore'), gnode('ds:elasticache:sessions', 'datastore')],
    [
      gedge('dns:shop.example.com', 'gw:shop/web', ['routing']), gedge('gw:shop/web', 'svc:shop/web', ['routing']),
      gedge('gw:payments/pay', 'svc:payments/pay', ['routing']),
      gedge('svc:shop/web', 'svc:shop/api', ['trace']), gedge('svc:shop/api', 'svc:shop/cart'), gedge('svc:shop/api', 'svc:shop/catalog'),
      gedge('svc:shop/api', 'svc:payments/pay', ['trace', 'config']), gedge('svc:shop/cart', 'svc:payments/notify', ['config']),
      gedge('svc:payments/pay', 'svc:payments/ledger', ['trace']), gedge('svc:payments/pay', 'svc:payments/fraud'),
      gedge('svc:payments/ledger', 'ds:rds:orders'), gedge('svc:shop/cart', 'ds:elasticache:sessions'), gedge('svc:shop/catalog', 'ds:rds:orders', ['trace']),
      gedge('svc:payments/fraud', 'svc:shop/search', ['trace']),
    ].sort((a, b) => (a.id < b.id ? -1 : 1)),
  );
}

// 15 namespaces × 20 services with a deterministic pseudo-random call mesh.
function synthetic300(): ServiceGraph {
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const namespaces: Record<string, string[]> = {};
  for (let i = 0; i < 15; i++) namespaces[`ns${String(i).padStart(2, '0')}`] = Array.from({ length: 20 }, (_, j) => `s${j}`);
  const extra: GNode[] = [];
  for (let i = 0; i < 5; i++) extra.push(gnode(`dns:d${i}`, 'dns'));
  for (let i = 0; i < 10; i++) extra.push(gnode(`gw:ns${String(i).padStart(2, '0')}/g`, 'gateway', `ns${String(i).padStart(2, '0')}`));
  for (let i = 0; i < 20; i++) extra.push(gnode(`ds:rds:db${i}`, 'datastore'));
  const svcs = Object.entries(namespaces).flatMap(([ns, s]) => s.map((n) => `svc:${ns}/${n}`));
  const edges = new Map<string, GEdge>();
  const add = (s: string, t: string) => { if (s !== t) edges.set(`${s}->${t}`, gedge(s, t)); };
  for (let i = 0; i < 5; i++) add(`dns:d${i}`, `gw:ns${String(i * 2).padStart(2, '0')}/g`);
  for (let i = 0; i < 10; i++) add(`gw:ns${String(i).padStart(2, '0')}/g`, `svc:ns${String(i).padStart(2, '0')}/s0`);
  for (let k = 0; k < 450; k++) add(svcs[Math.floor(rnd() * 300)], svcs[Math.floor(rnd() * 300)]);
  for (let k = 0; k < 60; k++) add(svcs[Math.floor(rnd() * 300)], `ds:rds:db${Math.floor(rnd() * 20)}`);
  return graphOf(namespaces, extra, [...edges.values()]);
}

type Rect = { x: number; y: number; width: number; height: number };
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const kindOf = (g: ServiceGraph) => new Map(g.nodes.map((n) => [n.id, n.kind]));

/** Absolute rect of a laid-out node (child positions are relative to their group). */
function absRect(out: LaidOut, id: string): Rect {
  const n = out.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`missing node ${id}`);
  const p = n.parentId ? out.groups.find((g) => g.id === n.parentId)! : { x: 0, y: 0 };
  return { x: p.x + n.x, y: p.y + n.y, width: n.width, height: n.height };
}

function expectColumns(g: ServiceGraph, out: LaidOut, axis: 'x' | 'y') {
  const ext = axis === 'x' ? 'width' : 'height';
  const kinds = kindOf(g);
  // A collapsed-namespace leaf stands in the services column.
  const kind = (id: string) => kinds.get(id) ?? (id.startsWith('ns:') ? 'service' : undefined);
  const col = (k: GKind) => out.nodes.filter((n) => kind(n.id) === k).map((n) => absRect(out, n.id));
  const order: GKind[] = ['dns', 'gateway', 'service', 'datastore'];
  for (let i = 0; i < order.length - 1; i++) {
    const before = col(order[i]); const after = col(order[i + 1]);
    expect(before.length).toBeGreaterThan(0);
    expect(after.length).toBeGreaterThan(0);
    const maxEnd = Math.max(...before.map((r) => r[axis] + r[ext]));
    const minStart = Math.min(...after.map((r) => r[axis]));
    expect(maxEnd, `${order[i]} column must end before ${order[i + 1]} starts on ${axis}`).toBeLessThan(minStart);
  }
}

function expectContainedAndDisjoint(g: ServiceGraph, out: LaidOut) {
  for (const ns of g.namespaces) {
    const grp = out.groups.find((x) => x.id === groupId(ns.name));
    expect(grp, ns.name).toBeDefined();
    expect(grp!.label).toBe(ns.name);
    for (const id of ns.serviceIds) {
      const n = out.nodes.find((x) => x.id === id)!;
      expect(n.parentId).toBe(groupId(ns.name));
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.x + n.width).toBeLessThanOrEqual(grp!.width);
      expect(n.y + n.height).toBeLessThanOrEqual(grp!.height);
    }
  }
  for (let i = 0; i < out.groups.length; i++) for (let j = i + 1; j < out.groups.length; j++) {
    expect(overlaps(out.groups[i], out.groups[j]), `${out.groups[i].id} overlaps ${out.groups[j].id}`).toBe(false);
  }
  // Root-level leaves (DNS, gateway, datastore, collapsed namespaces) never sit inside a group box.
  for (const n of out.nodes.filter((x) => !x.parentId)) for (const grp of out.groups) {
    expect(overlaps(n, grp), `${n.id} intrudes into ${grp.id}`).toBe(false);
  }
}

const NONE: ReadonlySet<string> = new Set();

describe('layoutServiceGraph', () => {
  it('returns an empty layout for an empty graph', async () => {
    expect(await layoutServiceGraph({ namespaces: [], nodes: [], edges: [], notes: [] }, { collapsed: NONE, vertical: false }))
      .toEqual({ nodes: [], groups: [], edges: [] });
  });

  it('places every service inside its namespace group and keeps groups disjoint', async () => {
    const g = fixture();
    const out = await layoutServiceGraph(g, { collapsed: NONE, vertical: false });
    expect(out.groups.map((x) => x.id)).toEqual(['ns:kube-system', 'ns:payments', 'ns:shop']);
    expect(out.nodes).toHaveLength(g.nodes.length);
    expectContainedAndDisjoint(g, out);
    for (const n of out.nodes) for (const m of out.nodes) {
      if (n.id < m.id) expect(overlaps(absRect(out, n.id), absRect(out, m.id)), `${n.id} overlaps ${m.id}`).toBe(false);
    }
  });

  it('orders the columns DNS < gateway < services < datastores left to right', async () => {
    const g = fixture();
    expectColumns(g, await layoutServiceGraph(g, { collapsed: NONE, vertical: false }), 'x');
  });

  it('flips to top-to-bottom when vertical', async () => {
    const g = fixture();
    const out = await layoutServiceGraph(g, { collapsed: NONE, vertical: true });
    expectColumns(g, out, 'y');
    expectContainedAndDisjoint(g, out);
  });

  it('keeps every edge, cross-namespace ones included, with root-coordinate sections', async () => {
    const g = fixture();
    const out = await layoutServiceGraph(g, { collapsed: NONE, vertical: false });
    expect(out.edges.map((e) => e.id)).toEqual(g.edges.map((e) => e.id));
    for (const e of out.edges) {
      const src = g.edges.find((x) => x.id === e.id)!;
      expect(e).toMatchObject({ source: src.source, target: src.target, evidence: src.evidence, count: 1, edgeIds: [src.id] });
      const sec = (e.sections as { startPoint: { x: number; y: number }; endPoint: { x: number; y: number } }[])[0];
      const inside = (p: { x: number; y: number }, r: Rect) => p.x >= r.x - 1 && p.x <= r.x + r.width + 1 && p.y >= r.y - 1 && p.y <= r.y + r.height + 1;
      expect(inside(sec.startPoint, absRect(out, e.source)), `${e.id} start`).toBe(true);
      expect(inside(sec.endPoint, absRect(out, e.target)), `${e.id} end`).toBe(true);
    }
  });

  it('collapses a namespace into one leaf and aggregates edges per box pair with an evidence union', async () => {
    const g = fixture();
    const out = await layoutServiceGraph(g, { collapsed: new Set(['payments']), vertical: false });
    const leaf = collapsedNodeId('payments');
    expect(out.groups.map((x) => x.id)).toEqual(['ns:kube-system', 'ns:shop']);
    expect(out.nodes.filter((n) => n.id.startsWith('svc:payments/'))).toEqual([]);
    expect(out.nodes.filter((n) => n.id === leaf)).toHaveLength(1);
    expect(out.nodes.find((n) => n.id === leaf)!.parentId).toBeUndefined();

    const touching = (e: GEdge) => e.source.startsWith('svc:payments/') || e.target.startsWith('svc:payments/');
    const box = (id: string) => (id.startsWith('svc:payments/') ? leaf : id);
    const crossBox = g.edges.filter((e) => touching(e) && box(e.source) !== box(e.target));
    const agg = out.edges.filter((e) => e.source === leaf || e.target === leaf);
    expect(agg.reduce((s, e) => s + e.count, 0)).toBe(crossBox.length);
    expect(agg.flatMap((e) => e.edgeIds).sort()).toEqual(crossBox.map((e) => e.id).sort());
    // shop/api → payments/pay [trace, config] (no other shop/api → payments edge)
    expect(agg.find((e) => e.source === 'svc:shop/api')).toMatchObject({ target: leaf, count: 1, evidence: ['trace', 'config'] });
    // gw:payments/pay → payments/pay
    expect(agg.find((e) => e.source === 'gw:payments/pay')).toMatchObject({ target: leaf, count: 1, evidence: ['routing'] });
    // payments/ledger → rds:orders
    expect(agg.find((e) => e.target === 'ds:rds:orders')).toMatchObject({ source: leaf, count: 1, evidence: ['config'] });
    // intra-namespace edges inside a collapsed box disappear; untouched edges pass through as-is
    expect(out.edges.find((e) => e.id === 'svc:shop/web->svc:shop/api')).toMatchObject({ count: 1, evidence: ['trace'] });
    expect(out.edges.some((e) => e.source === e.target)).toBe(false);
    expectColumns(g, out, 'x');
  });

  it('merges several hidden edges between the same two boxes into one with a summed count', async () => {
    const g = fixture();
    const out = await layoutServiceGraph(g, { collapsed: new Set(['payments', 'shop']), vertical: false });
    const between = out.edges.filter((e) => e.source === 'ns:shop' && e.target === 'ns:payments');
    // shop/api→payments/pay [trace,config] + shop/cart→payments/notify [config]
    expect(between).toEqual([expect.objectContaining({ count: 2, evidence: ['trace', 'config'], edgeIds: ['svc:shop/api->svc:payments/pay', 'svc:shop/cart->svc:payments/notify'] })]);
    const back = out.edges.filter((e) => e.source === 'ns:payments' && e.target === 'ns:shop');
    expect(back).toEqual([expect.objectContaining({ count: 1, evidence: ['trace'] })]);
    const ds = out.edges.filter((e) => e.source === 'ns:shop' && e.target === 'ds:rds:orders');
    expect(ds).toEqual([expect.objectContaining({ count: 1, evidence: ['trace'] })]);
    const groupsAndLeaves = [...out.groups, ...out.nodes.filter((n) => !n.parentId)];
    for (let i = 0; i < groupsAndLeaves.length; i++) for (let j = i + 1; j < groupsAndLeaves.length; j++) {
      expect(overlaps(groupsAndLeaves[i], groupsAndLeaves[j])).toBe(false);
    }
  });

  it('ignores collapsed names that are not namespaces of the graph', async () => {
    const g = fixture();
    const a = await layoutServiceGraph(g, { collapsed: new Set(['nope']), vertical: false });
    const b = await layoutServiceGraph(g, { collapsed: NONE, vertical: false });
    expect(a).toEqual(b);
  });

  it('skips namespaces without services (no empty group box)', async () => {
    const g = fixture();
    g.namespaces.push({ name: 'zz-empty', serviceIds: [], system: false });
    const out = await layoutServiceGraph(g, { collapsed: new Set(['zz-empty']), vertical: false });
    expect(out.groups.some((x) => x.id === 'ns:zz-empty')).toBe(false);
    expect(out.nodes.some((x) => x.id === 'ns:zz-empty')).toBe(false);
  });

  it('is deterministic and independent of input array order, and never mutates its input', async () => {
    const g = fixture();
    const snapshot = structuredClone(g);
    const a = await layoutServiceGraph(g, { collapsed: new Set(['kube-system']), vertical: false });
    expect(g).toEqual(snapshot);
    const shuffled: ServiceGraph = {
      ...snapshot,
      namespaces: [...snapshot.namespaces].reverse().map((n) => ({ ...n, serviceIds: [...n.serviceIds].reverse() })),
      nodes: [...snapshot.nodes].reverse(), edges: [...snapshot.edges].reverse(),
    };
    const b = await layoutServiceGraph(shuffled, { collapsed: new Set(['kube-system']), vertical: false });
    expect(b).toEqual(a);
  });

  it('gives the same result for overlapping calls on the shared elk instance', async () => {
    const g = fixture();
    const seq = [await layoutServiceGraph(g, { collapsed: NONE, vertical: false }), await layoutServiceGraph(g, { collapsed: NONE, vertical: true })];
    const par = await Promise.all([layoutServiceGraph(g, { collapsed: NONE, vertical: false }), layoutServiceGraph(g, { collapsed: NONE, vertical: true })]);
    expect(par).toEqual(seq);
  });

  it('lays out a 300-service graph with every namespace collapsed in well under 5 s', async () => {
    const g = synthetic300();
    const collapsed = new Set(g.namespaces.map((n) => n.name));
    const t0 = performance.now();
    const out = await layoutServiceGraph(g, { collapsed, vertical: false });
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(5000);
    expect(out.groups).toEqual([]);
    expect(out.nodes.filter((n) => n.id.startsWith('ns:'))).toHaveLength(15);
    const hiddenCross = g.edges.filter((e) => {
      const b = (id: string) => (id.startsWith('svc:') ? `ns:${id.slice(4, id.indexOf('/'))}` : id);
      return b(e.source) !== b(e.target);
    });
    expect(out.edges.reduce((s, e) => s + e.count, 0)).toBe(hiddenCross.length);
    expectColumns(g, out, 'x');
  });
});
