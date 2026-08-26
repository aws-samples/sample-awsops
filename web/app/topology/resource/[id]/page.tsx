'use client';

import { useEffect, useMemo, useState } from 'react';
import { useActiveAccount, accountParam } from '@/lib/account-context';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { Background, Controls, Position, type Node, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import PageHeader from '@/components/ui/PageHeader';
import { layoutFlow } from '@/lib/flow-layout';

// ReactFlow touches the DOM on mount — client-only.
const ReactFlow = dynamic(() => import('@xyflow/react').then((m) => m.ReactFlow), { ssr: false });

interface GNode { id: string; kind: string; label: string; meta?: Record<string, unknown> }
interface GEdge { source: string; target: string; rel: string }
interface Graph { nodes: GNode[]; edges: GEdge[]; captured_at: string | null; capped?: boolean }

// kind → [bg, border] (paper/ink tokens; infra kinds + a generic resource fallback)
const COLORS: Record<string, [string, string]> = {
  vpc: ['#E7EDFB', '#4F6BED'],      // cobalt-ish
  subnet: ['#EAF3EE', '#3F9D6B'],   // green
  sg: ['#FBEFE0', '#C9842B'],       // amber (security)
};
const RESOURCE = ['#EEF0F2', '#9AA6B2'] as const;

const relLabel: Record<string, string> = {
  'infra:in_vpc': 'in vpc', 'infra:in_subnet': 'in subnet', 'infra:uses_sg': 'uses sg',
};

export default function ResourceTopologyPage({ params }: { params: { id: string } }) {
  const fromId = decodeURIComponent(params.id);
  const [activeAccount] = useActiveAccount();
  const [depth, setDepth] = useState(2);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setBusy(true);
    fetch(`/api/graph?class=infra&from=${encodeURIComponent(fromId)}&depth=${depth}&${accountParam(activeAccount) || 'account=self'}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (live) { setGraph(d); setErr(''); } })
      .catch((e) => { if (live) setErr(String(e instanceof Error ? e.message : e)); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [fromId, depth, activeAccount]);

  const { nodes, edges } = useMemo(() => {
    if (!graph) return { nodes: [] as Node[], edges: [] as Edge[] };
    const pos = Object.fromEntries(
      layoutFlow(
        { nodes: graph.nodes as never, edges: graph.edges.map((e) => ({ id: `${e.source}->${e.target}`, source: e.source, target: e.target, confidence: 'observed' })) as never },
        { rankdir: 'TB' },
      ).map((p) => [p.id, p]),
    );
    const nodes: Node[] = graph.nodes.map((n) => {
      const [bg, border] = COLORS[n.kind] ?? RESOURCE;
      const p = pos[n.id] ?? { x: 0, y: 0 };
      const isFrom = n.id === fromId;
      return {
        id: n.id,
        position: { x: p.x, y: p.y },
        data: { label: `${n.kind === 'vpc' || n.kind === 'subnet' || n.kind === 'sg' ? n.kind + ': ' : ''}${n.label}` },
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
        style: {
          background: bg,
          border: `${isFrom ? '2px solid' : '1px solid'} ${border}`,
          borderRadius: 8, fontSize: 11, padding: 6, width: 200, color: '#16202A',
        },
      };
    });
    const edges: Edge[] = graph.edges.map((e) => ({
      id: `${e.source}->${e.target}`, source: e.source, target: e.target,
      label: relLabel[e.rel] ?? e.rel, animated: false,
      style: { stroke: '#9AA6B2' }, labelStyle: { fontSize: 9, fill: '#586773' },
    }));
    return { nodes, edges };
  }, [graph, fromId]);

  const title = graph?.nodes.find((n) => n.id === fromId)?.label ?? fromId;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={`관계 그래프 · ${title}`}
        subtitle="리소스-관계 토폴로지 (VPC · subnet · security group). 트래픽 흐름이 아닌 리소스 배치 그래프."
        right={
          <div className="flex items-center gap-3 text-[12px] text-ink-600">
            <label className="flex items-center gap-1">
              depth
              <select className="rounded-md border border-ink-200 bg-card px-2 py-1" value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
                <option value={1}>1</option><option value={2}>2</option><option value={3}>3</option>
              </select>
            </label>
            <Link href="/topology" className="rounded-md border border-ink-200 bg-card px-2 py-1 hover:bg-ink-50">← 트래픽 흐름</Link>
          </div>
        }
      />
      <div className="flex items-center gap-3 px-4 py-1 text-[11px] text-ink-500">
        {busy && <span>불러오는 중…</span>}
        {err && <span className="text-red-600">조회 실패: {err}</span>}
        {graph?.captured_at && <span>그래프 시점: {new Date(graph.captured_at).toLocaleString()}</span>}
        {graph?.capped && <span className="text-amber-600">일부 허브는 이웃이 많아 상위 일부만 표시됩니다 (cap).</span>}
        {graph && graph.nodes.length === 0 && !busy && <span>이 리소스의 관계 그래프가 비어 있습니다 (materializer 미실행이거나 네트워크 배치 없음).</span>}
      </div>
      <div className="min-h-0 flex-1">
        <ReactFlow nodes={nodes} edges={edges} fitView fitViewOptions={{ padding: 0.2 }} proOptions={{ hideAttribution: true }}>
          <Background />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  );
}
