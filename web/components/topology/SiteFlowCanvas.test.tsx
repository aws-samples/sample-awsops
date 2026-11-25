// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteFlow } from '@/lib/site-flow';

type El = { group?: string; data: Record<string, unknown>; classes?: string; position?: { x: number; y: number } };
interface FakeCy {
  opts: Record<string, unknown>; els: El[]; handlers: Map<string, (evt: unknown) => void>;
  add: ReturnType<typeof vi.fn>; layout: ReturnType<typeof vi.fn>; run: ReturnType<typeof vi.fn>;
  style: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; minZoom: ReturnType<typeof vi.fn>; maxZoom: ReturnType<typeof vi.fn>;
  tap(id: string, y?: number): void;
}

const h = vi.hoisted(() => {
  const instances: FakeCy[] = [];
  const make = (opts: Record<string, unknown>): FakeCy => {
    const run = vi.fn();
    const cy: FakeCy = {
      opts, els: [...(opts.elements as El[])], handlers: new Map(), run,
      add: vi.fn((list: El[]) => { cy.els = [...list]; }),
      layout: vi.fn(() => ({ run })),
      style: vi.fn(), destroy: vi.fn(), minZoom: vi.fn(), maxZoom: vi.fn(),
      // `y` = tap position; every fake body's top edge is at y=50, so the default y=40 is a label-band tap.
      tap(id, y = 40) {
        const el = cy.els.find((e) => e.data.id === id);
        if (!el) throw new Error(`no element ${id}`);
        cy.handlers.get('tap node')?.({
          position: { x: 0, y },
          target: { id: () => id, data: (k: string) => el.data[k], boundingBox: () => ({ x1: 0, y1: 50, x2: 300, y2: 400 }) },
        });
      },
    };
    Object.assign(cy, {
      getElementById: (id: string) => {
        const el = cy.els.find((e) => e.data.id === id);
        return {
          nonempty: () => !!el,
          data: (d?: Record<string, unknown>) => (d ? void Object.assign(el!.data, d) : el!.data),
          removeData: (k: string) => { delete el!.data[k]; },
          classes: (c: string) => { el!.classes = c; },
        };
      },
      on: (evt: string, sel: string, fn: (e: unknown) => void) => { cy.handlers.set(`${evt} ${sel}`, fn); },
      batch: (fn: () => void) => fn(),
      elements: () => ({ remove: () => { cy.els = []; } }),
      nodes: () => cy.els.filter((e) => e.group === 'nodes').map((e) => ({
        id: () => String(e.data.id), position: () => ({ x: 100, y: 200 }),
      })),
    });
    instances.push(cy);
    return cy;
  };
  const factory = Object.assign(vi.fn(make), { use: vi.fn() });
  return { instances, factory, fcose: { fcose: true }, failImport: 0 };
});
vi.mock('cytoscape', () => ({ default: h.factory }));
// `failImport` > 0 makes the next dynamic import of cytoscape-fcose reject (like a chunk 404 after a redeploy).
vi.mock('cytoscape-fcose', () => ({
  get default() {
    if (h.failImport > 0) { h.failImport -= 1; throw new Error('Loading chunk failed'); }
    return h.fcose;
  },
}));

import SiteFlowCanvas from './SiteFlowCanvas';

const ARN = 'arn:aws:eks:ap-northeast-2:123456789012:cluster/shop';
const CL = `eks:${ARN}`;
const NS = `ns:${ARN}:web`;
function flow(over: Partial<SiteFlow> = {}): SiteFlow {
  return {
    host: 'shop.example.com', path: null,
    nodes: [
      { id: 'dns1', kind: 'dns', label: 'shop.example.com', group: 'host:shop.example.com' },
      { id: 'cf1', kind: 'cdn', label: 'E123', group: 'cdn:cf1' },
      { id: 'alb1', kind: 'lb', label: 'alb-web', group: 'lb:alb1' },
      { id: 'tg1', kind: 'tg', label: 'tg-web', group: 'lb:alb1' },
      { id: 'wl:front', kind: 'workload', label: 'front', group: NS, account: '123456789012' },
      { id: 'wl:api', kind: 'workload', label: 'api', group: NS },
      { id: 'db1', kind: 'datastore', label: 'orders-db', group: 'datastore:rds' },
    ],
    edges: [
      { id: 'e1', source: 'dns1', target: 'cf1', evidence: 'configured' },
      { id: 'e2', source: 'cf1', target: 'alb1', evidence: 'configured' },
      { id: 'e3', source: 'alb1', target: 'tg1', evidence: 'observed' },
      { id: 'e4', source: 'tg1', target: 'wl:front', evidence: 'observed' },
      { id: 'e5', source: 'tg1', target: 'wl:api', evidence: 'inferred' },
      { id: 'e6', source: 'wl:api', target: 'db1', evidence: 'traced', calls: 9, errors: 1 },
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

const ids = (els: El[]) => new Set(els.map((e) => String(e.data.id)));
const get = (els: El[], id: string) => els.find((e) => e.data.id === id);
const cls = (e: El | undefined) => new Set(String(e?.classes ?? '').split(/\s+/).filter(Boolean));
async function mounted(n = 1) {
  await waitFor(() => expect(h.instances).toHaveLength(n));
  return h.instances[n - 1];
}

afterEach(cleanup);
beforeEach(() => { h.instances.length = 0; h.factory.mockClear(); h.failImport = 0; document.documentElement.style.cssText = ''; });

describe('SiteFlowCanvas', () => {
  it('creates one fcose-laid-out instance with compound parents and collapsed (+N) groups', async () => {
    render(<SiteFlowCanvas flow={flow()} theme="light" />);
    const cy = await mounted();
    expect(h.factory.use).toHaveBeenCalledWith(h.fcose);
    const els = cy.opts.elements as El[];
    expect(get(els, 'cdn:cf1')?.data.parent).toBe('host:shop.example.com');
    expect(get(els, 'tg1')?.data.parent).toBe('lb:alb1');
    expect(get(els, CL)?.data).toMatchObject({ label: 'shop (+2)', role: 'collapsed', parent: 'lb:alb1' });
    expect(get(els, 'datastore:rds')?.data.label).toBe('rds (+1)');
    for (const hidden of [NS, 'wl:front', 'wl:api', 'db1']) expect(ids(els).has(hidden)).toBe(false);
    expect(cy.opts.layout).toMatchObject({
      name: 'fcose', quality: 'default', nodeDimensionsIncludeLabels: true, packComponents: true, fit: true, randomize: true,
    });
    expect(cy.opts.minZoom as number).toBeGreaterThan(0);
    expect(cy.opts.maxZoom as number).toBeGreaterThan(1);
  });

  it('re-points edges into collapsed groups and dedupes them with the strongest evidence', async () => {
    render(<SiteFlowCanvas flow={flow()} theme="light" />);
    const els = (await mounted()).opts.elements as El[];
    const toCluster = els.filter((e) => e.group === 'edges' && e.data.target === CL);
    expect(toCluster).toHaveLength(1);
    expect(toCluster[0].data).toMatchObject({ source: 'tg1', evidence: 'observed', members: ['e4', 'e5'] });
    const toDb = els.filter((e) => e.group === 'edges' && e.data.source === CL);
    expect(toDb).toHaveLength(1);
    expect(toDb[0].data).toMatchObject({ target: 'datastore:rds', evidence: 'traced', calls: 9, errors: 1 });
    expect(cls(toDb[0]).has('has-errors')).toBe(true);
  });

  it('fades non-highlighted elements and marks inferred edges with the dashed overlay class', async () => {
    const f = flow({ highlight: { nodes: ['dns1', 'cf1'], edges: ['e1'], inferred: ['alb1', 'e2'] } });
    render(<SiteFlowCanvas flow={f} theme="light" />);
    const cy = await mounted();
    const els = cy.opts.elements as El[];
    expect(cls(get(els, 'dns1')).has('hl')).toBe(true);
    expect(cls(get(els, 'tg1')).has('faded')).toBe(true);
    expect(cls(get(els, 'e3')).has('faded')).toBe(true);
    expect(cls(get(els, 'e2'))).toEqual(new Set(['ev-configured', 'inferred']));
    expect(cls(get(els, 'alb1')).has('inferred')).toBe(true);
    const style = cy.opts.style as { selector: string; style: Record<string, unknown> }[];
    expect(style.find((s) => s.selector === 'edge.inferred')?.style).toMatchObject({ 'line-style': 'dashed' });
    expect(style.find((s) => s.selector === '.faded')?.style).toMatchObject({ opacity: 0.15 });
  });

  it('calls onSelect with the SiteNode on a leaf tap', async () => {
    const onSelect = vi.fn();
    const f = flow();
    render(<SiteFlowCanvas flow={f} theme="light" onSelect={onSelect} />);
    const cy = await mounted();
    cy.tap('tg1');
    expect(onSelect).toHaveBeenCalledWith(f.nodes.find((n) => n.id === 'tg1'));
    expect(cy.add).not.toHaveBeenCalled();
  });

  it('expands a collapsed group on tap and collapses it from its label, re-running fcose without randomizing', async () => {
    const onSelect = vi.fn();
    render(<SiteFlowCanvas flow={flow()} theme="light" onSelect={onSelect} />);
    const cy = await mounted();
    cy.tap(CL);
    expect(onSelect).not.toHaveBeenCalled();
    expect(get(cy.els, CL)?.data).toMatchObject({ label: 'shop', role: 'group' });
    expect(get(cy.els, NS)?.data).toMatchObject({ label: 'web (+2)', parent: CL });
    expect(get(cy.els, NS)?.position).toEqual({ x: 100, y: 200 }); // seeded at the toggled group's position
    expect(cy.layout).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'fcose', randomize: false }));
    expect(cy.run).toHaveBeenCalledTimes(1);
    cy.tap(NS);
    expect(ids(cy.els).has('wl:front')).toBe(true);
    cy.tap(CL, 200); // a tap on the expanded group's blank body does nothing
    expect(get(cy.els, CL)?.data.role).toBe('group');
    expect(cy.run).toHaveBeenCalledTimes(2);
    cy.tap(CL); // a tap on its label collapses it (and everything inside)
    expect(get(cy.els, CL)?.data.role).toBe('collapsed');
    expect(ids(cy.els).has('wl:front')).toBe(false);
    expect(cy.run).toHaveBeenCalledTimes(3);
    expect(h.factory).toHaveBeenCalledTimes(1);
  });

  it('a path-only change keeps the instance and its layout, updating only the highlight classes in place', async () => {
    const { rerender, unmount } = render(<SiteFlowCanvas flow={flow()} theme="light" />);
    const cy = await mounted();
    expect(cls(get(cy.els, 'dns1')).has('hl')).toBe(false);
    rerender(<SiteFlowCanvas flow={flow({ path: '/products', highlight: { nodes: ['dns1', 'cf1'], edges: ['e1'], inferred: [] } })} theme="light" />);
    await waitFor(() => expect(cls(get(cy.els, 'dns1')).has('hl')).toBe(true));
    expect(cls(get(cy.els, 'tg1')).has('faded')).toBe(true);
    expect(cls(get(cy.els, 'e1')).has('hl')).toBe(true);
    expect(h.factory).toHaveBeenCalledTimes(1); // no new cytoscape instance
    expect(cy.add).not.toHaveBeenCalled(); // no rebuild
    expect(cy.layout).not.toHaveBeenCalled(); // no re-layout
    expect(cy.destroy).not.toHaveBeenCalled();
    rerender(<SiteFlowCanvas flow={flow({ path: null })} theme="light" />);
    await waitFor(() => expect(cls(get(cy.els, 'dns1')).has('hl')).toBe(false));
    expect(cls(get(cy.els, 'tg1')).has('faded')).toBe(false);
    unmount();
    expect(cy.destroy).toHaveBeenCalledTimes(1);
  });

  it('a structural change (evidence landing) keeps expanded groups and known positions, re-running fcose without randomizing', async () => {
    const { rerender } = render(<SiteFlowCanvas flow={flow()} theme="light" />);
    const cy = await mounted();
    cy.tap(CL); // expand the cluster (its namespace stays collapsed)
    cy.layout.mockClear(); cy.run.mockClear();
    const base = flow();
    const landed = flow({
      nodes: [...base.nodes, { id: 'wl:cart', kind: 'workload', label: 'cart', group: NS },
        { id: 'db2', kind: 'datastore', label: 'cart-cache', group: 'datastore:cache' }],
      edges: [...base.edges, { id: 'e7', source: 'wl:front', target: 'wl:cart', evidence: 'traced', calls: 3 },
        { id: 'e8', source: 'wl:cart', target: 'db2', evidence: 'configured' }],
      groups: [...base.groups, { id: 'datastore:cache', kind: 'datastore', label: 'cache', parent: 'host:shop.example.com' }],
    });
    rerender(<SiteFlowCanvas flow={landed} theme="light" />);
    await waitFor(() => expect(cy.layout).toHaveBeenCalledTimes(1));
    expect(h.factory).toHaveBeenCalledTimes(1);
    expect(cy.layout).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'fcose', randomize: false }));
    expect(get(cy.els, CL)?.data).toMatchObject({ label: 'shop', role: 'group' }); // still expanded
    expect(get(cy.els, NS)?.data).toMatchObject({ label: 'web (+3)', role: 'collapsed', parent: CL });
    expect(get(cy.els, 'datastore:cache')?.data).toMatchObject({ role: 'collapsed' }); // a new datastore group starts collapsed
    expect(get(cy.els, 'dns1')?.position).toEqual({ x: 100, y: 200 }); // known position carried
    expect(get(cy.els, 'datastore:cache')?.position).toBeDefined(); // new node seeded near its parent
  });

  it('builds from the latest flow when it changes before the dynamic import resolves', async () => {
    const { rerender } = render(<SiteFlowCanvas flow={flow()} theme="light" />);
    rerender(<SiteFlowCanvas flow={flow({ path: '/x', highlight: { nodes: ['dns1'], edges: [], inferred: [] } })} theme="light" />);
    const cy = await mounted();
    expect(cls(get(cy.opts.elements as El[], 'dns1')).has('hl')).toBe(true);
    expect(h.factory).toHaveBeenCalledTimes(1);
  });

  it('never creates an instance when unmounted before the dynamic import resolves', async () => {
    const { unmount } = render(<SiteFlowCanvas flow={flow()} theme="light" />);
    unmount();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.factory).not.toHaveBeenCalled();
  });

  it('restyles from CSS tokens on theme change without rebuilding', async () => {
    document.documentElement.style.setProperty('--warning', '#123456');
    const f = flow();
    const { rerender } = render(<SiteFlowCanvas flow={f} theme="light" />);
    const cy = await mounted();
    const first = cy.opts.style as { selector: string; style: Record<string, unknown> }[];
    expect(first.find((s) => s.selector === 'edge.inferred')?.style['line-color']).toBe('#123456');
    document.documentElement.style.setProperty('--warning', '#abcdef');
    rerender(<SiteFlowCanvas flow={f} theme="dark" />);
    await waitFor(() => expect(cy.style).toHaveBeenCalled());
    const next = cy.style.mock.calls.at(-1)![0] as { selector: string; style: Record<string, unknown> }[];
    expect(next.find((s) => s.selector === 'edge.inferred')?.style['line-color']).toBe('#abcdef');
    expect(h.factory).toHaveBeenCalledTimes(1);
  });

  it('restyles between two light themes (raw theme key) without rebuilding', async () => {
    document.documentElement.style.setProperty('--brand-500', '#0a0a0a');
    const f = flow();
    const { rerender } = render(<SiteFlowCanvas flow={f} theme="light" themeKey="teal" />);
    const cy = await mounted();
    expect(cy.style).not.toHaveBeenCalled();
    rerender(<SiteFlowCanvas flow={f} theme="light" themeKey="cobalt" />);
    await waitFor(() => expect(cy.style).toHaveBeenCalledTimes(1));
    expect(h.factory).toHaveBeenCalledTimes(1);
  });

  it('exposes an image role with a node/edge count summary once the graph is drawn (a status while loading)', async () => {
    render(<SiteFlowCanvas flow={flow()} theme="light" />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByRole('status')).toBeTruthy();
    await mounted();
    const img = await screen.findByRole('img');
    expect(img.getAttribute('aria-label')).toContain('7');
    expect(img.getAttribute('aria-label')).toContain('6');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a failed dynamic import shows an alert with a retry (no graph claimed); retry draws the canvas', async () => {
    h.failImport = 1;
    render(<SiteFlowCanvas flow={flow()} theme="light" />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('사이트 흐름 그래프를 표시하지 못했습니다.');
    expect(screen.queryByRole('img')).toBeNull(); // the empty box never claims nodes/edges
    expect(h.factory).not.toHaveBeenCalled();
    fireEvent.click(within(alert).getByRole('button', { name: '다시 시도' }));
    await mounted();
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect((await screen.findByRole('img')).getAttribute('aria-label')).toContain('7');
  });

  it('a throw while building the instance is caught the same way', async () => {
    h.factory.mockImplementationOnce(() => { throw new Error('bad style'); });
    render(<SiteFlowCanvas flow={flow()} theme="light" />);
    expect((await screen.findByRole('alert')).textContent).toContain('사이트 흐름 그래프를 표시하지 못했습니다.');
    expect(screen.queryByRole('img')).toBeNull();
  });
});
