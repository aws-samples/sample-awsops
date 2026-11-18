import { describe, it, expect } from 'vitest';
import { layoutServiceGraph, collapsedNodeId, groupId, GROUP_PADDING, SERVICE_GRAPH_NODE_SIZE, type LaidOut } from './k8s-graph-layout';
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
      expect(n.x).toBeGreaterThanOrEqual(GROUP_PADDING.left);
      expect(n.y, `${id} below the label header`).toBeGreaterThanOrEqual(GROUP_PADDING.top);
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

  it('keeps every edge, cross-namespace ones included, with no precomputed route sections', async () => {
    const g = fixture();
    const out = await layoutServiceGraph(g, { collapsed: NONE, vertical: false });
    expect(out.edges.map((e) => e.id)).toEqual(g.edges.map((e) => e.id));
    for (const e of out.edges) {
      const src = g.edges.find((x) => x.id === e.id)!;
      expect(e).toMatchObject({ source: src.source, target: src.target, evidence: src.evidence, count: 1, edgeIds: [src.id] });
      // The canvas routes every edge itself (smoothstep between handles).
      expect(e.sections).toBeUndefined();
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

  it('gives the same result for overlapping calls', async () => {
    const g = fixture();
    const seq = [await layoutServiceGraph(g, { collapsed: NONE, vertical: false }), await layoutServiceGraph(g, { collapsed: NONE, vertical: true })];
    const par = await Promise.all([layoutServiceGraph(g, { collapsed: NONE, vertical: false }), layoutServiceGraph(g, { collapsed: NONE, vertical: true })]);
    expect(par).toEqual(seq);
  });

  it('is input-order independent when vertical too', async () => {
    const g = fixture();
    const shuffled: ServiceGraph = {
      ...g,
      namespaces: [...g.namespaces].reverse().map((n) => ({ ...n, serviceIds: [...n.serviceIds].reverse() })),
      nodes: [...g.nodes].reverse(), edges: [...g.edges].reverse(),
    };
    expect(await layoutServiceGraph(shuffled, { collapsed: NONE, vertical: true })).toEqual(await layoutServiceGraph(g, { collapsed: NONE, vertical: true }));
  });

  it('skips dangling edges whose endpoints are not graph nodes', async () => {
    const g = fixture();
    g.edges.push(gedge('svc:shop/api', 'ds:rds:ghost'), gedge('gw:ghost', 'svc:shop/web'));
    const out = await layoutServiceGraph(g, { collapsed: NONE, vertical: false });
    expect(out.edges.some((e) => e.id.includes('ghost'))).toBe(false);
    expect(out.nodes.some((n) => n.id.includes('ghost'))).toBe(false);
    expect(out.edges).toHaveLength(g.edges.length - 2);
  });

  it('keeps isolated DNS, gateway and datastore nodes in their own columns', async () => {
    const g = fixture();
    g.nodes.push(gnode('dns:lonely.example.com', 'dns'), gnode('gw:shop/lonely', 'gateway', 'shop'), gnode('ds:rds:lonely', 'datastore'));
    for (const vertical of [false, true]) {
      const out = await layoutServiceGraph(g, { collapsed: NONE, vertical });
      expect(out.nodes.filter((n) => n.id.includes('lonely')).every((n) => n.parentId === undefined)).toBe(true);
      expectColumns(g, out, vertical ? 'y' : 'x');
      expectContainedAndDisjoint(g, out);
    }
  });

  it('places a service whose namespace is not listed as a root-level node in the services column', async () => {
    const g = fixture();
    g.nodes.push(gnode('svc:orphan/x', 'service', 'orphan'));
    g.edges.push(gedge('gw:shop/web', 'svc:orphan/x', ['routing']), gedge('svc:orphan/x', 'ds:rds:orders'));
    const out = await layoutServiceGraph(g, { collapsed: NONE, vertical: false });
    const orphan = out.nodes.find((n) => n.id === 'svc:orphan/x')!;
    expect(orphan.parentId).toBeUndefined();
    expect(orphan).toMatchObject(SERVICE_GRAPH_NODE_SIZE.service);
    expect(out.groups.some((x) => x.id === 'ns:orphan')).toBe(false);
    expectColumns(g, out, 'x');
    expectContainedAndDisjoint(g, out);
  });

  it('wraps services without intra-namespace edges into a compact grid', async () => {
    const svcs = Array.from({ length: 9 }, (_, i) => `s${i}`);
    for (const vertical of [false, true]) {
      const g = graphOf({ prod: svcs }, [], []);
      const out = await layoutServiceGraph(g, { collapsed: NONE, vertical });
      const grp = out.groups[0];
      const kids = out.nodes.filter((n) => n.parentId === grp.id);
      expect(kids).toHaveLength(9);
      expect(new Set(kids.map((n) => n.x)).size, 'more than one grid column').toBeGreaterThan(1);
      expect(new Set(kids.map((n) => n.y)).size, 'more than one grid row').toBeGreaterThan(1);
      for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) expect(overlaps(kids[i], kids[j])).toBe(false);
      expect(Math.max(grp.width / grp.height, grp.height / grp.width)).toBeLessThanOrEqual(2.5);
      expectContainedAndDisjoint(g, out);
    }
  });

  it('keeps a 300-service namespace without internal edges roughly square', async () => {
    const g = graphOf({ big: Array.from({ length: 300 }, (_, i) => `s${String(i).padStart(3, '0')}`) }, [], []);
    const out = await layoutServiceGraph(g, { collapsed: NONE, vertical: false });
    const grp = out.groups[0];
    expect(Math.max(grp.width / grp.height, grp.height / grp.width)).toBeLessThanOrEqual(2);
    expectContainedAndDisjoint(g, out);
  });

  it('bounds the time spent on a dense call mesh inside one namespace (grid fallback)', async () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const names = Array.from({ length: 300 }, (_, i) => `s${String(i).padStart(3, '0')}`);
    const edges = new Map<string, GEdge>();
    for (let k = 0; k < 900; k++) {
      const a = `svc:mesh/${names[Math.floor(rnd() * 300)]}`; const b = `svc:mesh/${names[Math.floor(rnd() * 300)]}`;
      if (a !== b) edges.set(`${a}->${b}`, gedge(a, b));
    }
    const g = graphOf({ mesh: names }, [], [...edges.values()]);
    const t0 = performance.now();
    const out = await layoutServiceGraph(g, { collapsed: NONE, vertical: false });
    expect(performance.now() - t0).toBeLessThan(5000);
    const grp = out.groups[0];
    expect(Math.max(grp.width / grp.height, grp.height / grp.width)).toBeLessThanOrEqual(2);
    expectContainedAndDisjoint(g, out);
  });

  // Namespace `a`: 4 components of 18 services with 150 edges each (i→j for i<j, first 150 pairs);
  // namespace `z`: the chain p→q→r. 2 + 4×150 edges exceed the 600-edge layout-wide dagre budget.
  function budgetGraph(): ServiceGraph {
    const comps = ['c0', 'c1', 'c2', 'c3'];
    const n = (c: string, i: number) => `${c}n${String(i).padStart(2, '0')}`;
    const edges: GEdge[] = [gedge('svc:z/p', 'svc:z/q'), gedge('svc:z/q', 'svc:z/r')];
    for (const c of comps) {
      const pairs: [number, number][] = [];
      for (let i = 0; i < 18; i++) for (let j = i + 1; j < 18; j++) pairs.push([i, j]);
      for (const [i, j] of pairs.slice(0, 150)) edges.push(gedge(`svc:a/${n(c, i)}`, `svc:a/${n(c, j)}`));
    }
    return graphOf({ a: comps.flatMap((c) => Array.from({ length: 18 }, (_, i) => n(c, i))), z: ['p', 'q', 'r'] }, [], edges);
  }
  const childrenOf = (o: LaidOut, grp: string) => o.nodes.filter((x) => x.parentId === grp);

  it('spends the dagre budget on the cheapest components first, so a small namespace never depends on others', async () => {
    const g = budgetGraph();
    const expanded = await layoutServiceGraph(g, { collapsed: NONE, vertical: false });
    const aCollapsed = await layoutServiceGraph(g, { collapsed: new Set(['a']), vertical: false });
    expect(childrenOf(expanded, 'ns:z')).toEqual(childrenOf(aCollapsed, 'ns:z'));
    const at = (id: string) => expanded.nodes.find((x) => x.id === id)!;
    // z keeps its call direction (dagre), left to right on one row.
    expect(at('svc:z/p').x).toBeLessThan(at('svc:z/q').x);
    expect(at('svc:z/q').x).toBeLessThan(at('svc:z/r').x);
    expect(new Set(['p', 'q', 'r'].map((s) => at(`svc:z/${s}`).y)).size).toBe(1);
    expectContainedAndDisjoint(g, expanded);
  });

  it('grids the components that exceed the layout-wide dagre budget, deterministically', async () => {
    const g = budgetGraph();
    const out = await layoutServiceGraph(g, { collapsed: NONE, vertical: false });
    const at = (id: string) => out.nodes.find((x) => x.id === id)!;
    const svc = SERVICE_GRAPH_NODE_SIZE.service;
    // z (2 edges) then c0, c1, c2 (150 each, by smallest service id) fit in 600; c3 does not.
    for (const c of ['c0', 'c1', 'c2']) {
      // dagre: n01 is one rank after n00 (edge n00→n01).
      expect(at(`svc:a/${c}n01`).x - at(`svc:a/${c}n00`).x, c).toBeCloseTo(svc.width + 60);
    }
    // grid: n00 and n01 are neighbours in the first grid row.
    expect(at('svc:a/c3n01').x - at('svc:a/c3n00').x).toBe(svc.width + 24);
    expect(at('svc:a/c3n01').y).toBe(at('svc:a/c3n00').y);
    const shuffled: ServiceGraph = {
      ...g, namespaces: [...g.namespaces].reverse().map((x) => ({ ...x, serviceIds: [...x.serviceIds].reverse() })),
      nodes: [...g.nodes].reverse(), edges: [...g.edges].reverse(),
    };
    expect(await layoutServiceGraph(shuffled, { collapsed: NONE, vertical: false })).toEqual(out);
  });

  it('ignores duplicate node ids and duplicate namespace service ids (first one wins)', async () => {
    const g = fixture();
    const clean = await layoutServiceGraph(g, { collapsed: NONE, vertical: false });
    const dup: ServiceGraph = {
      ...g,
      namespaces: g.namespaces.map((ns) => ({ ...ns, serviceIds: [...ns.serviceIds, ns.serviceIds[0]] })),
      nodes: [...g.nodes, gnode('svc:shop/api', 'service', 'shop'), gnode('dns:shop.example.com', 'datastore')],
    };
    const out = await layoutServiceGraph(dup, { collapsed: NONE, vertical: false });
    expect(out).toEqual(clean);
    expect(new Set(out.nodes.map((n) => n.id)).size).toBe(out.nodes.length);
  });

  it('uses the intra-namespace call direction inside a box and grids the unconnected rest', async () => {
    const g = graphOf({ prod: ['a', 'b', 'c', 'x', 'y'] }, [], [gedge('svc:prod/a', 'svc:prod/b'), gedge('svc:prod/b', 'svc:prod/c')]);
    const horiz = await layoutServiceGraph(g, { collapsed: NONE, vertical: false });
    const at = (o: LaidOut, id: string) => o.nodes.find((n) => n.id === id)!;
    expect(at(horiz, 'svc:prod/a').x).toBeLessThan(at(horiz, 'svc:prod/b').x);
    expect(at(horiz, 'svc:prod/b').x).toBeLessThan(at(horiz, 'svc:prod/c').x);
    const vert = await layoutServiceGraph(g, { collapsed: NONE, vertical: true });
    expect(at(vert, 'svc:prod/a').y).toBeLessThan(at(vert, 'svc:prod/b').y);
    expect(at(vert, 'svc:prod/b').y).toBeLessThan(at(vert, 'svc:prod/c').y);
    expectContainedAndDisjoint(g, horiz);
    expectContainedAndDisjoint(g, vert);
  });

  it('orders boxes and leaves within each column by the barycenter of their neighbours', async () => {
    // Id order alone would cross every link: gw:a→ns zeta, gw:b→ns alpha; alpha→ds:z, zeta→ds:a.
    const g = graphOf({ alpha: ['s'], zeta: ['s'] },
      [gnode('gw:a', 'gateway'), gnode('gw:b', 'gateway'), gnode('ds:a', 'datastore'), gnode('ds:z', 'datastore'),
        gnode('dns:a', 'dns'), gnode('dns:b', 'dns')],
      [gedge('dns:a', 'gw:b'), gedge('dns:b', 'gw:a'), gedge('gw:a', 'svc:zeta/s'), gedge('gw:b', 'svc:alpha/s'),
        gedge('svc:alpha/s', 'ds:z'), gedge('svc:zeta/s', 'ds:a')]);
    for (const vertical of [false, true]) {
      for (const collapsed of [NONE, new Set(['alpha', 'zeta'])]) {
        const out = await layoutServiceGraph(g, { collapsed, vertical });
        const cross = (id: string) => {
          const r = out.groups.find((x) => x.id === id) ?? absRect(out, id);
          return vertical ? r.x + r.width / 2 : r.y + r.height / 2;
        };
        // Every chain dns → gw → ns → ds keeps its rank in each column: no crossings.
        const before = (a: string, b: string) => cross(a) < cross(b);
        expect(before('gw:b', 'gw:a')).toBe(before('dns:a', 'dns:b'));
        expect(before('ns:alpha', 'ns:zeta')).toBe(before('gw:b', 'gw:a'));
        expect(before('ds:z', 'ds:a')).toBe(before('ns:alpha', 'ns:zeta'));
        expectColumns(g, out, vertical ? 'y' : 'x');
      }
    }
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

  it('lays out a 300-service graph with every namespace expanded in well under 5 s, without overlaps', async () => {
    const g = synthetic300();
    const t0 = performance.now();
    const out = await layoutServiceGraph(g, { collapsed: NONE, vertical: false });
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(5000);
    expect(out.groups).toHaveLength(15);
    expect(out.nodes).toHaveLength(g.nodes.length);
    expectContainedAndDisjoint(g, out);
    for (const grp of out.groups) expect(Math.max(grp.width / grp.height, grp.height / grp.width), grp.id).toBeLessThanOrEqual(4);
    expectColumns(g, out, 'x');
    const vert = await layoutServiceGraph(g, { collapsed: NONE, vertical: true });
    expectContainedAndDisjoint(g, vert);
    expectColumns(g, vert, 'y');
  });
});
