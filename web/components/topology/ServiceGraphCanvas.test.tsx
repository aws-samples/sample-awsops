// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentType } from 'react';
import { buildServiceGraph, type GraphInput, type ServiceGraph } from '@/lib/k8s-service-graph';
import type { LaidOut, LaidOutEdge, LaidOutGroup, LaidOutNode } from '@/lib/k8s-graph-layout';
import type { NodeRow, PodRow } from '@/lib/eks-resources';
import { applyTerms } from '@/lib/i18n-terms';

// ---- fakes -------------------------------------------------------------------------------------
interface FakeNode { id: string; type: string; data: Record<string, unknown>; style?: Record<string, unknown>; parentId?: string; position: { x: number; y: number } }
interface FakeEdge { id: string; source: string; target: string; label?: string; style?: Record<string, unknown>; data?: Record<string, unknown> }
interface FlowProps {
  nodes?: FakeNode[]; edges?: FakeEdge[]; nodeTypes?: Record<string, ComponentType<{ id: string; data: unknown }>>;
  onNodeClick?: (e: unknown, n: FakeNode) => void; onPaneClick?: (e: unknown) => void; children?: React.ReactNode;
}
const flow = vi.hoisted(() => ({ props: null as FlowProps | null }));
// Every dynamic() import (ReactFlow, Background, Controls) becomes this fake; only the one that
// receives `nodes` is the flow. It renders the custom node components so clicks/labels are real.
vi.mock('next/dynamic', () => ({
  default: () => function FakeFlow(props: FlowProps) {
    if (!Array.isArray(props.nodes)) return null;
    flow.props = props;
    return (
      <div data-testid="flow" onClick={(e) => { if (e.target === e.currentTarget) props.onPaneClick?.(e); }}>
        {props.nodes.map((n) => {
          const C = props.nodeTypes![n.type];
          return <div key={n.id} data-testid={`node:${n.id}`} onClick={(e) => props.onNodeClick?.(e, n)}><C id={n.id} data={n.data} /></div>;
        })}
      </div>
    );
  },
}));
vi.mock('@xyflow/react', () => ({
  Handle: () => null, BaseEdge: () => null, getSmoothStepPath: () => ['', 0, 0],
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' }, MarkerType: { ArrowClosed: 'arrowclosed' },
}));
const layout = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('@/lib/k8s-graph-layout', () => ({ layoutServiceGraph: (...args: unknown[]) => layout.fn(...args) }));

import ServiceGraphCanvas from './ServiceGraphCanvas';

/** Deterministic stand-in honouring the k8s-graph-layout coordinate/aggregation contract. */
function fakeLayout(graph: ServiceGraph, opts: { collapsed: ReadonlySet<string> }): LaidOut {
  const boxOf = new Map<string, string>();
  const nodes: LaidOutNode[] = []; const groups: LaidOutGroup[] = [];
  graph.namespaces.filter((ns) => ns.serviceIds.length).forEach((ns, i) => {
    const id = `ns:${ns.name}`;
    if (opts.collapsed.has(ns.name)) {
      nodes.push({ id, x: 300, y: i * 100, width: 220, height: 56 });
      for (const s of ns.serviceIds) boxOf.set(s, id);
      return;
    }
    groups.push({ id, label: ns.name, x: 300, y: i * 300, width: 260, height: 200 });
    ns.serviceIds.forEach((s, j) => nodes.push({ id: s, x: 16, y: 36 + j * 60, width: 200, height: 48, parentId: id }));
  });
  graph.nodes.filter((n) => n.kind !== 'service').forEach((n, i) =>
    nodes.push({ id: n.id, x: n.kind === 'datastore' ? 700 : 0, y: i * 60, width: 200, height: 48 }));
  const edges = new Map<string, LaidOutEdge>();
  for (const e of graph.edges) {
    const s = boxOf.get(e.source) ?? e.source; const t = boxOf.get(e.target) ?? e.target;
    if (s === t) continue;
    if (s === e.source && t === e.target) { edges.set(e.id, { id: e.id, source: s, target: t, evidence: [...e.evidence], count: 1, edgeIds: [e.id] }); continue; }
    const id = `agg:${s}->${t}`; const a = edges.get(id);
    if (a) { a.count += 1; a.edgeIds.push(e.id); a.evidence = [...new Set([...a.evidence, ...e.evidence])]; }
    else edges.set(id, { id, source: s, target: t, evidence: [...e.evidence], count: 1, edgeIds: [e.id] });
  }
  return { nodes, groups, edges: [...edges.values()] };
}

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
beforeEach(() => {
  flow.props = null;
  layout.fn.mockReset();
  layout.fn.mockImplementation(async (g: ServiceGraph, o: { collapsed: ReadonlySet<string> }) => fakeLayout(g, o));
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// ---- fixture -----------------------------------------------------------------------------------
const pod = (over: Partial<PodRow> & Pick<PodRow, 'name' | 'namespace'>): PodRow => ({
  status: 'Running', node: 'node-a', restarts: 0, age: '1h', cpuRequest: 0, memRequest: 0, diskRequest: 0, ...over,
});
const nodeRow = (over: Partial<NodeRow> & Pick<NodeRow, 'name'>): NodeRow => ({
  status: 'Ready', roles: '', version: 'v1.31', instanceType: 'm7g.large', zone: 'apne2-a', age: '9d',
  cpuCapacity: 4, cpuAllocatable: 4, memCapacity: 16384, memAllocatable: 15000, diskCapacity: 0, diskAllocatable: 0, ...over,
});
const svc = (namespace: string, name: string) => ({ name, namespace, type: 'ClusterIP', clusterIP: '172.20.0.10', ports: '80/TCP', age: '1h' });
const RDS_HOST = 'orders.cluster-abc.ap-northeast-2.rds.amazonaws.com';

const input = (): GraphInput => ({
  services: [svc('prod', 'api'), svc('prod', 'web'), svc('auth', 'login')],
  endpoints: [
    { name: 'api', namespace: 'prod', ips: ['10.0.2.10', '10.0.2.11'], targets: [{ ip: '10.0.2.10', pod: 'api-1' }, { ip: '10.0.2.11', pod: 'api-2' }] },
    { name: 'web', namespace: 'prod', ips: ['10.0.2.20'], targets: [{ ip: '10.0.2.20', pod: 'web-1' }] },
  ],
  pods: [
    pod({ name: 'api-1', namespace: 'prod', podIP: '10.0.2.10', workload: 'api', node: 'node-a' }),
    pod({ name: 'api-2', namespace: 'prod', podIP: '10.0.2.11', workload: 'api', node: 'node-b', status: 'CrashLoopBackOff', restarts: 4 }),
    pod({ name: 'web-1', namespace: 'prod', podIP: '10.0.2.20', workload: 'web', node: 'node-a' }),
  ],
  nodes: [nodeRow({ name: 'node-a' }), nodeRow({ name: 'node-b', status: 'running', source: 'aws-api' })],
  ingresses: [{ name: 'shop', namespace: 'prod', className: 'alb', lbHostname: 'k8s-x.elb.amazonaws.com', backends: [{ service: 'web', port: '80' }], age: '1h' }],
  dbRefs: [{ workload: { namespace: 'prod', name: 'api' }, via: 'env', host: RDS_HOST, kind: 'rds',
    resource: { type: 'rds_cluster', id: 'orders', region: 'ap-northeast-2', accountId: '111111111111' } }],
  secretRefs: [{ workload: { namespace: 'prod', name: 'api' }, secret: 'db-password' }],
  trace: null, dns: [],
});
/** Builder output plus one trace-observed call (web → api, 12 rps) the overlay would add. */
function graphOf(inp: GraphInput): ServiceGraph {
  const g = buildServiceGraph(inp);
  return { ...g, edges: [...g.edges, { id: 'svc:prod/web->svc:prod/api', source: 'svc:prod/web', target: 'svc:prod/api', evidence: ['trace'], metric: { rps: 12 } }] };
}
const flowNodes = () => flow.props?.nodes ?? [];
const flowEdge = (id: string) => flow.props?.edges?.find((e) => e.id === id);
const lastCollapsed = () => [...(layout.fn.mock.lastCall![1] as { collapsed: ReadonlySet<string> }).collapsed].sort();

async function renderCanvas(over: Partial<{ graph: ServiceGraph; input: GraphInput; query: string }> = {}) {
  const inp = over.input ?? input();
  const graph = over.graph ?? graphOf(inp);
  const utils = render(<ServiceGraphCanvas graph={graph} input={inp} query={over.query ?? ''} theme="light" />);
  await waitFor(() => expect(flowNodes().length).toBeGreaterThan(0));
  return { ...utils, graph, inp };
}

// ---- tests -------------------------------------------------------------------------------------
describe('ServiceGraphCanvas', () => {
  it('renders namespace boxes with labels and a collapse toggle', async () => {
    await renderCanvas();
    const prod = screen.getByTestId('node:ns:prod');
    expect(within(prod).getByText('prod')).toBeTruthy();
    const toggle = within(prod).getByRole('button', { name: '네임스페이스 접기: prod' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(flowNodes().find((n) => n.id === 'svc:prod/api')?.parentId).toBe('ns:prod');
    // parents precede their children (React Flow requirement)
    const ids = flowNodes().map((n) => n.id);
    expect(ids.indexOf('ns:prod')).toBeLessThan(ids.indexOf('svc:prod/api'));
  });

  it('expands every namespace when there are at most 40 services', async () => {
    await renderCanvas();
    expect(lastCollapsed()).toEqual([]);
    expect(flowNodes().filter((n) => n.type === 'group').map((n) => n.id).sort()).toEqual(['ns:auth', 'ns:prod']);
  });

  it('collapses every namespace when there are more than 40 services, and a collapsed box click expands it', async () => {
    const inp = input();
    for (let i = 0; i < 39; i++) inp.services.push(svc('batch', `job-${String(i).padStart(2, '0')}`));
    await renderCanvas({ input: inp });
    expect(lastCollapsed()).toEqual(['auth', 'batch', 'prod']);
    const batch = screen.getByTestId('node:ns:batch');
    expect(within(batch).getByText('서비스 39개')).toBeTruthy();
    expect(applyTerms('en', '서비스 39개')).toBe('39 services'); // the dynamic count label has a RULE
    // aggregated edge (gateway → collapsed prod) carries its count; datastore edge is aggregated too
    expect(flowEdge('agg:gw:prod/shop->ns:prod')).toBeTruthy();

    fireEvent.click(batch);
    await waitFor(() => expect(lastCollapsed()).toEqual(['auth', 'prod']));
    await waitFor(() => expect(flowNodes().find((n) => n.id === 'ns:batch')?.type).toBe('group'));
  });

  it('labels aggregated edges with their underlying edge count', async () => {
    const inp = input();
    for (let i = 0; i < 39; i++) inp.services.push(svc('batch', `job-${String(i).padStart(2, '0')}`));
    const g = graphOf(inp);
    g.edges.push({ id: 'svc:prod/web->ds:rds_cluster:orders', source: 'svc:prod/web', target: 'ds:rds_cluster:orders', evidence: ['config'] });
    await renderCanvas({ input: inp, graph: g });
    expect(flowEdge('agg:ns:prod->ds:rds_cluster:orders')?.label).toBe('×2');
  });

  it('collapses and expands all namespaces from the toolbar', async () => {
    await renderCanvas();
    fireEvent.click(screen.getByRole('button', { name: '모두 접기' }));
    await waitFor(() => expect(lastCollapsed()).toEqual(['auth', 'prod']));
    fireEvent.click(await screen.findByRole('button', { name: '모두 펼치기' }));
    await waitFor(() => expect(lastCollapsed()).toEqual([]));
  });

  it('collapses one namespace from its header toggle', async () => {
    await renderCanvas();
    fireEvent.click(screen.getByRole('button', { name: '네임스페이스 접기: prod' }));
    await waitFor(() => expect(lastCollapsed()).toEqual(['prod']));
    const box = await screen.findByTestId('node:ns:prod');
    await waitFor(() => expect(within(box).getByRole('button', { name: '네임스페이스 펼치기: prod' }).getAttribute('aria-expanded')).toBe('false'));
  });

  it('draws trace edges solid, config edges dashed, routing edges thin, with rps labels', async () => {
    await renderCanvas();
    const trace = flowEdge('svc:prod/web->svc:prod/api')!;
    const config = flowEdge('svc:prod/api->ds:rds_cluster:orders')!;
    const routing = flowEdge('gw:prod/shop->svc:prod/web')!;
    expect(trace.style?.strokeDasharray).toBeUndefined();
    expect(trace.label).toBe('12 rps');
    expect(config.style?.strokeDasharray).toBe('5 4');
    expect(config.label).toBeUndefined();
    expect(routing.style?.strokeDasharray).toBeUndefined();
    expect(Number(routing.style?.strokeWidth)).toBeLessThan(Number(trace.style?.strokeWidth));
    expect(screen.getByText('실선: 트레이스로 관측된 호출')).toBeTruthy();
    expect(screen.getByText('점선: 설정(ConfigMap·Pod env)에서 추론')).toBeTruthy();
  });

  it('renders gateways as diamonds, services as cards and datastores as squares', async () => {
    await renderCanvas();
    const type = (id: string) => flowNodes().find((n) => n.id === id)?.type;
    expect(type('gw:prod/shop')).toBe('diamond');
    expect(type('svc:prod/api')).toBe('card');
    expect(type('ds:rds_cluster:orders')).toBe('square');
  });

  it('opens the detail panel on a Service click and never renders Pods or Nodes as graph nodes', async () => {
    const { graph } = await renderCanvas();
    const allowed = new Set([...graph.nodes.map((n) => n.id), ...graph.namespaces.map((n) => `ns:${n.name}`)]);
    expect(flowNodes().every((n) => allowed.has(n.id))).toBe(true);
    expect(flowNodes().some((n) => /api-1|node-a/.test(n.id))).toBe(false);

    fireEvent.click(screen.getByTestId('node:svc:prod/api'));
    const panel = await screen.findByRole('complementary', { name: '서비스 상세' });
    const pods = within(panel).getByRole('table', { name: 'Pod 목록' });
    expect(within(pods).getByText('api-1')).toBeTruthy();
    expect(within(within(pods).getByText('api-2').closest('tr')!).getByText('CrashLoopBackOff')).toBeTruthy();
    const nodes = within(panel).getByRole('table', { name: '노드' });
    expect(within(nodes).getByText('running · Ready unknown')).toBeTruthy();
    expect(within(panel).getByText('Secret 참조: db-password')).toBeTruthy();
    expect(flowNodes().some((n) => /api-1|node-a|node-b/.test(n.id))).toBe(false);

    fireEvent.click(screen.getByTestId('flow'));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: '서비스 상세' })).toBeNull());
  });

  it('does not open the panel for gateways or datastores', async () => {
    await renderCanvas();
    fireEvent.click(screen.getByTestId('node:gw:prod/shop'));
    fireEvent.click(screen.getByTestId('node:ds:rds_cluster:orders'));
    expect(screen.queryByRole('complementary', { name: '서비스 상세' })).toBeNull();
  });

  it('dims nodes that do not match the query (case-insensitive on label/namespace/sub)', async () => {
    await renderCanvas({ query: 'LOGIN' });
    const opacity = (id: string) => flowNodes().find((n) => n.id === id)?.style?.opacity;
    expect(opacity('svc:auth/login')).toBeUndefined();
    expect(opacity('svc:prod/api')).toBe(0.25);
    expect(opacity('gw:prod/shop')).toBe(0.25);
    expect(flowEdge('svc:prod/web->svc:prod/api')?.style?.opacity).toBe(0.25);
  });

  it('matches the query on namespace and dims nothing when nothing matches', async () => {
    const { rerender, graph, inp } = await renderCanvas({ query: 'auth' });
    expect(flowNodes().find((n) => n.id === 'svc:auth/login')?.style?.opacity).toBeUndefined();
    expect(flowNodes().find((n) => n.id === 'svc:prod/web')?.style?.opacity).toBe(0.25);
    rerender(<ServiceGraphCanvas graph={graph} input={inp} query="zzz-no-hit" theme="light" />);
    await waitFor(() => expect(flowNodes().every((n) => n.style?.opacity === undefined)).toBe(true));
  });

  it('shows a translatable notice for builder notes, keeping the English text out of the visible copy', async () => {
    const g = graphOf(input());
    const note = '2 trace-observed call(s) could not be mapped to exactly one Service or datastore and are not shown.';
    await renderCanvas({ graph: { ...g, notes: [note] } });
    const notice = screen.getByText(/일부 연결은 근거가 부족해 표시하지 않았습니다/);
    expect(notice.textContent).toContain('1');
    expect(notice.closest('[title]')?.getAttribute('title')).toContain(note);
    expect(screen.queryByText(note)).toBeNull();
  });

  it('shows an error state when the layout fails, and retries', async () => {
    layout.fn.mockRejectedValueOnce(new Error('elk exploded'));
    const inp = input();
    render(<ServiceGraphCanvas graph={graphOf(inp)} input={inp} query="" theme="light" />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('그래프를 배치하지 못했습니다.')).toBeTruthy();
    expect(screen.queryByText(/elk exploded/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    await waitFor(() => expect(flowNodes().length).toBeGreaterThan(0));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('ignores a stale layout result that resolves after a newer one', async () => {
    let resolveFirst!: (v: LaidOut) => void;
    const inp = input(); const g = graphOf(inp);
    layout.fn.mockImplementationOnce(() => new Promise<LaidOut>((r) => { resolveFirst = r; }));
    render(<ServiceGraphCanvas graph={g} input={inp} query="" theme="light" />);
    fireEvent.click(await screen.findByRole('button', { name: '모두 접기' }));
    await waitFor(() => expect(flowNodes().find((n) => n.id === 'ns:prod')?.type).toBe('namespace'));
    await act(async () => { resolveFirst(fakeLayout(g, { collapsed: new Set() })); });
    expect(flowNodes().find((n) => n.id === 'ns:prod')?.type).toBe('namespace');
  });

  it('does not update after unmount when a layout resolves late', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    let resolveLate!: (v: LaidOut) => void;
    const inp = input(); const g = graphOf(inp);
    layout.fn.mockImplementationOnce(() => new Promise<LaidOut>((r) => { resolveLate = r; }));
    const { unmount } = render(<ServiceGraphCanvas graph={g} input={inp} query="" theme="light" />);
    await waitFor(() => expect(layout.fn).toHaveBeenCalled());
    unmount();
    await act(async () => { resolveLate(fakeLayout(g, { collapsed: new Set() })); });
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('shows an empty state for a graph with no nodes without laying out', async () => {
    const inp = { ...input(), services: [], endpoints: [], pods: [], ingresses: [], dbRefs: [] };
    render(<ServiceGraphCanvas graph={buildServiceGraph(inp)} input={inp} query="" theme="light" />);
    expect(await screen.findByText('표시할 서비스가 없습니다.')).toBeTruthy();
    expect(layout.fn).not.toHaveBeenCalled();
  });
});
