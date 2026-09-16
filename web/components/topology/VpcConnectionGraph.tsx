'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { Background, Controls, Position, useReactFlow, useStore, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { VpcConnectivity } from '@/lib/vpc-connectivity-types';
import { buildVpcConnectionGraph } from '@/lib/vpc-connection-graph';
import { layoutFlow } from '@/lib/flow-layout';
import { useTheme } from '@/lib/use-theme';
import { useI18n } from '@/components/shell/LanguageProvider';

const ReactFlow = dynamic(() => import('@xyflow/react').then(m => m.ReactFlow), { ssr: false });
const COLORS = {
  vpc: ['#EAF3EE', '#1F3A2F', '#3F9D6B'],
  tgw: ['#F0EBFA', '#30223E', '#8B5CF6'],
  peering: ['#E7F1FA', '#173246', '#0284C7'],
  unknown: ['#F8F0DF', '#3A2A0E', '#AA6500'],
} as const;

function FitMeasuredGraph({ matches, height }: { matches: Set<string>; height: number }) {
  const fitted = useRef('');
  const viewportReady = useStore(state => state.width > 0 && state.height === height);
  const { fitView, viewportInitialized } = useReactFlow();
  // Observe the positions/dimensions actually committed to ReactFlow's store.
  // Selection and manual zoom do not change this key, so opening evidence does
  // not reset a user's viewport. This is the only automatic-fit owner.
  // Controlled input nodes do not receive measurement changes when there is no
  // onNodesChange setter. Read the measured internal nodes, not those inputs.
  const layoutKey = useStore(state => JSON.stringify([...state.nodeLookup.values()].map(n =>
    [n.id, n.position.x, n.position.y, n.measured?.width ?? 0, n.measured?.height ?? 0])));
  const targetKey = JSON.stringify([...matches]);
  useEffect(() => {
    const measured: [string, number, number, number, number][] = JSON.parse(layoutKey);
    if (!viewportInitialized || !viewportReady || !measured.length || measured.some(n => !n[3] || !n[4])) return;
    const key = `${layoutKey}\n${targetKey}`;
    if (fitted.current === key) return;
    const frame = requestAnimationFrame(() => {
      fitted.current = key;
      const ids: string[] = JSON.parse(targetKey);
      void fitView({ ...(ids.length ? { nodes: ids.map(id => ({ id })) } : {}), padding: 0.25, maxZoom: 1.1 });
    });
    return () => cancelAnimationFrame(frame);
  }, [viewportInitialized, viewportReady, layoutKey, targetKey, fitView]);
  return null;
}

export default function VpcConnectionGraph({ data, query = '' }: { data: VpcConnectivity; query?: string }) {
  const { tt } = useI18n();
  const dark = useTheme() === 'dark';
  const model = useMemo(() => buildVpcConnectionGraph(data), [data]);
  const [selected, setSelected] = useState<{ kind: 'node' | 'edge'; id: string } | null>(null);
  const frame = useRef<HTMLDivElement | null>(null);
  const [vertical, setVertical] = useState(false);
  useEffect(() => {
    if (!frame.current) return;
    const observer = new ResizeObserver(([entry]) => setVertical(entry.contentRect.width < 620));
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, []);
  const needle = query.trim().toLowerCase();
  const matches = useMemo(() => new Set(model.nodes.filter(n =>
    needle && [n.label, n.kind, n.accountId, n.region, ...Object.values(n.details)]
      .some(value => value?.toLowerCase().includes(needle))).map(n => n.id)), [model, needle]);
  const positions = useMemo(() => new Map(layoutFlow(model, {
    rankdir: vertical ? 'TB' : 'LR', nodeSize: () => ({ width: 244, height: 92 }),
  }).map(p => [p.id, p])), [model, vertical]);
  const nodes = useMemo<Node[]>(() => {
    const labels = { vpc: 'VPC', tgw: 'Transit Gateway', peering: 'VPC Peering', unknown: tt('식별 정보 미확인') };
    return model.nodes.map(n => ({
    id: n.id, position: positions.get(n.id) ?? { x: 0, y: 0 },
    sourcePosition: vertical ? Position.Bottom : Position.Right,
    targetPosition: vertical ? Position.Top : Position.Left,
    className: `vpc-connection-node-${n.kind}`,
    data: { label: <div className="text-left">
      <div className="truncate font-semibold" title={`${labels[n.kind]}: ${n.label}`}>{labels[n.kind]}: {n.label}</div>
      <div className="mt-1 truncate text-[11px]">{n.source && data.source.ownerId === null
        ? tt('소유 계정 미확인') : n.accountId ?? tt('소유 계정 미확인')}</div>
      <div className="truncate text-[11px]">{n.region ?? tt('리전 미확인')}{n.source ? ` · ${tt('기준 VPC')}` : ''}</div>
    </div> },
    style: {
      width: 244, height: 92, padding: 10, borderRadius: 10, fontSize: 12,
      color: dark ? '#F1F5F9' : '#16202A',
      background: COLORS[n.kind][dark ? 1 : 0],
      border: `${n.source || matches.has(n.id) ? 3 : 1}px solid ${COLORS[n.kind][2]}`,
      opacity: needle && matches.size && !matches.has(n.id) ? 0.4 : 1,
    },
    }));
  }, [model, positions, vertical, dark, matches, needle, tt, data.source.ownerId]);
  const edges = useMemo<Edge[]>(() => model.edges.map(e => ({
    id: e.id, source: e.source, target: e.target, type: 'smoothstep',
    label: e.kind === 'tgw' ? 'TGW' : 'Peering',
    // These undirected lines show configuration relationships, never a tested route.
    style: { stroke: e.kind === 'tgw' ? COLORS.tgw[2] : COLORS.peering[2], strokeWidth: 2 },
    labelStyle: { fontSize: 11, fill: dark ? '#F1F5F9' : '#16202A' },
    labelBgStyle: { fill: dark ? '#232C34' : '#FFFFFF', fillOpacity: 0.95 },
  })), [model, dark]);
  const selectedNode = selected?.kind === 'node' ? model.nodes.find(n => n.id === selected.id) : null;
  const selectedEdge = selected?.kind === 'edge' ? model.edges.find(e => e.id === selected.id) : null;
  const details = selectedNode ? selectedNode.details : selectedEdge ? {
    relationship: selectedEdge.kind, recordId: selectedEdge.recordId,
    from: model.nodes.find(n => n.id === selectedEdge.source)?.label ?? selectedEdge.source,
    to: model.nodes.find(n => n.id === selectedEdge.target)?.label ?? selectedEdge.target,
  } : null;
  return (
    <section aria-label={tt('VPC 연결 그래프')} className="overflow-hidden rounded-lg border border-ink-200 bg-paper">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-ink-100 px-3 py-2 text-[12px] text-ink-600">
        <strong>{tt('VPC 연결 그래프')}</strong>
        <span>{tt('표시 노드')} {nodes.length} · {tt('연결선')} {edges.length}</span>
        <span>VPC · Transit Gateway · Peering</span>
        {needle && <span>{tt('검색 결과')} {matches.size}</span>}
      </div>
      <p className="px-3 pt-2 text-[12px] text-ink-600">{tt('선은 활성 연결 구성입니다. 노드·선을 클릭하면 근거를 볼 수 있습니다. 통신 가능성을 보장하지 않습니다.')}</p>
      {Object.values(model.omitted).some(Boolean) && <p role="status" className="px-3 pt-2 text-[12px] text-ink-600">
        {tt('대기·종료 기록')} {model.omitted.inactive} · {tt('식별 정보 미확인')} {model.omitted.unresolved} · {tt('표시 상한으로 생략')} {model.omitted.capped}
      </p>}
      {!edges.length && <p role="status" className="px-3 pt-2 text-[12px] text-ink-600">{tt('현재 조회 결과에서 그릴 활성 연결선이 없습니다. 조회 제한과 상세 기록을 확인하세요.')}</p>}
      <div ref={frame} className="w-full" style={{ height: vertical ? 560 : 440 }} data-testid="vpc-connection-canvas">
        <ReactFlow nodes={nodes} edges={edges}
          minZoom={0.01} maxZoom={2} colorMode={dark ? 'dark' : 'light'} nodesDraggable={false} nodesConnectable={false}
          onNodeClick={(_, node) => setSelected({ kind: 'node', id: node.id })}
          onEdgeClick={(_, edge) => setSelected({ kind: 'edge', id: edge.id })}
          proOptions={{ hideAttribution: true }}>
          <Background />
          <Controls showInteractive={false} />
          <FitMeasuredGraph matches={matches} height={vertical ? 560 : 440} />
        </ReactFlow>
      </div>
      {details && <div className="border-t border-ink-100 p-3 text-[12px] text-ink-600">
        <div className="mb-2 flex items-center justify-between gap-2">
          <strong className="break-all">{selectedNode?.label ?? selectedEdge?.recordId}</strong>
          <button type="button" className="rounded border border-ink-200 px-2 py-1" onClick={() => setSelected(null)}>{tt('닫기')}</button>
        </div>
        <dl className="grid max-h-48 grid-cols-[minmax(100px,1fr)_2fr] gap-x-3 gap-y-1 overflow-auto">
          {Object.entries(details).slice(0, 50).map(([key, value]) => <div key={key} className="contents">
            <dt className="break-all font-medium">{key}</dt><dd className="break-all">{value ?? tt('미확인')}</dd>
          </div>)}
        </dl>
        {Object.keys(details).length > 50 && <p>{tt('상세 항목은 처음 50개까지 표시합니다.')}</p>}
      </div>}
    </section>
  );
}
