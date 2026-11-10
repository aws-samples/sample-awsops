'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { Background, Controls, MarkerType, Position, type Node, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import PageHeader from '@/components/ui/PageHeader';
import { fetchGraph, GraphFetchError, type GraphFetchFailure } from '@/lib/graph-fetch';
import GraphReadError from '@/components/topology/GraphReadError';
import { layoutFlow } from '@/lib/flow-layout';
import { selectGraphPaths, serviceOverview } from '@/lib/graph-display';
import { useI18n } from '@/components/shell/LanguageProvider';
import { useTheme } from '@/lib/use-theme';
import GraphCollectionStatus, { type GraphCollection } from '@/components/topology/GraphCollectionStatus';
import useGraphViewport from '@/components/topology/useGraphViewport';

const ReactFlow = dynamic(() => import('@xyflow/react').then(m => m.ReactFlow), { ssr: false });
interface GNode { id: string; kind: string; label: string; meta?: Record<string, unknown> }
interface GEdge { source: string; target: string; rel: string }
interface Graph { nodes: GNode[]; edges: GEdge[]; captured_at: string | null; collection?: GraphCollection }
const COLORS: Record<string, [string, string, string]> = {
  service: ['#3D6FB5', '#E6EEFE', '#16243E'],
  db: ['#C8902F', '#FBEFE0', '#33260C'],
  workload: ['#8A5BD0', '#F1E9FF', '#241A3E'],
  queue: ['#4D906C', '#E9F5EE', '#0E2E1C'],
};
const HEIGHT = 76, QUEUE_HEIGHT = 144;
const relLabel: Record<string, string> = {
  calls: 'calls', queries: 'queries', runs_on: 'runs on',
  linked: 'async link', publishes: 'publishes', consumes: 'consumes',
};
const text = (value: unknown) => typeof value === 'string' ? value : '';

export default function ServiceMapPage() {
  const { tt } = useI18n();
  const dark = useTheme() === 'dark';
  const [graph, setGraph] = useState<Graph | null>(null);
  const [err, setErr] = useState<GraphFetchFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [environment, setEnvironment] = useState('');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [showWorkloads, setShowWorkloads] = useState(false);

  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    setBusy(true); setErr(null);
    fetchGraph('/api/graph?class=trace', controller.signal)
      .then(d => { if (live) setGraph(d); })
      .catch(e => { if (live) { setGraph(null); setErr(e instanceof GraphFetchError ? e.reason : 'rejected'); } })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; controller.abort(); };
  }, [revision]);

  const environments = useMemo(() => [...new Set((graph?.nodes ?? [])
    .map(n => text(n.meta?.environment) || 'unknown'))].sort(), [graph]);
  const scoped = useMemo(() => {
    const nodes = (graph?.nodes ?? []).filter(n => !environment || (text(n.meta?.environment) || 'unknown') === environment);
    const ids = new Set(nodes.map(n => n.id));
    return { nodes, edges: (graph?.edges ?? []).filter(e => ids.has(e.source) && ids.has(e.target)) };
  }, [graph, environment]);
  const overview = useMemo(() => serviceOverview(scoped, showWorkloads), [scoped, showWorkloads]);
  const services = useMemo(() => overview.nodes.filter(n => n.kind === 'service')
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)), [overview]);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return overview.nodes.filter(n => [n.label, n.id, n.meta?.cluster, n.meta?.namespace, n.meta?.sourceId]
      .some(v => text(v).toLowerCase().includes(q)));
  }, [overview, query]);
  const focusId = overview.nodes.some(n => n.id === selectedId) ? selectedId : !showAll ? services[0]?.id ?? null : null;
  const selected = overview.nodes.find(n => n.id === focusId);
  const visible = useMemo(() => {
    if (query.trim()) return selectGraphPaths(overview, matches.map(n => n.id), 2);
    return focusId && !showAll ? selectGraphPaths(overview, [focusId], 2) : overview;
  }, [overview, matches, query, focusId, showAll]);
  const viewport = useGraphViewport(visible.nodes, visible.edges);
  const { nodes, edges } = useMemo(() => {
    const kinds = new Map(visible.nodes.map(n => [n.id, n.kind]));
    const pos = new Map(layoutFlow(visible, { rankdir: viewport.vertical ? 'TB' : 'LR', nodeSize: id => ({
      width: 240, height: kinds.get(id) === 'queue' ? QUEUE_HEIGHT : HEIGHT,
    }) }).map(p => [p.id, p]));
    const nodes: Node[] = visible.nodes.map(n => {
      const [border, light, deep] = COLORS[n.kind] ?? ['#9AA6B2', '#EEF0F2', '#1F262D'];
      const context = [n.meta?.cluster, n.meta?.namespace].filter(Boolean).join(' · ') || text(n.meta?.environment) || 'unknown';
      return {
        id: n.id, position: pos.get(n.id) ?? { x: 0, y: 0 },
        data: { label: <div className="nodrag nowheel text-left" title={`${n.kind}: ${n.label}\n${context}`}
          style={{ maxHeight: (n.kind === 'queue' ? QUEUE_HEIGHT : HEIGHT) - 18, overflowY: 'auto' }}>
          <div className="truncate text-[13px] font-semibold">{n.kind}: {n.label}</div>
          <div className="mt-1 truncate text-[10px] opacity-75">{context}</div>
          {n.kind === 'queue' && <div className="mt-1 text-[10px]" style={{ overflowWrap: 'anywhere' }}>
            {tt('Telemetry claim · AWS identity unverified')}<br />
            claimedAccountId: {text(n.meta?.claimedAccountId) || '—'}<br />
            claimedRegion: {text(n.meta?.claimedRegion) || '—'}
          </div>}
        </div> },
        sourcePosition: viewport.vertical ? Position.Bottom : Position.Right,
        targetPosition: viewport.vertical ? Position.Top : Position.Left,
        style: { background: dark ? deep : light, border: `${n.id === focusId ? 2 : 1}px solid ${border}`,
          borderRadius: 10, padding: 8, width: 240, height: n.kind === 'queue' ? QUEUE_HEIGHT : HEIGHT,
          color: dark ? '#E3E9EE' : '#16202A', cursor: 'pointer' },
      };
    });
    const edges: Edge[] = visible.edges.map(e => ({
      id: `${e.source}->${e.target}:${e.rel}`, source: e.source, target: e.target,
      type: 'smoothstep', label: relLabel[e.rel] ?? e.rel, animated: false,
      markerEnd: { type: MarkerType.ArrowClosed, color: '#9AA6B2' },
      style: { stroke: '#9AA6B2', strokeWidth: 1.4, ...(e.rel === 'runs_on' ? { strokeDasharray: '4 4' } : {}) },
      labelStyle: { fontSize: 10, fill: dark ? '#AFBAC3' : '#586773' },
    }));
    return { nodes, edges };
  }, [visible, dark, focusId, tt, viewport.vertical]);
  const focus = (id: string) => { setSelectedId(id); setQuery(''); setShowAll(false); };

  return (
    <div className="flex h-full min-w-0 flex-col overflow-y-auto">
      <PageHeader title={tt('서비스 맵')} subtitle={tt('서비스 호출과 데이터베이스 의존성을 살펴봅니다.')}
        right={<div className="flex flex-wrap gap-2">
          <Link href="/topology?view=e2e" className="rounded-md border border-ink-200 bg-card px-2 py-1 text-xs">{tt('서비스 + 네트워크 →')}</Link>
          <Link href="/topology/infra?view=map" className="rounded-md border border-ink-200 bg-card px-2 py-1 text-xs">{tt('인프라 맵 →')}</Link>
        </div>} />
      <div className="mx-4 mt-3 rounded-lg border border-ink-200 bg-card px-3 py-2 text-xs text-ink-600">
        {tt('호출 관계는 트레이스·서비스 지표의 관측입니다. IGW·VPC·서브넷은 인프라 맵에서 확인하세요.')}
        <p className="mt-1 text-ink-500">{tt('저장된 host 관측 자료입니다. member 계정의 EKS 소유권과 전체 네트워크 경로를 증명하지 않습니다.')}</p>
      </div>
      {graph && <GraphCollectionStatus collection={graph.collection} />}
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-100 px-4 py-2 text-xs">
        <input aria-label={tt('서비스 검색')} placeholder={tt('서비스·클러스터·데이터소스 검색')} value={query}
          onChange={e => { setQuery(e.target.value); setSelectedId(null); }} className="min-w-0 basis-full flex-1 rounded-md border border-ink-200 bg-card px-3 py-2 sm:basis-auto sm:max-w-xs" />
        <label>Environment <select aria-label="Environment" value={environment} onChange={e => { setEnvironment(e.target.value); setSelectedId(null); }}
          className="rounded-md border border-ink-200 bg-card px-2 py-2">
          <option value="">All</option>{environments.map(value => <option key={value}>{value}</option>)}
        </select></label>
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={showWorkloads} onChange={e => setShowWorkloads(e.target.checked)} />{tt('워크로드 표시')}</label>
        <button type="button" aria-pressed={showAll} onClick={() => { setShowAll(v => !v); setQuery(''); setSelectedId(null); }}
          className="rounded-md border border-ink-200 bg-card px-2 py-2">{tt(showAll ? '서비스 중심 보기' : '전체 그래프')}</button>
        <button type="button" disabled={busy || err !== null} onClick={() => setRevision(n => n + 1)}
          className="rounded-md border border-ink-200 bg-card px-2 py-2 disabled:opacity-50">{tt('새로고침')}</button>
      </div>
      {err && <GraphReadError reason={err} />}
      <div className="flex flex-wrap gap-2 px-4 py-2 text-[11px] text-ink-500" role="status">
        {busy && <span>{tt('불러오는 중…')}</span>}
        <span>{tt('표시')}: {visible.nodes.length}/{scoped.nodes.length} · {tt('연결')}: {visible.edges.length}/{scoped.edges.length}</span>
        {!showAll && focusId && !query.trim() && <span>{tt('선택한 서비스의 상·하위 2단계')}</span>}
        {!showWorkloads && scoped.nodes.length > overview.nodes.length && <span>{tt('워크로드 문맥은 숨김')}</span>}
        {graph?.captured_at && <span>{tt('그래프 시점:')} {new Date(graph.captured_at).toLocaleString()}</span>}
      </div>
      <div className="flex min-h-[620px] flex-1 flex-col md:min-h-0 md:flex-row">
        <aside className="flex max-h-44 shrink-0 flex-col border-b border-ink-100 bg-card md:max-h-none md:w-64 md:border-b-0 md:border-r">
          <div className="px-4 py-2 text-xs font-semibold">{tt('서비스')} · {services.length}</div>
          <div className="min-h-0 overflow-y-auto px-2 pb-2">
            {services.filter(n => !query.trim() || matches.some(m => m.id === n.id)).map(n =>
              <button key={n.id} type="button" onClick={() => focus(n.id)} aria-pressed={n.id === focusId}
                className={`mb-1 block w-full rounded-md px-2 py-2 text-left ${n.id === focusId ? 'bg-brand-50 text-brand-700' : 'hover:bg-ink-50'}`}>
                <span className="block truncate text-xs font-semibold" title={n.label}>{n.label}</span>
                <span className="block truncate text-[10px] text-ink-500" title={text(n.meta?.sourceId)}>
                  {[n.meta?.cluster, n.meta?.namespace, n.meta?.sourceId].filter(Boolean).join(' · ')}
                </span>
              </button>)}
          </div>
        </aside>
        <div ref={viewport.container} className="relative min-h-[440px] min-w-0 flex-1 md:min-h-64">
          {!nodes.length && !busy && !err && <div className="absolute inset-0 z-10 flex items-center justify-center p-4 text-sm text-ink-500">
            {tt(query.trim() ? '검색 결과가 없습니다.' : '표시할 호출 관계가 없습니다. 수집 상태와 계측 범위를 확인하세요.')}
          </div>}
          <ReactFlow nodes={nodes} edges={edges} onInit={viewport.onInit} onNodeClick={(_, node) => focus(node.id)}
            fitView minZoom={0.05} fitViewOptions={{ padding: 0.16, maxZoom: 1 }} colorMode={dark ? 'dark' : 'light'}
            nodesDraggable={false} nodesConnectable={false} proOptions={{ hideAttribution: true }}>
            <Background gap={24} /><Controls showInteractive={false} />
          </ReactFlow>
        </div>
      </div>
      {selected && <details className="shrink-0 border-t border-ink-100 bg-card px-4 py-2 text-xs">
        <summary className="cursor-pointer font-medium">{tt('선택한 리소스 상세')} · {selected.kind}: {selected.label}</summary>
        <dl className="grid max-h-40 grid-cols-[auto_1fr] gap-x-4 gap-y-1 overflow-y-auto pt-2">
          {['environment','cluster','namespace','sourceId','host','system','spanCount','errorSpanCount','claimedAccountId','claimedRegion'].map(key =>
            selected.meta?.[key] != null ? <div key={key} className="contents"><dt className="text-ink-500">{key}</dt><dd className="break-all">{String(selected.meta[key])}</dd></div> : null)}
        </dl>
        {selected.kind === 'db' && text(selected.meta?.infra_ref) && <Link className="mt-2 inline-block text-brand-700" href={`/topology/resource/${encodeURIComponent(text(selected.meta?.infra_ref))}`}>{tt('인프라 리소스 보기 →')}</Link>}
        {selected.kind === 'workload' && text(selected.meta?.cluster) && <Link className="mt-2 inline-block text-brand-700" href={`/topology?cluster=${encodeURIComponent(`eks:${text(selected.meta?.cluster)}`)}`}>{tt('클러스터 요청 흐름 →')}</Link>}
      </details>}
    </div>
  );
}
