'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { Activity, Box, CircleHelp, Cloud, Database, GitBranch, Network, Search, Server, X } from 'lucide-react';
import { Background, Controls, MarkerType, MiniMap, Position, type Edge, type Node, type ReactFlowInstance } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { filterE2eGraph, matchesE2eQuery, rankE2eConnections, selectE2eGraph } from '@/lib/e2e-topology';
import type { E2eCorrelationReason, E2eEvidence, E2eGraph, E2eNode } from '@/lib/e2e-topology-types';
import type { NfmEndpoint, NfmFlowRow } from '@/lib/nfm';
import { layoutFlow } from '@/lib/flow-layout';
import { localeOf } from '@/lib/i18n';
import { useTheme } from '@/lib/use-theme';
import { useI18n } from '@/components/shell/LanguageProvider';
import Button from '@/components/ui/Button';

const ReactFlow = dynamic(() => import('@xyflow/react').then((m) => m.ReactFlow), { ssr: false });
const NODE_SIZE = { width: 232, height: 76 };
const MEMBER_LIMIT = 20;
const EVIDENCE: Record<E2eEvidence, { label: string; color: string; dash?: string }> = {
  configuration: { label: '구성 관계', color: '#8795a5', dash: '6 4' },
  service: { label: '서비스 관측', color: '#8b5cf6' },
  network: { label: '네트워크 관측', color: '#0284c7' },
  identity: { label: '식별자 연결', color: '#0d9488', dash: '3 4' },
  context: { label: '참고 정보 (캐시된 구성·경유 구성요소)', color: '#c08438', dash: '2 5' },
};
const ALL_EVIDENCE = Object.keys(EVIDENCE) as E2eEvidence[];
const METRIC_LABELS: Record<string, string> = {
  DATA_TRANSFERRED: '전송량', ROUND_TRIP_TIME: 'RTT', RETRANSMISSIONS: '재전송', TIMEOUTS: '타임아웃',
};
const SOURCE_LABELS = { configuration: '구성', service: '서비스', network: 'NFM' };
const mainE2eConnection = (nodes: E2eNode[]) => rankE2eConnections(nodes)[0];
const READ_LABELS = {
  idle: '현재 적용된 네트워크 관측이 없습니다.', loading: '네트워크 관측을 불러오는 중입니다.',
  partial: '네트워크 관측 범위가 불완전합니다.', failed: '네트워크 관측 조회가 실패했습니다.',
  unknown: '네트워크 관측 조회 상태를 확인할 수 없습니다.',
  unsupported: '이 계정에서 네트워크 관측을 사용할 수 없습니다.',
};
const GENERATED_LABELS: Record<string, string> = {
  network_observation: '네트워크 관측',
  local_endpoint: '로컬 엔드포인트',
  remote_endpoint: '원격 엔드포인트',
  cached_configured_endpoint_record: '캐시된 구성 엔드포인트 기록',
  configured_endpoint_record: '구성 엔드포인트 기록',
  configured_pod_identity: '구성에서 확인된 Pod 식별자',
  'Cached configured endpoint record': '캐시된 구성 엔드포인트 기록',
  'Configured endpoint record': '구성 엔드포인트 기록',
  'Configured pod identity': '구성에서 확인된 Pod 식별자',
};
const CORRELATION: Record<string, string> = { correlated: '식별자 연결', unmatched: '미연결', ambiguous: '식별 보류' };
const CORRELATION_REASONS: Record<E2eCorrelationReason, string> = {
  configuration_conflict: '구성 기록이 충돌하여 연결을 보류했습니다.',
  configuration_unverified: '구성 근거를 확인할 수 없어 연결을 보류했습니다.',
  workload_conflict: '워크로드 식별자가 충돌하여 연결을 보류했습니다.',
  workload_scope_unverified: '워크로드 범위를 확인할 수 없어 구성 기록 연결도 보류했습니다.',
  service_source_unverified: '서비스 근거의 완전성·신선도를 확인할 수 없어 워크로드 식별을 보류했습니다.',
  pod_identity_conflict: 'Pod 식별 정보가 충돌하여 연결을 보류했습니다.',
  context_only: '캐시된 구성 기록은 참고 정보이며 식별자 연결이 아닙니다.',
  no_match: '연결할 식별 근거가 없습니다.',
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const display = (v: unknown): string => v == null || v === '' ? '—' : Array.isArray(v) ? v.join(', ') : String(v);
const text = (v: unknown): string => typeof v === 'string' ? v.trim() : '';
const safeCount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
function remainingMembers(meta: Record<string, unknown>, length: number): number | null {
  if ([meta.count, meta.membersTruncated].some(value => value != null && safeCount(value) === null)) return null;
  const sampleTotal = length + (safeCount(meta.membersTruncated) ?? 0);
  if (!Number.isSafeInteger(sampleTotal)) return null;
  return Math.max(length, safeCount(meta.count) ?? 0, sampleTotal) - Math.min(length, MEMBER_LIMIT);
}
function metricValue(value: number, unit: string, locale: string): string {
  if (!Number.isFinite(value) || value < 0 || !unit || unit === '—') return '—';
  if (unit === 'Bytes') {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
    return `${Number(value.toFixed(1)).toLocaleString(locale)} ${units[i]}`;
  }
  return `${Number(value.toFixed(2)).toLocaleString(locale)}${unit === 'Count' ? '' : ` ${unit === 'Milliseconds' ? 'ms' : unit}`}`;
}
function timeLabel(value: unknown, locale: string): string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? `${new Date(value).toLocaleString(locale, { timeZone: 'UTC' })} UTC` : '—';
}
function CaptureTime({ value, locale }: { value: unknown; locale: string }) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? <time dateTime={value}>{timeLabel(value, locale)}</time> : <>—</>;
}
function endpointLabel(endpoint: NfmEndpoint | Record<string, unknown>, missing: string): string {
  return text(endpoint.podName) ? `${text(endpoint.podNamespace) || '?'}/${text(endpoint.podName)}`
    : text(endpoint.instanceId) || text(endpoint.ip) || text(endpoint.serviceName) || missing;
}
function flowOf(node: E2eNode): NfmFlowRow | null {
  const flow = node.meta.flow;
  return node.kind === 'connection' && object(flow) && object(flow.local) && object(flow.remote)
    && typeof flow.value === 'number' ? flow as unknown as NfmFlowRow : null;
}
function traversedItems(flow: NfmFlowRow): string[] {
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
  const ids = strings(flow.traversedIds);
  const represented = new Set(ids.map(id => id.split(':')[0]));
  return [...new Set([...ids, ...strings(flow.traversed).filter(kind => !represented.has(kind))])];
}
function IconForNode({ node }: { node: E2eNode }) {
  const Icon = identityWithheld(node) ? CircleHelp : node.kind === 'connection' ? Activity : node.kind === 'db' ? Database
    : node.kind === 'construct' ? GitBranch : node.kind === 'workload' ? Box
      : node.layer === 'network' ? Network : node.kind === 'target' ? node.meta.resolved === 'ambiguous' ? CircleHelp : Server : Cloud;
  return <Icon size={16} aria-hidden className="shrink-0" />;
}
function identityWithheld(node: E2eNode): boolean {
  return node.meta.e2e_correlation_blocked === true || node.meta.correlation === 'ambiguous'
    || node.meta.resolved === 'ambiguous' || !!text(node.meta.ambiguity);
}

export default function E2eGraphCanvas({ graph: inputGraph }: { graph: E2eGraph }) {
  const { tt, lang } = useI18n();
  const locale = localeOf(lang);
  const graph = useMemo(() => ({
    ...inputGraph,
    nodes: inputGraph.nodes.map((node) => {
      const endpoint = object(node.meta.endpoint) ? node.meta.endpoint : null;
      const fallback = node.meta.side === 'local' ? '로컬 엔드포인트' : '원격 엔드포인트';
      const generatedEndpoint = node.labelKey === 'local_endpoint' || node.labelKey === 'remote_endpoint'
        || node.label === fallback;
      const builderEndpoint = endpoint && [text(endpoint.podName), text(endpoint.instanceId), text(endpoint.ip)]
        .filter(Boolean).includes(node.label);
      if (node.layer === 'network' && node.kind === 'endpoint' && endpoint && (generatedEndpoint || builderEndpoint)) {
        return { ...node, label: endpointLabel(endpoint, tt(fallback)) };
      }
      if (node.labelKey && Object.hasOwn(GENERATED_LABELS, node.labelKey)) {
        return { ...node, label: tt(GENERATED_LABELS[node.labelKey]) };
      }
      const flow = flowOf(node);
      if (node.kind === 'connection' && !text(node.meta.metric) && node.label === '네트워크 관측') {
        return { ...node, label: tt('네트워크 관측') };
      }
      return flow && node.label === node.meta.metric
        ? { ...node, label: `${endpointLabel(flow.local, tt('식별 정보 없음'))} ↔ ${endpointLabel(flow.remote, tt('식별 정보 없음'))}` } : node;
    }),
    edges: inputGraph.edges.map(edge => edge.labelKey && Object.hasOwn(GENERATED_LABELS, edge.labelKey)
      ? { ...edge, label: tt(GENERATED_LABELS[edge.labelKey]) } : edge.label
      && ['configured-endpoint-match', 'same-identity'].includes(edge.relation) && Object.hasOwn(GENERATED_LABELS, edge.label)
      ? { ...edge, label: tt(GENERATED_LABELS[edge.label]) } : edge),
  }), [inputGraph, tt]);
  const readState = graph.summary.observationsUnsupported ? 'unsupported' : graph.summary.networkRead?.status ?? 'unknown';
  const dark = useTheme() === 'dark';
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [overview, setOverview] = useState(false);
  const [evidence, setEvidence] = useState<E2eEvidence[]>(ALL_EVIDENCE);
  const instance = useRef<ReactFlowInstance | null>(null);
  const eligible = useMemo(() => filterE2eGraph(graph, evidence), [graph, evidence]);
  const selected = eligible.nodes.find((n) => n.id === selectedId) ?? null;
  useEffect(() => {
    setSelectedId(current => current && !eligible.nodes.some(node => node.id === current) ? null : current);
  }, [eligible.nodes]);
  const view = useMemo(() => selectE2eGraph(graph, {
    query, focusId: selected?.id, evidence,
  }), [graph, query, selected?.id, evidence]);
  const matches = useMemo(() => {
    const search = query.trim().toLowerCase();
    return search ? eligible.nodes.filter(node => matchesE2eQuery(node, search)).slice(0, 10) : [];
  }, [eligible.nodes, query]);
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);
  const viewport = useMemo(() => {
    const primaryCandidate = mainE2eConnection(eligible.nodes);
    const primary = selected ?? (primaryCandidate && view.nodes.some(node => node.id === primaryCandidate.id)
      ? primaryCandidate : mainE2eConnection(view.nodes));
    if (overview || !primary) return { nodes: view.nodes.map(({ id }) => ({ id })), minZoom: 0.05 };
    const keep = new Set([primary.id]);
    let frontier = new Set(keep);
    for (let depth = 0; depth < 2; depth += 1) {
      const next = new Set<string>();
      for (const edge of view.edges) {
        if (edge.evidence === 'context' && depth > 0) continue;
        if (frontier.has(edge.source) && !keep.has(edge.target)) next.add(edge.target);
        if (frontier.has(edge.target) && !keep.has(edge.source)) next.add(edge.source);
      }
      for (const id of next) keep.add(id);
      frontier = next;
    }
    // A zoom floor must not clip a valid expanded target/workload neighborhood.
    return { nodes: view.nodes.filter((node) => keep.has(node.id)).map(({ id }) => ({ id })), minZoom: 0.05 };
  }, [view, selected, overview, eligible.nodes]);
  const fitOptions = useMemo(() => ({ ...viewport, padding: 0.18, maxZoom: 1.15 }), [viewport]);
  const { nodes, edges } = useMemo(() => {
    const positions = new Map(layoutFlow(view, { nodeSize: () => NODE_SIZE }).map((p) => [p.id, p]));
    const nodes: Node[] = view.nodes.map((n) => {
      const flow = flowOf(n);
      const color = identityWithheld(n) ? '#c08438'
        : n.layer === 'network' ? '#0284c7' : n.layer === 'service' ? '#8b5cf6' : '#7c8b9c';
      return {
        id: n.id, position: positions.get(n.id) ?? { x: 0, y: 0 },
        sourcePosition: Position.Right, targetPosition: Position.Left,
        data: { label: (
          <div data-e2e-kind={n.kind} className="flex h-full min-w-0 flex-col justify-center gap-1 text-left">
            <div className="flex min-w-0 items-center gap-2">
              <IconForNode node={n} />
              <span className="min-w-0 truncate font-semibold" title={n.label}>{n.label}</span>
            </div>
            <span className="truncate text-[11px] opacity-70">
              {flow ? `${tt(METRIC_LABELS[text(n.meta.metric)] ?? (text(n.meta.metric) || '네트워크 관측'))} · ${metricValue(flow.value, text(n.meta.unit) || text(flow.unit), locale)}`
                : `${tt(SOURCE_LABELS[n.layer])} · ${identityWithheld(n) ? tt('식별 보류') : n.kind}`}
            </span>
          </div>
        ) },
        style: {
          ...NODE_SIZE, padding: '8px 11px', borderRadius: 10, overflow: 'hidden',
          fontSize: 13, color: dark ? '#e3e9ee' : '#16202a',
          background: dark ? (n.kind === 'connection' ? '#0b3147' : '#18232f') : (n.kind === 'connection' ? '#eaf6fd' : '#ffffff'),
          border: `${n.id === selected?.id ? 2 : 1}px solid ${color}`, cursor: 'pointer',
        },
      };
    });
    const edges: Edge[] = view.edges.map((e) => {
      const style = EVIDENCE[e.evidence];
      const connection = byId.get(e.source)?.kind === 'connection' ? byId.get(e.source) : byId.get(e.target);
      const flow = connection ? flowOf(connection) : null;
      const width = e.evidence === 'network' && flow && Number.isFinite(flow.value) && flow.value >= 0
        && connection?.meta.metric === 'DATA_TRANSFERRED'
        ? Math.min(4, 1.5 + Math.log10(1 + flow.value) / 4) : 1.5;
      return {
        id: e.id, source: e.source, target: e.target,
        type: 'smoothstep', label: e.label || (e.evidence === 'identity' ? tt('식별자 일치') : undefined),
        markerEnd: e.directed ? { type: MarkerType.ArrowClosed, color: style.color, width: 15, height: 15 } : undefined,
        style: { stroke: style.color, strokeWidth: width,
          strokeDasharray: e.meta?.confidence === 'inferred' ? '6 4' : style.dash },
        labelStyle: { fontSize: 10, fill: dark ? '#e3e9ee' : '#586773' },
        labelBgStyle: { fill: dark ? '#18232f' : '#ffffff', fillOpacity: 0.92 },
      };
    });
    return { nodes, edges };
  }, [view, selected?.id, dark, byId, tt, locale]);
  useEffect(() => {
    if (!view.nodes.length) { instance.current = null; return; }
    const frame = requestAnimationFrame(() => instance.current?.fitView({ ...fitOptions, duration: 200 }));
    return () => cancelAnimationFrame(frame);
  }, [fitOptions, view.nodes.length]);
  useEffect(() => () => { instance.current = null; }, []);
  const selectedEdges = selected ? eligible.edges.filter((e) => e.source === selected.id || e.target === selected.id) : [];
  const visibleEdgeIds = new Set(view.edges.map(edge => edge.id));
  const omittedSelectedEdges = selectedEdges.filter(edge => !visibleEdgeIds.has(edge.id)).length;
  const selectedFlow = selected ? flowOf(selected) : null;
  const candidate = selected?.layer === 'configuration' && selected.meta.ownership_evidence === 'scope_unverified'
    && object(selected.meta.candidate) ? selected.meta.candidate : null;
  const candidateMeta: Record<string, unknown> = candidate && object(candidate.meta) ? candidate.meta : {};
  const groupedTarget = selected?.kind === 'target'
    && (Array.isArray(selected.meta.members) || Array.isArray(selected.meta.memberIdentities)
      || (safeCount(selected.meta.count) ?? 0) > 1);
  const traversed = selectedFlow ? traversedItems(selectedFlow) : [];
  const selectNode = (id: string) => { setOverview(false); setQuery(''); setSelectedId(id); };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3" data-testid="e2e-topology-canvas">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative min-w-0 flex-1 sm:max-w-sm">
          <div className="flex items-center gap-2 rounded-lg border border-ink-100 bg-card px-3 py-2">
            <Search size={15} className="shrink-0 text-ink-400" />
            <input type="search" aria-label={tt('서비스 또는 리소스 검색')} placeholder={tt('서비스, Pod, IP 또는 리소스 검색')}
              value={query} onChange={(e) => { setSelectedId(null); setQuery(e.target.value); }}
              className="min-w-0 flex-1 bg-transparent text-[12px] text-ink-800 outline-none" />
          </div>
          {matches.length > 0 && (
            <div className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-ink-100 bg-card p-1 shadow-pop">
              {matches.map((n) => (
                <button key={n.id} type="button" aria-label={`${tt('선택:')} ${n.label}`} onClick={() => selectNode(n.id)}
                  className="flex w-full min-w-0 items-center gap-2 rounded px-2 py-2 text-left text-[12px] text-ink-700 hover:bg-ink-50">
                  <IconForNode node={n} /><span className="truncate">{n.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant={overview ? 'secondary' : 'primary'} size="sm" aria-pressed={!overview} onClick={() => { setOverview(false); setSelectedId(null); setQuery(''); }}>
            {tt('주요 흐름 확대')}
          </Button>
          <Button variant="secondary" size="sm" aria-pressed={overview} onClick={() => { setOverview(true); setSelectedId(null); setQuery(''); }}>
            {tt('전체 보기')}
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-ink-600" aria-label={tt('관계 유형')}>
        {ALL_EVIDENCE.map((key) => (
          <label key={key} className="inline-flex cursor-pointer items-center gap-1.5">
            <input type="checkbox" checked={evidence.includes(key)} onChange={() => {
              setSelectedId(null);
              setEvidence(prev => prev.includes(key) ? prev.filter(v => v !== key) : [...prev, key]);
            }} />
            <span aria-hidden className="h-0.5 w-4" style={{ background: EVIDENCE[key].color }} />
            {tt(EVIDENCE[key].label)}
          </label>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-500" role="status">
        <span>{tt('표시 노드')} {view.nodes.length} · {tt('관계')} {view.edges.length}</span>
        {!graph.summary.configurationComplete && <span>{tt('구성 근거를 확인할 수 없어 연결을 보류했습니다.')}</span>}
        {!graph.summary.servicesComplete && <span>{tt('서비스 근거의 완전성·신선도를 확인할 수 없어 워크로드 식별을 보류했습니다.')}</span>}
        {readState !== 'complete' && <span>{tt(READ_LABELS[readState])}</span>}
        {!!graph.summary.networkRead?.failedCategories?.length && <span>{tt('조회 실패 분류:')} {graph.summary.networkRead.failedCategories.join(', ')}</span>}
        {!!graph.summary.networkRead?.unknownWindowCategories?.length && <span>{tt('관측 기간 미확인 분류:')} {graph.summary.networkRead.unknownWindowCategories.join(', ')}</span>}
        <span>{tt('네트워크 관계')} <span data-testid="e2e-network-edge-count">{view.edges.filter((e) => e.evidence === 'network').length}</span></span>
        {readState === 'unsupported' ? null
          : graph.summary.networkFlows === 0 ? <span>{tt(readState === 'complete'
            ? '표시할 네트워크 관측이 없습니다.' : '네트워크 관측 데이터가 없어 연결 여부를 집계할 수 없습니다.')}</span>
            : <>
              <span>{tt('미연결 관측')} {graph.summary.unmatchedEndpoints}</span>
              {graph.summary.ambiguousEndpoints > 0 && <span>{tt('식별 보류 관측')} {graph.summary.ambiguousEndpoints}</span>}
              <span>{tt('관측 행의 로컬·원격을 각각 집계하며 고유 엔드포인트 수가 아닙니다.')}</span>
            </>}
        {(view.omittedNodes > 0 || view.omittedEdges > 0) && (
          <span className="text-amber-700">{tt('화면 한도:')} {view.omittedNodes} {tt('노드')}, {view.omittedEdges} {tt('관계 생략 — 검색으로 범위를 좁히세요.')}</span>
        )}
        {Object.keys(view.omittedCategoryCounts).length > 0 && (
          <span className="text-amber-700">{tt('표시 한도로 제한된 관측 (분류별):')} {Object.entries(view.omittedCategoryCounts)
            .sort(([a], [b]) => a.localeCompare(b, 'en'))
            .map(([category, count]) => `${category || tt('분류 미확인')}: ${count}`).join(', ')}</span>
        )}
      </div>
      <div className={`grid h-[min(900px,calc(100dvh-64px))] min-h-[480px] min-w-0 shrink-0 gap-3 ${selected ? 'xl:grid-cols-[minmax(0,1fr)_320px]' : 'grid-cols-1'}`}>
        <div className="relative min-h-[480px] min-w-0 overflow-hidden rounded-xl border border-ink-100 bg-card">
          {view.nodes.length === 0 ? (
            <div className="flex min-h-[480px] items-center justify-center p-6 text-center text-[13px] text-ink-400">
              {tt(graph.nodes.length ? '검색 또는 관계 필터에 맞는 데이터가 없습니다.' : '표시할 관계 데이터가 없습니다.')}
            </div>
          ) : (
            <ReactFlow nodes={nodes} edges={edges} nodesDraggable={false} nodesConnectable={false}
              fitView minZoom={0.05} colorMode={dark ? 'dark' : 'light'}
              fitViewOptions={fitOptions} proOptions={{ hideAttribution: true }}
              onInit={(value) => { instance.current = value; }}
              onNodeClick={(_, node) => selectNode(node.id)} onPaneClick={() => setSelectedId(null)}>
              <Background /><Controls showInteractive={false} /><MiniMap className="hidden md:block" pannable zoomable />
            </ReactFlow>
          )}
        </div>
        {selected && (
          <section aria-label={tt('선택한 노드 상세')} className="min-w-0 overflow-auto rounded-xl border border-ink-100 bg-card p-4 text-[12px] text-ink-700">
            <div className="mb-4 flex items-start justify-between gap-2">
              <div className="min-w-0"><p className="mb-1 text-[10px] text-ink-400">{tt(SOURCE_LABELS[selected.layer])}</p>
                <h3 className="break-words font-semibold">{selected.label}</h3></div>
              <button type="button" aria-label={tt('상세 닫기')} onClick={() => setSelectedId(null)}><X size={16} /></button>
            </div>
            {selectedFlow ? (
              <div className="space-y-4">
                <div className="rounded-lg bg-ink-50 p-3">
                  <p className="text-[11px] text-ink-500">{tt(METRIC_LABELS[text(selected.meta.metric)] ?? (text(selected.meta.metric) || '네트워크 관측'))}</p>
                  <p data-testid="e2e-selected-metric" className="mt-1 text-xl font-semibold">{metricValue(selectedFlow.value, text(selected.meta.unit) || text(selectedFlow.unit), locale)}</p>
                  <p className="mt-1 text-[10px] text-ink-400">{tt('로컬·원격 간 집계값이며 개별 홉의 측정값이 아닙니다.')}</p>
                  {selected.meta.capped === true && <p className="mt-2 text-[10px] text-amber-700">{tt('상위 기여자 표본 상한에 도달했습니다. 전체 트래픽을 나타내지 않습니다.')}</p>}
                </div>
                <dl className="space-y-2">
                  {[
                    ['로컬', endpointLabel(selectedFlow.local, tt('식별 정보 없음'))], ['원격', endpointLabel(selectedFlow.remote, tt('식별 정보 없음'))],
                    ['로컬 IP', selectedFlow.local.ip], ['원격 IP', selectedFlow.remote.ip],
                    ['포트', selectedFlow.targetPort], ['SNAT', selectedFlow.snatIp], ['DNAT', selectedFlow.dnatIp],
                    ['분류', selected.meta.category], ['모니터', selected.meta.monitor],
                    ['windowQuality', selected.meta.windowQuality],
                    ['관측 시작', timeLabel(selected.meta.startTime, locale)], ['관측 종료', timeLabel(selected.meta.endTime, locale)],
                    ['조회 시각', timeLabel(selected.meta.queriedAt, locale)],
                  ].filter(([, value]) => value != null && value !== '').map(([key, value]) => (
                    <div key={String(key)}><dt className="text-[10px] text-ink-400">{tt(String(key))}</dt><dd className="break-all">{display(value)}</dd></div>
                  ))}
                </dl>
                <div>
                  <p className="mb-2 font-medium">{tt('경유 구성요소')}</p>
                  <ul className="space-y-1">{traversed.map(item => <li key={item} className="break-all rounded bg-ink-50 px-2 py-1 font-mono text-[10px]">{item}</li>)}</ul>
                  <p className="mt-2 text-[10px] text-ink-400">{tt(traversed.length ? '관측된 구성요소이며 패킷의 통과 순서를 보장하지 않습니다.' : '관측에 경유 구성요소 정보가 없습니다.')}</p>
                </div>
                <Link href="/network-flow" className="inline-block text-brand-600 hover:underline">{tt('네트워크 모니터 열기')}</Link>
              </div>
            ) : (
              <>
              {groupedTarget && <p className="mb-3 text-amber-700">{tt('여러 타깃을 묶은 구성 기록입니다.')}</p>}
              <dl className="space-y-2">
                {selected.layer !== 'network' && typeof selected.meta.id === 'string' && (
                  <div><dt className="text-[10px] text-ink-400">ID</dt><dd className="break-all font-mono text-[10px]">{selected.meta.id}</dd></div>
                )}
                {selected.layer !== 'network' && <div><dt className="text-[10px] text-ink-400">
                  {selected.kind === 'target' ? tt('대상 그룹 수집 시각') : selected.layer === 'service' ? tt('노드 수집 시각') : 'capturedAt'}</dt>
                  <dd><CaptureTime value={selected.kind === 'target' ? selected.meta.targetCapturedAt : selected.meta.capturedAt} locale={locale} /></dd>
                  {selected.kind === 'target' && <dd className="text-[10px] text-ink-400">{tt('대상 그룹 구성의 시각이며 소유권 증거의 시각이 아닙니다.')}</dd>}</div>}
                {selected.layer === 'service' && <div>
                  <dt className="text-[10px] text-ink-400">{tt('스냅샷 표시 시각')}</dt>
                  <dd><CaptureTime value={selected.meta.snapshotCapturedAt} locale={locale} /></dd>
                  <dd className="text-[10px] text-ink-400">{tt('스냅샷 표시 시각은 개별 노드·관계의 수집 시각이나 관측 구간이 아닙니다.')}</dd>
                </div>}
                {['cluster', 'namespace', 'deployment', 'pod', 'pods', 'resolved', 'podName', 'podNamespace', 'instanceId', 'az', 'subnetId', 'serviceName', 'ip', 'vpcId', 'region', 'match', 'host', 'dbName', 'componentId', 'type',
                  'count', 'members', 'membersTruncated', 'memberIdentities', 'ownership_evidence', 'ownership_reason', 'ambiguity', 'e2e_correlation_blocked', 'workloadReadStatus'].map((key) => {
                  if (groupedTarget && (key === 'pod' || key === 'namespace')) return null;
                  const nested = object(selected.meta.endpoint) ? selected.meta.endpoint[key] : undefined;
                  const value = selected.meta[key] ?? nested;
                  const items = (key === 'members' || key === 'memberIdentities') && Array.isArray(value) ? value : null;
                  const remaining = items ? remainingMembers(selected.meta, items.length) : 0;
                  const counter = key === 'count' || key === 'membersTruncated';
                  return value == null ? null : <div key={key}>
                    <dt className="text-[10px] text-ink-400">{key}</dt>
                    <dd className="break-all">
                      {key === 'memberIdentities' && items ? <ul>{items.slice(0, MEMBER_LIMIT).map((member, i) => (
                        <li key={i}>{object(member) ? `${display(member.id)} · ${text(member.namespace) || '?'}/${text(member.pod) || '?'}` : display(member)}</li>
                      ))}</ul> : display(counter ? safeCount(value) : items ? items.slice(0, MEMBER_LIMIT) : value)}
                      {remaining === null ? <p>{tt('추가 멤버 수 미확인')}</p>
                        : remaining > 0 && <p>+{remaining.toLocaleString(locale)} {tt('멤버 더 있음')}</p>}
                    </dd>
                  </div>;
                })}
                {typeof selected.meta.correlation === 'string' && <div>
                  <dt className="text-[10px] text-ink-400">{tt('식별 상태')}</dt>
                  <dd>{tt(CORRELATION[selected.meta.correlation] ?? selected.meta.correlation)}</dd>
                </div>}
                {typeof selected.meta.correlationReason === 'string' && <div>
                  <dt className="text-[10px] text-ink-400">correlationReason</dt>
                  <dd className="break-all">{selected.meta.correlationReason}</dd>
                  {CORRELATION_REASONS[selected.meta.correlationReason as E2eCorrelationReason] && <dd>{tt(CORRELATION_REASONS[selected.meta.correlationReason as E2eCorrelationReason])}</dd>}
                </div>}
              </dl>
              </>
            )}
            {candidate && <section aria-label={tt('소유권 미확인 후보')} className="mt-4 rounded-lg border border-ink-100 p-3">
              <h4 className="mb-2 font-medium">{tt('소유권 미확인 후보')}</h4>
              <dl className="space-y-2">{[
                ['label', candidate.label], ['resolved', candidate.resolved],
                ...['cluster', 'namespace', 'workload', 'ecsService', 'task', 'pod', 'region', 'vpcId', 'subnetId']
                  .map(key => [key, candidateMeta[key]]),
              ].filter(([, value]) => typeof value === 'string' && value !== '').map(([key, value]) => (
                <div key={String(key)}><dt className="text-[10px] text-ink-400">{String(key)}</dt>
                  <dd className="break-all">{display(value)}</dd></div>
              ))}</dl>
            </section>}
            <div className="mt-5 border-t border-ink-100 pt-3">
              <p className="mb-2 font-medium">{tt('연결 근거')}</p>
              {omittedSelectedEdges > 0 && <p className="mb-2 text-[10px] text-amber-700">{tt('캔버스에서 생략된 관계:')} {omittedSelectedEdges}</p>}
              {selectedEdges.length === 0 && <p>{tt('현재 관계 필터에서 연결 근거가 없습니다.')}</p>}
              <ul className="space-y-2">{selectedEdges.slice(0, 20).map((e) => (
                <li key={e.id} className="break-words text-[11px]">
                  <span style={{ color: EVIDENCE[e.evidence].color }}>{e.label || tt(EVIDENCE[e.evidence].label)}</span>
                  <p className="text-ink-500">{byId.get(e.source)?.label} {e.directed ? '→' : '↔'} {byId.get(e.target)?.label}</p>
                  {e.meta?.match != null && <p className="font-mono text-[10px] text-ink-400">{String(e.meta.match)}</p>}
                  {e.relation === 'configured-endpoint-match' && <p>
                    <span className="text-ink-400">{tt('대상 그룹 수집 시각')}</span>
                    {' · '}<CaptureTime value={e.meta?.targetCapturedAt} locale={locale} /></p>}
                  {e.evidence === 'service' && <p>
                    <span className="text-ink-400">{tt('스냅샷 표시 시각')}</span>
                    {' · '}<CaptureTime value={e.meta?.snapshotCapturedAt} locale={locale} /></p>}
                  {text(e.meta?.pod) && <p className="font-mono text-[10px]">{[e.meta?.cluster, e.meta?.namespace, e.meta?.pod].map(text).filter(Boolean).join(' / ')}</p>}
                  <p className="text-[10px] text-ink-400">relation: {e.relation}</p>
                  {e.meta?.confidence === 'inferred' && <p>{tt('추정 관계')}</p>}
                  {e.meta?.confidence != null && <p className="text-[10px] text-ink-400">confidence: {String(e.meta.confidence)}</p>}
                  {e.relation === 'configured-endpoint-match' && <>
                    {['ownership', 'ownership_evidence', 'ownership_reason', 'ambiguity', 'e2e_correlation_blocked'].map(key =>
                      e.meta?.[key] === undefined ? null : <p key={key} className="text-[10px] text-ink-400">
                        {key}: {display(e.meta[key])}
                      </p>)}
                    {selected.kind !== 'target' && <p className="text-[10px] text-ink-400">{tt('대상 그룹 구성의 시각이며 소유권 증거의 시각이 아닙니다.')}</p>}
                  </>}
                </li>
              ))}</ul>
              {selectedEdges.length > 20 && <p className="mt-2">+{selectedEdges.length - 20} {tt('관계 더 있음')}</p>}
            </div>
          </section>
        )}
      </div>
      <p className="text-[10px] text-ink-400">
        {tt('화살표는 구성·서비스 관계의 방향입니다. NFM 연결은 로컬·원격 관측이며 동일한 요청의 인과관계를 뜻하지 않습니다.')}
      </p>
    </div>
  );
}
