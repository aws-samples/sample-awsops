'use client';

// AWS architecture-diagram rendering of a NetworkTopology: nested group boxes
// (Account > Region > VPC > AZ > Subnet) with AWS group colors and category-colored
// resource tiles. Layout comes from the pure lib/network-layout.ts packer.
import { useMemo } from 'react';
import dynamic from 'next/dynamic';
import { Handle, Position, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  ArrowLeftRight, Box, Cloud, Database, Globe, Lock, Network, Scale, Server, Split, Waypoints, Zap, type LucideIcon,
} from 'lucide-react';
import { layoutNetwork } from '@/lib/network-layout';
import type { NetKind, NetNode, NetworkTopology } from '@/lib/network-topology-types';

const ReactFlow = dynamic(() => import('@xyflow/react').then((m) => m.ReactFlow), { ssr: false });
const Background = dynamic(() => import('@xyflow/react').then((m) => m.Background), { ssr: false });
const Controls = dynamic(() => import('@xyflow/react').then((m) => m.Controls), { ssr: false });

type Theme = 'light' | 'dark';

// AWS architecture group colors (Account, Region, VPC, AZ, public/private subnet).
const GROUP_BORDER: Partial<Record<NetKind, string>> = {
  account: '#E7157B', region: '#00A4A6', vpc: '#8C4FFF', az: '#147EBA',
};
const SUBNET_BORDER = { public: '#7AA116', private: '#00A4A6', unknown: '#7D8998' } as const;
const DASHED = new Set<NetKind>(['region', 'az']);
const GROUP_ICON: Partial<Record<NetKind, LucideIcon>> = { account: Cloud, region: Globe, vpc: Network, az: Box, subnet: Split };

// Resource tiles: AWS category color + glyph.
const TILE: Partial<Record<NetKind, { color: string; icon: LucideIcon; label: string }>> = {
  ec2: { color: '#ED7100', icon: Server, label: 'EC2' },
  lambda: { color: '#ED7100', icon: Zap, label: 'Lambda' },
  igw: { color: '#8C4FFF', icon: Globe, label: 'IGW' },
  nat: { color: '#8C4FFF', icon: ArrowLeftRight, label: 'NAT' },
  vpce: { color: '#8C4FFF', icon: Lock, label: 'Endpoint' },
  alb: { color: '#8C4FFF', icon: Scale, label: 'ALB' },
  nlb: { color: '#8C4FFF', icon: Scale, label: 'NLB' },
  rds: { color: '#C925D1', icon: Database, label: 'RDS' },
  more: { color: '#7D8998', icon: Box, label: '' },
};
const CARD: Partial<Record<NetKind, { color: string; icon: LucideIcon }>> = {
  vpc: { color: '#8C4FFF', icon: Network },
  tgw: { color: '#8C4FFF', icon: Waypoints },
  external: { color: '#7D8998', icon: Network },
};
const EDGE_COLOR = { tgw: '#8C4FFF', peering: '#00A4A6' } as const;
const CONTAINERS = new Set<NetKind>(['account', 'region', 'vpc', 'az', 'subnet']);

interface NetData extends Record<string, unknown> { net: NetNode; theme: Theme; container: boolean }

const hidden = { opacity: 0, pointerEvents: 'none' as const };
function Handles() {
  return (<>
    <Handle type="target" position={Position.Left} style={hidden} />
    <Handle type="source" position={Position.Right} style={hidden} />
  </>);
}

function GroupNode({ data }: NodeProps) {
  const { net: n, theme } = data as NetData;
  const border = n.kind === 'subnet' ? SUBNET_BORDER[n.tier ?? 'unknown'] : GROUP_BORDER[n.kind] ?? '#7D8998';
  const Icon = GROUP_ICON[n.kind] ?? Box;
  const tier = n.kind === 'subnet' ? (n.tier === 'public' ? 'Public' : n.tier === 'private' ? 'Private' : 'Subnet') : null;
  return (
    <div className="h-full w-full rounded-sm" style={{
      border: `${n.kind === 'account' ? 2 : 1.5}px ${DASHED.has(n.kind) ? 'dashed' : 'solid'} ${border}`,
      background: n.kind === 'subnet' ? `${border}${theme === 'dark' ? '22' : '14'}` : 'transparent',
      color: theme === 'dark' ? '#E8EDF2' : '#16202A',
    }}>
      <Handles />
      <div className="flex items-center gap-1.5 px-2 py-1 text-[11px]">
        <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-white" style={{ background: border }}>
          <Icon size={11} aria-hidden />
        </span>
        {tier && <span className="shrink-0 font-semibold" style={{ color: border }}>{tier}</span>}
        <span className="truncate font-semibold" title={n.label}>{n.label}</span>
        {n.sub && <span className="truncate opacity-70" title={n.sub}>{n.sub}</span>}
      </div>
    </div>
  );
}

function CardNode({ data }: NodeProps) {
  const { net: n, theme } = data as NetData;
  const spec = CARD[n.kind] ?? CARD.external!;
  const Icon = spec.icon;
  return (
    <div className="flex h-full w-full items-center gap-2 rounded-md px-2" style={{
      border: `1.5px ${n.kind === 'external' ? 'dashed' : 'solid'} ${spec.color}`,
      background: theme === 'dark' ? '#111827' : '#FFFFFF', color: theme === 'dark' ? '#E8EDF2' : '#16202A',
    }}>
      <Handles />
      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-white" style={{ background: spec.color }}>
        <Icon size={16} aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[12px] font-semibold" title={n.label}>{n.label}</span>
        {n.sub && <span className="block truncate text-[10px] opacity-70" title={n.sub}>{n.sub}</span>}
      </span>
    </div>
  );
}

function TileNode({ data }: NodeProps) {
  const { net: n, theme } = data as NetData;
  const spec = TILE[n.kind] ?? TILE.more!;
  const Icon = spec.icon;
  return (
    <div className="flex h-full w-full flex-col items-center gap-0.5 pt-1 text-center"
      style={{ color: theme === 'dark' ? '#E8EDF2' : '#16202A' }} title={[spec.label, n.label, n.sub, n.state].filter(Boolean).join(' · ')}>
      <Handles />
      <span className="inline-flex h-10 w-10 items-center justify-center rounded-md text-white" style={{ background: spec.color }}>
        {n.kind === 'more' ? <span className="text-[13px] font-semibold">{n.label}</span> : <Icon size={22} aria-hidden />}
      </span>
      {n.kind !== 'more' && <span className="w-full truncate px-0.5 text-[10px] leading-tight">{n.label}</span>}
    </div>
  );
}

const nodeTypes = { netGroup: GroupNode, netCard: CardNode, netTile: TileNode };

/** Pure conversion to xyflow elements (parents precede children, as xyflow requires). */
export function toFlowElements(topology: NetworkTopology, theme: Theme): { nodes: Node[]; edges: Edge[] } {
  const placed = new Map(layoutNetwork(topology).map((p) => [p.id, p]));
  const hasChildren = new Set(topology.nodes.map((n) => n.parent).filter((p): p is string => !!p));
  const nodes: Node[] = topology.nodes.map((n) => {
    const p = placed.get(n.id)!;
    const container = CONTAINERS.has(n.kind) && (n.kind !== 'vpc' || hasChildren.has(n.id));
    return {
      id: n.id,
      type: container ? 'netGroup' : TILE[n.kind] ? 'netTile' : 'netCard',
      position: { x: p.x, y: p.y },
      ...(p.parentId ? { parentId: p.parentId, extent: 'parent' as const } : {}),
      style: { width: p.width, height: p.height },
      data: { net: n, theme, container } satisfies NetData,
      draggable: false,
      selectable: !container,
      zIndex: container ? 0 : 1,
    };
  });
  const edges: Edge[] = topology.edges.map((e) => ({
    id: e.id, source: e.source, target: e.target, type: 'smoothstep', zIndex: 2,
    style: {
      stroke: EDGE_COLOR[e.kind], strokeWidth: e.crossAccount ? 2.5 : 1.5,
      ...(e.kind === 'peering' ? { strokeDasharray: '6 4' } : {}),
    },
    label: e.crossAccount ? 'cross-account' : undefined,
    labelStyle: { fontSize: 9 },
  }));
  return { nodes, edges };
}

/** VPC key a click should toggle into the selection, or null for non-VPC nodes. */
export function selectableVpcKey(node: Node): string | null {
  const n = (node.data as NetData | undefined)?.net;
  // A stub without an inventory row cannot expand, so it never consumes a selection slot.
  return n && n.vpcKey && (n.kind === 'vpc' || (n.kind === 'external' && n.inInventory === true)) ? n.vpcKey : null;
}

export default function NetworkDiagram({ topology, theme, onSelectVpc }:
  { topology: NetworkTopology; theme: Theme; onSelectVpc: (vpcKey: string) => void }) {
  const { nodes, edges } = useMemo(() => toFlowElements(topology, theme), [topology, theme]);
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      colorMode={theme}
      fitView
      minZoom={0.05}
      nodesConnectable={false}
      onNodeClick={(_, node) => { const key = selectableVpcKey(node); if (key) onSelectVpc(key); }}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={24} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
