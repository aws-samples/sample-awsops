'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useActiveAccount, accountParam } from '@/lib/account-context';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { Background, Controls, Position, type Node, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import PageHeader from '@/components/ui/PageHeader';
import GraphCollectionStatus from '@/components/topology/GraphCollectionStatus';
import { useI18n } from '@/components/shell/LanguageProvider';
import { fetchGraph, GraphFetchError, type GraphFetchFailure } from '@/lib/graph-fetch';
import GraphReadError from '@/components/topology/GraphReadError';
import { layoutFlow } from '@/lib/flow-layout';
import InfraMapView from '@/components/topology/InfraMapView';
import K8sMapView from '@/components/topology/K8sMapView';
import VpcConnectivitySection from '@/components/inventory/VpcConnectivitySection';
import { splitUnionNodeId } from '@/lib/graph-identity';
import { infraGraphPage, INFRA_PAGE_SIZE } from '@/lib/infra-graph-display';
import { INFRA_CONTEXT_KINDS } from '@/lib/infra-topology';
import useGraphViewport from '@/components/topology/useGraphViewport';

// ReactFlow touches the DOM on mount — client-only.
const ReactFlow = dynamic(() => import('@xyflow/react').then((m) => m.ReactFlow), { ssr: false });

interface GNode { id: string; kind: string; label: string; meta?: Record<string, unknown> }
interface GEdge { source: string; target: string; rel: string }
interface Graph { nodes: GNode[]; edges: GEdge[]; captured_at: string | null; capped?: boolean; collection?: unknown }
const EMPTY_GRAPH: Graph = { nodes: [], edges: [], captured_at: null };
const MIN_FIT_ZOOM = 0.85;
const FIT_PADDING = 0.16;
const CARD_WIDTH = 260;
const CARD_HEIGHT = 100;

// kind → [bg, border] — same palette as the ego-graph page, plus new network kinds.
const COLORS: Record<string, [string, string]> = {
  vpc: ['#E7EDFB', '#4F6BED'],
  subnet: ['#EAF3EE', '#3F9D6B'],
  sg: ['#FBEFE0', '#C9842B'],
};
const RESOURCE = ['#EEF0F2', '#9AA6B2'] as const;
const HILITE = '#D13212';

const relLabel: Record<string, string> = {
  'infra:in_vpc': 'in vpc', 'infra:in_subnet': 'in subnet', 'infra:uses_sg': 'uses sg',
};

const LEGEND: { kind: string; label: string }[] = [
  { kind: 'vpc', label: 'VPC' }, { kind: 'subnet', label: 'Subnet' },
  { kind: 'sg', label: 'Security Group' }, { kind: '_res', label: '리소스' },
];

/** Readable pages of saved placement relations; filtering does not establish reachability. */
function GraphView({ q, onVpc }: { q: string; onVpc: (id: string) => void }) {
  const { tt } = useI18n();
  const [activeAccount] = useActiveAccount();
  const [graph, setGraph] = useState<Graph | null>(null);
  const [err, setErr] = useState<GraphFetchFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [vpc, setVpc] = useState<string | null>(null);
  const [subnet, setSubnet] = useState('');
  const [kind, setKind] = useState('');
  const [page, setPage] = useState(0);
  const [showSecurityGroups, setShowSecurityGroups] = useState(false);

  const unavailable = (graph?.collection as { readStatus?: string } | undefined)?.readStatus === 'unavailable';

  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    setBusy(true);
    setErr(null);
    setGraph(null);
    setVpc(null); setSubnet(''); setKind(''); setPage(0);
    fetchGraph(`/api/graph?class=infra&${accountParam(activeAccount) || 'account=self'}`, controller.signal)
      .then((d) => { if (live) { setGraph(d); setErr(null); } })
      .catch((e) => { if (live) { setGraph(null); setErr(e instanceof GraphFetchError ? e.reason : 'rejected'); } })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; controller.abort(); };
  }, [activeAccount, revision]);
  useEffect(() => { setPage(0); }, [q]);

  const vpcs = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of graph?.edges ?? []) if (e.rel === 'infra:in_vpc') counts.set(e.target, (counts.get(e.target) ?? 0) + 1);
    return (graph?.nodes.filter(n => n.kind === 'vpc') ?? [])
      .sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0));
  }, [graph]);
  const effectiveVpc = vpc ?? (q.trim() ? '' : vpcs[0]?.id ?? '');
  const choices = useMemo(() => {
    if (!graph) return { subnets: [] as GNode[], kinds: [] as string[] };
    const members = new Set(graph.edges.filter(e => e.rel === 'infra:in_vpc' && (!effectiveVpc || e.target === effectiveVpc)).map(e => e.source));
    const subnetIds = new Set(graph.edges.filter(e => e.rel === 'infra:in_subnet' && members.has(e.source)).map(e => e.target));
    return {
      subnets: graph.nodes.filter(n => n.kind === 'subnet' && subnetIds.has(n.id)),
      kinds: [...new Set(graph.nodes.filter(n => !(INFRA_CONTEXT_KINDS as readonly string[]).includes(n.kind) && (!effectiveVpc || members.has(n.id))).map(n => n.kind))].sort(),
    };
  }, [graph, effectiveVpc]);
  const effectiveSubnet = choices.subnets.some(n => n.id === subnet) ? subnet : '';
  const effectiveKind = choices.kinds.includes(kind) ? kind : '';
  useEffect(() => {
    if (subnet !== effectiveSubnet || kind !== effectiveKind) {
      setSubnet(effectiveSubnet); setKind(effectiveKind); setPage(0);
    }
  }, [subnet, kind, effectiveSubnet, effectiveKind]);
  const viewport = useGraphViewport((graph ?? EMPTY_GRAPH).nodes, (graph ?? EMPTY_GRAPH).edges, 1, MIN_FIT_ZOOM);
  const display = useMemo(() => infraGraphPage(graph ?? EMPTY_GRAPH, {
    vpc: effectiveVpc, subnet: effectiveSubnet, kind: effectiveKind, query: q, page,
    pageSize: viewport.vertical ? 1 : INFRA_PAGE_SIZE, showSecurityGroups,
  }), [graph, effectiveVpc, effectiveSubnet, effectiveKind, q, page, viewport.vertical, showSecurityGroups]);
  useEffect(() => { viewport.fit(); }, [display, viewport.fit]);
  useEffect(() => { setPage(0); }, [viewport.vertical]);

  // Multi-match search highlight (v1 parity): id/label/kind/meta substring, case-insensitive.
  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle || !graph) return new Set<string>();
    return new Set(
      graph.nodes
        .filter((n) =>
          n.id.toLowerCase().includes(needle) ||
          n.label.toLowerCase().includes(needle) ||
          n.kind.toLowerCase().includes(needle) ||
          (n.meta ? JSON.stringify(n.meta).toLowerCase().includes(needle) : false))
        .map((n) => n.id),
    );
  }, [q, graph]);

  const { nodes, edges } = useMemo(() => {
    if (!graph) return { nodes: [] as Node[], edges: [] as Edge[] };
    const resourceIds = new Set(display.resources.map(n => n.id));
    // A single column keeps all saved context readable on narrow canvases.
    // Positions do not add edges between a VPC and subnet without saved evidence.
    const positions = viewport.vertical
      ? [...display.resources, ...display.nodes.filter(n => !resourceIds.has(n.id))]
        .map((n, i) => ({ id: n.id, x: 16, y: 16 + i * 140 }))
      : layoutFlow(display, { rankdir: 'LR', nodeSize: () => ({ width: CARD_WIDTH, height: CARD_HEIGHT }) });
    const pos = Object.fromEntries(positions.map(p => [p.id, p]));
    const nodes: Node[] = display.nodes.map((n) => {
      const [bg, border] = COLORS[n.kind] ?? RESOURCE;
      const p = pos[n.id] ?? { x: 0, y: 0 };
      const hit = matches.has(n.id);
      return {
        id: n.id,
        position: { x: p.x, y: p.y },
        data: { label: <div>
          <div className="mb-1 text-[15px] font-medium uppercase opacity-70">{n.kind}</div>
          <div className="truncate font-semibold" title={n.label}>{n.label}</div>
          {typeof n.meta?.region === 'string' && <div className="mt-1 truncate text-[15px] opacity-70">
            {[n.meta.inventoryAccount, n.meta.region].filter(Boolean).join(' · ')}
          </div>}
        </div>, kind: n.kind, meta: n.meta },
        sourcePosition: Position.Right,
        // Side lanes bypass intervening cards instead of implying a chained hop.
        targetPosition: viewport.vertical ? Position.Right : Position.Left,
        style: {
          background: bg,
          border: `${hit ? `2px solid ${HILITE}` : `1px solid ${border}`}`,
          borderRadius: 10, fontSize: 18, padding: 10, width: CARD_WIDTH,
          height: CARD_HEIGHT, color: '#16202A',
        },
      };
    });
    const edges: Edge[] = display.edges.map((e, i) => ({
      id: `${e.source}->${e.target}:${e.rel}`, source: e.source, target: e.target,
      animated: false, ariaLabel: relLabel[e.rel] ?? e.rel,
      ...(viewport.vertical ? { type: 'smoothstep', pathOptions: { offset: 12 + (i % 4) * 8 } } : {}),
      style: { stroke: '#9AA6B2', strokeWidth: 1.5 },
    }));
    return { nodes, edges };
  }, [graph, display, matches, viewport.vertical]);
  const canvasHeight = useMemo(() => {
    if (!nodes.length) return 520;
    const top = Math.min(...nodes.map(n => n.position.y));
    const bottom = Math.max(...nodes.map(n => n.position.y + CARD_HEIGHT));
    // Fractional fitView padding applies to both sides of the canvas.
    return Math.max(520, Math.ceil((bottom - top) * MIN_FIT_ZOOM / (1 - 2 * FIT_PADDING)) + 32);
  }, [nodes]);

  return (
    <>
      {graph && !unavailable && (
        <div className="mx-4 my-3 flex shrink-0 flex-wrap items-center gap-3 rounded-lg border border-ink-200 bg-card px-3 py-3 text-[13px] text-ink-700">
          <label className="flex min-w-0 items-center gap-2">VPC
            <select aria-label={tt('배치 그래프 VPC')} value={effectiveVpc}
              onChange={e => { setVpc(e.target.value); setSubnet(''); setKind(''); setPage(0); }}
              className="max-w-[240px] rounded border border-ink-200 bg-card px-2 py-1.5">
              <option value="">{tt('전체 VPC')}</option>
              {vpcs.map(n => <option key={n.id} value={n.id}>{[n.label, n.meta?.inventoryAccount, n.meta?.region].filter(Boolean).join(' · ')}</option>)}
            </select>
          </label>
          <label className="flex min-w-0 items-center gap-2">Subnet
            <select aria-label={tt('배치 그래프 서브넷')} value={effectiveSubnet} onChange={e => { setSubnet(e.target.value); setPage(0); }}
              className="max-w-[220px] rounded border border-ink-200 bg-card px-2 py-1.5">
              <option value="">{tt('전체 서브넷')}</option>
              {choices.subnets.map(n => <option key={n.id} value={n.id}>{n.label}</option>)}
            </select>
          </label>
          <select aria-label={tt('배치 그래프 리소스 종류')} value={effectiveKind} onChange={e => { setKind(e.target.value); setPage(0); }}
            className="rounded border border-ink-200 bg-card px-2 py-1.5">
            <option value="">{tt('전체 리소스 종류')}</option>
            {choices.kinds.map(k => <option key={k} value={k}>{k}</option>)}
          </select>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={showSecurityGroups} onChange={e => setShowSecurityGroups(e.target.checked)} />
            {tt('보안 그룹 연결 표시')}
          </label>
          <span className="ml-auto text-ink-500">{tt('표시 리소스')} {display.resources.length} / {display.totalResources}</span>
          <button aria-label={tt('이전 리소스')} disabled={display.page === 0} onClick={() => setPage(display.page - 1)}
            className="rounded border border-ink-200 px-2 py-1 disabled:opacity-40">←</button>
          <span>{display.page + 1} / {display.pages}</span>
          <button aria-label={tt('다음 리소스')} disabled={display.page + 1 >= display.pages} onClick={() => setPage(display.page + 1)}
            className="rounded border border-ink-200 px-2 py-1 disabled:opacity-40">→</button>
          <p className="w-full text-[12px] text-ink-500">{tt('한 화면에 리소스 최대 4개와 해당 배치 관계를 표시합니다. 좁은 화면은 1개씩, 나머지는 다음 페이지에서 확인하세요.')}</p>
          <p className="w-full text-[12px] text-ink-500">{tt('연결 대상 수에 맞춰 페이지와 캔버스 높이를 조절합니다.')}</p>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-1 text-[11px] text-ink-500">
        <span>{tt('VPC 노드를 클릭하면 TGW·피어링 연결을 조회할 수 있습니다.')}</span>
        <button type="button" disabled={busy || err !== null} onClick={() => setRevision(n => n + 1)} className="rounded border border-ink-200 px-2 py-1 disabled:opacity-50">{tt('새로고침')}</button>
        {busy && <span>{tt('불러오는 중…')}</span>}
        {err && <GraphReadError reason={err} />}
        {graph && !unavailable && <span>{tt('저장된 그래프:')} {tt(`노드 ${graph.nodes.length.toLocaleString()} · 엣지 ${graph.edges.length.toLocaleString()}`)}</span>}
        {LEGEND.map((l) => {
          const [bg, border] = COLORS[l.kind] ?? RESOURCE;
          return (
            <span key={l.kind} className="inline-flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: bg, border: `1px solid ${border}` }} />
              {tt(l.label)}
            </span>
          );
        })}
        {graph?.captured_at && <span>{tt('그래프 시점:')} {new Date(graph.captured_at).toLocaleString()}</span>}
        {graph && !unavailable && graph.nodes.length === 0 && !busy && <span>{tt('표시할 그래프 노드가 없습니다. 수집 상태를 확인하세요.')}</span>}
      </div>
      {!busy && !err && graph ? <div className="shrink-0 px-4"><GraphCollectionStatus collection={graph.collection} /></div> : null}
      {graph && !unavailable && !busy && !graph.nodes.length && !graph.captured_at && <div className="mx-4 my-2 rounded-lg border border-ink-200 bg-card p-3 text-[13px] text-ink-600">
        <p>{tt('저장된 배치 그래프가 아직 없습니다. VPC 연결은 실시간 조회로 확인할 수 있습니다.')}</p>
        <button type="button" onClick={() => onVpc('')} className="mt-2 rounded border border-ink-200 px-3 py-1.5 hover:bg-ink-50">
          {tt('VPC 연결 그래프 열기')}
        </button>
      </div>}
      {graph && !unavailable && !busy && display.totalResources === 0 && <p className="px-4 py-2 text-sm text-ink-500">{tt('선택 조건에 맞는 리소스가 없습니다.')}</p>}
      <div ref={viewport.container} style={{ height: canvasHeight }} className="min-h-[520px] min-w-0 shrink-0 overflow-hidden">
        <ReactFlow nodes={nodes} edges={edges} onInit={viewport.onInit} fitView fitViewOptions={{ padding: FIT_PADDING, minZoom: MIN_FIT_ZOOM, maxZoom: 1 }} minZoom={0.25}
          onNodeClick={(_, node) => {
            if (node.data.kind !== 'vpc') return;
            const meta = node.data.meta as GNode['meta'];
            const savedId = splitUnionNodeId(node.id)?.id ?? node.id;
            const id = typeof meta?.resourceId === 'string' ? meta.resourceId
              : savedId.startsWith('vpc:') && !savedId.startsWith('vpc:@') ? savedId.slice(4) : '';
            if (!id) return;
            onVpc(typeof meta?.inventoryAccount === 'string' && typeof meta?.region === 'string'
              ? `${meta.inventoryAccount}/${meta.region}/${id}` : id);
          }}
          proOptions={{ hideAttribution: true }}>
          <Background />
          <Controls />
        </ReactFlow>
      </div>
    </>
  );
}

const VIEWS = [['vpc', 'VPC 연결'], ['graph', '배치 그래프'], ['map', '인프라 맵'], ['k8s', 'K8s 맵']] as const;
type View = (typeof VIEWS)[number][0];

const SUBTITLES: Record<View, string> = {
  vpc: 'VPC를 선택하여 TGW·피어링 연결을 조회합니다. 선은 활성 구성 관계이며 통신 가능성을 보장하지 않습니다.',
  graph: 'VPC·서브넷별로 리소스를 크게 표시합니다. 배치 관계이며 실제 통신 경로를 증명하지 않습니다.',
  map: 'External | VPC | Subnet | Compute | NAT 컬럼 맵. 노드 클릭으로 교차 하이라이트.',
  k8s: 'Ingress → Service → Pod → Node 컬럼 맵. 노드 클릭으로 교차 하이라이트.',
};

/** 계정 전체 인프라 배치 그래프 + 컬럼형 맵 뷰 (v1 Infra Map/K8s Map parity). */
function InfraTopologyPageInner() {
  const { tt } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const raw = params.get('view');
  const view: View = raw === 'map' || raw === 'k8s' || raw === 'vpc' ? raw : 'graph';
  const [q, setQ] = useState('');
  const setView = (v: View) => router.replace(`/topology/infra${v === 'graph' ? '' : `?view=${v}`}`);
  const onVpc = (id: string) => router.push(`/topology/infra?${new URLSearchParams({ view: 'vpc', vpc: id })}`);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={tt(view === 'vpc' ? 'VPC 연결 그래프' : '인프라 배치 그래프')}
        subtitle={tt(SUBTITLES[view])}
        right={
          <div className="flex max-w-full flex-wrap items-center gap-2 text-[12px] text-ink-600">
            <div className="flex max-w-full overflow-auto rounded-md border border-ink-200">
              {VIEWS.map(([v, label]) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  aria-pressed={view === v}
                  className={`whitespace-nowrap px-2 py-1 ${view === v ? 'bg-brand-600 text-white' : 'bg-card hover:bg-ink-50'}`}
                >
                  {tt(label)}
                </button>
              ))}
            </div>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={tt('검색 (id · 이름 · IP · 타입)…')}
              className="w-full min-w-0 rounded-md border border-ink-200 bg-card px-2 py-1 text-[12px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 sm:w-56"
            />
            <Link href="/topology" className="rounded-md border border-ink-200 bg-card px-2 py-1 hover:bg-ink-50">{tt('← 트래픽 흐름')}</Link>
          </div>
        }
      />
      {view === 'vpc' && <div className="min-h-0 flex-1 overflow-auto p-4">
        <VpcConnectivitySection topology initialVpc={params.get('vpc') ?? ''} query={q} />
      </div>}
      {view === 'graph' && <GraphView q={q} onVpc={onVpc} />}
      {view === 'map' && <InfraMapView query={q} />}
      {view === 'k8s' && <K8sMapView query={q} />}
    </div>
  );
}

// useSearchParams requires a Suspense boundary at build time (repo convention: assistant/page.tsx).
export default function InfraTopologyPage() {
  return (
    <Suspense fallback={<div className="p-6 text-[13px] text-ink-400">로딩 중…</div>}>
      <InfraTopologyPageInner />
    </Suspense>
  );
}
