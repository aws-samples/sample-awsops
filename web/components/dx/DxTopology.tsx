'use client';
import { useEffect, useMemo, useRef } from 'react';
import dynamic from 'next/dynamic';
import { Building2, MapPin, Cable, Layers, Waypoints, Router, Share2, Shield, Cloud, type LucideIcon } from 'lucide-react';
import { Background, Controls, Position, type Node, type Edge, type ReactFlowInstance } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useI18n } from '@/components/shell/LanguageProvider';
import { useTheme } from '@/lib/use-theme';
import { buildDxTopology, layoutDxTopology, type DxNodeKind, type DxTopoNode } from '@/lib/dx-topology';
import type { DxAnalysis } from '@/lib/dx';

// ReactFlow touches the DOM on mount — load it client-only to avoid SSR mismatch (topology page pattern).
const ReactFlow = dynamic(() => import('@xyflow/react').then((m) => m.ReactFlow), { ssr: false });

// Node fill/border per kind — light + dark variants (topology page convention).
const KIND_LIGHT: Record<DxNodeKind, [string, string]> = {
  onprem: ['#EBEFF2', '#586773'], location: ['#E6EEFE', '#3D6FB5'], connection: ['#FEF3E2', '#C8902F'],
  lag: ['#F1E9FF', '#8A5BD0'], vif: ['#E6F6F2', '#01A88D'], dxgw: ['#E6EEFE', '#3D6FB5'],
  vgw: ['#E6F6EC', '#2E9E5B'], tgw: ['#F1E9FF', '#8A5BD0'], awspub: ['#EBEFF2', '#AFBAC3'],
};
const KIND_DARK: Record<DxNodeKind, [string, string]> = {
  onprem: ['#1F262D', '#8696A3'], location: ['#16243E', '#3D6FB5'], connection: ['#33260C', '#C8902F'],
  lag: ['#241A3E', '#8A5BD0'], vif: ['#0E2E2A', '#2CC9AE'], dxgw: ['#16243E', '#3D6FB5'],
  vgw: ['#0E2E1C', '#2E9E5B'], tgw: ['#241A3E', '#8A5BD0'], awspub: ['#1F262D', '#586773'],
};
// 상태 우선 색: down = rose, warn = amber (topology page HEALTH convention).
const STATE_LIGHT: Record<string, [string, string]> = { down: ['#FDECE8', '#D13212'], warn: ['#FEF3E2', '#F59E0B'] };
const STATE_DARK: Record<string, [string, string]> = { down: ['#3A1712', '#F26B4D'], warn: ['#33260C', '#F5B53C'] };

const KIND_ICON: Record<DxNodeKind, LucideIcon> = {
  onprem: Building2, location: MapPin, connection: Cable, lag: Layers, vif: Waypoints,
  dxgw: Router, tgw: Share2, vgw: Shield, awspub: Cloud,
};
const KIND_LABEL: Record<DxNodeKind, string> = {
  onprem: '온프레미스', location: '로케이션', connection: '커넥션', lag: 'LAG', vif: 'VIF',
  dxgw: 'DX Gateway', tgw: 'Transit Gateway', vgw: 'Virtual Private Gateway', awspub: 'AWS 퍼블릭 서비스',
};

export default function DxTopology({ data, onNodeSelect }: {
  data: Pick<DxAnalysis, 'connections' | 'vifs' | 'gateways'>;
  /** connection/vif/dxgw 노드 클릭 → 원본 행 전달 (페이지의 기존 DetailPanel 재사용). */
  onNodeSelect?: (n: DxTopoNode) => void;
}) {
  const { tt } = useI18n();
  const dark = useTheme() === 'dark';

  const { nodes, edges } = useMemo(() => {
    const g = buildDxTopology(data);
    const pos = layoutDxTopology(g);
    const nodes: Node[] = g.nodes.map((n) => {
      const [bg, border] = (dark ? STATE_DARK : STATE_LIGHT)[n.state] ?? (dark ? KIND_DARK : KIND_LIGHT)[n.kind];
      const Icon = KIND_ICON[n.kind];
      const p = pos.get(n.id) ?? { x: 0, y: 0 };
      const clickable = n.row != null;
      // 미연결 VIF(나가는 엣지 없는 vif)와 미연결 DXGW는 점선 테두리 — sample의 Unattached Zone 관례.
      const dangling = (n.kind === 'vif' && !g.edges.some((e) => e.source === n.id))
        || (n.kind === 'dxgw' && !g.edges.some((e) => e.source === n.id || e.target === n.id));
      return {
        id: n.id,
        position: { x: p.x, y: p.y },
        data: {
          tnode: n,
          label: (
            <div className="flex items-start gap-1.5 text-left">
              <Icon size={13} className="mt-0.5 shrink-0" style={{ color: border }} />
              <div className="min-w-0">
                <div className="truncate font-medium leading-tight">{n.kind === 'onprem' || n.kind === 'awspub' ? tt(n.label) : n.label}</div>
                <div className="truncate text-[10px] opacity-70">{tt(n.sub ?? KIND_LABEL[n.kind])}</div>
              </div>
            </div>
          ),
        },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        style: {
          background: bg,
          border: `${dangling ? '1px dashed' : '1px solid'} ${border}`,
          color: dark ? '#E3E9EE' : '#16202A',
          borderRadius: 8, fontSize: 11, padding: 6, width: 200,
          cursor: clickable ? 'pointer' : 'default',
        },
      };
    });
    const edges: Edge[] = g.edges.map((e) => ({
      id: e.id, source: e.source, target: e.target,
      ...(e.label ? { label: e.label, labelStyle: { fontSize: 9, fill: dark ? '#9FAEBA' : '#586773' } } : {}),
      style: {
        ...(e.dashed ? { strokeDasharray: '4 4' } : {}),
        ...(e.state === 'down' ? { stroke: dark ? '#F26B4D' : '#D13212' } : e.state === 'warn' ? { stroke: dark ? '#F5B53C' : '#F59E0B' } : {}),
      },
      animated: e.state === 'down',
    }));
    return { nodes, edges };
  }, [data, dark, tt]);

  // topology 페이지 관례: 리마운트 대신 imperative fitView (pan/zoom 보존).
  const rfRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  useEffect(() => {
    const id = requestAnimationFrame(() => rfRef.current?.fitView({ padding: 0.15, duration: 300, maxZoom: 1.1 }));
    return () => cancelAnimationFrame(id);
  }, [nodes.length]);

  if (nodes.length === 0) {
    return <div className="px-4 py-6 text-[13px] text-ink-400">{tt('Direct Connect 리소스 없음')}</div>;
  }
  return (
    <div className="h-[440px]">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1.1 }}
        colorMode={dark ? 'dark' : 'light'}
        proOptions={{ hideAttribution: true }}
        onInit={(inst) => { rfRef.current = inst; }}
        onNodeClick={(_, node) => {
          const n = (node.data as { tnode?: DxTopoNode })?.tnode;
          if (n?.row && onNodeSelect) onNodeSelect(n);
        }}
        nodesConnectable={false}
        deleteKeyCode={null}
      >
        <Background gap={16} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
