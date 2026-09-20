'use client';

// Shared ReactFlow renderer for columnar MapGraphs (infra map / K8s map).
// Layout is deterministic: x from column index, y from per-column stacking order.
import { useMemo, useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { Handle, Position, type Node, type Edge, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { highlightClosure, searchMatches, type MapGraph, type MapKind, type MapNode } from '@/lib/infra-map';
import { useI18n } from '@/components/shell/LanguageProvider';

const ReactFlow = dynamic(() => import('@xyflow/react').then((m) => m.ReactFlow), { ssr: false });
const Background = dynamic(() => import('@xyflow/react').then((m) => m.Background), { ssr: false });
const Controls = dynamic(() => import('@xyflow/react').then((m) => m.Controls), { ssr: false });

const COL_X = 340; // column pitch
const CARD_W = 260;
const ROW_H = 84; // vertical pitch inside a column
const TITLE_Y = -70;

// kind → [light bg, light border, dark bg, dark border]
const KIND_COLORS: Record<MapKind, [string, string, string, string]> = {
  igw:     ['#E6F6EC', '#2E9E5B', '#0E2E1C', '#2E9E5B'],
  tgw:     ['#F1E9FF', '#8A5BD0', '#241A3E', '#8A5BD0'],
  vpc:     ['#E7EDFB', '#4F6BED', '#161F3E', '#4F6BED'],
  subnet:  ['#EAF3EE', '#3F9D6B', '#12271B', '#3F9D6B'],
  ec2:     ['#FEF3E2', '#C8902F', '#33260C', '#C8902F'],
  alb:     ['#FDF0E0', '#B7791F', '#302108', '#B7791F'],
  nlb:     ['#FDF0E0', '#B7791F', '#302108', '#B7791F'],
  rds:     ['#E6EEFE', '#3D6FB5', '#16243E', '#3D6FB5'],
  nat:     ['#FDECE8', '#C85A45', '#331410', '#C85A45'],
  ingress: ['#FDECE8', '#C85A45', '#331410', '#C85A45'],
  service: ['#E6EEFE', '#3D6FB5', '#16243E', '#3D6FB5'],
  pod:     ['#EAF3EE', '#3F9D6B', '#12271B', '#3F9D6B'],
  node:    ['#F1E9FF', '#8A5BD0', '#241A3E', '#8A5BD0'],
};
const STATUS_DOT: Record<NonNullable<MapNode['status']>, string> = {
  ok: '#01A88D', warn: '#F59E0B', bad: '#D13212', neutral: '#9AA6B2',
};

export const KIND_LABELS: Partial<Record<MapKind, string>> = {
  igw: 'IGW', tgw: 'TGW', vpc: 'VPC', subnet: 'Subnet', ec2: 'EC2', alb: 'ALB',
  nlb: 'NLB', rds: 'RDS', nat: 'NAT', ingress: 'Ingress', service: 'Service', pod: 'Pod', node: 'Node',
};

/** Legend chips for the kinds + status dots present in a graph (gap-audit L248). */
export function MapLegend({ graph, theme }: { graph: MapGraph; theme: 'light' | 'dark' }) {
  const kinds = [...new Set(graph.nodes.map((n) => n.kind))];
  const statuses = [...new Set(graph.nodes.map((n) => n.status).filter((s): s is NonNullable<MapNode['status']> => s != null))];
  return (
    <>
      {kinds.map((k) => {
        const [lb, lbo, db, dbo] = KIND_COLORS[k];
        return (
          <span key={k} className="inline-flex items-center gap-1">
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ background: theme === 'dark' ? db : lb, border: `1px solid ${theme === 'dark' ? dbo : lbo}` }}
            />
            {KIND_LABELS[k] ?? k}
          </span>
        );
      })}
      {/* status-dot meanings — the same STATUS_DOT colors the cards render (gap L248). */}
      {statuses.map((s) => (
        <span key={s} className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: STATUS_DOT[s] }} />
          {s}
        </span>
      ))}
    </>
  );
}

interface CardData extends Record<string, unknown> { mapNode: MapNode; theme: 'light' | 'dark' }

function CardNode({ data }: NodeProps) {
  const { mapNode: n, theme } = data as CardData;
  const [lb, lbo, db, dbo] = KIND_COLORS[n.kind];
  const [bg, border] = theme === 'dark' ? [db, dbo] : [lb, lbo];
  return (
    <div
      className="rounded-lg px-2.5 py-1.5"
      style={{ width: CARD_W, background: bg, border: `1.5px solid ${border}`, color: theme === 'dark' ? '#E8EDF2' : '#16202A' }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0, pointerEvents: 'none' }} />
      <Handle type="source" position={Position.Right} style={{ opacity: 0, pointerEvents: 'none' }} />
      <div className="flex items-center gap-1.5">
        {n.status && <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: STATUS_DOT[n.status] }} />}
        <span className="truncate text-[12px] font-semibold" title={n.label}>{n.label}</span>
        {n.badge && (
          <span className="ml-auto shrink-0 rounded px-1 text-[9px]" style={{ border: `1px solid ${border}` }}>{n.badge}</span>
        )}
      </div>
      {n.sub && <div className="truncate text-[10px] opacity-75" title={n.sub}>{n.sub}</div>}
    </div>
  );
}
const nodeTypes = { card: CardNode };

export default function MapCanvas({ graph, columns, query, theme, onSelect }:
  { graph: MapGraph; columns: { title: string }[]; query: string; theme: 'light' | 'dark'; onSelect?: (node: MapNode | null) => void }) {
  const { tt } = useI18n();
  const [selected, setSelected] = useState<string | null>(null);

  const lit = useMemo(() => {
    const m = searchMatches(graph, query);
    if (m.size > 0) return m; // an active search wins over a prior selection
    if (query.trim()) return null; // searching with no hits → dim nothing (empty-result state)
    if (selected && graph.nodes.some((n) => n.id === selected)) return highlightClosure(graph, selected);
    return null;
  }, [graph, selected, query]);

  const { nodes, edges } = useMemo(() => {
    const stack: number[] = columns.map(() => 0);
    const nodes: Node[] = graph.nodes.map((n) => {
      const y = stack[n.column] * ROW_H;
      stack[n.column] += 1;
      return {
        id: n.id,
        type: 'card',
        position: { x: n.column * COL_X, y },
        data: { mapNode: n, theme } satisfies CardData,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        style: { opacity: lit && !lit.has(n.id) ? 0.22 : 1 },
      };
    });
    // Column titles as static nodes so they pan/zoom with the canvas.
    columns.forEach((c, i) => {
      nodes.push({
        id: `__col${i}`, type: 'default', position: { x: i * COL_X, y: TITLE_Y }, draggable: false, selectable: false,
        data: { label: c.title },
        style: {
          width: CARD_W, background: 'transparent', border: 'none', boxShadow: 'none',
          fontSize: 13, fontWeight: 700, color: theme === 'dark' ? '#AFBAC3' : '#586773', textAlign: 'center' as const,
        },
      });
    });
    const edges: Edge[] = graph.edges.map((e, i) => {
      const on = !lit || (lit.has(e.source) && lit.has(e.target));
      return {
        id: `e${i}:${e.source}->${e.target}`, source: e.source, target: e.target,
        type: 'smoothstep',
        style: { stroke: theme === 'dark' ? '#586773' : '#9AA6B2', opacity: on ? 0.9 : 0.12, strokeWidth: on && lit ? 1.8 : 1.2 },
      };
    });
    return { nodes, edges };
  }, [graph, columns, lit, theme]);

  const handleNodeClick = useCallback((_: unknown, node: Node) => {
    if (node.id.startsWith('__col')) return;
    setSelected((cur) => {
      const next = cur === node.id ? null : node.id;
      onSelect?.(next ? graph.nodes.find((n) => n.id === next) ?? null : null);
      return next;
    });
  }, [graph, onSelect]);

  return (
    <div className="relative min-h-0 flex-1">
      {selected && (
        <button
          onClick={() => { setSelected(null); onSelect?.(null); }}
          className="absolute right-3 top-3 z-10 rounded-md border border-ink-200 bg-card px-2 py-1 text-[11px] hover:bg-ink-50"
        >
          {tt('선택 해제')}
        </button>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={handleNodeClick}
        onPaneClick={() => { setSelected(null); onSelect?.(null); }}
        fitView
        fitViewOptions={{ padding: 0.12 }}
        minZoom={0.05}
        colorMode={theme}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
