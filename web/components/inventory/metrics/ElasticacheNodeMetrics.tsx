'use client';
import { useMemo, useState } from 'react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import { useI18n } from '@/components/shell/LanguageProvider';
import DiagnosisGuide from './DiagnosisGuide';
import { EC_GUIDE } from './guides';
import MetricTable, { type MetricCol } from './MetricTable';
import { type Row, num, dash, gb, mb, cnt, meter, RangePicker, useFleet } from './shared';

// ── ElastiCache: per-node rows (cache_nodes JSONB flattened; metrics are cluster-level, v1 parity) ──
interface CacheNode { CacheNodeId?: string; cache_node_id?: string; CacheNodeStatus?: string; cache_node_status?: string; CustomerAvailabilityZone?: string; customer_availability_zone?: string; Endpoint?: { Address?: string }; endpoint?: { address?: string } }

type Metrics = Record<string, number | null>;
type NodeItem = { cluster: Row; node: CacheNode; m: Metrics };
type ClusterItem = { row: Row; m: Metrics };

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

// CacheHitRate: 요청이 없으면 null — 값이 0..1 비율로 오면 %로 환산.
const hitPctOf = (m: Metrics): number | null => {
  const hr = num(m.hitRate);
  return hr == null ? null : hr <= 1 ? hr * 100 : hr;
};
const swapMbOf = (m: Metrics): number | null => {
  const s = num(m.swap);
  return s == null ? null : s / 1024 / 1024;
};
const bwExOf = (m: Metrics): number | null =>
  num(m.bwInEx) == null && num(m.bwOutEx) == null ? null : (num(m.bwInEx) ?? 0) + (num(m.bwOutEx) ?? 0);

export function ElasticacheNodeMetrics({ rows }: { rows: Row[] }) {
  const { tt } = useI18n();
  const [range, setRange] = useState(3600);
  const ids = useMemo(() => [...new Set(rows.map((r) => String(r.resource_id)))].slice(0, 200), [rows]);
  const { fleet, err } = useFleet('elasticache', ids, range);

  const nodeItems: NodeItem[] = useMemo(() => rows.flatMap((r) => {
    const raw = r.cache_nodes;
    const nodes: CacheNode[] = Array.isArray(raw) && raw.length > 0 ? (raw as CacheNode[]) : [{}];
    return nodes.map((n) => ({ cluster: r, node: n, m: fleet[String(r.resource_id)] ?? {} }));
  }), [rows, fleet]);

  const clusterItems: ClusterItem[] = useMemo(
    () => rows.map((row) => ({ row, m: fleet[String(row.resource_id)] ?? {} })),
    [rows, fleet],
  );
  if (rows.length === 0) return null;

  const statusOf = (it: NodeItem) =>
    String(it.node.CacheNodeStatus ?? it.node.cache_node_status ?? it.cluster.cache_cluster_status ?? '—');

  const nodeColumns: MetricCol<NodeItem>[] = [
    { key: 'cluster', label: 'Cluster', mono: true, value: (it) => String(it.cluster.resource_id) },
    {
      key: 'engine', label: 'Engine', facet: true,
      value: (it) => str(it.cluster.engine),
      render: (it) => {
        const engine = String(it.cluster.engine ?? '—');
        return <Badge tone={engine === 'valkey' ? 'negative' : engine === 'redis' ? 'brand' : 'positive'} variant="soft">{engine}</Badge>;
      },
    },
    { key: 'version', label: 'Version', value: (it) => str(it.cluster.engine_version) },
    { key: 'nodeType', label: 'Node Type', mono: true, facet: true, value: (it) => str(it.cluster.cache_node_type) },
    { key: 'nodeId', label: 'Node ID', mono: true, value: (it) => String(it.node.CacheNodeId ?? it.node.cache_node_id ?? '0001') },
    {
      key: 'status', label: 'Status', facet: true,
      value: (it) => statusOf(it),
      render: (it) => {
        const status = statusOf(it);
        return <Badge tone={status === 'available' ? 'positive' : 'brand'} variant="soft" dot>{status}</Badge>;
      },
    },
    { key: 'cpu', label: 'CPU', type: 'num', value: (it) => num(it.m.cpu), render: (it) => meter(num(it.m.cpu)) },
    { key: 'ecpu', label: 'Engine CPU', type: 'num', value: (it) => num(it.m.ecpu), render: (it) => meter(num(it.m.ecpu)) },
    { key: 'mem', label: 'Memory', type: 'num', value: (it) => num(it.m.mem), render: (it) => gb(num(it.m.mem)) },
    {
      key: 'netIn', label: tt('Net In (누적)'), type: 'num', title: tt('NetworkBytesIn — 선택 기간 누적 합계'),
      value: (it) => num(it.m.netIn), render: (it) => mb(num(it.m.netIn)),
    },
    {
      key: 'netOut', label: tt('Net Out (누적)'), type: 'num', title: tt('NetworkBytesOut — 선택 기간 누적 합계'),
      value: (it) => num(it.m.netOut), render: (it) => mb(num(it.m.netOut)),
    },
    { key: 'conn', label: 'Conn', type: 'num', value: (it) => num(it.m.conn), render: (it) => cnt(num(it.m.conn)) },
    {
      key: 'az', label: 'AZ', facet: true,
      value: (it) => String(it.node.CustomerAvailabilityZone ?? it.node.customer_availability_zone ?? it.cluster.preferred_availability_zone ?? '—'),
    },
    { key: 'endpoint', label: 'Endpoint', mono: true, value: (it) => String(it.node.Endpoint?.Address ?? it.node.endpoint?.address ?? '—') },
  ];

  // 진단 지표 (owner 가이드): 메모리 압박·히트율·축출·대역폭 상한·복제 지연 — 클러스터 단위
  const diagColumns: MetricCol<ClusterItem>[] = [
    { key: 'cluster', label: 'Cluster', mono: true, value: (it) => String(it.row.resource_id) },
    { key: 'engine', label: 'Engine', facet: true, value: (it) => str(it.row.engine) },
    {
      key: 'dbMem', label: 'DB Mem', type: 'num', title: tt('DatabaseMemoryUsagePercentage — maxmemory 대비 사용률, 가장 중요한 경보 지표'),
      value: (it) => num(it.m.dbMemPct), render: (it) => meter(num(it.m.dbMemPct)),
    },
    {
      key: 'hitRate', label: 'Hit Rate', type: 'num', title: tt('CacheHitRate — 낮으면 캐시 효용 저하 (TTL 짧음/키 설계/콜드 캐시)'),
      value: (it) => hitPctOf(it.m),
      render: (it) => { const v = hitPctOf(it.m); return v == null ? dash : `${v.toFixed(1)}%`; },
      danger: (it) => { const v = hitPctOf(it.m); return v != null && v < 80; },
    },
    {
      key: 'evictions', label: 'Evictions', type: 'num',
      title: tt('Evictions(선택 기간 누적) — >0 지속 = 메모리 부족으로 키 강제 축출 → 노드 확장/샤딩/maxmemory-policy 재검토'),
      value: (it) => num(it.m.evictions), render: (it) => cnt(num(it.m.evictions)),
      danger: (it) => { const v = num(it.m.evictions); return v != null && v > 0; },
    },
    {
      key: 'reclaimed', label: 'Reclaimed', type: 'num', title: tt('Reclaimed — TTL 만료로 제거된 키 수 (정상 동작)'),
      value: (it) => num(it.m.reclaimed), render: (it) => cnt(num(it.m.reclaimed)),
    },
    {
      key: 'swap', label: 'Swap', type: 'num', title: tt('SwapUsage — 커지면 디스크 스왑 → 지연 급증 위험'),
      value: (it) => swapMbOf(it.m),
      render: (it) => { const v = swapMbOf(it.m); return v == null ? dash : `${v.toFixed(0)} MB`; },
      danger: (it) => { const v = swapMbOf(it.m); return v != null && v > 50; },
    },
    {
      key: 'items', label: 'Items', type: 'num', title: tt('CurrItems — 저장된 아이템 수'),
      value: (it) => num(it.m.currItems), render: (it) => cnt(num(it.m.currItems)),
    },
    {
      key: 'newConn', label: 'New Conn', type: 'num', title: tt('NewConnections(선택 기간 누적) — 급증 시 커넥션 풀 미사용/재연결 폭풍 의심'),
      value: (it) => num(it.m.newConn), render: (it) => cnt(num(it.m.newConn)),
    },
    {
      key: 'bwEx', label: tt('BW 상한 초과'), type: 'num',
      title: tt('NetworkBandwidthIn/OutAllowanceExceeded — 인스턴스 네트워크 상한 초과, 놓치기 쉬운 병목'),
      value: (it) => bwExOf(it.m),
      render: (it) => { const v = bwExOf(it.m); return v == null ? dash : Math.round(v).toLocaleString(); },
      danger: (it) => { const v = bwExOf(it.m); return v != null && v > 0; },
    },
    {
      key: 'replLag', label: 'Repl Lag', type: 'num', title: tt('ReplicationLag(초) — 리드 리플리카 복제 지연, 증가 추세면 경보'),
      value: (it) => num(it.m.replLag),
      render: (it) => { const v = num(it.m.replLag); return v == null ? dash : `${v.toFixed(1)}s`; },
      danger: (it) => { const v = num(it.m.replLag); return v != null && v > 10; },
    },
  ];

  return (
    <Card
      title={tt('노드 메트릭')}
      subtitle={`${nodeItems.length} nodes · CloudWatch AWS/ElastiCache (${tt('클러스터 단위')}) · ${tt('값은 선택 기간 전체 집계')}`}
      right={<RangePicker value={range} onChange={setRange} />}
      padded={false}
    >
      {err && <div className="px-3 py-2 text-[12px] text-rose-600">{tt('메트릭 조회 실패')}: {err}</div>}
      <MetricTable
        columns={nodeColumns}
        items={nodeItems}
        rowKey={(it, i) => `${String(it.cluster.resource_id)}/${String(it.node.CacheNodeId ?? it.node.cache_node_id ?? i)}`}
      />

      {/* 진단 지표 (owner 가이드): 메모리 압박·히트율·축출·대역폭 상한·복제 지연 — 클러스터 단위 */}
      <div className="border-t border-ink-100">
        <div className="px-4 pt-3 text-[12.5px] font-semibold text-ink-700">{tt('진단 지표 (Redis/Valkey 중심, 선택 기간)')}</div>
        <MetricTable
          columns={diagColumns}
          items={clusterItems}
          rowKey={(it) => String(it.row.resource_id)}
        />
      </div>

      <DiagnosisGuide spec={EC_GUIDE} />
    </Card>
  );
}
