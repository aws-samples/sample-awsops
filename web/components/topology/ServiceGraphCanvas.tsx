'use client';

// Namespaced (Kiali-style, layered) renderer for the K8s service graph.
// Columns: DNS | Gateway | namespace boxes (services) | datastores — positions come from
// `layoutServiceGraph` (elkjs), which is imported DYNAMICALLY so elk stays in a lazy chunk.
// Only `import type` from '@/lib/k8s-graph-layout' is allowed in this file for that reason.
// Pods and Nodes are never graph nodes: they appear only in ServiceDetailPanel.
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  BaseEdge, Handle, MarkerType, Position, getSmoothStepPath, type Edge, type EdgeProps, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { serviceDetail, type GEdge, type GKind, type GNode, type GraphInput, type ServiceGraph } from '@/lib/k8s-service-graph';
import type { LaidOut, LaidOutEdge } from '@/lib/k8s-graph-layout';
import { useI18n } from '@/components/shell/LanguageProvider';
import useGraphViewport from './useGraphViewport';
import ServiceDetailPanel from './ServiceDetailPanel';

const ReactFlow = dynamic(() => import('@xyflow/react').then((m) => m.ReactFlow), { ssr: false });
const Background = dynamic(() => import('@xyflow/react').then((m) => m.Background), { ssr: false });
const Controls = dynamic(() => import('@xyflow/react').then((m) => m.Controls), { ssr: false });

/** Spec rule: at most this many services → every namespace starts expanded; more → all collapsed. */
const EXPAND_ALL_MAX_SERVICES = 40;
/** Same id scheme as k8s-graph-layout `groupId` (not imported: that would pull the module eagerly). */
const NS_PREFIX = 'ns:';
const DIM = 0.25;
const NO_ITEMS: readonly unknown[] = [];

type Theme = 'light' | 'dark';
// kind → [light bg, light border, dark bg, dark border]
const KIND_COLORS: Record<GKind, [string, string, string, string]> = {
  dns:       ['#F1E9FF', '#8A5BD0', '#2A2140', '#A07BE0'],
  gateway:   ['#F1E9FF', '#8A5BD0', '#2A2140', '#A07BE0'],
  service:   ['#E6EEFE', '#3D6FB5', '#16243E', '#4F9BFF'],
  datastore: ['#FEF3E2', '#C8902F', '#33260C', '#E0A43A'],
};
const NS_PALETTE = ['#4F6BED', '#3F9D6B', '#8A5BD0', '#C85A45', '#B7791F', '#2E9EA8'];
const NS_SYSTEM = '#9AA6B2';
const STATUS_DOT: Record<NonNullable<GNode['status']>, string> = {
  ok: '#01A88D', warn: '#F59E0B', bad: '#D13212', neutral: '#9AA6B2',
};
const EDGE_COLORS = {
  trace:   { light: '#586773', dark: '#9FB0BF' },
  config:  { light: '#B7791F', dark: '#E0A43A' },
  routing: { light: '#9AA6B2', dark: '#7D8B99' },
} as const;
const fg = (theme: Theme) => (theme === 'dark' ? '#E8EDF2' : '#16202A');
const colors = (kind: GKind, theme: Theme) => {
  const [lb, lbo, db, dbo] = KIND_COLORS[kind];
  return theme === 'dark' ? { bg: db, border: dbo } : { bg: lb, border: lbo };
};

// ---- node components ---------------------------------------------------------------------------
interface LeafData extends Record<string, unknown> { node: GNode; theme: Theme; vertical: boolean }
interface GroupData extends Record<string, unknown> {
  name: string; color: string; theme: Theme; toggleLabel: string; onCollapse(name: string): void;
}
interface NamespaceData extends Record<string, unknown> {
  name: string; color: string; theme: Theme; vertical: boolean; countLabel: string; toggleLabel: string; onExpand(name: string): void;
}

function Handles({ vertical }: { vertical: boolean }) {
  return (
    <>
      <Handle type="target" position={vertical ? Position.Top : Position.Left} style={{ opacity: 0, pointerEvents: 'none' }} />
      <Handle type="source" position={vertical ? Position.Bottom : Position.Right} style={{ opacity: 0, pointerEvents: 'none' }} />
    </>
  );
}

function Label({ node, theme }: { node: GNode; theme: Theme }) {
  return (
    <div className="min-w-0 flex-1" style={{ color: fg(theme) }}>
      <div className="flex items-center gap-1">
        {node.status && <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: STATUS_DOT[node.status] }} />}
        <span className="truncate text-[12px] font-semibold" title={node.label}>{node.label}</span>
      </div>
      {node.sub && <div className="truncate text-[10px] opacity-75" title={node.sub}>{node.sub}</div>}
    </div>
  );
}

/** Service: rounded pill with a circle marker (the mock's circles, with room for the label). */
const CardNode = memo(function CardNode({ data }: NodeProps) {
  const { node, theme, vertical } = data as LeafData;
  const { bg, border } = colors(node.kind, theme);
  return (
    <div className="flex h-full w-full items-center gap-2 rounded-full px-2.5" style={{ background: bg, border: `1.5px solid ${border}` }}>
      <Handles vertical={vertical} />
      <span aria-hidden className="h-5 w-5 shrink-0 rounded-full" style={{ border: `2px solid ${border}` }} />
      <Label node={node} theme={theme} />
    </div>
  );
});

/** DNS / gateway: diamond marker + label. */
const DiamondNode = memo(function DiamondNode({ data }: NodeProps) {
  const { node, theme, vertical } = data as LeafData;
  const { bg, border } = colors(node.kind, theme);
  return (
    <div className="flex h-full w-full items-center gap-2 px-1">
      <Handles vertical={vertical} />
      <svg aria-hidden width="30" height="30" viewBox="0 0 30 30" className="shrink-0">
        <polygon points="15,1 29,15 15,29 1,15" fill={bg} stroke={border} strokeWidth="2" />
      </svg>
      <Label node={node} theme={theme} />
    </div>
  );
});

/** Datastore: square marker + label. */
const SquareNode = memo(function SquareNode({ data }: NodeProps) {
  const { node, theme, vertical } = data as LeafData;
  const { bg, border } = colors(node.kind, theme);
  return (
    <div className="flex h-full w-full items-center gap-2 px-1">
      <Handles vertical={vertical} />
      <span aria-hidden className="h-7 w-7 shrink-0 rounded-[4px]" style={{ background: bg, border: `2px solid ${border}` }} />
      <Label node={node} theme={theme} />
    </div>
  );
});

/** Expanded namespace box (React Flow parent of its service nodes). */
const GroupNode = memo(function GroupNode({ data }: NodeProps) {
  const { name, color, theme, toggleLabel, onCollapse } = data as GroupData;
  return (
    <div className="h-full w-full rounded-[10px]" style={{ background: `${color}14`, border: `1.5px solid ${color}99` }}>
      <div className="flex items-center gap-1.5 px-3 pt-2">
        <span className="truncate text-[13px] font-bold" style={{ color: theme === 'dark' ? '#C9D3DC' : color }} title={name}>{name}</span>
        <button type="button" aria-label={toggleLabel} aria-expanded="true" title={toggleLabel}
          onClick={() => onCollapse(name)}
          className="nodrag nopan ml-auto rounded px-1 text-[11px] leading-none hover:bg-ink-100" style={{ color: fg(theme) }}>
          <span aria-hidden>−</span>
        </button>
      </div>
    </div>
  );
});

/** Collapsed namespace leaf: name + service count; clicking it (or its button) expands it. */
const NamespaceNode = memo(function NamespaceNode({ data }: NodeProps) {
  const { name, color, theme, vertical, countLabel, toggleLabel, onExpand } = data as NamespaceData;
  return (
    <div className="flex h-full w-full items-center gap-2 rounded-[10px] px-3"
      style={{ background: `${color}1F`, border: `1.5px dashed ${color}`, color: fg(theme) }}>
      <Handles vertical={vertical} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-bold" title={name}>{name}</div>
        <div className="text-[10px] opacity-75">{countLabel}</div>
      </div>
      <button type="button" aria-label={toggleLabel} aria-expanded="false" title={toggleLabel}
        onClick={() => onExpand(name)}
        className="nodrag nopan rounded px-1 text-[11px] leading-none hover:bg-ink-100">
        <span aria-hidden>+</span>
      </button>
    </div>
  );
});

// Overrides React Flow's built-in `group` type with the namespace box.
const nodeTypes = { group: GroupNode, namespace: NamespaceNode, card: CardNode, diamond: DiamondNode, square: SquareNode };

// ---- edge component ----------------------------------------------------------------------------
interface ElkPoint { x: number; y: number }
interface ElkSection { startPoint: ElkPoint; endPoint: ElkPoint; bendPoints?: ElkPoint[] }
interface ElkEdgeData extends Record<string, unknown> { sections?: unknown }

function sectionPoints(sections: unknown): ElkPoint[] | null {
  if (!Array.isArray(sections) || sections.length !== 1) return null;
  const s = sections[0] as Partial<ElkSection>;
  if (!s?.startPoint || !s.endPoint) return null;
  return [s.startPoint, ...(s.bendPoints ?? []), s.endPoint];
}

/** Draws elk's orthogonal route (ROOT coords, same space as the flow); falls back to smoothstep. */
function ElkEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, markerEnd, label, data } = props;
  const pts = sectionPoints((data as ElkEdgeData | undefined)?.sections);
  let path: string; let labelX: number; let labelY: number;
  if (pts) {
    path = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ');
    const mid = Math.floor((pts.length - 1) / 2);
    labelX = (pts[mid].x + pts[mid + 1].x) / 2;
    labelY = (pts[mid].y + pts[mid + 1].y) / 2;
  } else {
    [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  }
  return (
    <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} label={label}
      labelX={labelX} labelY={labelY} labelStyle={{ fontSize: 10 }} labelShowBg labelBgPadding={[3, 1]} labelBgBorderRadius={3} />
  );
}
const edgeTypes = { elk: ElkEdge };

function edgeStyle(evidence: GEdge['evidence'], theme: Theme): { stroke: string; strokeWidth: number; strokeDasharray?: string } {
  if (evidence.includes('trace')) return { stroke: EDGE_COLORS.trace[theme], strokeWidth: 1.8 };
  if (evidence.includes('config')) return { stroke: EDGE_COLORS.config[theme], strokeWidth: 1.6, strokeDasharray: '5 4' };
  return { stroke: EDGE_COLORS.routing[theme], strokeWidth: 1 };
}

const formatRps = (rps: number) => `${rps >= 10 ? Math.round(rps) : Number(rps.toFixed(1))} rps`;

// ---- search ------------------------------------------------------------------------------------
function matchingIds(graph: ServiceGraph, query: string): Set<string> | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  const hit = (s: string | null | undefined) => !!s && s.toLowerCase().includes(needle);
  const out = new Set<string>();
  for (const n of graph.nodes) if (hit(n.label) || hit(n.namespace) || hit(n.sub)) out.add(n.id);
  // A collapsed namespace box matches when its name or any of its services matches.
  for (const ns of graph.namespaces) {
    if (hit(ns.name) || ns.serviceIds.some((id) => out.has(id))) out.add(`${NS_PREFIX}${ns.name}`);
  }
  return out.size ? out : null; // no hits → dim nothing (MapCanvas parity)
}

// ---- canvas ------------------------------------------------------------------------------------
interface LayoutRequest { graph: ServiceGraph; collapsed: ReadonlySet<string>; vertical: boolean; attempt: number }
type LayoutResult = { req: LayoutRequest; laid: LaidOut; error?: undefined } | { req: LayoutRequest; laid?: undefined; error: true };

const initialCollapsed = (graph: ServiceGraph): Set<string> => {
  const total = graph.nodes.filter((n) => n.kind === 'service').length;
  return total > EXPAND_ALL_MAX_SERVICES ? new Set(graph.namespaces.map((ns) => ns.name)) : new Set();
};
/** Re-apply the initial rule only when the namespace set or the >40 side changes (not on every refresh). */
const collapseKey = (graph: ServiceGraph) =>
  `${graph.namespaces.map((ns) => ns.name).join('\u0000')}#${graph.nodes.filter((n) => n.kind === 'service').length > EXPAND_ALL_MAX_SERVICES}`;

export default function ServiceGraphCanvas({ graph, input, query, theme, onSelectService }: {
  graph: ServiceGraph; input: GraphInput; query: string; theme: Theme;
  /** Called with the Service node id each time a Service is selected (e.g. to lazy-load detail data). */
  onSelectService?: (id: string) => void;
}) {
  const { tt } = useI18n();
  const [collapseState, setCollapseState] = useState(() => ({ key: collapseKey(graph), collapsed: initialCollapsed(graph) as ReadonlySet<string> }));
  const key = collapseKey(graph);
  // Derived-state reset (render-phase, React-sanctioned) when the namespace set changes.
  if (collapseState.key !== key) setCollapseState({ key, collapsed: initialCollapsed(graph) });
  const collapsed = collapseState.key === key ? collapseState.collapsed : initialCollapsed(graph);
  const setCollapsed = useCallback((fn: (prev: ReadonlySet<string>) => ReadonlySet<string>) =>
    setCollapseState((s) => ({ key: s.key, collapsed: fn(s.collapsed) })), []);
  const collapse = useCallback((name: string) => setCollapsed((p) => (p.has(name) ? p : new Set([...p, name]))), [setCollapsed]);
  const expand = useCallback((name: string) => setCollapsed((p) => {
    if (!p.has(name)) return p;
    const next = new Set(p); next.delete(name); return next;
  }), [setCollapsed]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<LayoutResult | null>(null);
  // Refit when a new layout lands (query dimming alone never moves anything).
  const viewport = useGraphViewport(result?.laid?.nodes ?? NO_ITEMS, result?.laid?.edges ?? NO_ITEMS);
  const vertical = viewport.vertical;

  const empty = graph.nodes.length === 0;
  const req = useMemo<LayoutRequest>(() => ({ graph, collapsed, vertical, attempt }), [graph, collapsed, vertical, attempt]);
  useEffect(() => {
    if (empty) return;
    let live = true; // stale/unmounted results are ignored
    import('@/lib/k8s-graph-layout')
      .then((m) => m.layoutServiceGraph(req.graph, { collapsed: req.collapsed, vertical: req.vertical }))
      .then((laid) => { if (live) setResult({ req, laid }); }, () => { if (live) setResult({ req, error: true }); });
    return () => { live = false; };
  }, [req, empty]);

  const loading = !empty && result?.req !== req;
  const failed = !loading && !!result?.error;
  const laid = result?.laid ?? null; // keep the previous layout on screen while a new one computes

  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const edgeById = useMemo(() => new Map(graph.edges.map((e) => [e.id, e])), [graph]);
  const nsInfo = useMemo(() => new Map(graph.namespaces.map((ns, i) => [ns.name, {
    color: ns.system ? NS_SYSTEM : NS_PALETTE[i % NS_PALETTE.length], count: ns.serviceIds.length,
  }])), [graph]);
  const matches = useMemo(() => matchingIds(graph, query), [graph, query]);

  const flow = useMemo(() => {
    if (!laid) return { nodes: [] as Node[], edges: [] as Edge[] };
    const dimmed = (id: string) => (matches ? !matches.has(id) : false);
    const nodes: Node[] = [];
    for (const g of laid.groups) {
      const name = g.id.slice(NS_PREFIX.length);
      const info = nsInfo.get(name);
      nodes.push({
        id: g.id, type: 'group', position: { x: g.x, y: g.y }, selectable: false,
        style: { width: g.width, height: g.height, padding: 0, border: 'none', background: 'transparent' },
        data: { name, color: info?.color ?? NS_SYSTEM, theme, toggleLabel: `${tt('네임스페이스 접기')}: ${name}`, onCollapse: collapse } satisfies GroupData,
      });
    }
    for (const n of laid.nodes) {
      const style: Record<string, unknown> = { width: n.width, height: n.height };
      if (dimmed(n.id)) style.opacity = DIM;
      const base = { id: n.id, position: { x: n.x, y: n.y }, style, ...(n.parentId ? { parentId: n.parentId } : {}) };
      const g = byId.get(n.id);
      if (!g && n.id.startsWith(NS_PREFIX)) {
        const name = n.id.slice(NS_PREFIX.length);
        const info = nsInfo.get(name);
        nodes.push({
          ...base, type: 'namespace',
          data: {
            name, color: info?.color ?? NS_SYSTEM, theme, vertical, countLabel: tt(`서비스 ${info?.count ?? 0}개`),
            toggleLabel: `${tt('네임스페이스 펼치기')}: ${name}`, onExpand: expand,
          } satisfies NamespaceData,
        });
        continue;
      }
      if (!g) continue; // contract drift: never invent a node the graph does not have
      const type = g.kind === 'service' ? 'card' : g.kind === 'datastore' ? 'square' : 'diamond';
      nodes.push({ ...base, type, data: { node: g, theme, vertical } satisfies LeafData });
    }
    const present = new Set(nodes.map((n) => n.id));
    const edges: Edge[] = laid.edges.filter((e) => present.has(e.source) && present.has(e.target)).map((e: LaidOutEdge) => {
      const style: Record<string, unknown> = edgeStyle(e.evidence, theme);
      if (dimmed(e.source) || dimmed(e.target)) style.opacity = DIM;
      const rps = e.count === 1 && !e.id.startsWith('agg:') ? edgeById.get(e.id)?.metric?.rps : undefined;
      const label = e.id.startsWith('agg:') ? `×${e.count}` : typeof rps === 'number' && Number.isFinite(rps) ? formatRps(rps) : undefined;
      return {
        id: e.id, source: e.source, target: e.target, type: 'elk', style,
        markerEnd: { type: MarkerType.ArrowClosed, color: String(style.stroke), width: 14, height: 14 },
        data: { sections: e.sections } satisfies ElkEdgeData,
        ...(label ? { label } : {}),
      };
    });
    return { nodes, edges };
  }, [laid, matches, nsInfo, byId, edgeById, theme, vertical, tt, collapse, expand]);

  const selected = selectedId ? byId.get(selectedId) : undefined;
  const service = selected?.kind === 'service' ? selected : undefined;
  const detail = useMemo(() => (service ? serviceDetail(graph, input, service.id) : null), [graph, input, service]);

  const handleNodeClick = useCallback((_: unknown, node: Node) => {
    if (node.type === 'namespace') { expand(node.id.slice(NS_PREFIX.length)); return; }
    if (byId.get(node.id)?.kind === 'service') { setSelectedId(node.id); onSelectService?.(node.id); }
  }, [byId, expand, onSelectService]);

  const totalServices = useMemo(() => graph.nodes.filter((n) => n.kind === 'service').length, [graph]);
  const allCollapsed = graph.namespaces.length > 0 && graph.namespaces.every((ns) => collapsed.has(ns.name));
  const toggleAll = () => setCollapsed(() => (allCollapsed ? new Set() : new Set(graph.namespaces.map((ns) => ns.name))));

  const legendLine = (stroke: string, width: number, dash?: string) => (
    <svg aria-hidden width="28" height="8" className="shrink-0"><line x1="0" y1="4" x2="28" y2="4" stroke={stroke} strokeWidth={width} strokeDasharray={dash} /></svg>
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-ink-100 px-4 py-2 text-xs">
        <span className="text-ink-500">{`${tt('서비스')}: ${totalServices} · ${tt('네임스페이스')}: ${graph.namespaces.length}`}</span>
        <span className="inline-flex items-center gap-1 text-ink-600">{legendLine(EDGE_COLORS.trace[theme], 1.8)}{tt('실선: 트레이스로 관측된 호출')}</span>
        <span className="inline-flex items-center gap-1 text-ink-600">{legendLine(EDGE_COLORS.config[theme], 1.6, '5 4')}{tt('점선: 설정(ConfigMap·Pod env)에서 추론')}</span>
        <span className="inline-flex items-center gap-1 text-ink-600">{legendLine(EDGE_COLORS.routing[theme], 1)}{tt('가는 선: Ingress 라우팅')}</span>
        {graph.notes.length > 0 && (
          // Builder notes are English operator diagnostics with their own counts (mixed units), shown
          // only via the tooltip. No number here: the note count is not a count of connections.
          <span className="text-warning-text" title={graph.notes.join('\n')}>
            {tt('일부 연결은 근거가 부족해 표시하지 않았습니다')}
          </span>
        )}
        {graph.namespaces.length > 0 && (
          <button type="button" onClick={toggleAll}
            className="ml-auto rounded-md border border-ink-200 bg-card px-2 py-1">{tt(allCollapsed ? '모두 펼치기' : '모두 접기')}</button>
        )}
      </div>
      <div ref={viewport.container} className="relative min-h-64 flex-1">
        {empty ? <div className="p-6 text-sm text-ink-500">{tt('표시할 서비스가 없습니다.')}</div>
          : failed ? (
            <div role="alert" className="flex flex-col items-start gap-2 p-6 text-sm text-ink-600">
              <p>{tt('그래프를 배치하지 못했습니다.')}</p>
              <button type="button" onClick={() => setAttempt((a) => a + 1)}
                className="rounded-md border border-ink-200 bg-card px-2 py-1 text-xs">{tt('다시 시도')}</button>
            </div>
          ) : !laid ? <div role="status" className="p-6 text-sm text-ink-500">{tt('그래프 배치 중…')}</div>
          : (
            <>
              <ReactFlow
                nodes={flow.nodes}
                edges={flow.edges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                onNodeClick={handleNodeClick}
                onPaneClick={() => setSelectedId(null)}
                fitView
                onInit={viewport.onInit}
                fitViewOptions={{ padding: 0.16, maxZoom: 1 }}
                minZoom={0.05}
                colorMode={theme}
                proOptions={{ hideAttribution: true }}
                nodesDraggable={false}
                nodesConnectable={false}
              >
                <Background />
                <Controls showInteractive={false} />
              </ReactFlow>
              {loading && <div role="status" className="pointer-events-none absolute left-3 top-3 rounded bg-card px-2 py-1 text-[11px] text-ink-500 shadow-sm">{tt('그래프 배치 중…')}</div>}
            </>
          )}
        {service && detail && (
          <div className="absolute inset-y-0 right-0 z-10 w-full max-w-sm border-l border-ink-100 shadow-pop">
            <ServiceDetailPanel detail={detail} service={service} onClose={() => setSelectedId(null)} />
          </div>
        )}
      </div>
    </div>
  );
}
