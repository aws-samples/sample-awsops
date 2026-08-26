'use client';
import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, DollarSign, Globe, Network, Plug, ShieldAlert, Unplug } from 'lucide-react';
import PageHeader from '@/components/ui/PageHeader';
import Card from '@/components/ui/Card';
import StatTile from '@/components/ui/StatTile';
import Badge from '@/components/ui/Badge';
import DetailPanel from '@/components/ui/DetailPanel';
import MetricTable, { type MetricCol } from '@/components/inventory/metrics/MetricTable';
import { RangePicker, TH, MONO, TD, DANGER, dash } from '@/components/inventory/metrics/shared';
import DonutBreakdown from '@/components/charts/DonutBreakdown';
import HBarList from '@/components/charts/HBarList';
import { useI18n } from '@/components/shell/LanguageProvider';
import type { VpceAnalysis, VpceRow } from '@/lib/vpce';
import type { InvType } from '@/lib/inventory-types';

// /vpc-endpoints — VPC Endpoint 리스트+분석 (Network 메뉴). 전 리전 엔드포인트를 수집하고
// PrivateLink 메트릭(BytesProcessed 등)으로 **미사용 Interface(유휴 과금)**를 잡는다 —
// IF 엔드포인트는 AZ(ENI)당 시간 과금이라 트래픽 0 = 실돈 낭비. 추가로 전면 허용 정책,
// Private DNS off, S3/DynamoDB gateway 커버리지 갭(NAT 경유 비용 후보)을 표면화.
// 데이터 계층은 lib/vpce.ts(4분 TTL 캐시) — 이 페이지는 GET /api/vpce?range= 1회만 소비.

const IF_HOURLY_PER_AZ = 0.0126; // lib/vpce.ts와 동일한 추정 기준 (Interface per-AZ $/h)

/** 사람 단위 바이트 포맷 — 트래픽 컬럼/상세용. null=메트릭 없음. */
function fmtBytes(v: number | null): string | null {
  if (v == null) return null;
  if (v === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = v;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(1)} ${units[i]}`;
}

// 상세 패널을 인벤토리 상세와 같은 섹션 카드 디자인으로 렌더하기 위한 최소 spec —
// sections가 있으면 DetailPanel이 아이콘 있는 섹션 + 친화적 라벨 포맷을 쓴다 (ENI_DETAIL_SPEC 선례).
const VPCE_DETAIL_SPEC: InvType = {
  label: 'VPC Endpoint', group: 'Network', stateKey: 'state',
  columns: [
    { key: 'id', label: 'Endpoint ID' }, { key: 'service', label: 'Service' },
    { key: 'service_name', label: 'Service Name' }, { key: 'type', label: 'Type' },
    { key: 'state', label: 'State' }, { key: 'region', label: 'Region' }, { key: 'created_at', label: 'Created' },
    { key: 'bytes_processed', label: 'Bytes Processed' }, { key: 'active_connections', label: 'Active Connections' },
    { key: 'new_connections', label: 'New Connections' }, { key: 'packets_dropped', label: 'Packets Dropped' },
    { key: 'unused', label: 'Unused (idle billing)' },
    { key: 'policy_open', label: 'Policy Full Access' }, { key: 'private_dns_enabled', label: 'Private DNS' },
    { key: 'vpc_id', label: 'VPC' }, { key: 'subnet_count', label: 'Subnets' }, { key: 'eni_count', label: 'ENIs' },
  ],
  sections: [
    { label: 'Identity', keys: ['id', 'service', 'service_name', 'type', 'state', 'region', 'created_at'] },
    { label: 'Traffic', keys: ['bytes_processed', 'active_connections', 'new_connections', 'packets_dropped', 'unused'] },
    { label: 'Security', keys: ['policy_open', 'private_dns_enabled'] },
    { label: 'Network', keys: ['vpc_id', 'subnet_count', 'eni_count'] },
  ],
};

/** 상세 패널용 flat 뷰 — 빈 필드는 제외 (Gateway엔 메트릭/Private DNS가 없다). */
function vpceDetail(r: VpceRow): Record<string, unknown> {
  const all: Record<string, unknown> = {
    id: r.id, service: r.service, service_name: r.serviceName, type: r.type, state: r.state,
    region: r.region, created_at: r.createdAt,
    bytes_processed: fmtBytes(r.bytesProcessed), active_connections: r.activeConnections,
    new_connections: r.newConnections, packets_dropped: r.packetsDropped,
    unused: r.type === 'Interface' ? r.unused : undefined,
    policy_open: r.policyOpen, private_dns_enabled: r.privateDnsEnabled,
    vpc_id: r.vpcId, subnet_count: r.subnetCount, eni_count: r.eniCount,
  };
  return Object.fromEntries(Object.entries(all).filter(([, v]) => v != null && v !== ''));
}

export default function VpcEndpointsPage() {
  const { tt } = useI18n();
  const [range, setRange] = useState(86400);
  const [data, setData] = useState<VpceAnalysis | null>(null);
  const [err, setErr] = useState('');
  const [selected, setSelected] = useState<VpceRow | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/vpce?range=${range}`)
      .then(async (r) => {
        const d = await r.json().catch(() => null);
        if (!r.ok) throw new Error(d?.message ?? `HTTP ${r.status}`);
        return d as VpceAnalysis;
      })
      .then((d) => { if (alive) { setData(d); setErr(''); } })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [range]);

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const unusedRows = useMemo(() => rows.filter((r) => r.unused), [rows]);
  const gaps = data?.coverageGaps ?? [];

  // 도넛: 타입 분포 (0 타입은 슬라이스 제외).
  const typeDist = useMemo(() => {
    const t = data?.totals;
    if (!t) return [];
    return [
      { name: 'Interface', value: t.interface },
      { name: 'Gateway', value: t.gateway },
      { name: 'GWLB', value: t.gwlb },
    ].filter((d) => d.value > 0);
  }, [data]);

  // 서비스 Top 10 — rows의 service별 개수 상위.
  const serviceTop = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.service, (counts.get(r.service) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([service, count]) => ({ service, count }));
  }, [rows]);

  const columns = useMemo<MetricCol<VpceRow>[]>(() => [
    {
      key: 'id', label: 'ID', mono: true,
      title: tt('미사용(기간 내 트래픽 0) Interface 엔드포인트는 빨간색 — 유휴 과금'),
      value: (r) => r.id,
      danger: (r) => r.unused,
    },
    { key: 'region', label: 'Region', facet: true, value: (r) => r.region },
    { key: 'service', label: 'Service', facet: true, value: (r) => r.service },
    { key: 'type', label: 'Type', facet: true, value: (r) => r.type },
    { key: 'vpc', label: 'VPC', mono: true, facet: true, value: (r) => r.vpcId || null },
    { key: 'state', label: 'State', facet: true, value: (r) => r.state },
    {
      key: 'eni', label: tt('ENI 수'), type: 'num',
      title: tt('Interface는 ENI(AZ)당 시간 과금'),
      value: (r) => r.eniCount,
    },
    {
      key: 'dns', label: 'Private DNS',
      title: tt('off면 서비스 기본 DNS가 엔드포인트로 해석되지 않아 퍼블릭 경로를 탈 수 있음'),
      value: (r) => (r.privateDnsEnabled == null ? null : r.privateDnsEnabled ? 'on' : 'off'),
      render: (r) => r.privateDnsEnabled == null
        ? dash
        : r.privateDnsEnabled
          ? 'on'
          : <span className="font-semibold text-warning-text">off</span>,
    },
    {
      key: 'policy', label: tt('정책'),
      title: tt('전면 허용(Action:* + Principal:*) 정책 여부'),
      value: (r) => (r.policyOpen ? 'FULL' : null),
      render: (r) => (r.policyOpen ? <Badge tone="negative" variant="soft">FULL</Badge> : dash),
      danger: (r) => r.policyOpen,
    },
    {
      key: 'bytes', label: tt('트래픽'), type: 'num',
      title: tt('기간 내 BytesProcessed 합계 (Interface만)'),
      value: (r) => r.bytesProcessed,
      render: (r) => fmtBytes(r.bytesProcessed) ?? dash,
      danger: (r) => r.unused,
    },
    {
      key: 'conns', label: tt('연결'), type: 'num',
      title: tt('기간 내 ActiveConnections 최대 (Interface만)'),
      value: (r) => r.activeConnections,
    },
    {
      key: 'dropped', label: 'Dropped', type: 'num',
      title: tt('기간 내 PacketsDropped 합계 — >0이면 엔드포인트 경유 패킷 드랍 발생'),
      value: (r) => r.packetsDropped,
      danger: (r) => (r.packetsDropped ?? 0) > 0,
    },
  ], [tt]);

  const t = data?.totals;

  return (
    <>
      <PageHeader
        title="VPC Endpoints"
        subtitle="전 리전 VPC 엔드포인트 + PrivateLink 메트릭 기반 미사용(유휴 과금)·보안 정책·커버리지 갭 분석"
        right={<RangePicker value={range} onChange={setRange} />}
      />
      <div className="px-4 lg:px-8 py-8 flex flex-col gap-6">
        {err && (
          <div className="text-[13px] text-rose-600">{tt('VPC Endpoint 조회 실패')}: {err}</div>
        )}
        {!data && !err && <div className="text-ink-400">{tt('로딩 중…')}</div>}

        {data && t && (
          <>
            {/* ① KPI — 미사용 IF(>0 danger, 유휴 과금) + 전면 허용 정책/Private DNS off(warn) + 월 추정 비용 */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
              <StatTile label="총 엔드포인트" value={t.total} icon={<Plug size={16} />} />
              <StatTile
                label="Interface"
                value={t.interface}
                hint={`Gateway ${t.gateway} · GWLB ${t.gwlb}`}
                icon={<Network size={16} />}
              />
              <StatTile
                label="미사용 Interface"
                value={t.unused}
                variant={t.unused > 0 ? 'danger' : 'default'}
                hint="기간 내 트래픽 0 — 유휴 과금"
                icon={<Unplug size={16} />}
              />
              <StatTile
                label="전면 허용 정책"
                value={t.policyOpen}
                variant={t.policyOpen > 0 ? 'warn' : 'default'}
                hint="Action:* + Principal:*"
                icon={<ShieldAlert size={16} />}
              />
              <StatTile
                label="Private DNS off"
                value={t.privateDnsOff}
                variant={t.privateDnsOff > 0 ? 'warn' : 'default'}
                hint={tt('Interface 전용 설정')}
                icon={<Globe size={16} />}
              />
              <StatTile
                label="월 추정 비용"
                value={`$${t.estMonthlyUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                hint="Interface ENI(AZ)당 $0.0126/h 추정"
                icon={<DollarSign size={16} />}
              />
            </div>

            {/* ② 분포 — 타입 도넛 + 서비스 Top 10 */}
            <div className="grid gap-6 lg:grid-cols-2">
              <DonutBreakdown title="타입 분포" data={typeDist} nameKey="name" valueKey="value" />
              <HBarList title="서비스 Top 10" data={serviceTop} labelKey="service" valueKey="count" highlightMax />
            </div>

            {/* ③ 미사용 Interface — 트래픽 0인데 ENI(AZ)당 시간 과금이 계속 나가는 엔드포인트 */}
            <Card
              title="미사용 Interface 엔드포인트"
              subtitle="기간 내 BytesProcessed 0 — 트래픽 없이 ENI(AZ)당 시간 과금 지속"
              padded={false}
            >
              {unusedRows.length === 0 ? (
                <div className="flex items-center gap-2 px-4 py-3 text-[13px] text-emerald-700">
                  <CheckCircle2 size={15} />
                  {tt('이상 없음 — 기간 내 트래픽 없는 Interface 엔드포인트 없음')}
                </div>
              ) : (
                <div className="overflow-x-auto pb-2">
                  <table className="w-full">
                    <thead><tr className="border-b border-ink-100">
                      <th className={TH}>ID</th>
                      <th className={TH}>Service</th>
                      <th className={TH}>VPC</th>
                      <th className={TH}>ENI</th>
                      <th className={TH}>{tt('월 추정 낭비')}</th>
                    </tr></thead>
                    <tbody>
                      {unusedRows.map((r) => (
                        <tr
                          key={r.id}
                          onClick={() => setSelected(r)}
                          className="cursor-pointer border-b border-ink-50 last:border-0 hover:bg-ink-50"
                        >
                          <td className={`${MONO} ${DANGER}`}>{r.id}</td>
                          <td className={MONO}>{r.service}</td>
                          <td className={MONO}>{r.vpcId || dash}</td>
                          <td className={TD}>{r.eniCount}</td>
                          <td className={`${TD} ${DANGER}`}>${(r.eniCount * IF_HOURLY_PER_AZ * 720).toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            {/* ④ 커버리지 갭 — S3/DynamoDB gateway 엔드포인트 없는 VPC (NAT 경유 비용 후보) */}
            <Card
              title="Gateway 커버리지 갭"
              subtitle="S3/DynamoDB Gateway 엔드포인트가 없는 VPC"
              padded={false}
            >
              {gaps.length === 0 ? (
                <div className="flex items-center gap-2 px-4 py-3 text-[13px] text-emerald-700">
                  <CheckCircle2 size={15} />
                  {tt('이상 없음 — 모든 VPC에 S3/DynamoDB Gateway 엔드포인트 있음')}
                </div>
              ) : (
                <>
                  <div className="px-4 pt-3 text-[12px] text-ink-500">
                    {tt('S3/DynamoDB Gateway 엔드포인트가 없는 VPC는 해당 트래픽이 NAT를 경유해 데이터 처리 비용이 발생할 수 있습니다 (Gateway 엔드포인트는 무료)')}
                  </div>
                  <div className="overflow-x-auto pb-2">
                    <table className="w-full">
                      <thead><tr className="border-b border-ink-100">
                        <th className={TH}>VPC</th>
                        <th className={TH}>{tt('리전')}</th>
                        <th className={TH}>{tt('누락 서비스')}</th>
                      </tr></thead>
                      <tbody>
                        {gaps.map((g) => (
                          <tr key={`${g.vpcId}|${g.region}`} className="border-b border-ink-50 last:border-0">
                            <td className={MONO}>{g.vpcId}</td>
                            <td className={TD}>{g.region}</td>
                            <td className={TD}>
                              <span className="inline-flex flex-wrap gap-1">
                                {g.missing.map((s) => (
                                  <Badge key={s} tone="negative" variant="outline" mono>{s}</Badge>
                                ))}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </Card>

            {/* ⑤ 메인 인벤토리 — 정렬/검색/facet은 MetricTable 내장, 행 클릭 → 상세 패널 */}
            <Card
              title="VPC Endpoint 인벤토리"
              subtitle="행 클릭 → 트래픽·보안·네트워크 상세"
              padded={false}
            >
              <MetricTable
                columns={columns}
                items={rows}
                rowKey={(r) => r.id}
                emptyText="엔드포인트 없음"
                onRowClick={setSelected}
              />
            </Card>
          </>
        )}
      </div>

      <DetailPanel
        title={selected?.id}
        data={selected ? vpceDetail(selected) : null}
        spec={VPCE_DETAIL_SPEC}
        onClose={() => setSelected(null)}
      />
    </>
  );
}
