'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { Activity, Box, Cloud, Database, GitBranch, Network, Search, Server, X } from 'lucide-react';
import { Background, Controls, MarkerType, MiniMap, Position, type Edge, type Node, type ReactFlowInstance } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { filterE2eGraph, matchesE2eQuery, selectE2eGraph } from '@/lib/e2e-topology';
import type { E2eEvidence, E2eGraph, E2eNode } from '@/lib/e2e-topology-types';
import type { NfmEndpoint, NfmFlowRow } from '@/lib/nfm';
import { layoutFlow } from '@/lib/flow-layout';
import { useTheme } from '@/lib/use-theme';
import { useI18n } from '@/components/shell/LanguageProvider';
import Button from '@/components/ui/Button';

const ReactFlow = dynamic(() => import('@xyflow/react').then((m) => m.ReactFlow), { ssr: false });
const NODE_SIZE = { width: 232, height: 76 };
const EVIDENCE: Record<E2eEvidence, { label: string; color: string; dash?: string }> = {
  configuration: { label: '구성 관계', color: '#8795a5', dash: '6 4' },
  service: { label: '서비스 관측', color: '#8b5cf6' },
  network: { label: '네트워크 관측', color: '#0284c7' },
  identity: { label: '식별자 연결', color: '#0d9488', dash: '3 4' },
  context: { label: '경유 구성요소', color: '#c08438', dash: '2 5' },
};
const ALL_EVIDENCE = Object.keys(EVIDENCE) as E2eEvidence[];
const METRIC_LABELS: Record<string, string> = {
  DATA_TRANSFERRED: '전송량', ROUND_TRIP_TIME: 'RTT', RETRANSMISSIONS: '재전송', TIMEOUTS: '타임아웃',
};
const SOURCE_LABELS = { configuration: '구성', service: '서비스', network: 'NFM' };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const display = (v: unknown): string => v == null || v === '' ? '—' : Array.isArray(v) ? v.join(', ') : String(v);
function metricValue(value: number, unit: string): string {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (unit === 'Bytes') {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
    return `${Number(value.toFixed(1)).toLocaleString()} ${units[i]}`;
  }
  return `${Number(value.toFixed(2)).toLocaleString()} ${unit === 'Milliseconds' ? 'ms' : unit}`;
}
function timeLabel(value: unknown): string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString() : '—';
}
function endpointLabel(endpoint: NfmEndpoint): string {
  return endpoint.podName ? `${endpoint.podNamespace ?? '?'}/${endpoint.podName}`
    : endpoint.instanceId || endpoint.ip || endpoint.serviceName || '식별 정보 없음';
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
  const Icon = node.kind === 'connection' ? Activity : node.kind === 'db' ? Database
    : node.kind === 'construct' ? GitBranch : node.kind === 'workload' ? Box
      : node.layer === 'network' ? Network : node.kind === 'target' ? Server : Cloud;
  return <Icon size={16} aria-hidden className="shrink-0" />;
}

export default function E2eGraphCanvas({ graph: inputGraph }: { graph: E2eGraph }) {
  const { tt } = useI18n();
  const graph = useMemo(() => ({
    ...inputGraph,
    nodes: inputGraph.nodes.map((node) => {
      const flow = flowOf(node);
      return flow && node.label === node.meta.metric
        ? { ...node, label: `${endpointLabel(flow.local)} ↔ ${endpointLabel(flow.remote)}` } : node;
    }),
  }), [inputGraph]);
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
    const connections = view.nodes.filter((node) => node.kind === 'connection');
    const primary = selected ?? [...connections].sort((a, b) =>
      (flowOf(b)?.value ?? 0) - (flowOf(a)?.value ?? 0))[0];
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
    return { nodes: view.nodes.filter((node) => keep.has(node.id)).map(({ id }) => ({ id })), minZoom: 0.7 };
  }, [view, selected, overview]);
  const fitOptions = useMemo(() => ({ ...viewport, padding: 0.18, maxZoom: 1.15 }), [viewport]);
  const { nodes, edges } = useMemo(() => {
    const positions = new Map(layoutFlow(view, { nodeSize: () => NODE_SIZE }).map((p) => [p.id, p]));
    const nodes: Node[] = view.nodes.map((n) => {
      const flow = flowOf(n);
      const color = n.layer === 'network' ? '#0284c7' : n.layer === 'service' ? '#8b5cf6' : '#7c8b9c';
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
              {flow ? `${tt(METRIC_LABELS[String(n.meta.metric)] ?? String(n.meta.metric))} · ${metricValue(flow.value, String(n.meta.unit ?? flow.unit))}`
                : `${tt(SOURCE_LABELS[n.layer])} · ${n.kind}`}
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
  }, [view, selected?.id, dark, byId, tt]);
  useEffect(() => {
    if (!view.nodes.length) { instance.current = null; return; }
    const frame = requestAnimationFrame(() => instance.current?.fitView({ ...fitOptions, duration: 200 }));
    return () => cancelAnimationFrame(frame);
  }, [fitOptions, view.nodes.length]);
  useEffect(() => () => { instance.current = null; }, []);
  const selectedEdges = selected ? view.edges.filter((e) => e.source === selected.id || e.target === selected.id) : [];
  const selectedFlow = selected ? flowOf(selected) : null;
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
        <span>{tt('네트워크 관계')} <span data-testid="e2e-network-edge-count">{view.edges.filter((e) => e.evidence === 'network').length}</span></span>
        <span>{tt('미연결 엔드포인트')} {graph.summary.unmatchedEndpoints}</span>
        {graph.summary.ambiguousEndpoints > 0 && <span>{tt('식별자 중복')} {graph.summary.ambiguousEndpoints}</span>}
        {(view.omittedNodes > 0 || view.omittedEdges > 0) && (
          <span className="text-amber-700">{tt('화면 한도:')} {view.omittedNodes} {tt('노드')}, {view.omittedEdges} {tt('관계 생략 — 검색으로 범위를 좁히세요.')}</span>
        )}
      </div>
      <div className={`grid min-h-[480px] min-w-0 flex-1 gap-3 ${selected ? 'xl:grid-cols-[minmax(0,1fr)_320px]' : 'grid-cols-1'}`}>
        <div className="relative min-h-[480px] min-w-0 overflow-hidden rounded-xl border border-ink-100 bg-card">
          {view.nodes.length === 0 ? (
            <div className="flex min-h-[480px] items-center justify-center p-6 text-center text-[13px] text-ink-400">
              {tt(graph.nodes.length ? '검색 또는 관계 필터에 맞는 데이터가 없습니다.' : '표시할 관계 데이터가 없습니다.')}
            </div>
          ) : (
            <ReactFlow nodes={nodes} edges={edges} fitView minZoom={0.05} colorMode={dark ? 'dark' : 'light'}
              fitViewOptions={fitOptions} proOptions={{ hideAttribution: true }}
              onInit={(value) => { instance.current = value; }}
              onNodeClick={(_, node) => selectNode(node.id)} onPaneClick={() => setSelectedId(null)}>
              <Background /><Controls /><MiniMap pannable zoomable />
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
                  <p className="text-[11px] text-ink-500">{tt(METRIC_LABELS[String(selected.meta.metric)] ?? String(selected.meta.metric))}</p>
                  <p className="mt-1 text-xl font-semibold">{metricValue(selectedFlow.value, String(selected.meta.unit ?? selectedFlow.unit))}</p>
                  <p className="mt-1 text-[10px] text-ink-400">{tt('로컬·원격 간 집계값이며 개별 홉의 측정값이 아닙니다.')}</p>
                </div>
                <dl className="space-y-2">
                  {[
                    ['로컬', endpointLabel(selectedFlow.local)], ['원격', endpointLabel(selectedFlow.remote)],
                    ['로컬 IP', selectedFlow.local.ip], ['원격 IP', selectedFlow.remote.ip],
                    ['포트', selectedFlow.targetPort], ['SNAT', selectedFlow.snatIp], ['DNAT', selectedFlow.dnatIp],
                    ['분류', selected.meta.category], ['모니터', selected.meta.monitor],
                    ['관측 시작', timeLabel(selected.meta.startTime)], ['관측 종료', timeLabel(selected.meta.endTime)],
                  ].filter(([, value]) => value != null && value !== '').map(([key, value]) => (
                    <div key={String(key)}><dt className="text-[10px] text-ink-400">{tt(String(key))}</dt><dd className="break-all">{display(value)}</dd></div>
                  ))}
                </dl>
                <div>
                  <p className="mb-2 font-medium">{tt('경유 구성요소')}</p>
                  <ul className="space-y-1">{traversedItems(selectedFlow).map(item => <li key={item} className="break-all rounded bg-ink-50 px-2 py-1 font-mono text-[10px]">{item}</li>)}</ul>
                  <p className="mt-2 text-[10px] text-ink-400">{tt('관측된 구성요소이며 패킷의 통과 순서를 보장하지 않습니다.')}</p>
                </div>
                <Link href="/network-flow" className="inline-block text-brand-600 hover:underline">{tt('네트워크 모니터 열기')}</Link>
              </div>
            ) : (
              <dl className="space-y-2">
                {selected.layer !== 'network' && typeof selected.meta.id === 'string' && (
                  <div><dt className="text-[10px] text-ink-400">ID</dt><dd className="break-all font-mono text-[10px]">{selected.meta.id}</dd></div>
                )}
                {['cluster', 'namespace', 'deployment', 'podName', 'ip', 'vpcId', 'region', 'match', 'host', 'dbName', 'componentId', 'type'].map((key) => {
                  const nested = object(selected.meta.endpoint) ? selected.meta.endpoint[key] : undefined;
                  const value = selected.meta[key] ?? nested;
                  return value == null ? null : <div key={key}><dt className="text-[10px] text-ink-400">{key}</dt><dd className="break-all">{display(value)}</dd></div>;
                })}
              </dl>
            )}
            <div className="mt-5 border-t border-ink-100 pt-3">
              <p className="mb-2 font-medium">{tt('연결 근거')}</p>
              <ul className="space-y-2">{selectedEdges.slice(0, 20).map((e) => (
                <li key={e.id} className="break-words text-[11px]">
                  <span style={{ color: EVIDENCE[e.evidence].color }}>{tt(EVIDENCE[e.evidence].label)}</span>
                  <p className="text-ink-500">{byId.get(e.source)?.label} {e.directed ? '→' : '↔'} {byId.get(e.target)?.label}</p>
                  {e.meta?.match != null && <p className="font-mono text-[10px] text-ink-400">{String(e.meta.match)}</p>}
                  {e.meta?.confidence === 'inferred' && <p>{tt('추정 관계')}</p>}
                </li>
              ))}</ul>
            </div>
          </section>
        )}
      </div>
      <p className="text-[10px] text-ink-400">
        {tt('화살표는 구성·서비스 호출의 방향입니다. NFM 연결은 로컬·원격 관측이며 동일한 요청의 인과관계를 뜻하지 않습니다.')}
      </p>
    </div>
  );
}
