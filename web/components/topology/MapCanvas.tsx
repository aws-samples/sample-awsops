'use client';

// Shared ReactFlow renderer for columnar MapGraphs (infra map / K8s map).
// Layout is deterministic: x from column index, y from per-column stacking order.
import { useMemo, useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { Handle, Position, type Node, type Edge, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { searchMatches, type MapGraph, type MapKind, type MapNode } from '@/lib/infra-map';
import { selectGraphPaths } from '@/lib/graph-display';
import { useI18n } from '@/components/shell/LanguageProvider';
import useGraphViewport from './useGraphViewport';
import { layoutFlow } from '@/lib/flow-layout';

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

interface CardData extends Record<string, unknown> { mapNode: MapNode; theme: 'light' | 'dark'; vertical: boolean }

function CardNode({ data }: NodeProps) {
  const { mapNode: n, theme, vertical } = data as CardData;
  const [lb, lbo, db, dbo] = KIND_COLORS[n.kind];
  const [bg, border] = theme === 'dark' ? [db, dbo] : [lb, lbo];
  return (
    <div
      className="rounded-lg px-2.5 py-1.5"
      style={{ width: CARD_W, background: bg, border: `1.5px solid ${border}`, color: theme === 'dark' ? '#E8EDF2' : '#16202A' }}
    >
      <Handle type="target" position={vertical ? Position.Top : Position.Left} style={{ opacity: 0, pointerEvents: 'none' }} />
      <Handle type="source" position={vertical ? Position.Bottom : Position.Right} style={{ opacity: 0, pointerEvents: 'none' }} />
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
  const [showAll, setShowAll] = useState(false);

  const visible = useMemo(() => {
    const m = searchMatches(graph, query);
    if (query.trim()) return selectGraphPaths(graph, [...m]);
    if (selected && graph.nodes.some(n => n.id === selected)) return selectGraphPaths(graph, [selected]);
    return graph;
  }, [graph, selected, query]);
  const roots = graph.nodes.filter(n => n.kind === 'vpc');
  const chooseVpc = roots.length > 1 && graph.nodes.length > 40 && !selected && !query.trim() && !showAll;
  const viewport = useGraphViewport(visible.nodes, visible.edges);

  const { nodes, edges } = useMemo(() => {
    const stack: number[] = columns.map(() => 0);
    const verticalPositions = viewport.vertical ? new Map(layoutFlow(visible, {
      rankdir: 'TB', nodeSize: () => ({ width: CARD_W, height: 62 }),
    }).map(p => [p.id, p])) : null;
    const nodes: Node[] = visible.nodes.map((n) => {
      const y = stack[n.column] * ROW_H;
      stack[n.column] += 1;
      return {
        id: n.id,
        type: 'card',
        position: verticalPositions?.get(n.id) ?? { x: n.column * COL_X, y },
        data: { mapNode: n, theme, vertical: viewport.vertical } satisfies CardData,
        sourcePosition: viewport.vertical ? Position.Bottom : Position.Right,
        targetPosition: viewport.vertical ? Position.Top : Position.Left,
        style: { width: CARD_W, height: 62 },
      };
    });
    // Column titles as static nodes so they pan/zoom with the canvas.
    columns.forEach((c, i) => {
      if (viewport.vertical || !visible.nodes.some(n => n.column === i)) return;
      nodes.push({
        id: `__col${i}`, type: 'default', position: { x: i * COL_X, y: TITLE_Y }, draggable: false, selectable: false,
        data: { label: c.title },
        style: {
          width: CARD_W, background: 'transparent', border: 'none', boxShadow: 'none',
          fontSize: 13, fontWeight: 700, color: theme === 'dark' ? '#AFBAC3' : '#586773', textAlign: 'center' as const,
        },
      });
    });
    const edges: Edge[] = visible.edges.map((e, i) => {
      return {
        id: `e${i}:${e.source}->${e.target}`, source: e.source, target: e.target,
        type: 'smoothstep',
        style: { stroke: theme === 'dark' ? '#586773' : '#9AA6B2', strokeWidth: 1.4 },
      };
    });
    return { nodes, edges };
  }, [visible, columns, theme, viewport.vertical]);

  const handleNodeClick = useCallback((_: unknown, node: Node) => {
    if (node.id.startsWith('__col')) return;
    setSelected((cur) => {
      const next = cur === node.id ? null : node.id;
      onSelect?.(next ? graph.nodes.find((n) => n.id === next) ?? null : null);
      return next;
    });
  }, [graph, onSelect]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-100 px-4 py-2 text-xs">
        <label>VPC <select aria-label={tt('VPC 선택')} value={roots.some(n => n.id === selected) ? selected! : ''}
          onChange={e => { setSelected(e.target.value || null); onSelect?.(graph.nodes.find(n => n.id === e.target.value) ?? null); }}
          className="max-w-[240px] rounded-md border border-ink-200 bg-card px-2 py-1">
          <option value="">{tt('전체')}</option>{roots.map(n => <option key={n.id} value={n.id}>{n.label}</option>)}
        </select></label>
        <span className="text-ink-500">{chooseVpc ? `VPC: ${roots.length}` : `${tt('표시')}: ${visible.nodes.length}/${graph.nodes.length} · ${tt('연결')}: ${visible.edges.length}/${graph.edges.length}`}</span>
        <button type="button" onClick={() => { setSelected(null); setShowAll(v => !v); onSelect?.(null); }}
          className="ml-auto rounded-md border border-ink-200 bg-card px-2 py-1">{tt(showAll ? 'VPC 중심 보기' : '전체 그래프')}</button>
        {selected && <button type="button" onClick={() => { setSelected(null); onSelect?.(null); }}
          className="rounded-md border border-ink-200 bg-card px-2 py-1">{tt('선택 해제')}</button>}
      </div>
      <div ref={viewport.container} className="relative min-h-64 flex-1">
      {chooseVpc ? <div className="h-full overflow-y-auto p-4">
        <p className="mb-3 text-sm text-ink-600">{tt('VPC를 선택하면 연결된 게이트웨이·서브넷·리소스를 표시합니다.')}</p>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {roots.map(n => <button key={n.id} type="button" onClick={() => { setSelected(n.id); onSelect?.(n); }}
            className="rounded-lg border border-ink-200 bg-card p-3 text-left hover:border-brand-400">
            <span className="block truncate text-sm font-semibold" title={n.label}>{n.label}</span>
            <span className="mt-1 block truncate text-xs text-ink-500">{n.sub}</span>
            <span className="mt-2 block text-xs text-brand-700">{tt('경로 보기 →')}</span>
          </button>)}
        </div>
      </div> : !visible.nodes.length ? <div className="p-6 text-sm text-ink-500">{tt('검색 결과가 없습니다.')}</div> : <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={handleNodeClick}
        onPaneClick={() => { setSelected(null); onSelect?.(null); }}
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
      </ReactFlow>}
      </div>
    </div>
  );
}
