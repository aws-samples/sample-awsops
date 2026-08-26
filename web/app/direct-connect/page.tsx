'use client';
import { useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, Cable, CheckCircle2, Gauge, Network, Unplug, Waypoints, XCircle } from 'lucide-react';
import PageHeader from '@/components/ui/PageHeader';
import Card from '@/components/ui/Card';
import StatTile from '@/components/ui/StatTile';
import Badge from '@/components/ui/Badge';
import DetailPanel from '@/components/ui/DetailPanel';
import MetricTable, { type MetricCol } from '@/components/inventory/metrics/MetricTable';
import { RangePicker, TH, MONO, TD, DANGER, dash } from '@/components/inventory/metrics/shared';
import DonutBreakdown from '@/components/charts/DonutBreakdown';
import DxTopology from '@/components/dx/DxTopology';
import HBarList from '@/components/charts/HBarList';
import { useI18n } from '@/components/shell/LanguageProvider';
import type { DxAnalysis, DxConnectionRow, DxVifRow, DxGatewayRow, DxRoute } from '@/lib/dx';
import { assessResiliency, type DxSlaTier, type DxResiliency, type DxNoneReason } from '@/lib/dx-topology';
import type { InvType } from '@/lib/inventory-types';

// /direct-connect — Direct Connect 리스트+분석 (Network 메뉴). 커넥션/VIF를 리전 fan-out으로
// 수집하고(DX Gateway는 글로벌 1회) AWS/DX 메트릭으로 **기간 내 다운 감지**(ConnectionState/
// BgpStatus 최소값)와 **피크 사용률**(VIF Bps 최대 ÷ 커넥션 대역폭)을 계산한다. 핵심 분석:
// 로케이션 이중화 — 전 커넥션이 단일 로케이션이면 위치 장애 = 전체 DX 경로 상실
// (AWS Resiliency Toolkit은 2개 이상 로케이션 권장). 데이터 계층은 lib/dx.ts(4분 TTL 캐시).

/** 사람 단위 bps 포맷 (십진 단위). null=메트릭 없음. */
function fmtBps(v: number | null): string | null {
  if (v == null) return null;
  if (v === 0) return '0 bps';
  const units = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];
  let n = v;
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return `${n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(1)} ${units[i]}`;
}

// 상세 패널을 인벤토리 상세와 같은 섹션 카드 디자인으로 렌더하기 위한 최소 spec
// (VPCE_DETAIL_SPEC 선례 — sections가 있어야 아이콘 있는 섹션 카드 포맷).
const CONN_DETAIL_SPEC: InvType = {
  label: 'DX Connection', group: 'Network', stateKey: 'state',
  columns: [
    { key: 'id', label: 'Connection ID' }, { key: 'name', label: 'Name' }, { key: 'state', label: 'State' },
    { key: 'region', label: 'Region' }, { key: 'location', label: 'Location' },
    { key: 'partner_name', label: 'Partner' }, { key: 'aws_device', label: 'AWS Device' },
    { key: 'bandwidth', label: 'Bandwidth' }, { key: 'vlan', label: 'VLAN' },
    { key: 'jumbo_frame_capable', label: 'Jumbo Frame' }, { key: 'lag_id', label: 'LAG' },
    { key: 'mac_sec_capable', label: 'MACsec Capable' }, { key: 'encryption_mode', label: 'Encryption Mode' },
    { key: 'port_encryption_status', label: 'Port Encryption' },
    { key: 'down_detected', label: 'Down Detected (range)' }, { key: 'vif_count', label: 'VIFs' },
    { key: 'has_logical_redundancy', label: 'Logical Redundancy' },
  ],
  sections: [
    { label: 'Identity', keys: ['id', 'name', 'state', 'region', 'location', 'partner_name', 'aws_device'] },
    { label: 'Capacity', keys: ['bandwidth', 'vlan', 'jumbo_frame_capable', 'lag_id'] },
    { label: 'Security', keys: ['mac_sec_capable', 'encryption_mode', 'port_encryption_status'] },
    { label: 'Health', keys: ['down_detected', 'vif_count', 'has_logical_redundancy'] },
  ],
};

const VIF_DETAIL_SPEC: InvType = {
  label: 'DX Virtual Interface', group: 'Network', stateKey: 'state',
  columns: [
    { key: 'id', label: 'VIF ID' }, { key: 'name', label: 'Name' }, { key: 'type', label: 'Type' },
    { key: 'state', label: 'State' }, { key: 'region', label: 'Region' },
    { key: 'connection_id', label: 'Connection' }, { key: 'vlan', label: 'VLAN' },
    { key: 'asn', label: 'Customer ASN' }, { key: 'amazon_side_asn', label: 'Amazon ASN' },
    { key: 'address_family', label: 'Address Family' }, { key: 'amazon_address', label: 'Amazon Address' },
    { key: 'customer_address', label: 'Customer Address' }, { key: 'bgp_peers', label: 'BGP Peers' },
    { key: 'bps_ingress', label: 'Avg In' }, { key: 'bps_egress', label: 'Avg Out' },
    { key: 'peak_bps_ingress', label: 'Peak In' }, { key: 'peak_bps_egress', label: 'Peak Out' },
    { key: 'pps_ingress', label: 'Avg Pps In' }, { key: 'pps_egress', label: 'Avg Pps Out' },
    { key: 'peak_utilization_pct', label: 'Peak Utilization %' },
    { key: 'bgp_down_detected', label: 'BGP Down Detected (range)' },
    { key: 'prefixes_accepted', label: 'BGP Prefixes Accepted' }, { key: 'prefixes_advertised', label: 'BGP Prefixes Advertised' },
    { key: 'routes_accepted', label: 'Accepted Routes' }, { key: 'routes_advertised', label: 'Advertised Routes' },
    { key: 'mtu', label: 'MTU' }, { key: 'jumbo_frame_capable', label: 'Jumbo Frame' },
    { key: 'site_link_enabled', label: 'SiteLink' }, { key: 'attached_to', label: 'Attached To' },
    { key: 'attachment_type', label: 'Attachment Type' },
  ],
  sections: [
    { label: 'Identity', keys: ['id', 'name', 'type', 'state', 'region', 'connection_id', 'vlan'] },
    { label: 'BGP', keys: ['asn', 'amazon_side_asn', 'address_family', 'amazon_address', 'customer_address', 'bgp_peers', 'prefixes_accepted', 'prefixes_advertised'] },
    { label: 'Routes', keys: ['routes_accepted', 'routes_advertised'] },
    { label: 'Traffic', keys: ['bps_ingress', 'bps_egress', 'peak_bps_ingress', 'peak_bps_egress', 'pps_ingress', 'pps_egress', 'peak_utilization_pct', 'bgp_down_detected'] },
    { label: 'Network', keys: ['mtu', 'jumbo_frame_capable', 'site_link_enabled', 'attached_to', 'attachment_type'] },
  ],
};

const GW_DETAIL_SPEC: InvType = {
  label: 'DX Gateway', group: 'Network', stateKey: 'state',
  columns: [
    { key: 'id', label: 'Gateway ID' }, { key: 'name', label: 'Name' }, { key: 'state', label: 'State' },
    { key: 'amazon_side_asn', label: 'Amazon ASN' }, { key: 'owner_account', label: 'Owner Account' },
    { key: 'associations', label: 'Associations' }, { key: 'vif_count', label: 'VIFs' },
  ],
  sections: [
    { label: 'Identity', keys: ['id', 'name', 'state', 'amazon_side_asn', 'owner_account'] },
    { label: 'Attachments', keys: ['associations', 'vif_count'] },
  ],
};

/** BGP 라우트 1건 → 상세 패널 표시 문자열 (idlist 행 렌더). */
function routeLine(r: DxRoute): string {
  return [r.cidr, r.family, r.asPath && `AS ${r.asPath}`, r.communities.length ? r.communities.join(',') : null]
    .filter(Boolean).join(' · ');
}
const nonEmpty = (a: string[]) => (a.length ? a : undefined);

/** 상세 패널용 flat 뷰 — 빈 필드는 제외. */
function connDetail(r: DxConnectionRow): Record<string, unknown> {
  const all: Record<string, unknown> = {
    id: r.id, name: r.name, state: r.state, region: r.region, location: r.location,
    partner_name: r.partnerName, aws_device: r.awsDevice,
    bandwidth: r.bandwidth, vlan: r.vlan, jumbo_frame_capable: r.jumboFrameCapable, lag_id: r.lagId,
    mac_sec_capable: r.macSecCapable, encryption_mode: r.encryptionMode, port_encryption_status: r.portEncryptionStatus,
    down_detected: r.stateMetricMin == null ? undefined : r.stateMetricMin === 0,
    vif_count: r.vifCount, has_logical_redundancy: r.hasLogicalRedundancy,
  };
  return Object.fromEntries(Object.entries(all).filter(([, v]) => v != null && v !== ''));
}

function vifDetail(r: DxVifRow): Record<string, unknown> {
  const all: Record<string, unknown> = {
    id: r.id, name: r.name, type: r.type, state: r.state, region: r.region,
    connection_id: r.connectionId, vlan: r.vlan,
    asn: r.asn, amazon_side_asn: r.amazonSideAsn, address_family: r.addressFamily,
    amazon_address: r.amazonAddress, customer_address: r.customerAddress,
    bgp_peers: r.bgpPeers.length ? r.bgpPeers : undefined,
    prefixes_accepted: r.prefixesAccepted, prefixes_advertised: r.prefixesAdvertised,
    routes_accepted: nonEmpty(r.routes.filter((x) => x.direction === 'accepted').map(routeLine)),
    routes_advertised: nonEmpty(r.routes.filter((x) => x.direction === 'advertised').map(routeLine)),
    bps_ingress: fmtBps(r.bpsIngress), bps_egress: fmtBps(r.bpsEgress),
    peak_bps_ingress: fmtBps(r.peakBpsIngress), peak_bps_egress: fmtBps(r.peakBpsEgress),
    pps_ingress: r.ppsIngress == null ? undefined : r.ppsIngress.toFixed(1),
    pps_egress: r.ppsEgress == null ? undefined : r.ppsEgress.toFixed(1),
    peak_utilization_pct: r.peakUtilizationPct == null ? undefined : `${r.peakUtilizationPct}%`,
    bgp_down_detected: r.bgpStatusMin == null ? undefined : r.bgpStatusMin === 0,
    mtu: r.mtu, jumbo_frame_capable: r.jumboFrameCapable, site_link_enabled: r.siteLinkEnabled,
    attached_to: r.attachedTo, attachment_type: r.attachmentType,
  };
  return Object.fromEntries(Object.entries(all).filter(([, v]) => v != null && v !== ''));
}

function gwDetail(r: DxGatewayRow): Record<string, unknown> {
  const all: Record<string, unknown> = {
    id: r.id, name: r.name, state: r.state, amazon_side_asn: r.amazonSideAsn, owner_account: r.ownerAccount,
    associations: r.associations.length
      ? r.associations.map((a) => `${a.id} ${a.type} ${a.state}${a.cidrs.length ? ` (${a.cidrs.join(', ')})` : ''}`)
      : undefined,
    vif_count: r.vifCount,
  };
  return Object.fromEntries(Object.entries(all).filter(([, v]) => v != null && v !== ''));
}

// SLA 티어 표시 — aws-samples/sample-network-resilience-agent의 resilience-engine 티어.
const TIER_LABEL: Record<DxSlaTier, string> = {
  maximum: '최대 복원력', high: '높은 복원력', single: '단일 연결', none: '커넥션 없음',
};
const TIER_TONE: Record<DxSlaTier, 'positive' | 'neutral' | 'negative'> = {
  maximum: 'positive', high: 'neutral', single: 'negative', none: 'negative',
};
// 리뷰(Codex stop-hook, 3라운드): tier==='none'은 서로 다른 라벨이 필요한 세 상황을
// 뭉뚱그린다 — assessResiliency()가 계산한 noneReason(단일 소스)으로 그대로 분기한다.
// 이전 두 라운드는 각각 hostedConnections(배포 상태 한정)·allConnectionsHosted(상태
// 무관이지만 이분법)라는 단일 축만 봐서, owned+호스티드가 혼재하는데 배포된 owned가
// 0개인 "혼재" 케이스를 매번 "커넥션 없음"으로 오분류했다 — noneReason이 그 세 번째
// 경우를 별도 값으로 이미 구분해 반환하므로 여기서 재조합할 필요가 없다.
const NONE_REASON_LABEL: Record<DxNoneReason, string> = {
  'no-connections': '커넥션 없음',
  'all-hosted': 'AWS SLA 해당 없음 (전량 호스티드)',
  'no-deployed-owned': 'AWS SLA 미확정 (배포된 owned 커넥션 없음)',
};
function tierLabel(r: DxResiliency): string {
  if (r.tier === 'none' && r.noneReason) return NONE_REASON_LABEL[r.noneReason];
  return TIER_LABEL[r.tier];
}

type Selected =
  | { kind: 'conn'; row: DxConnectionRow }
  | { kind: 'vif'; row: DxVifRow }
  | { kind: 'gw'; row: DxGatewayRow };

export default function DirectConnectPage() {
  const { tt } = useI18n();
  const [range, setRange] = useState(86400);
  const [data, setData] = useState<DxAnalysis | null>(null);
  const [err, setErr] = useState('');
  const [selected, setSelected] = useState<Selected | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/dx?range=${range}`)
      .then(async (r) => {
        const d = await r.json().catch(() => null);
        if (!r.ok) throw new Error(d?.message ?? `HTTP ${r.status}`);
        return d as DxAnalysis;
      })
      .then((d) => { if (alive) { setData(d); setErr(''); } })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [range]);

  const conns = useMemo(() => data?.connections ?? [], [data]);
  const vifs = useMemo(() => data?.vifs ?? [], [data]);
  const gws = useMemo(() => data?.gateways ?? [], [data]);
  const resiliency = useMemo(() => (data ? assessResiliency(data) : null), [data]);
  const locations = data?.locations ?? [];

  // 도넛: VIF 타입 분포 (transit/private/public).
  const vifTypeDist = useMemo(() => {
    const counts = new Map<string, number>();
    for (const v of vifs) counts.set(v.type, (counts.get(v.type) ?? 0) + 1);
    return [...counts.entries()].map(([name, value]) => ({ name, value }));
  }, [vifs]);

  // VIF별 평균 트래픽 — HBarList는 정수 표시라 Kbps 단위 사용 (1Mbps 미만도 0으로 뭉개지지 않게).
  const vifTraffic = useMemo(() =>
    vifs
      .filter((v) => v.bpsIngress != null || v.bpsEgress != null)
      .map((v) => ({
        vif: `${v.name} (${v.id})`,
        kbps: Math.round(((v.bpsIngress ?? 0) + (v.bpsEgress ?? 0)) / 1e3),
      }))
      .sort((a, b) => b.kbps - a.kbps)
      .slice(0, 10),
  [vifs]);

  // BGP 라우트 가시성 (ListVirtualInterfaceRoutes) — 전 VIF 라우트 평탄화.
  const routeRows = useMemo(() => vifs.flatMap((v) => v.routes), [vifs]);
  const routesUnavailable = useMemo(() => vifs.filter((v) => !v.routesAvailable).length, [vifs]);
  const routesTruncated = useMemo(() => vifs.some((v) => v.routesTruncated), [vifs]);
  const vifById = useMemo(() => new Map(vifs.map((v) => [v.id, v])), [vifs]);

  const connColumns = useMemo<MetricCol<DxConnectionRow>[]>(() => [
    {
      key: 'id', label: 'ID', mono: true,
      title: tt('상태 비정상 또는 기간 내 다운이 감지된 커넥션은 빨간색'),
      value: (r) => r.id,
      danger: (r) => r.down,
    },
    { key: 'name', label: 'Name', value: (r) => r.name },
    { key: 'state', label: 'State', facet: true, value: (r) => r.state },
    { key: 'location', label: 'Location', facet: true, value: (r) => r.location },
    { key: 'region', label: 'Region', facet: true, value: (r) => r.region },
    {
      key: 'bandwidth', label: tt('대역폭'), type: 'num',
      value: (r) => r.bandwidthBps,
      render: (r) => r.bandwidth,
    },
    { key: 'vlan', label: 'VLAN', type: 'num', value: (r) => r.vlan },
    { key: 'partner', label: 'Partner', facet: true, value: (r) => r.partnerName },
    {
      key: 'jumbo', label: 'Jumbo',
      value: (r) => (r.jumboFrameCapable ? 'yes' : 'no'),
    },
    {
      key: 'macsec', label: 'MACsec',
      title: tt('MACsec 지원 여부 (전용 1G 이상 포트만 해당)'),
      value: (r) => (r.macSecCapable ? 'yes' : 'no'),
    },
    {
      key: 'downRange', label: tt('기간 다운'),
      title: tt('CloudWatch ConnectionState 기간 내 최소값 — 0이면 기간 중 다운 발생'),
      value: (r) => (r.stateMetricMin == null ? null : r.stateMetricMin === 0 ? 'DOWN' : 'OK'),
      render: (r) => r.stateMetricMin == null
        ? dash
        : r.stateMetricMin === 0
          ? <Badge tone="negative" variant="soft">{tt('다운 감지')}</Badge>
          : 'OK',
      danger: (r) => r.stateMetricMin === 0,
    },
    { key: 'vifs', label: 'VIFs', type: 'num', value: (r) => r.vifCount },
  ], [tt]);

  const vifColumns = useMemo<MetricCol<DxVifRow>[]>(() => [
    {
      key: 'id', label: 'ID', mono: true,
      title: tt('상태 비정상, BGP 피어 다운 또는 기간 내 BGP 다운이 감지된 VIF는 빨간색'),
      value: (r) => r.id,
      danger: (r) => r.down,
    },
    { key: 'name', label: 'Name', value: (r) => r.name },
    { key: 'type', label: 'Type', facet: true, value: (r) => r.type },
    { key: 'state', label: 'State', facet: true, value: (r) => r.state },
    { key: 'conn', label: 'Connection', mono: true, facet: true, value: (r) => r.connectionId },
    { key: 'vlan', label: 'VLAN', type: 'num', value: (r) => r.vlan },
    {
      key: 'bgp', label: 'BGP',
      title: tt('BGP 피어 up/전체 — 다운 피어가 있으면 경로 상실 위험'),
      value: (r) => (r.bgpPeersTotal === 0 ? null : `${r.bgpPeersUp}/${r.bgpPeersTotal}`),
      render: (r) => r.bgpPeersTotal === 0
        ? dash
        : r.bgpPeersUp < r.bgpPeersTotal
          ? <Badge tone="negative" variant="soft">{`${r.bgpPeersUp}/${r.bgpPeersTotal} up`}</Badge>
          : `${r.bgpPeersUp}/${r.bgpPeersTotal} up`,
      danger: (r) => r.bgpPeersTotal > 0 && r.bgpPeersUp < r.bgpPeersTotal,
    },
    {
      key: 'in', label: tt('평균 수신'), type: 'num',
      title: tt('기간 내 VirtualInterfaceBpsIngress 평균'),
      value: (r) => r.bpsIngress,
      render: (r) => fmtBps(r.bpsIngress) ?? dash,
    },
    {
      key: 'out', label: tt('평균 송신'), type: 'num',
      title: tt('기간 내 VirtualInterfaceBpsEgress 평균'),
      value: (r) => r.bpsEgress,
      render: (r) => fmtBps(r.bpsEgress) ?? dash,
    },
    {
      key: 'ppsIn', label: tt('Pps 수신'), type: 'num',
      title: tt('기간 내 VirtualInterfacePpsIngress 평균 (packets/s)'),
      value: (r) => r.ppsIngress,
      render: (r) => (r.ppsIngress == null ? dash : r.ppsIngress.toFixed(1)),
    },
    {
      key: 'ppsOut', label: tt('Pps 송신'), type: 'num',
      title: tt('기간 내 VirtualInterfacePpsEgress 평균 (packets/s)'),
      value: (r) => r.ppsEgress,
      render: (r) => (r.ppsEgress == null ? dash : r.ppsEgress.toFixed(1)),
    },
    {
      key: 'util', label: tt('피크 사용률'), type: 'num',
      title: tt('VirtualInterfaceUtilization 메트릭(없으면 피크 bps ÷ 대역폭) — 80% 이상이면 증설 검토'),
      value: (r) => r.peakUtilizationPct,
      render: (r) => (r.peakUtilizationPct == null ? dash : `${r.peakUtilizationPct}%`),
      danger: (r) => (r.peakUtilizationPct ?? 0) >= 80,
    },
    {
      key: 'pfxAcc', label: tt('프리픽스 수신'), type: 'num',
      title: tt('BgpPrefixesAccepted 최신값 — 고객 라우터에서 수신한 BGP 프리픽스 수'),
      value: (r) => r.prefixesAccepted,
    },
    {
      key: 'pfxAdv', label: tt('프리픽스 광고'), type: 'num',
      title: tt('BgpPrefixesAdvertised 최신값 — 고객 라우터로 광고한 BGP 프리픽스 수'),
      value: (r) => r.prefixesAdvertised,
    },
    { key: 'mtu', label: 'MTU', type: 'num', value: (r) => r.mtu },
    { key: 'gw', label: 'Gateway', mono: true, value: (r) => r.attachedTo },
  ], [tt]);

  const routeColumns = useMemo<MetricCol<DxRoute>[]>(() => [
    { key: 'vif', label: 'VIF', mono: true, facet: true, value: (r) => r.vifId },
    {
      key: 'dir', label: tt('방향'), facet: true,
      title: tt('accepted=고객 라우터에서 수신 · advertised=고객 라우터로 광고'),
      value: (r) => (r.direction === 'accepted' ? 'accepted' : 'advertised'),
      render: (r) => r.direction === 'accepted'
        ? <Badge variant="soft">{tt('수신')}</Badge>
        : <Badge variant="outline">{tt('광고')}</Badge>,
    },
    { key: 'cidr', label: 'Prefix', mono: true, value: (r) => r.cidr },
    { key: 'family', label: 'Family', facet: true, value: (r) => r.family },
    { key: 'aspath', label: 'AS Path', mono: true, value: (r) => r.asPath || null },
    {
      key: 'comm', label: 'Communities', mono: true,
      value: (r) => (r.communities.length ? r.communities.join(', ') : null),
    },
    {
      key: 'installed', label: tt('설치 시각'), type: 'num',
      value: (r) => (r.installedAt ? Date.parse(r.installedAt) : null),
      render: (r) => (r.installedAt ? r.installedAt.replace('T', ' ').slice(0, 19) : dash),
    },
  ], [tt]);

  const gwColumns = useMemo<MetricCol<DxGatewayRow>[]>(() => [
    {
      key: 'id', label: 'ID', mono: true,
      title: tt('연결(association)이 하나도 없는 게이트웨이는 빨간색'),
      value: (r) => r.id,
      danger: (r) => r.unassociated,
    },
    { key: 'name', label: 'Name', value: (r) => r.name },
    { key: 'state', label: 'State', facet: true, value: (r) => r.state },
    { key: 'asn', label: 'Amazon ASN', type: 'num', value: (r) => r.amazonSideAsn },
    {
      key: 'assoc', label: tt('연결 대상'),
      value: (r) => (r.associations.length ? r.associations.map((a) => a.id).join(' ') : null),
      render: (r) => r.associations.length === 0
        ? <Badge tone="negative" variant="soft">{tt('미연결')}</Badge>
        : (
          <span className="inline-flex flex-wrap gap-1">
            {r.associations.map((a) => (
              <Badge key={a.id} variant="outline" mono>{`${a.type === 'transitGateway' ? 'TGW' : a.type === 'virtualPrivateGateway' ? 'VGW' : a.type} ${a.id}`}</Badge>
            ))}
          </span>
        ),
      danger: (r) => r.unassociated,
    },
    { key: 'vifs', label: 'VIFs', type: 'num', value: (r) => r.vifCount },
  ], [tt]);

  const t = data?.totals;

  return (
    <>
      <PageHeader
        title="Direct Connect"
        subtitle="커넥션·VIF·DX Gateway 인벤토리 + AWS/DX 메트릭 기반 다운 감지·피크 사용률·로케이션 이중화 분석"
        right={<RangePicker value={range} onChange={setRange} />}
      />
      <div className="px-4 lg:px-8 py-8 flex flex-col gap-6">
        {err && (
          <div className="text-[13px] text-rose-600">{tt('Direct Connect 조회 실패')}: {err}</div>
        )}
        {!data && !err && <div className="text-ink-400">{tt('로딩 중…')}</div>}

        {data && t && (
          <>
            {/* ① KPI — 다운(danger) + 단일 로케이션/미연결 DXGW(warn) + 피크 사용률 */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
              <StatTile
                label="커넥션"
                value={t.connections}
                hint={`${tt('로케이션')} ${t.locations}`}
                icon={<Cable size={16} />}
              />
              <StatTile
                label="가상 인터페이스"
                value={t.vifs}
                hint={`BGP down ${t.bgpPeersDown}`}
                variant={t.vifsDown > 0 ? 'danger' : 'default'}
                icon={<Network size={16} />}
              />
              <StatTile
                label="DX Gateway"
                value={t.gateways}
                hint={`${tt('미연결')} ${t.gatewaysUnassociated}`}
                variant={t.gatewaysUnassociated > 0 ? 'warn' : 'default'}
                icon={<Waypoints size={16} />}
              />
              <StatTile
                label="총 대역폭"
                value={fmtBps(t.totalBandwidthBps) ?? '—'}
                hint="커넥션 대역폭 합계"
                icon={<Gauge size={16} />}
              />
              <StatTile
                label="다운 감지"
                value={t.connectionsDown + t.vifsDown}
                variant={t.connectionsDown + t.vifsDown > 0 ? 'danger' : 'default'}
                hint={`${tt('커넥션')} ${t.connectionsDown} · VIF ${t.vifsDown}`}
                icon={<Unplug size={16} />}
              />
              <StatTile
                label="피크 사용률"
                value={t.maxUtilizationPct == null ? '—' : `${t.maxUtilizationPct}%`}
                variant={(t.maxUtilizationPct ?? 0) >= 80 ? 'danger' : 'default'}
                hint="기간 내 피크 bps ÷ 대역폭"
                icon={<Activity size={16} />}
              />
            </div>

            {/* ② 분포 — VIF 타입 도넛 + VIF별 평균 트래픽 */}
            <div className="grid gap-6 lg:grid-cols-2">
              <DonutBreakdown title="VIF 타입 분포" data={vifTypeDist} nameKey="name" valueKey="value" />
              <HBarList title="VIF별 평균 트래픽 (Kbps)" data={vifTraffic} labelKey="vif" valueKey="kbps" highlightMax />
            </div>

            {/* ②-b 구성도 + 복원력 평가 — aws-samples/sample-network-resilience-agent 참조:
                온프레미스 → 로케이션 → 커넥션/LAG → VIF → DXGW → TGW/VGW 계층 그래프 + SLA 티어 */}
            <div className="grid gap-6 lg:grid-cols-3">
              <Card
                title="구성도"
                subtitle="온프레미스 → 로케이션 → 커넥션/LAG → VIF → DX Gateway → TGW/VGW — 노드 클릭 → 상세"
                padded={false}
                className="lg:col-span-2"
              >
                <DxTopology
                  data={data}
                  onNodeSelect={(n) => {
                    if (n.kind === 'connection') setSelected({ kind: 'conn', row: n.row as DxConnectionRow });
                    else if (n.kind === 'vif') setSelected({ kind: 'vif', row: n.row as DxVifRow });
                    else if (n.kind === 'dxgw') setSelected({ kind: 'gw', row: n.row as DxGatewayRow });
                  }}
                />
              </Card>
              <Card
                title="복원력 평가"
                subtitle="AWS Direct Connect SLA 티어 — 로케이션·커넥션 이중화 기준"
                padded={false}
              >
                {resiliency && (
                  <>
                    <div className="flex flex-wrap items-center gap-2 px-4 py-3">
                      <Badge tone={TIER_TONE[resiliency.tier]} variant="soft">{tt(tierLabel(resiliency))}</Badge>
                      {resiliency.slaPct && <span className="text-[13px] font-semibold">SLA {resiliency.slaPct}</span>}
                      <span className="text-[12px] text-ink-500">
                        {tt('로케이션')} {resiliency.locations} · {tt('디바이스 2개 이상 로케이션')} {resiliency.dualConnLocations}
                      </span>
                    </div>
                    {resiliency.hostedConnections > 0 && (
                      <div className="px-4 pb-2 text-[12px] text-ink-500">
                        {tt('호스티드 커넥션은 AWS Direct Connect SLA 적용 제외 — 파트너 SLA를 확인하세요')} ({resiliency.hostedConnections})
                      </div>
                    )}
                    <ul className="border-t border-ink-100">
                      {resiliency.checks.map((c) => (
                        <li key={c.label} className="flex items-start gap-2 border-b border-ink-50 px-4 py-2 text-[12.5px] last:border-0">
                          {c.ok
                            ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-600" />
                            : c.severity === 'critical'
                              ? <XCircle size={14} className="mt-0.5 shrink-0 text-rose-600" />
                              : <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-500" />}
                          <span className={c.ok ? 'text-ink-600' : c.severity === 'critical' ? 'text-rose-700' : 'text-amber-700'}>
                            {tt(c.label)}
                            {c.detail && <span className="ml-1 text-ink-400">({c.detail})</span>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </Card>
            </div>

            {/* ③ 로케이션 이중화 — 전 커넥션 단일 로케이션 = 위치 장애 시 전체 DX 경로 상실 */}
            <Card
              title="로케이션 이중화"
              subtitle="Direct Connect 로케이션별 커넥션 분포 — 위치 단일 장애점 분석"
              padded={false}
            >
              {t.singleLocation ? (
                <div className="px-4 pt-3 text-[12px] text-warning-text">
                  {tt('모든 커넥션이 단일 로케이션에 있습니다 — 이 로케이션 장애 시 전체 DX 경로가 끊깁니다. AWS Resiliency Toolkit은 2개 이상 로케이션을 권장합니다')}
                </div>
              ) : t.connections > 0 ? (
                <div className="flex items-center gap-2 px-4 py-3 text-[13px] text-emerald-700">
                  <CheckCircle2 size={15} />
                  {tt('이상 없음 — 커넥션이 2개 이상 로케이션에 분산되어 있습니다')}
                </div>
              ) : (
                <div className="px-4 py-3 text-[13px] text-ink-400">{tt('커넥션 없음')}</div>
              )}
              {locations.length > 0 && (
                <div className="overflow-x-auto pb-2">
                  <table className="w-full">
                    <thead><tr className="border-b border-ink-100">
                      <th className={TH}>Location</th>
                      <th className={TH}>{tt('리전')}</th>
                      <th className={TH}>{tt('커넥션')}</th>
                      <th className={TH}>{tt('대역폭 합계')}</th>
                    </tr></thead>
                    <tbody>
                      {locations.map((l) => (
                        <tr key={`${l.location}|${l.region}`} className="border-b border-ink-50 last:border-0">
                          <td className={MONO}>{l.location}</td>
                          <td className={TD}>{l.region}</td>
                          <td className={TD}>{l.connections}</td>
                          <td className={TD}>{fmtBps(l.bandwidthBps) ?? dash}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            {/* ④ 커넥션 — 정렬/검색/facet은 MetricTable 내장, 행 클릭 → 상세 */}
            <Card
              title="커넥션"
              subtitle="행 클릭 → 용량·보안·상태 상세"
              padded={false}
            >
              <MetricTable
                columns={connColumns}
                items={conns}
                rowKey={(r) => r.id}
                emptyText="커넥션 없음"
                onRowClick={(r) => setSelected({ kind: 'conn', row: r })}
              />
            </Card>

            {/* ⑤ VIF — BGP 상태 + 트래픽/사용률 */}
            <Card
              title="가상 인터페이스 (VIF)"
              subtitle="행 클릭 → BGP·트래픽 상세"
              padded={false}
            >
              <MetricTable
                columns={vifColumns}
                items={vifs}
                rowKey={(r) => r.id}
                emptyText="VIF 없음"
                onRowClick={(r) => setSelected({ kind: 'vif', row: r })}
              />
            </Card>

            {/* ⑥ BGP 라우트 가시성 — ListVirtualInterfaceRoutes (2026-07 신기능):
                accepted=고객 라우터에서 수신한 경로, advertised=AWS가 광고한 경로 */}
            <Card
              title="BGP 라우트 가시성"
              subtitle="VIF별 수신(accepted)·광고(advertised) BGP 라우트 — AS 경로·커뮤니티·설치 시각"
              padded={false}
            >
              {(routesUnavailable > 0 || routesTruncated) && (
                <div className="px-4 pt-3 text-[12px] text-ink-500">
                  {routesUnavailable > 0 && <span>{tt('일부 VIF에서 라우트 조회 불가 (ListVirtualInterfaceRoutes 미지원 리전 또는 권한)')} ({routesUnavailable}) </span>}
                  {routesTruncated && <span>{tt('VIF당 200건까지만 표시')}</span>}
                </div>
              )}
              <MetricTable
                columns={routeColumns}
                items={routeRows}
                rowKey={(r) => `${r.vifId}|${r.direction}|${r.family}|${r.cidr}|${r.asPath}`}
                emptyText="BGP 라우트 없음"
                onRowClick={(r) => {
                  const v = vifById.get(r.vifId);
                  if (v) setSelected({ kind: 'vif', row: v });
                }}
              />
            </Card>

            {/* ⑦ DX Gateway — TGW/VGW 연결(association) 현황 */}
            <Card
              title="DX Gateway"
              subtitle="행 클릭 → 연결(association) 상세"
              padded={false}
            >
              <MetricTable
                columns={gwColumns}
                items={gws}
                rowKey={(r) => r.id}
                emptyText="DX Gateway 없음"
                onRowClick={(r) => setSelected({ kind: 'gw', row: r })}
              />
            </Card>
          </>
        )}
      </div>

      <DetailPanel
        title={selected?.row.id}
        data={selected
          ? selected.kind === 'conn'
            ? connDetail(selected.row)
            : selected.kind === 'vif'
              ? vifDetail(selected.row)
              : gwDetail(selected.row)
          : null}
        spec={selected?.kind === 'conn' ? CONN_DETAIL_SPEC : selected?.kind === 'vif' ? VIF_DETAIL_SPEC : GW_DETAIL_SPEC}
        onClose={() => setSelected(null)}
      />
    </>
  );
}
