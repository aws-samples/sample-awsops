'use client';

import { useMemo, useRef } from 'react';
import dynamic from 'next/dynamic';
import { Background, MiniMap, Position, type Node, type Edge, type ReactFlowInstance } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  CheckCircle2, XCircle, CircleHelp, CircleDashed, CircleSlash,
  ZoomIn, ZoomOut, Maximize, type LucideIcon,
} from 'lucide-react';
import { layoutFlow } from '@/lib/flow-layout';
import type { FlowGraph } from '@/lib/flow-topology';
import type { PolicyGraphDto, PolicyGraphNode, PolicyGraphEdge, PolicyGraphStatus } from '@/lib/policy-graph';

// ReactFlow touches the DOM on mount — client-only (same pattern as app/topology/infra/page.tsx).
const ReactFlow = dynamic(() => import('@xyflow/react').then((m) => m.ReactFlow), { ssr: false });

export interface PolicyGraphSelection {
  kind: 'node' | 'edge';
  id: string;
}

interface StatusMeta {
  marker: string;
  label: string;
  icon: LucideIcon;
  bg: string;
  border: string;
  text: string;
  stroke: string;
  dash: boolean;
}

// Status is never color-only: each state carries a distinct O/X/?/marker glyph, label, and line
// style (solid vs dashed) in addition to color — see the design's "Graph contract and UI" rules.
const STATUS_META: Record<PolicyGraphStatus, StatusMeta> = {
  allowed: { marker: 'O', label: 'Allowed', icon: CheckCircle2, bg: '#e8f6ef', border: '#16845b', text: '#16845b', stroke: '#16845b', dash: false },
  blocked: { marker: 'X', label: 'Blocked', icon: XCircle, bg: '#fcedea', border: '#c33b28', text: '#c33b28', stroke: '#c33b28', dash: false },
  unknown: { marker: '?', label: 'Unknown', icon: CircleHelp, bg: '#fff4df', border: '#a96508', text: '#a96508', stroke: '#a96508', dash: true },
  not_run: { marker: '·', label: 'Not run', icon: CircleDashed, bg: '#f4f6f8', border: '#c7d0d8', text: '#677582', stroke: '#97a5b2', dash: true },
  not_applicable: { marker: '—', label: 'Not applicable', icon: CircleSlash, bg: '#f4f6f8', border: '#dfe4e8', text: '#94a0aa', stroke: '#c7d0d8', dash: true },
};

function nodeSummaryText(n: PolicyGraphNode): string {
  const meta = STATUS_META[n.status];
  return `${n.kind}: ${n.label} — ${meta.marker} ${meta.label}`;
}

function edgeSummaryText(e: PolicyGraphEdge): string {
  const meta = STATUS_META[e.status];
  const detail = e.label ? ` ${e.label}` : '';
  return `${e.relation}${detail} — ${meta.marker} ${meta.label}`;
}

const CTRL_BTN = 'flex h-7 w-7 items-center justify-center rounded-md border border-ink-200 bg-card text-ink-500 hover:bg-ink-50';

// Must match the width/height PolicyGraph actually renders a node at (passed to layoutFlow's
// nodeSize below) — a mismatch is exactly how a long label ends up overflowing into, or visually
// overlapping, dagre's assumed spacing for a neighboring node.
const PG_NODE_W = 220;
const PG_NODE_H = 44;

/**
 * Pure node/edge builder, exported so the "only the running id animates" and "long labels clip
 * instead of overflowing" behaviors are unit-testable directly (React Flow doesn't reliably render
 * measured SVG edges under jsdom, so asserting on rendered DOM classes for this is not reliable).
 */
export function buildFlowElements(
  graph: PolicyGraphDto,
  running: ReadonlySet<string>,
): { nodes: Node[]; edges: Edge[] } {
  const flowGraph: FlowGraph = {
    nodes: graph.nodes.map((n) => ({ id: n.id, kind: 'more', label: n.label })),
    edges: graph.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, confidence: 'observed' })),
  };
  // nodeSize MUST match the style width/height below (PG_NODE_W/PG_NODE_H) — see comment there.
  const pos = Object.fromEntries(
    layoutFlow(flowGraph, { rankdir: 'LR', nodeSize: () => ({ width: PG_NODE_W, height: PG_NODE_H }) })
      .map((p) => [p.id, p]),
  );

  const nodes: Node[] = graph.nodes.map((n) => {
    const meta = STATUS_META[n.status];
    const p = pos[n.id] ?? { x: 0, y: 0 };
    const label = `${meta.marker} ${n.label}`;
    return {
      id: n.id,
      position: { x: p.x, y: p.y },
      // title = full untruncated label on hover; the visible text is clamped to the node's own
      // box (see style below) so a long AWS resource id/ARN can never overflow into a neighbor —
      // dagre reserved exactly PG_NODE_W x PG_NODE_H for this node, so the box itself must clip.
      data: { label: <span title={label}>{label}</span> },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      style: {
        background: meta.bg,
        border: `2px ${meta.dash ? 'dashed' : 'solid'} ${meta.border}`,
        borderRadius: 8,
        fontSize: 11,
        fontWeight: 600,
        padding: 8,
        width: PG_NODE_W,
        height: PG_NODE_H,
        boxSizing: 'border-box' as const,
        display: 'flex' as const,
        alignItems: 'center' as const,
        overflow: 'hidden' as const,
        whiteSpace: 'nowrap' as const,
        textOverflow: 'ellipsis' as const,
        color: '#17222d',
      },
    };
  });

  const edges: Edge[] = graph.edges.map((e) => {
    const meta = STATUS_META[e.status];
    const isRunning = running.has(e.id);
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label ? `${meta.marker} ${e.label}` : meta.marker,
      // Only the edge(s) actually executing right now animate — see `runningIds` doc on the
      // component below. Everything else is static even when its status matches.
      animated: isRunning,
      style: {
        stroke: meta.stroke,
        strokeWidth: isRunning ? 3 : 2,
        strokeDasharray: meta.dash ? '7 5' : undefined,
      },
      labelStyle: { fontSize: 10, fill: meta.text, fontWeight: 700 },
    };
  });

  return { nodes, edges };
}

/**
 * Shared read-only policy graph canvas — renders a `PolicyGraphDto` (web/lib/policy-graph.ts) via
 * React Flow, reusing the existing dagre layout (`layoutFlow`) rather than a bespoke one. Used by
 * Network Path Check (full, with MiniMap) and the Security Group Usage/Rules detail graphs
 * (`compact`, no MiniMap). Layout is read-only: pan/zoom/fit only, no persisted manual edits.
 */
export default function PolicyGraph({
  graph,
  compact = false,
  onSelect,
  runningIds,
}: {
  graph: PolicyGraphDto;
  compact?: boolean;
  onSelect?: (selection: PolicyGraphSelection | null) => void;
  /**
   * Edge (or node) ids that are the CURRENTLY EXECUTING step/phase of an in-progress run — the only
   * ones animated. Everything else renders static, even when its own status is otherwise identical,
   * because "animated" here means "actively running right now", not a property of a status value.
   * Omit or pass an empty set for a finished/historical run — nothing animates then.
   */
  runningIds?: ReadonlySet<string> | string[];
}) {
  const instanceRef = useRef<ReactFlowInstance | null>(null);
  const running = useMemo(
    () => (runningIds instanceof Set ? runningIds : new Set(runningIds ?? [])),
    [runningIds],
  );

  const { nodes, edges } = useMemo(() => buildFlowElements(graph, running), [graph, running]);

  return (
    <div className="relative h-full min-h-[320px] w-full" data-testid="policy-graph">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        onInit={(instance) => { instanceRef.current = instance; }}
        onNodeClick={(_evt, node) => onSelect?.({ kind: 'node', id: node.id })}
        onEdgeClick={(_evt, edge) => onSelect?.({ kind: 'edge', id: edge.id })}
        onPaneClick={() => onSelect?.(null)}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        {!compact && <MiniMap pannable zoomable />}
      </ReactFlow>

      <div className="absolute bottom-2 left-2 z-10 grid gap-1">
        <button type="button" aria-label="Zoom in" onClick={() => instanceRef.current?.zoomIn()} className={CTRL_BTN}>
          <ZoomIn size={15} aria-hidden />
        </button>
        <button type="button" aria-label="Zoom out" onClick={() => instanceRef.current?.zoomOut()} className={CTRL_BTN}>
          <ZoomOut size={15} aria-hidden />
        </button>
        <button type="button" aria-label="Fit graph" onClick={() => instanceRef.current?.fitView()} className={CTRL_BTN}>
          <Maximize size={15} aria-hidden />
        </button>
      </div>

      {graph.truncated && (
        <div
          className={
            graph.pathTruncated
              ? 'absolute right-2 top-2 z-10 rounded-md border border-rose-400 bg-rose-50 px-2 py-1 text-[11px] font-semibold text-rose-800'
              : 'absolute right-2 top-2 z-10 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-800'
          }
        >
          {graph.pathTruncated ? '⚠ ' : ''}
          {graph.omitted.nodes > 0 && `+${graph.omitted.nodes} nodes `}
          {graph.omitted.edges > 0 && `+${graph.omitted.edges} edges `}
          {graph.pathTruncated ? 'hidden — resolved path is incomplete, result may be wrong' : 'hidden by graph limits'}
        </div>
      )}

      {/* The checklist remains the accessible textual source of truth when the graph cannot
         render (design rule) — this list is always in the DOM, independent of canvas mount. */}
      <ul className="sr-only" aria-label="Policy graph summary">
        {graph.nodes.map((n) => <li key={n.id}>{nodeSummaryText(n)}</li>)}
        {graph.edges.map((e) => <li key={e.id}>{edgeSummaryText(e)}</li>)}
      </ul>
    </div>
  );
}
