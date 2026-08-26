'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Background, Controls, Position, type Node, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import PageHeader from '@/components/ui/PageHeader';
import { layoutFlow } from '@/lib/flow-layout';

// ReactFlow touches the DOM on mount — client-only.
const ReactFlow = dynamic(() => import('@xyflow/react').then((m) => m.ReactFlow), { ssr: false });

interface GNode { id: string; kind: string; label: string; meta?: Record<string, unknown> }
interface GEdge { source: string; target: string; rel: string }
interface Graph { nodes: GNode[]; edges: GEdge[]; captured_at: string | null }

// kind → [bg, border] (paper/ink tokens; service-map kinds, mirrors resource/[id]'s COLORS)
const COLORS: Record<string, [string, string]> = {
  service: ['#E6EEFE', '#3D6FB5'],   // blue
  db: ['#FBEFE0', '#C8902F'],        // amber
  workload: ['#F1E9FF', '#8A5BD0'],  // purple
};
const RESOURCE = ['#EEF0F2', '#9AA6B2'] as const;

const relLabel: Record<string, string> = { calls: 'calls', queries: 'queries', runs_on: 'runs on' };

// db-node meta carries infra_ref (M2 bridge) when infra-topology's meta.host matched this host.
const infraRefOf = (meta?: Record<string, unknown>): string | undefined =>
  typeof meta?.infra_ref === 'string' ? meta.infra_ref : undefined;

// workload-node meta carries cluster (from the span's k8s.cluster.name) → deep-link to the main
// flow topology filtered to that EKS cluster (its filter key is `${resolved}:${cluster}`, resolved
// = 'eks' for live-resolved EKS target nodes).
const clusterOf = (meta?: Record<string, unknown>): string | undefined =>
  typeof meta?.cluster === 'string' && meta.cluster ? meta.cluster : undefined;

export default function ServiceMapPage() {
  const router = useRouter();
  const [graph, setGraph] = useState<Graph | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setBusy(true);
    fetch('/api/graph?class=trace')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (live) { setGraph(d); setErr(''); } })
      .catch((e) => { if (live) setErr(String(e instanceof Error ? e.message : e)); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, []);

  const metaById = useMemo(
    () => new Map((graph?.nodes ?? []).map((n) => [n.id, n.meta])),
    [graph],
  );

  const { nodes, edges } = useMemo(() => {
    if (!graph) return { nodes: [] as Node[], edges: [] as Edge[] };
    const pos = Object.fromEntries(
      layoutFlow(
        { nodes: graph.nodes as never, edges: graph.edges.map((e) => ({ id: `${e.source}->${e.target}`, source: e.source, target: e.target, confidence: 'observed' })) as never },
        { rankdir: 'LR' },
      ).map((p) => [p.id, p]),
    );
    const nodes: Node[] = graph.nodes.map((n) => {
      const [bg, border] = COLORS[n.kind] ?? RESOURCE;
      const p = pos[n.id] ?? { x: 0, y: 0 };
      const clickable = (n.kind === 'db' && !!infraRefOf(n.meta)) || (n.kind === 'workload' && !!clusterOf(n.meta));
      return {
        id: n.id,
        position: { x: p.x, y: p.y },
        data: { label: `${n.kind}: ${n.label}` },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        style: {
          background: bg,
          border: `1px solid ${border}`,
          borderRadius: 8, fontSize: 11, padding: 6, width: 200, color: '#16202A',
          cursor: clickable ? 'pointer' : 'default',
        },
      };
    });
    const edges: Edge[] = graph.edges.map((e) => ({
      id: `${e.source}->${e.target}`, source: e.source, target: e.target,
      label: relLabel[e.rel] ?? e.rel, animated: false,
      style: { stroke: '#9AA6B2' }, labelStyle: { fontSize: 9, fill: '#586773' },
    }));
    return { nodes, edges };
  }, [graph]);

  const onNodeClick = (_: unknown, node: Node) => {
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
        subtitle="분산 트레이스에서 파생된 서비스 호출 그래프 (service → service → db). ClickHouse otel_traces 기반."
        right={
          <Link href="/topology" className="rounded-md border border-ink-200 bg-card px-2 py-1 text-[12px] text-ink-600 hover:bg-ink-50">
            ← 트래픽 흐름
          </Link>
        }
      />
      <div className="flex items-center gap-3 px-4 py-1 text-[11px] text-ink-500">
        {busy && <span>불러오는 중…</span>}
        {err && <span className="text-red-600">조회 실패: {err}</span>}
        {graph?.captured_at && <span>그래프 시점: {new Date(graph.captured_at).toLocaleString()}</span>}
        {graph && graph.nodes.length === 0 && !busy && (
          <span>trace 데이터 없음 — ClickHouse 데이터소스 등록 여부와 최근 60분 내 span 존재 여부를 확인하세요.</span>
        )}
      </div>
      <div className="min-h-0 flex-1">
        <ReactFlow nodes={nodes} edges={edges} onNodeClick={onNodeClick} fitView fitViewOptions={{ padding: 0.2 }} proOptions={{ hideAttribution: true }}>
          <Background />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  );
}
