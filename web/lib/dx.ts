import {
  DirectConnectClient,
  DescribeConnectionsCommand,
  DescribeVirtualInterfacesCommand,
  DescribeDirectConnectGatewaysCommand,
  DescribeDirectConnectGatewayAssociationsCommand,
  DescribeLagsCommand,
  ListVirtualInterfaceRoutesCommand,
} from '@aws-sdk/client-direct-connect';
import { CloudWatchClient, ListMetricsCommand, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { getPool } from './db';

// Direct Connect 리스트 + 분석 (Network 메뉴): 커넥션/VIF는 리전 리소스라 인벤토리 VPC 리전으로
// fan-out하고(리전별 degrade), DX Gateway는 **글로벌 리소스**라 홈 리전에서 1회만 조회한다.
// AWS/DX 메트릭으로 기간 내 다운 감지(ConnectionState/BgpStatus 최소값)와 VIF 트래픽·피크
// 사용률(BpsIngress/Egress vs 커넥션 대역폭)을 계산 — 호스티드(<1G) 커넥션은 커넥션 레벨
// Bps 메트릭이 없어 **VIF 레벨만** 발행된다(실측). 추가 분석: 로케이션 이중화(전 커넥션이
// 단일 로케이션이면 위치 장애 = 전체 DX 경로 상실 — Resiliency Toolkit은 2+ 로케이션 권장),
// 미연결 DX Gateway.
// 주의: describe-virtual-interfaces 응답의 authKey/customerRouterConfig(BGP 인증키 포함)는
// 민감정보 — row에 절대 싣지 않는다(필드 명시 구성).

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const dcClients = new Map<string, DirectConnectClient>();
const dc = (r: string) => {
  let c = dcClients.get(r);
  if (!c) { c = new DirectConnectClient({ region: r }); dcClients.set(r, c); }
  return c;
};
const cwClients = new Map<string, CloudWatchClient>();
const cw = (r: string) => {
  let c = cwClients.get(r);
  if (!c) { c = new CloudWatchClient({ region: r }); cwClients.set(r, c); }
  return c;
};

const TTL_MS = 4 * 60_000;
const cache = new Map<string, { at: number; v: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v as T;
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = fn().then((v) => { cache.set(key, { at: Date.now(), v }); return v; }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
export function _resetDxCacheForTests() { cache.clear(); inflight.clear(); dcClients.clear(); cwClients.clear(); }

export interface DxConnectionRow {
  id: string; name: string; state: string; region: string; location: string;
  bandwidth: string;
  /** '50Mbps'/'1Gbps' → bps 숫자 (사용률 분모). 파싱 불가 시 0. */
  bandwidthBps: number;
  vlan: number | null;
  partnerName: string | null; awsDevice: string | null;
  jumboFrameCapable: boolean; macSecCapable: boolean;
  encryptionMode: string | null; portEncryptionStatus: string | null;
  hasLogicalRedundancy: string | null; lagId: string | null;
  vifCount: number;
  /** CW ConnectionState 기간 내 최소값 (1=계속 up, 0=다운 감지, null=메트릭 없음). */
  stateMetricMin: number | null;
  /** API 상태 비정상 또는 기간 내 ConnectionState 0 감지. */
  down: boolean;
}

/** BGP 라우트 1건 (ListVirtualInterfaceRoutes — 2026-07 BGP 가시성 기능). */
export interface DxRoute {
  vifId: string;
  cidr: string;
  /** accepted=고객 라우터에서 수신, advertised=고객 라우터로 광고. */
  direction: 'accepted' | 'advertised';
  family: string;
  /** AS 경로 평탄화 표시 (예: '65011 65001'; seq 외 타입은 접두사 표기). */
  asPath: string;
  communities: string[];
  installedAt: string | null;
}

export interface DxVifRow {
  id: string; name: string; type: string; state: string; region: string;
  connectionId: string; vlan: number | null; mtu: number | null; jumboFrameCapable: boolean;
  asn: number | null; amazonSideAsn: number | null; addressFamily: string | null;
  amazonAddress: string | null; customerAddress: string | null;
  /** 연결 대상: DX Gateway 또는 VGW id (미연결 = null). */
  attachedTo: string | null;
  attachmentType: 'dx-gateway' | 'virtual-gateway' | null;
  siteLinkEnabled: boolean;
  /** BGP 피어 상태 목록 — 민감 필드(authKey) 제거, 표시용 문자열. */
  bgpPeers: string[];
  bgpPeersUp: number; bgpPeersTotal: number;
  /** AWS/DX VirtualInterfaceBps* — 기간 평균/최대 (null=메트릭 없음). */
  bpsIngress: number | null; bpsEgress: number | null;
  peakBpsIngress: number | null; peakBpsEgress: number | null;
  /** AWS/DX VirtualInterfacePps* 기간 평균 (packets/s). */
  ppsIngress: number | null; ppsEgress: number | null;
  /** 피크 사용률 % — VirtualInterfaceUtilization* 메트릭(퍼센트 발행, 실측 검증) 우선,
   *  없으면 피크 bps ÷ 커넥션 대역폭으로 산출 (null=둘 다 불가). */
  peakUtilizationPct: number | null;
  /** CW VirtualInterfaceBgpStatus 기간 내 최소값 (0=기간 내 BGP 다운 감지). */
  bgpStatusMin: number | null;
  /** CW BgpPrefixes{Accepted,Advertised} 최신값 (패밀리 합산, null=메트릭 없음). */
  prefixesAccepted: number | null; prefixesAdvertised: number | null;
  /** BGP 라우트 (accepted+advertised, VIF당 200건 캡). */
  routes: DxRoute[];
  routesTruncated: boolean;
  /** ListVirtualInterfaceRoutes 실패(미지원 리전 등) 시 false — 라우트만 정직 강등. */
  routesAvailable: boolean;
  /** API 상태 비정상, BGP 피어 다운, 또는 기간 내 BgpStatus 0 감지. */
  down: boolean;
}

export interface DxGatewayRow {
  id: string; name: string; state: string;
  amazonSideAsn: number | null; ownerAccount: string | null;
  /** 연결(association) 대상 — TGW/VGW id + 상태 + 허용 프리픽스. */
  associations: { id: string; type: string; state: string; region: string | null; cidrs: string[] }[];
  vifCount: number;
  /** association 조회 실패 시 false — routesAvailable 패턴 미러링. false 면 unassociated 는
   *  판정 불가라 false 로 남고(위험 발명 금지), 집계에서도 제외된다. */
  associationsAvailable: boolean;
  /** association 0건 — 어느 게이트웨이에도 연결 안 된 DXGW. associationsAvailable 전제. */
  unassociated: boolean;
}

export interface DxAnalysis {
  connections: DxConnectionRow[];
  vifs: DxVifRow[];
  gateways: DxGatewayRow[];
  /** 로케이션별 커넥션 집계 (이중화 분석용). */
  locations: { location: string; region: string; connections: number; bandwidthBps: number }[];
  /** 리소스 목록(Describe*) 자체가 실패해 그 리전의 커넥션/VIF가 전부 빠진 리전 —
   *  singleLocation·다운 카운트·총 대역폭이 실제보다 낙관적일 수 있다(누락된 리전에
   *  이중화용 두 번째 로케이션이나 다운 리소스가 있었을 수 있음). UI가 반드시 경고해야 함. */
  degradedRegions: string[];
  /** 리소스 목록은 받았지만 CloudWatch 메트릭 호출이 실패한 리전 — 그 리전 커넥션/VIF의
   *  다운 감지는 API 현재 상태로만 강등되고, 기간 내 과거 다운/사용률은 놓칠 수 있다. */
  metricsDegradedRegions: string[];
  /** DX Gateway(글로벌) 조회 자체가 실패 — gatewaysUnassociated/vifCount 등이 0으로 강등됨. */
  gatewaysDegraded: boolean;
  totals: {
    connections: number; connectionsDown: number;
    vifs: number; vifsDown: number; bgpPeersDown: number;
    gateways: number; gatewaysUnassociated: number;
    /** association 조회 실패로 미할당 여부를 판정할 수 없는 게이트웨이 수 — >0 이면
     *  gatewaysUnassociated 는 하한(실제보다 적을 수 있음)이다. UI 타일/배너가 노출. */
    gatewaysAssociationsUnknown: number;
    totalBandwidthBps: number; locations: number;
    /** VIF 피크 사용률 최댓값 (%). */
    maxUtilizationPct: number | null;
    /** 커넥션이 있는데 로케이션이 1곳뿐 — 위치 단일 장애점. */
    singleLocation: boolean;
  };
  rangeSec: number;
}

/** '50Mbps' | '1Gbps' | '10Gbps' → bps. 파싱 불가 → 0. */
export function parseBandwidth(bw?: string): number {
  const m = /^([\d.]+)\s*([MG])bps$/i.exec(bw ?? '');
  if (!m) return 0;
  return Math.round(Number(m[1]) * (m[2].toUpperCase() === 'G' ? 1e9 : 1e6));
}

async function regionsFromInventory(): Promise<string[]> {
  try {
    const r = await getPool().query<{ region: string }>(
      `SELECT DISTINCT region FROM inventory_resources WHERE resource_type = 'vpc' AND region IS NOT NULL`);
    const set = new Set(r.rows.map((x) => x.region));
    set.add(REGION);
    return [...set];
  } catch { return [REGION]; }
}

// ---- raw API shapes (필요 필드만 — 민감 필드는 의도적으로 미선언) ----
interface RawConn {
  connectionId?: string; connectionName?: string; connectionState?: string; region?: string;
  location?: string; bandwidth?: string; vlan?: number; partnerName?: string;
  awsDeviceV2?: string; jumboFrameCapable?: boolean; macSecCapable?: boolean;
  encryptionMode?: string; portEncryptionStatus?: string; hasLogicalRedundancy?: string; lagId?: string;
}
interface RawPeer { bgpPeerId?: string; addressFamily?: string; bgpPeerState?: string; bgpStatus?: string }
interface RawVif {
  virtualInterfaceId?: string; virtualInterfaceName?: string; virtualInterfaceType?: string;
  virtualInterfaceState?: string; region?: string; connectionId?: string; vlan?: number; mtu?: number;
  jumboFrameCapable?: boolean; asn?: number; amazonSideAsn?: number; addressFamily?: string;
  amazonAddress?: string; customerAddress?: string; directConnectGatewayId?: string;
  virtualGatewayId?: string; siteLinkEnabled?: boolean; bgpPeers?: RawPeer[];
}
interface RawGw { directConnectGatewayId?: string; directConnectGatewayName?: string; directConnectGatewayState?: string; amazonSideAsn?: number; ownerAccount?: string }
interface RawAssoc {
  associationState?: string;
  associatedGateway?: { id?: string; type?: string; region?: string };
  allowedPrefixesToDirectConnectGateway?: { cidr?: string }[];
}

interface VifMetricRec {
  bpsInAvg: number | null; bpsOutAvg: number | null; bpsInMax: number | null; bpsOutMax: number | null;
  ppsInAvg: number | null; ppsOutAvg: number | null; utilInMax: number | null; utilOutMax: number | null;
}
interface RegionMetrics {
  /** connectionId → ConnectionState 기간 최소값. */
  connState: Record<string, number | null>;
  /** vifId → Bps/Pps/Utilization 집계. */
  vif: Record<string, VifMetricRec>;
  /** vifId → BgpStatus 기간 최소값 (IPv4/IPv6 튜플 중 최소). */
  bgpMin: Record<string, number | null>;
  /** vifId → BgpPrefixes{Accepted,Advertised} 최신값 (패밀리 합산). */
  pfxAcc: Record<string, number | null>;
  pfxAdv: Record<string, number | null>;
  /** false = CloudWatch 호출 자체가 실패해 이 리전은 메트릭 없이(null) 나감 — 기간 내
   *  다운 감지는 API 현재 상태로만 강등되어 과거 다운을 놓칠 수 있다. 호출자가 노출. */
  ok: boolean;
}

// Utilization*은 퍼센트로 발행 (실측: bps 1,672 ÷ 50Mbps = 0.0033% ↔ 메트릭 0.00334 일치).
const VIF_METRICS = [
  { key: 'bpsInAvg', name: 'VirtualInterfaceBpsIngress', stat: 'Average' },
  { key: 'bpsOutAvg', name: 'VirtualInterfaceBpsEgress', stat: 'Average' },
  { key: 'bpsInMax', name: 'VirtualInterfaceBpsIngress', stat: 'Maximum' },
  { key: 'bpsOutMax', name: 'VirtualInterfaceBpsEgress', stat: 'Maximum' },
  { key: 'ppsInAvg', name: 'VirtualInterfacePpsIngress', stat: 'Average' },
  { key: 'ppsOutAvg', name: 'VirtualInterfacePpsEgress', stat: 'Average' },
  { key: 'utilInMax', name: 'VirtualInterfaceUtilizationIngress', stat: 'Maximum' },
  { key: 'utilOutMax', name: 'VirtualInterfaceUtilizationEgress', stat: 'Maximum' },
] as const;

const EMPTY_VIF_REC: VifMetricRec = {
  bpsInAvg: null, bpsOutAvg: null, bpsInMax: null, bpsOutMax: null,
  ppsInAvg: null, ppsOutAvg: null, utilInMax: null, utilOutMax: null,
};

// BGP 프리픽스 카운트 (2026-07 BGP 가시성 계열 메트릭) — BgpStatus와 같은 3-dim 튜플.
const BGP_PFX_METRICS = [
  { key: 'pfxAcc', name: 'VirtualInterfaceBgpPrefixesAccepted' },
  { key: 'pfxAdv', name: 'VirtualInterfaceBgpPrefixesAdvertised' },
] as const;

/** AWS/DX 메트릭 일괄 조회 — ConnectionState(커넥션 차원 직접 구성) + VIF Bps/Pps/Utilization 8종 +
 *  BgpStatus·BgpPrefixes(IpAddressFamily 3-dim 튜플은 ListMetrics로 발견 — MSK lag 패턴).
 *  GetMetricData는 호출당 500쿼리 한도 — 500 단위 청크로 분할 호출. */
async function dxMetrics(
  region: string, rangeSec: number,
  conns: { id: string }[], vifs: { id: string; connectionId: string; families: Set<string> }[],
): Promise<RegionMetrics> {
  const out: RegionMetrics = { connState: {}, vif: {}, bgpMin: {}, pfxAcc: {}, pfxAdv: {}, ok: true };
  const connIds = conns.map((c) => c.id).slice(0, 100);
  const vifList = vifs.slice(0, 100);
  // 캡이 실제로 물면 잘린 커넥션/VIF 의 connState/bgpMin/pfx* 가 조용히 null 강등된다 —
  // 새 degrade 계약(metricsDegradedRegions)이 정상이라고 보증한 채로. 무신호 금지 (리뷰 MAJOR:
  // 캡은 API 제약이 아니라 우리 상한이므로, 무는 순간만 degrade 로 표기).
  if (conns.length > connIds.length || vifs.length > vifList.length) out.ok = false;
  try {
    const queries: { Id: string; ReturnData: boolean; MetricStat: { Metric: { Namespace: string; MetricName: string; Dimensions: { Name: string; Value: string }[] }; Period: number; Stat: string } }[] = [];
    connIds.forEach((id, i) => {
      queries.push({
        Id: `cs_i${i}`, ReturnData: true,
        MetricStat: {
          Metric: { Namespace: 'AWS/DX', MetricName: 'ConnectionState', Dimensions: [{ Name: 'ConnectionId', Value: id }] },
          Period: rangeSec, Stat: 'Minimum',
        },
      });
    });
    vifList.forEach((v, i) => {
      for (const m of VIF_METRICS) {
        queries.push({
          Id: `${m.key.toLowerCase()}_i${i}`, ReturnData: true,
          MetricStat: {
            Metric: {
              Namespace: 'AWS/DX', MetricName: m.name,
              Dimensions: [{ Name: 'ConnectionId', Value: v.connectionId }, { Name: 'VirtualInterfaceId', Value: v.id }],
            },
            Period: rangeSec, Stat: m.stat,
          },
        });
      }
    });

    // BgpStatus는 IpAddressFamily 차원이 추가된 3-dim 튜플 — 발견 후 그대로 질의.
    // 단 **VIF에 실제 구성된 피어 패밀리만** 채택: 미구성 패밀리(예: IPv4 전용 VIF의 IPv6)도
    // 메트릭이 상시 0으로 발행되어(실측) 무차별 최소값이면 영구 다운 오탐이 된다.
    const bgpTuples: { vifId: string; dims: { Name: string; Value: string }[] }[] = [];
    try {
      // NextToken 순회 — 응답은 페이지당 500 metric 캡이라 미순회면 튜플이 조용히 누락돼
      // ok=true 인 채 bgpMin null 강등 (리뷰 MAJOR L2-1과 같은 클래스).
      let nextToken: string | undefined;
      do {
        const lm = await cw(region).send(new ListMetricsCommand({ Namespace: 'AWS/DX', MetricName: 'VirtualInterfaceBgpStatus', NextToken: nextToken }));
        for (const m of lm.Metrics ?? []) {
          const vifId = m.Dimensions?.find((d) => d.Name === 'VirtualInterfaceId')?.Value;
          const fam = (m.Dimensions?.find((d) => d.Name === 'IpAddressFamily')?.Value ?? '').toLowerCase();
          const vif = vifId ? vifList.find((v) => v.id === vifId) : undefined;
          if (vif && (vif.families.size === 0 || vif.families.has(fam))) {
            bgpTuples.push({ vifId: vif.id, dims: (m.Dimensions ?? []).map((d) => ({ Name: d.Name ?? '', Value: d.Value ?? '' })) });
          }
        }
        nextToken = lm.NextToken;
      } while (nextToken);
    } catch {
      // BGP 튜플 발견(ListMetrics)만 실패 — GetMetricData 가 성공해도 이 리전 전체 VIF 의
      // bgpMin/pfx* 가 null 로 강등된다. ok JSDoc 이 문서화한 바로 그 상황(기간 내 과거 다운
      // 누락)이므로 무신호로 두지 않고 리전을 metricsDegraded 로 표시한다 (PR #210 리뷰 MAJOR:
      // outer catch 만 ok=false 였음 — ListMetrics-only 실패(throttling 이 전형)가 무신호였다).
      out.ok = false;
    }
    // 프리픽스 수는 "현재 값"이 의미 — 별도 1h 윈도우 호출 (range 전체를 Period 300으로
    // 훑으면 7d × 다수 튜플에서 MaxDatapoints 100,800 초과로 결과가 잘릴 수 있음).
    // Period 300 + 기본 내림차순 스캔에서 Values[0]=최신.
    const latestQueries: typeof queries = [];
    if (bgpTuples.length > 100) out.ok = false; // 캡이 물면 잘린 튜플의 bgpMin/pfx* 무신호 금지 (위와 동일)
    bgpTuples.slice(0, 100).forEach((t, i) => {
      queries.push({
        Id: `bgp_i${i}`, ReturnData: true,
        MetricStat: { Metric: { Namespace: 'AWS/DX', MetricName: 'VirtualInterfaceBgpStatus', Dimensions: t.dims }, Period: rangeSec, Stat: 'Minimum' },
      });
      for (const pm of BGP_PFX_METRICS) {
        latestQueries.push({
          Id: `${pm.key.toLowerCase()}_i${i}`, ReturnData: true,
          MetricStat: { Metric: { Namespace: 'AWS/DX', MetricName: pm.name, Dimensions: t.dims }, Period: 300, Stat: 'Maximum' },
        });
      }
    });
    if (queries.length === 0 && latestQueries.length === 0) return out;

    // GetMetricData 한도: 호출당 500 MetricDataQueries — 청크 분할 (Id에 계열·인덱스가
    // 인코딩되어 있어 청크 간 병합에 추가 로직 불필요).
    const results: { Id?: string; Values?: number[]; StatusCode?: string }[] = [];
    const runChunked = async (qs: typeof queries, windowSec: number) => {
      for (let i = 0; i < qs.length; i += 500) {
        const r = await cw(region).send(new GetMetricDataCommand({
          StartTime: new Date(Date.now() - windowSec * 1000), EndTime: new Date(),
          MetricDataQueries: qs.slice(i, i + 500),
        }));
        for (const res of r.MetricDataResults ?? []) {
          // CloudWatch 는 HTTP 성공 응답에 쿼리 단위 실패(PartialData/InternalError/Forbidden)를
          // 실을 수 있다 — 예외가 없으므로 무검사면 그 쿼리만 조용히 null 강등되면서 ok=true 로
          // 남는다(리뷰 MAJOR: metricsDegradedRegions 계약을 신설 지점에서 우회). Complete 외는 degrade.
          if (res.StatusCode && res.StatusCode !== 'Complete') out.ok = false;
          results.push(res);
        }
      }
    };
    await runChunked(queries, rangeSec);
    await runChunked(latestQueries, 3600);

    for (const id of connIds) out.connState[id] = null;
    for (const v of vifList) out.vif[v.id] = { ...EMPTY_VIF_REC };
    // 프리픽스는 튜플별 대입(멱등) 후 패밀리(IPv4/IPv6) 합산 — 중복 결과에도 안전.
    const pfxByTuple: Record<'pfxacc' | 'pfxadv', (number | undefined)[]> = { pfxacc: [], pfxadv: [] };
    for (const res of results) {
      const mm = (res.Id ?? '').match(/^(\w+?)_i(\d+)$/);
      const v = res.Values?.[0];
      if (!mm || typeof v !== 'number') continue;
      const idx = Number(mm[2]);
      if (mm[1] === 'cs' && connIds[idx]) out.connState[connIds[idx]] = v;
      else if (mm[1] === 'bgp' && bgpTuples[idx]) {
        const vifId = bgpTuples[idx].vifId;
        const prev = out.bgpMin[vifId];
        out.bgpMin[vifId] = prev == null ? v : Math.min(prev, v);
      } else if ((mm[1] === 'pfxacc' || mm[1] === 'pfxadv') && bgpTuples[idx]) {
        pfxByTuple[mm[1]][idx] = v;
      } else if (vifList[idx]) {
        const rec = out.vif[vifList[idx].id];
        const key = VIF_METRICS.find((m) => m.key.toLowerCase() === mm[1])?.key;
        if (rec && key) rec[key] = v;
      }
    }
    bgpTuples.forEach((t, i) => {
      const acc = pfxByTuple.pfxacc[i];
      if (acc != null) out.pfxAcc[t.vifId] = (out.pfxAcc[t.vifId] ?? 0) + acc;
      const adv = pfxByTuple.pfxadv[i];
      if (adv != null) out.pfxAdv[t.vifId] = (out.pfxAdv[t.vifId] ?? 0) + adv;
    });
  } catch { out.ok = false; /* region degrade — 메트릭 없이 리스트만, 호출자에 노출 */ }
  return out;
}

const ROUTES_CAP = 200;

/** VIF별 BGP 라우트 (ListVirtualInterfaceRoutes, 2026-07 BGP 가시성) — accepted+advertised
 *  단일 응답, VIF당 200건 캡. 실패(미지원 리전 등) 시 available=false로 정직 강등. */
async function vifRoutes(region: string, vifId: string): Promise<{ routes: DxRoute[]; truncated: boolean; available: boolean }> {
  try {
    const routes: DxRoute[] = [];
    let nextToken: string | undefined;
    let truncated = false;
    do {
      const r: {
        routes?: {
          cidr?: string; routeDirection?: string; addressFamily?: string;
          asPath?: { pathType?: string; path?: number[] }[];
          communities?: string[]; routeInstalledAt?: string | Date;
        }[];
        nextToken?: string;
      } = await dc(region).send(new ListVirtualInterfaceRoutesCommand({ virtualInterfaceId: vifId, maxResults: 100, nextToken }));
      for (const rt of r.routes ?? []) {
        if (routes.length >= ROUTES_CAP) { truncated = true; break; }
        const dir = rt.routeDirection === 'advertised' ? 'advertised' : 'accepted';
        routes.push({
          vifId,
          cidr: rt.cidr ?? '?',
          direction: dir,
          family: rt.addressFamily ?? '?',
          asPath: (rt.asPath ?? [])
            .map((s) => `${s.pathType && s.pathType !== 'seq' ? `${s.pathType} ` : ''}${(s.path ?? []).join(' ')}`)
            .join(' | '),
          communities: rt.communities ?? [],
          installedAt: rt.routeInstalledAt ? new Date(rt.routeInstalledAt).toISOString() : null,
        });
      }
      nextToken = truncated ? undefined : r.nextToken;
    } while (nextToken);
    return { routes, truncated, available: true };
  } catch {
    return { routes: [], truncated: false, available: false };
  }
}

/** DX Gateway(글로벌) + association — 홈 리전에서 1회, 페이지네이션 수용.
 *  실패 시 [] + ok=false — 호출자가 "게이트웨이 0건"과 "조회 실패"를 구분해 경고할 수 있게. */
async function fetchGateways(vifs: DxVifRow[]): Promise<{ gateways: DxGatewayRow[]; ok: boolean }> {
  const raw: RawGw[] = [];
  try {
    let nextToken: string | undefined;
    do {
      const r: { directConnectGateways?: RawGw[]; nextToken?: string } =
        await dc(REGION).send(new DescribeDirectConnectGatewaysCommand({ nextToken }));
      raw.push(...(r.directConnectGateways ?? []));
      nextToken = r.nextToken;
    } while (nextToken);
  } catch { return { gateways: [], ok: false }; }

  const gateways = await Promise.all(raw.map(async (g): Promise<DxGatewayRow> => {
    const id = g.directConnectGatewayId ?? '';
    let associations: DxGatewayRow['associations'] = [];
    let associationsAvailable = true;
    try {
      const assocs: RawAssoc[] = [];
      let nextToken: string | undefined;
      do {
        const r: { directConnectGatewayAssociations?: RawAssoc[]; nextToken?: string } =
          await dc(REGION).send(new DescribeDirectConnectGatewayAssociationsCommand({ directConnectGatewayId: id, nextToken }));
        assocs.push(...(r.directConnectGatewayAssociations ?? []));
        nextToken = r.nextToken;
      } while (nextToken);
      associations = assocs.map((a) => ({
        id: a.associatedGateway?.id ?? '?',
        type: a.associatedGateway?.type ?? '?',
        state: a.associationState ?? '?',
        region: a.associatedGateway?.region ?? null,
        cidrs: (a.allowedPrefixesToDirectConnectGateway ?? []).map((p) => p.cidr ?? '').filter(Boolean),
      }));
    } catch {
      // association-only 실패는 "미할당"이 아니라 "판정 불가" — [] 그대로 두면
      // unassociated=true 가 위험을 발명한다(PR #210 리뷰 MAJOR). 행 단위로 정직 강등.
      associationsAvailable = false;
    }
    return {
      id, name: g.directConnectGatewayName ?? id, state: g.directConnectGatewayState ?? '?',
      amazonSideAsn: g.amazonSideAsn ?? null, ownerAccount: g.ownerAccount ?? null,
      associations, associationsAvailable,
      vifCount: vifs.filter((v) => v.attachedTo === id).length,
      unassociated: associationsAvailable && associations.length === 0,
    };
  }));
  return { gateways, ok: true };
}

/** 전 리전 DX 커넥션/VIF + 글로벌 DX Gateway + 메트릭 분석. */
export async function dxAnalysis(rangeSec: number): Promise<DxAnalysis> {
  return cached(`a|${rangeSec}`, async () => {
    const regions = await regionsFromInventory();
    const perRegion = await Promise.all(regions.map(async (region) => {
      try {
        const [cr, vr, lr] = await Promise.all([
          dc(region).send(new DescribeConnectionsCommand({})) as Promise<{ connections?: RawConn[] }>,
          dc(region).send(new DescribeVirtualInterfacesCommand({})) as Promise<{ virtualInterfaces?: RawVif[] }>,
          // LAG 위 VIF의 connectionId는 dxlag-* — 사용률 분모(대역폭) 확보용, 실패는 무해 강등.
          (dc(region).send(new DescribeLagsCommand({})) as Promise<{ lags?: { lagId?: string; connectionsBandwidth?: string; numberOfConnections?: number }[] }>)
            .catch(() => ({ lags: [] })),
        ]);
        const rawConns = cr.connections ?? [];
        const rawVifs = vr.virtualInterfaces ?? [];
        if (rawConns.length === 0 && rawVifs.length === 0) return { region, connections: [], vifs: [], degraded: false, metricsDegraded: false };

        const vifIds = rawVifs.map((v) => v.virtualInterfaceId ?? '').filter(Boolean);
        const [metrics, routesById] = await Promise.all([
          dxMetrics(
            region, rangeSec,
            rawConns.map((c) => ({ id: c.connectionId ?? '' })),
            rawVifs.map((v) => ({
              id: v.virtualInterfaceId ?? '', connectionId: v.connectionId ?? '',
              // BGP 메트릭 채택 패밀리: 피어에 구성된 패밀리 (피어 없으면 VIF addressFamily 폴백)
              families: new Set(
                ((v.bgpPeers?.length ? v.bgpPeers.map((p) => p.addressFamily) : [v.addressFamily]) ?? [])
                  .map((f) => (f ?? '').toLowerCase()).filter(Boolean)),
            })),
          ),
          Promise.all(vifIds.map(async (id) => [id, await vifRoutes(region, id)] as const))
            .then((entries) => new Map(entries)),
        ]);
        const bwByConn = new Map(rawConns.map((c) => [c.connectionId ?? '', parseBandwidth(c.bandwidth)]));
        for (const l of lr.lags ?? []) {
          if (l.lagId) bwByConn.set(l.lagId, parseBandwidth(l.connectionsBandwidth) * (l.numberOfConnections ?? 0));
        }

        const vifs = rawVifs.map((v): DxVifRow => {
          const id = v.virtualInterfaceId ?? '';
          const peers = v.bgpPeers ?? [];
          const peersUp = peers.filter((p) => p.bgpStatus === 'up').length;
          const m = metrics.vif[id] ?? EMPTY_VIF_REC;
          const bw = bwByConn.get(v.connectionId ?? '') ?? 0;
          const peak = Math.max(m.bpsInMax ?? -1, m.bpsOutMax ?? -1);
          // 사용률: Utilization 메트릭(퍼센트 발행) 우선, 없으면 피크 bps ÷ 대역폭 폴백.
          // 유효숫자 2자리 반올림 — 0.0033% 같은 미세값이 0으로 뭉개지지 않게.
          const utilMetric = Math.max(m.utilInMax ?? -1, m.utilOutMax ?? -1);
          const utilRaw = utilMetric >= 0
            ? utilMetric
            : bw > 0 && peak >= 0 ? (peak / bw) * 100 : null;
          const utilPct = utilRaw == null ? null : utilRaw === 0 ? 0 : Number(utilRaw.toPrecision(2));
          const bgpMin = metrics.bgpMin[id] ?? null;
          const rt = routesById.get(id) ?? { routes: [], truncated: false, available: false };
          const state = v.virtualInterfaceState ?? '?';
          return {
            id, name: v.virtualInterfaceName ?? id, type: v.virtualInterfaceType ?? '?',
            state, region, connectionId: v.connectionId ?? '',
            vlan: v.vlan ?? null, mtu: v.mtu ?? null, jumboFrameCapable: v.jumboFrameCapable ?? false,
            asn: v.asn ?? null, amazonSideAsn: v.amazonSideAsn ?? null,
            addressFamily: v.addressFamily ?? null,
            amazonAddress: v.amazonAddress ?? null, customerAddress: v.customerAddress ?? null,
            attachedTo: v.directConnectGatewayId || v.virtualGatewayId || null,
            attachmentType: v.directConnectGatewayId ? 'dx-gateway' : v.virtualGatewayId ? 'virtual-gateway' : null,
            siteLinkEnabled: v.siteLinkEnabled ?? false,
            // 표시용 피어 요약 — authKey 등 민감 필드는 여기서 명시적으로 배제된다.
            bgpPeers: peers.map((p) => `${p.bgpPeerId ?? '?'} ${p.addressFamily ?? ''} ${p.bgpStatus ?? '?'}`.trim()),
            bgpPeersUp: peersUp, bgpPeersTotal: peers.length,
            bpsIngress: m.bpsInAvg, bpsEgress: m.bpsOutAvg,
            peakBpsIngress: m.bpsInMax, peakBpsEgress: m.bpsOutMax,
            ppsIngress: m.ppsInAvg, ppsEgress: m.ppsOutAvg,
            peakUtilizationPct: utilPct,
            bgpStatusMin: bgpMin,
            prefixesAccepted: metrics.pfxAcc[id] ?? null,
            prefixesAdvertised: metrics.pfxAdv[id] ?? null,
            routes: rt.routes, routesTruncated: rt.truncated, routesAvailable: rt.available,
            down: state !== 'available' || (peers.length > 0 && peersUp < peers.length) || bgpMin === 0,
          };
        });

        const connections = rawConns.map((c): DxConnectionRow => {
          const id = c.connectionId ?? '';
          const state = c.connectionState ?? '?';
          const stateMin = metrics.connState[id] ?? null;
          return {
            id, name: c.connectionName ?? id, state, region: c.region ?? region,
            location: c.location ?? '?',
            bandwidth: c.bandwidth ?? '?', bandwidthBps: parseBandwidth(c.bandwidth),
            vlan: c.vlan ?? null, partnerName: c.partnerName ?? null, awsDevice: c.awsDeviceV2 ?? null,
            jumboFrameCapable: c.jumboFrameCapable ?? false, macSecCapable: c.macSecCapable ?? false,
            encryptionMode: c.encryptionMode ?? null, portEncryptionStatus: c.portEncryptionStatus ?? null,
            hasLogicalRedundancy: c.hasLogicalRedundancy ?? null, lagId: c.lagId ?? null,
            vifCount: vifs.filter((v) => v.connectionId === id).length,
            stateMetricMin: stateMin,
            down: !['available', 'ordering', 'requested', 'pending'].includes(state) || stateMin === 0,
          };
        });
        return { region, connections, vifs, degraded: false, metricsDegraded: !metrics.ok };
      } catch { return { region, connections: [] as DxConnectionRow[], vifs: [] as DxVifRow[], degraded: true, metricsDegraded: false }; }
    }));

    const connections = perRegion.flatMap((r) => r.connections);
    const vifs = perRegion.flatMap((r) => r.vifs);
    const degradedRegions = perRegion.filter((r) => r.degraded).map((r) => r.region);
    const metricsDegradedRegions = perRegion.filter((r) => r.metricsDegraded).map((r) => r.region);
    const { gateways, ok: gatewaysOk } = await fetchGateways(vifs);

    const locMap = new Map<string, { location: string; region: string; connections: number; bandwidthBps: number }>();
    for (const c of connections) {
      const key = `${c.location}|${c.region}`;
      const cur = locMap.get(key) ?? { location: c.location, region: c.region, connections: 0, bandwidthBps: 0 };
      cur.connections += 1;
      cur.bandwidthBps += c.bandwidthBps;
      locMap.set(key, cur);
    }
    const locations = [...locMap.values()].sort((a, b) => b.connections - a.connections);

    const utils = vifs.map((v) => v.peakUtilizationPct).filter((u): u is number => u != null);
    const totals: DxAnalysis['totals'] = {
      connections: connections.length,
      connectionsDown: connections.filter((c) => c.down).length,
      vifs: vifs.length,
      vifsDown: vifs.filter((v) => v.down).length,
      bgpPeersDown: vifs.reduce((s, v) => s + (v.bgpPeersTotal - v.bgpPeersUp), 0),
      gateways: gateways.length,
      gatewaysUnassociated: gateways.filter((g) => g.unassociated).length,
      gatewaysAssociationsUnknown: gateways.filter((g) => !g.associationsAvailable).length,
      totalBandwidthBps: connections.reduce((s, c) => s + c.bandwidthBps, 0),
      locations: locations.length,
      maxUtilizationPct: utils.length ? Math.max(...utils) : null,
      singleLocation: connections.length > 0 && new Set(connections.map((c) => c.location)).size === 1,
    };
    return {
      connections, vifs, gateways, locations, totals, rangeSec,
      degradedRegions, metricsDegradedRegions, gatewaysDegraded: !gatewaysOk,
    };
  });
}
