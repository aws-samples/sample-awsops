'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Background, Controls, Position, type Node, type Edge, type ReactFlowInstance } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import PageHeader from '@/components/ui/PageHeader';
import { layoutFlow } from '@/lib/flow-layout';
import { useI18n } from '@/components/shell/LanguageProvider';
import GraphCollectionStatus, { type GraphCollection } from '@/components/topology/GraphCollectionStatus';

// ReactFlow touches the DOM on mount — client-only.
const ReactFlow = dynamic(() => import('@xyflow/react').then((m) => m.ReactFlow), { ssr: false });

interface GNode { id: string; kind: string; label: string; meta?: Record<string, unknown> }
interface GEdge { source: string; target: string; rel: string }
interface Graph { nodes: GNode[]; edges: GEdge[]; captured_at: string | null; collection?: GraphCollection }

// kind → [bg, border] (paper/ink tokens; service-map kinds, mirrors resource/[id]'s COLORS)
const COLORS: Record<string, [string, string]> = {
  service: ['#E6EEFE', '#3D6FB5'],   // blue
  db: ['#FBEFE0', '#C8902F'],        // amber
  workload: ['#F1E9FF', '#8A5BD0'],  // purple
  queue: ['#E9F5EE', '#4D906C'],
};
const RESOURCE = ['#EEF0F2', '#9AA6B2'] as const;

const relLabel: Record<string, string> = {
  calls: 'calls', queries: 'queries', runs_on: 'runs on',
  linked: 'async link', publishes: 'publishes', consumes: 'consumes',
};

// db-node meta carries infra_ref (M2 bridge) when infra-topology's meta.host matched this host.
const infraRefOf = (meta?: Record<string, unknown>): string | undefined =>
  typeof meta?.infra_ref === 'string' ? meta.infra_ref : undefined;

// workload-node meta carries cluster (from the span's k8s.cluster.name) → deep-link to the main
// flow topology filtered to that EKS cluster (its filter key is `${resolved}:${cluster}`, resolved
// = 'eks' for live-resolved EKS target nodes).
const clusterOf = (meta?: Record<string, unknown>): string | undefined =>
  typeof meta?.cluster === 'string' && meta.cluster ? meta.cluster : undefined;

export default function ServiceMapPage() {
  const { tt } = useI18n();
  const router = useRouter();
  const [graph, setGraph] = useState<Graph | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [environment, setEnvironment] = useState('');
  const flow = useRef<ReactFlowInstance | null>(null);
  const canvas = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let live = true;
    setBusy(true);
    fetch('/api/graph?class=trace')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (live) { setGraph(d); setErr(''); } })
      .catch((e) => { if (live) setErr(String(e instanceof Error ? e.message : e)); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [revision]);

  const environments = useMemo(() => [...new Set((graph?.nodes ?? [])
    .map((n) => String(n.meta?.environment ?? 'unknown')))].sort(), [graph]);
  const visibleGraph = useMemo(() => {
    if (!graph || !environment) return graph;
    const nodes = graph.nodes.filter((n) => String(n.meta?.environment ?? 'unknown') === environment);
    const ids = new Set(nodes.map((n) => n.id));
    return { ...graph, nodes, edges: graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target)) };
  }, [graph, environment]);

  const metaById = useMemo(
    () => new Map((graph?.nodes ?? []).map((n) => [n.id, n.meta])),
    [graph],
  );

  const { nodes, edges } = useMemo(() => {
    if (!visibleGraph) return { nodes: [] as Node[], edges: [] as Edge[] };
    const pos = Object.fromEntries(
      layoutFlow(
        { nodes: visibleGraph.nodes as never, edges: visibleGraph.edges.map((e) => ({ id: `${e.source}->${e.target}:${e.rel}`, source: e.source, target: e.target, confidence: 'observed' })) as never },
        { rankdir: 'LR' },
      ).map((p) => [p.id, p]),
    );
    const nodes: Node[] = visibleGraph.nodes.map((n) => {
      const [bg, border] = COLORS[n.kind] ?? RESOURCE;
      const p = pos[n.id] ?? { x: 0, y: 0 };
      const clickable = (n.kind === 'db' && !!infraRefOf(n.meta)) || (n.kind === 'workload' && !!clusterOf(n.meta));
      return {
        id: n.id,
        position: { x: p.x, y: p.y },
        data: { label: `${n.kind}: ${n.label}\n${[
          n.meta?.environment ?? 'unknown', n.meta?.cluster, n.meta?.namespace, n.meta?.broker, n.meta?.sourceId,
        ].filter(Boolean).join(' · ')}${n.kind === 'queue' ? `\n${tt('Telemetry claim · AWS identity unverified')}` : ''}` },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        style: {
          background: bg,
          border: `1px solid ${border}`,
          borderRadius: 8, fontSize: 11, padding: 6, width: 240, color: '#16202A', whiteSpace: 'pre-line',
          cursor: clickable ? 'pointer' : 'default',
        },
      };
    });
    const edges: Edge[] = visibleGraph.edges.map((e) => ({
      id: `${e.source}->${e.target}:${e.rel}`, source: e.source, target: e.target,
      label: relLabel[e.rel] ?? e.rel, animated: false,
      style: { stroke: '#9AA6B2' }, labelStyle: { fontSize: 9, fill: '#586773' },
    }));
    return { nodes, edges };
  }, [visibleGraph, tt]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => { void flow.current?.fitView({ padding: 0.2 }); });
    return () => cancelAnimationFrame(frame);
  }, [nodes, edges]);

  useEffect(() => {
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { void flow.current?.fitView({ padding: 0.2 }); });
    });
    if (canvas.current) observer.observe(canvas.current);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);

  const onNodeClick = (_: unknown, node: Node) => {
    // A claimed queue ARN is never an inventory bridge, including retained metadata.
    if (graph?.nodes.find(n => n.id === node.id)?.kind === 'queue') return;
    const meta = metaById.get(node.id);
    const ref = infraRefOf(meta);
    if (ref) { router.push(`/topology/resource/${encodeURIComponent(ref)}`); return; }
    const cluster = clusterOf(meta);
    if (cluster) router.push(`/topology?cluster=${encodeURIComponent(`eks:${cluster}`)}`);
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="서비스 맵 (trace)"
        subtitle="ClickHouse · Tempo · Prometheus · Mimir"
        right={
          <Link href="/topology" className="rounded-md border border-ink-200 bg-card px-2 py-1 text-[12px] text-ink-600 hover:bg-ink-50">
            {tt('← 트래픽 흐름')}
          </Link>
        }
      />
      {graph && <GraphCollectionStatus collection={graph.collection} />}
      <div className="flex flex-wrap items-center gap-3 px-4 py-1 text-[11px] text-ink-500">
        <label className="flex items-center gap-1">Environment
          <select aria-label="Environment" value={environment} onChange={(e) => setEnvironment(e.target.value)}
            className="rounded border border-ink-200 bg-card px-2 py-1">
            <option value="">All</option>
            {environments.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <button type="button" disabled={busy} onClick={() => setRevision((n) => n + 1)}
          className="rounded border border-ink-200 bg-card px-2 py-1 disabled:opacity-50">
          {tt('새로고침')}
        </button>
        {busy && <span>{tt('불러오는 중…')}</span>}
        {err && <span className="text-red-600">{tt('조회 실패:')} {err}</span>}
        {graph?.captured_at && <span>{tt('그래프 시점:')} {new Date(graph.captured_at).toLocaleString()}</span>}
      </div>
      <div ref={canvas} className="min-h-0 flex-1">
        <ReactFlow nodes={nodes} edges={edges} onInit={(instance) => { flow.current = instance; }}
          onNodeClick={onNodeClick} fitView fitViewOptions={{ padding: 0.2 }} proOptions={{ hideAttribution: true }}>
          <Background />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  );
}
