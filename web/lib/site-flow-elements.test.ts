import { describe, expect, it, vi } from 'vitest';
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import type { SiteFlow } from './site-flow';
import { buildSiteElements, initialExpanded, toggleGroup, zoomLimits, LABEL_PX } from './site-flow-elements';
import { buildSiteStyle, readSitePalette, type SitePalette } from './site-flow-style';

const ARN = 'arn:aws:eks:ap-northeast-2:123456789012:cluster/shop';
const CL = `eks:${ARN}`;
const NS = `ns:${ARN}:web`;

/** Synthetic host flow: DNS → CDN → LB → cluster/namespace workloads → datastore group. */
function flow(over: Partial<SiteFlow> = {}): SiteFlow {
  return {
    host: 'shop.example.com', path: null,
    nodes: [
      { id: 'dns1', kind: 'dns', label: 'shop.example.com', group: 'host:shop.example.com' },
      { id: 'cf1', kind: 'cdn', label: 'E123', group: 'cdn:cf1' },
      { id: 'cf1/beh:default', kind: 'behavior', label: 'default', group: 'cdn:cf1' },
      { id: 'alb1', kind: 'lb', label: 'alb-web', group: 'lb:alb1' },
      { id: 'tg1', kind: 'tg', label: 'tg-web', group: 'lb:alb1' },
      { id: 'wl:front', kind: 'workload', label: 'front', group: NS },
      { id: 'wl:api', kind: 'workload', label: 'api', group: NS },
      { id: 'svc:cart', kind: 'service', label: 'cart', group: CL },
      { id: 'db1', kind: 'datastore', label: 'orders-db', group: 'datastore:rds' },
      { id: 'db2', kind: 'datastore', label: 'cache', group: 'datastore:rds' },
      { id: 'lonely', kind: 'target', label: '10.0.0.9', group: 'missing-group' },
    ],
    edges: [
      { id: 'e1', source: 'dns1', target: 'cf1', evidence: 'configured' },
      { id: 'e2', source: 'cf1', target: 'cf1/beh:default', evidence: 'configured' },
      { id: 'e3', source: 'cf1/beh:default', target: 'alb1', evidence: 'configured' },
      { id: 'e4', source: 'alb1', target: 'tg1', evidence: 'observed' },
      { id: 'e5', source: 'tg1', target: 'wl:front', evidence: 'observed' },
      { id: 'e6', source: 'tg1', target: 'wl:api', evidence: 'inferred' },
      { id: 'e7', source: 'wl:front', target: 'wl:api', evidence: 'traced', calls: 50, errors: 0 },
      { id: 'e8', source: 'wl:api', target: 'db1', evidence: 'traced', calls: 30, errors: 2 },
      { id: 'e9', source: 'wl:api', target: 'db2', evidence: 'configured' },
      { id: 'e10', source: 'wl:front', target: 'db1', evidence: 'configured' },
      { id: 'e11', source: 'tg1', target: 'lonely', evidence: 'observed' },
      { id: 'dangling', source: 'tg1', target: 'nope', evidence: 'observed' },
    ],
    groups: [
      { id: 'host:shop.example.com', kind: 'host', label: 'shop.example.com' },
      { id: 'cdn:cf1', kind: 'cdn', label: 'E123', parent: 'host:shop.example.com' },
      { id: 'lb:alb1', kind: 'lb', label: 'alb-web', parent: 'cdn:cf1' },
      { id: CL, kind: 'cluster', label: 'shop', parent: 'lb:alb1' },
      { id: NS, kind: 'namespace', label: 'web', parent: CL },
      { id: 'datastore:rds', kind: 'datastore', label: 'rds', parent: 'host:shop.example.com' },
    ],
    highlight: null, gaps: [],
    ...over,
  };
}

type El = { group?: string; data: Record<string, unknown>; classes?: string };
const byId = (els: El[]) => new Map(els.map((e) => [String(e.data.id), e]));
const cls = (e: El | undefined) => new Set(String(e?.classes ?? '').split(/\s+/).filter(Boolean));

describe('initialExpanded', () => {
  it('opens host/cdn/lb groups and collapses cluster/namespace/datastore groups', () => {
    expect([...initialExpanded(flow())].sort()).toEqual(['cdn:cf1', 'host:shop.example.com', 'lb:alb1']);
  });
  it('toggleGroup returns a new set with the id flipped', () => {
    const a = new Set(['x']);
    expect([...toggleGroup(a, 'x')]).toEqual([]);
    expect([...toggleGroup(a, 'y')].sort()).toEqual(['x', 'y']);
    expect([...a]).toEqual(['x']);
  });
});

describe('buildSiteElements', () => {
  it('sets compound parents from groups and drops parents that are not known groups', () => {
    const els = byId(buildSiteElements(flow(), initialExpanded(flow())) as El[]);
    expect(els.get('cdn:cf1')?.data.parent).toBe('host:shop.example.com');
    expect(els.get('lb:alb1')?.data.parent).toBe('cdn:cf1');
    expect(els.get('cf1')?.data.parent).toBe('cdn:cf1');
    expect(els.get('tg1')?.data.parent).toBe('lb:alb1');
    expect(els.get('host:shop.example.com')?.data.parent).toBeUndefined();
    expect(els.get('lonely')?.data.parent).toBeUndefined();
    expect(cls(els.get('cdn:cf1')).has('expanded')).toBe(true);
  });

  it('collapses cluster and datastore groups into one node labelled (+N), hiding children', () => {
    const els = byId(buildSiteElements(flow(), initialExpanded(flow())) as El[]);
    const cluster = els.get(CL)!;
    expect(cluster.data.label).toBe('shop (+3)');
    expect(cluster.data.count).toBe(3);
    expect(cluster.data.parent).toBe('lb:alb1');
    expect(cls(cluster).has('collapsed')).toBe(true);
    expect(els.get('datastore:rds')?.data.label).toBe('rds (+2)');
    // the nested namespace and every hidden leaf are absent
    for (const id of [NS, 'wl:front', 'wl:api', 'svc:cart', 'db1', 'db2']) expect(els.has(id)).toBe(false);
  });

  it('re-points edges to collapsed groups, drops internal ones and dedupes keeping the strongest evidence', () => {
    const els = buildSiteElements(flow(), initialExpanded(flow())) as El[];
    const edges = els.filter((e) => e.group === 'edges');
    // tg1 → front (observed) and tg1 → api (inferred) merge into one observed edge to the cluster
    const toCluster = edges.filter((e) => e.data.source === 'tg1' && e.data.target === CL);
    expect(toCluster).toHaveLength(1);
    expect(toCluster[0].data.evidence).toBe('observed');
    expect(toCluster[0].data.members).toEqual(['e5', 'e6']);
    // cluster → datastore: traced(e8) + configured(e9, e10) → one traced edge with summed calls/errors
    const toDb = edges.filter((e) => e.data.source === CL && e.data.target === 'datastore:rds');
    expect(toDb).toHaveLength(1);
    expect(toDb[0].data).toMatchObject({ evidence: 'traced', calls: 30, errors: 2 });
    expect(cls(toDb[0]).has('has-errors')).toBe(true);
    // front → api is internal to the collapsed cluster
    expect(edges.some((e) => (e.data.members as string[]).includes('e7'))).toBe(false);
    // edges with an unknown endpoint never render
    expect(edges.some((e) => (e.data.members as string[]).includes('dangling'))).toBe(false);
    // an untouched edge keeps its own id
    expect(edges.find((e) => e.data.id === 'e4')?.data.members).toEqual(['e4']);
  });

  it('expanding the cluster reveals the nested namespace still collapsed', () => {
    const exp = toggleGroup(initialExpanded(flow()), CL);
    const els = byId(buildSiteElements(flow(), exp) as El[]);
    expect(cls(els.get(CL)).has('expanded')).toBe(true);
    expect(els.get(CL)?.data.label).toBe('shop');
    expect(els.get('svc:cart')?.data.parent).toBe(CL);
    expect(els.get(NS)?.data).toMatchObject({ label: 'web (+2)', parent: CL });
    expect(els.has('wl:front')).toBe(false);
  });

  it('labels traced edges with calls and the error count only when errors > 0', () => {
    const all = new Set(flow().groups.map((g) => g.id));
    const els = byId(buildSiteElements(flow(), all, { errors: 'ERR' }) as El[]);
    expect(els.get('e7')?.data.label).toBe('50');
    expect(cls(els.get('e7')).has('has-errors')).toBe(false);
    expect(els.get('e8')?.data.label).toBe('30 · ERR 2');
    expect(cls(els.get('e8')).has('has-errors')).toBe(true);
    expect(els.get('e9')?.data.label).toBeUndefined();
    for (const [id, ev] of [['e4', 'observed'], ['e6', 'inferred'], ['e9', 'configured'], ['e7', 'traced']]) {
      expect(cls(els.get(id)).has(`ev-${ev}`)).toBe(true);
    }
  });

  it('fades elements outside the highlight and marks the inferred overlay separately', () => {
    const f = flow({ highlight: { nodes: ['dns1', 'cf1', 'wl:front'], edges: ['e1', 'e5'], inferred: ['wl:api', 'e6', 'e7'] } });
    const all = new Set(f.groups.map((g) => g.id));
    const els = byId(buildSiteElements(f, all) as El[]);
    expect(cls(els.get('dns1')).has('hl')).toBe(true);
    expect(cls(els.get('tg1')).has('faded')).toBe(true);
    expect(cls(els.get('wl:api')).has('inferred')).toBe(true);
    expect(cls(els.get('wl:api')).has('faded')).toBe(false);
    expect(cls(els.get('e1')).has('hl')).toBe(true);
    expect(cls(els.get('e4')).has('faded')).toBe(true);
    // inferred overlay is its own class; the edge keeps its own evidence class
    expect(cls(els.get('e7'))).toEqual(new Set(['ev-traced', 'inferred']));
    // compound containing a highlighted leaf is not faded; one without is
    expect(cls(els.get(NS)).has('faded')).toBe(false);
    expect(cls(els.get('datastore:rds')).has('faded')).toBe(true);
  });

  it('rolls highlight up to collapsed groups and merged edges', () => {
    const f = flow({ highlight: { nodes: ['tg1'], edges: [], inferred: ['wl:api', 'e6'] } });
    const els = byId(buildSiteElements(f, initialExpanded(f)) as El[]);
    expect(cls(els.get(CL))).toEqual(new Set(['group', 'collapsed', 'gkind-cluster', 'inferred']));
    const merged = [...els.values()].find((e) => e.data.source === 'tg1' && e.data.target === CL)!;
    expect(cls(merged).has('inferred')).toBe(true);
    expect(cls(els.get('datastore:rds')).has('faded')).toBe(true);
    // a highlighted member wins over the inferred overlay
    const g = flow({ highlight: { nodes: ['wl:front'], edges: ['e5'], inferred: ['wl:api', 'e6'] } });
    const els2 = byId(buildSiteElements(g, initialExpanded(g)) as El[]);
    expect(cls(els2.get(CL)).has('hl')).toBe(true);
    const merged2 = [...els2.values()].find((e) => e.data.source === 'tg1' && e.data.target === CL)!;
    expect(cls(merged2)).toEqual(new Set(['ev-observed', 'hl']));
  });

  it('is accepted by a real headless cytoscape (no dangling parents/endpoints or duplicate ids)', () => {
    for (const exp of [initialExpanded(flow()), new Set(flow().groups.map((g) => g.id)), new Set<string>()]) {
      const els = buildSiteElements(flow(), exp);
      const cy = cytoscape({ headless: true, elements: els });
      expect(cy.elements().length).toBe(els.length);
      cy.edges().forEach((e) => { expect(e.source().nonempty() && e.target().nonempty()).toBe(true); });
      cy.destroy();
    }
  });

  it('tolerates parent cycles without looping', () => {
    const f = flow({ groups: [{ id: 'a', kind: 'cluster', label: 'a', parent: 'b' }, { id: 'b', kind: 'cluster', label: 'b', parent: 'a' }],
      nodes: [{ id: 'n', kind: 'workload', label: 'n', group: 'a' }], edges: [] });
    expect(() => buildSiteElements(f, new Set(['a', 'b']))).not.toThrow();
    expect(() => buildSiteElements(f, new Set())).not.toThrow();
  });
});

describe('zoomLimits', () => {
  it('keeps labels at least 10px for up to 60 visible elements', () => {
    expect(zoomLimits(60).minZoom * LABEL_PX).toBeGreaterThanOrEqual(10);
    expect(zoomLimits(61).minZoom).toBeLessThan(zoomLimits(60).minZoom);
    expect(zoomLimits(10).maxZoom).toBeGreaterThan(1);
  });
});

describe('buildSiteStyle', () => {
  const palette: SitePalette = {
    fg: '#111111', muted: '#555555', surface: '#ffffff', groupBg: '#eeeeee', border: '#cccccc', edge: '#888888',
    highlight: '#00aa88', inferred: '#f59e0b', error: '#d13212',
    kinds: { dns: '#1', cdn: '#2', behavior: '#3', origin: '#4', lb: '#5', rule: '#6', tg: '#7', target: '#8', workload: '#9', service: '#a', datastore: '#b' },
    groups: { host: '#1', cdn: '#2', lb: '#5', cluster: '#9', namespace: '#9', datastore: '#b' },
  };
  const style = buildSiteStyle(palette);
  const rule = (sel: string) => style.find((s) => s.selector === sel)?.style as Record<string, unknown> | undefined;
  it('never styles inferred edges like observed ones', () => {
    expect(rule('edge.ev-observed')?.['line-style']).toBe('solid');
    expect(rule('edge.ev-configured')?.['line-style']).toBe('dotted');
    expect(rule('edge.ev-inferred')?.['line-style']).toBe('dashed');
    expect(rule('edge.inferred')).toMatchObject({ 'line-style': 'dashed', 'line-color': '#f59e0b' });
    expect(rule('edge.inferred')?.['line-color']).not.toBe(rule('edge.hl')?.['line-color']);
    // the overlay comes after evidence/highlight rules so it wins
    const idx = (sel: string) => style.findIndex((s) => s.selector === sel);
    expect(idx('edge.inferred')).toBeGreaterThan(idx('edge.ev-observed'));
    expect(idx('edge.inferred')).toBeGreaterThan(idx('edge.hl'));
  });
  it('fades with opacity 0.15 and colours error labels', () => {
    expect(rule('.faded')?.opacity).toBe(0.15);
    expect(rule('edge.has-errors')?.color).toBe('#d13212');
    expect(rule('edge.ev-traced')?.label).toBe('data(label)');
    expect(rule('node.expanded')?.['text-events']).toBe('yes'); // label taps reach the group (collapse target)
  });
});

describe('real cytoscape + fcose (headless)', () => {
  it('accepts every style property and lays out compound groups without warnings', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    cytoscape.use(fcose);
    const f = flow();
    const cy = cytoscape({
      headless: true, styleEnabled: true, elements: buildSiteElements(f, new Set(f.groups.map((g) => g.id))),
      style: buildSiteStyle(readSitePalette(() => '')),
    });
    cy.layout({ name: 'fcose', quality: 'default', nodeDimensionsIncludeLabels: true, packComponents: true, animate: false, randomize: true } as unknown as cytoscape.LayoutOptions).run();
    const msgs = [...warn.mock.calls, ...err.mock.calls].map((c) => c.join(' '));
    warn.mockRestore(); err.mockRestore();
    expect(msgs).toEqual([]);
    cy.nodes().forEach((n) => { expect(Number.isFinite(n.position().x) && Number.isFinite(n.position().y)).toBe(true); });
    cy.destroy();
  });
});
