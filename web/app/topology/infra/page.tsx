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

/** 계정 전체 인프라 배치 그래프 (v1 Infra Graph View parity) — materialized infra 그래프 전체 렌더. */
export default function InfraTopologyPage() {
  const [activeAccount] = useActiveAccount();
  const [graph, setGraph] = useState<Graph | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');

  useEffect(() => {
    let live = true;
    setBusy(true);
    fetch(`/api/graph?class=infra&${accountParam(activeAccount) || 'account=self'}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (live) { setGraph(d); setErr(''); } })
      .catch((e) => { if (live) setErr(String(e instanceof Error ? e.message : e)); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [activeAccount]);

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
    const pos = Object.fromEntries(
      layoutFlow(
        { nodes: graph.nodes as never, edges: graph.edges.map((e) => ({ id: `${e.source}->${e.target}`, source: e.source, target: e.target, confidence: 'observed' })) as never },
        { rankdir: 'TB' },
      ).map((p) => [p.id, p]),
    );
    const dim = matches.size > 0;
    const nodes: Node[] = graph.nodes.map((n) => {
      const [bg, border] = COLORS[n.kind] ?? RESOURCE;
      const p = pos[n.id] ?? { x: 0, y: 0 };
      const hit = matches.has(n.id);
      return {
        id: n.id,
        position: { x: p.x, y: p.y },
        data: { label: `${n.kind in COLORS ? `${n.kind}: ` : ''}${n.label}` },
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
        style: {
          background: bg,
          border: `${hit ? `2px solid ${HILITE}` : `1px solid ${border}`}`,
          borderRadius: 8, fontSize: 11, padding: 6, width: 200, color: '#16202A',
          opacity: dim && !hit ? 0.25 : 1,
        },
      };
    });
    const edges: Edge[] = graph.edges.map((e) => ({
      id: `${e.source}->${e.target}`, source: e.source, target: e.target,
      label: relLabel[e.rel] ?? e.rel, animated: false,
      style: { stroke: '#9AA6B2', opacity: dim ? 0.3 : 1 }, labelStyle: { fontSize: 9, fill: '#586773' },
    }));
    return { nodes, edges };
  }, [graph, matches]);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="인프라 배치 그래프"
        subtitle="계정 전체 리소스-관계 토폴로지 (VPC · Subnet · SG · 리소스). 노드 검색으로 하이라이트."
        right={
          <div className="flex items-center gap-3 text-[12px] text-ink-600">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="검색 (id · 이름 · IP · 타입)…"
              className="w-56 rounded-md border border-ink-200 bg-card px-2 py-1 text-[12px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
            />
            <Link href="/topology" className="rounded-md border border-ink-200 bg-card px-2 py-1 hover:bg-ink-50">← 트래픽 흐름</Link>
          </div>
        }
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-1 text-[11px] text-ink-500">
        {busy && <span>불러오는 중…</span>}
        {err && <span className="text-red-600">조회 실패: {err}</span>}
        {graph && <span>노드 {graph.nodes.length.toLocaleString()} · 엣지 {graph.edges.length.toLocaleString()}</span>}
        {q.trim() && <span className="font-semibold text-brand-700">매치 {matches.size}개</span>}
        {LEGEND.map((l) => {
          const [bg, border] = COLORS[l.kind] ?? RESOURCE;
          return (
            <span key={l.kind} className="inline-flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: bg, border: `1px solid ${border}` }} />
              {l.label}
            </span>
          );
        })}
        {graph?.captured_at && <span>그래프 시점: {new Date(graph.captured_at).toLocaleString()}</span>}
        {graph && graph.nodes.length === 0 && !busy && <span>인프라 그래프가 비어 있습니다 (materializer 미실행).</span>}
      </div>
      <div className="min-h-0 flex-1">
        <ReactFlow nodes={nodes} edges={edges} fitView fitViewOptions={{ padding: 0.15 }} minZoom={0.05} proOptions={{ hideAttribution: true }}>
          <Background />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  );
}
