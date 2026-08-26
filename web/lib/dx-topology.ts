import dagre from '@dagrejs/dagre';
import type { DxAnalysis, DxConnectionRow, DxVifRow, DxGatewayRow } from './dx';

// Direct Connect 구성도 + 복원력(SLA 티어) 평가 — 순수 함수 (React 비의존).
// 참조: aws-samples/sample-network-resilience-agent — 온프레미스 → DX 로케이션 →
// 커넥션/LAG → VIF → DXGW → TGW/VGW 계층 그래프와 DX SLA 티어 판정
// (Maximum 99.99% = 2개 이상 로케이션 × 로케이션당 검증된 고유 디바이스 2개 이상,
//  High 99.9% = 2개 이상 로케이션, Single 95% = 커넥션 1개 이상 — 모두 owned(비-호스티드)
//  커넥션 기준: 호스티드 커넥션은 파트너 SLA 소관이라 AWS 티어 산정에서 제외되고,
//  awsDevice가 없는 커넥션은 "검증된 고유 디바이스"로 세지 않는다 — 그래야 자격 없거나
//  검증 불가능한 설계에 확정 인증(예: "Maximum 99.99%")을 내주지 않는다).
// dxAnalysis()가 이미 가진 데이터만 사용 — 추가 AWS 호출 없음.

export type DxNodeKind =
  | 'onprem' | 'location' | 'connection' | 'lag' | 'vif' | 'dxgw' | 'vgw' | 'tgw' | 'awspub';
export type DxNodeState = 'ok' | 'warn' | 'down' | 'none';

export interface DxTopoNode {
  id: string;
  kind: DxNodeKind;
  /** 1행: 이름/식별자. */
  label: string;
  /** 2행: 보조 정보 (대역폭·타입·리전 등). */
  sub?: string;
  state: DxNodeState;
  /** 클릭 상세용 원본 행 (connection/vif/dxgw만). */
  row?: DxConnectionRow | DxVifRow | DxGatewayRow;
}

export interface DxTopoEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  state: DxNodeState;
  /** 미확정/비정상 연결(associating 등)은 점선. */
  dashed?: boolean;
}

export interface DxTopology { nodes: DxTopoNode[]; edges: DxTopoEdge[] }

type Input = Pick<DxAnalysis, 'connections' | 'vifs' | 'gateways'>;

export function buildDxTopology(a: Input): DxTopology {
  const nodes: DxTopoNode[] = [];
  const edges: DxTopoEdge[] = [];
  const seen = new Set<string>();
  const add = (n: DxTopoNode) => { if (!seen.has(n.id)) { seen.add(n.id); nodes.push(n); } };

  if (a.connections.length === 0 && a.vifs.length === 0 && a.gateways.length === 0) {
    return { nodes, edges };
  }

  if (a.connections.length > 0 || a.vifs.length > 0) add({ id: 'onprem', kind: 'onprem', label: '온프레미스', sub: '고객 라우터', state: 'ok' });

  // 로케이션 → 커넥션 (→ LAG)
  for (const c of a.connections) {
    const locId = `loc|${c.location || 'unknown'}`;
    add({ id: locId, kind: 'location', label: c.location || 'unknown', sub: c.region, state: 'ok' });
    add({ id: c.id, kind: 'connection', label: c.name || c.id, sub: `${c.bandwidth}${c.partnerName ? ` · ${c.partnerName}` : ''}`, state: c.down ? 'down' : 'ok', row: c });
    edges.push({ id: `${locId}→${c.id}`, source: locId, target: c.id, label: c.bandwidth, state: c.down ? 'down' : 'ok' });
    if (c.lagId) {
      add({ id: c.lagId, kind: 'lag', label: c.lagId, sub: 'LAG', state: 'ok' });
      edges.push({ id: `${c.id}→${c.lagId}`, source: c.id, target: c.lagId, state: c.down ? 'down' : 'ok' });
    }
  }
  // 온프레미스→로케이션: 로케이션당 1개, 멤버 커넥션 상태 집계 — 커넥션마다 push하면
  // 동일 경로에 평행 엣지가 겹쳐 SVG 페인트 순서에 따라 down(빨강)이 가려질 수 있음.
  for (const n of nodes) {
    if (n.kind !== 'location') continue;
    const members = a.connections.filter((c) => `loc|${c.location || 'unknown'}` === n.id);
    const downs = members.filter((c) => c.down).length;
    edges.push({
      id: `onprem→${n.id}`, source: 'onprem', target: n.id,
      state: downs === 0 ? 'ok' : downs === members.length ? 'down' : 'warn',
    });
  }

  // LAG 상태 = 멤버 커넥션 상태 집계 (전부 다운 = down, 일부 = warn)
  for (const n of nodes) {
    if (n.kind !== 'lag') continue;
    const members = a.connections.filter((c) => c.lagId === n.id);
    if (members.length === 0) continue; // 합성 LAG(크로스 계정) — 멤버 비가시, sub/state 유지
    const downs = members.filter((c) => c.down).length;
    n.state = downs === 0 ? 'ok' : downs === members.length ? 'down' : 'warn';
    n.sub = `LAG · ${members.length - downs}/${members.length} up`;
  }

  // 알려진 DXGW (계정 내) — 크로스 계정 DXGW는 VIF attachment에서 합성
  for (const g of a.gateways) {
    add({ id: g.id, kind: 'dxgw', label: g.name || g.id, sub: g.amazonSideAsn ? `ASN ${g.amazonSideAsn}` : undefined, state: g.unassociated ? 'warn' : 'ok', row: g });
    for (const as of g.associations) {
      const kind: DxNodeKind = /transit/i.test(as.type) ? 'tgw' : 'vgw';
      add({ id: as.id, kind, label: as.id, sub: as.region ?? undefined, state: as.state === 'associated' ? 'ok' : 'warn' });
      edges.push({
        id: `${g.id}→${as.id}`, source: g.id, target: as.id,
        label: as.cidrs.length ? as.cidrs.slice(0, 2).join(', ') + (as.cidrs.length > 2 ? ' …' : '') : undefined,
        state: as.state === 'associated' ? 'ok' : 'warn',
        dashed: as.state !== 'associated',
      });
    }
  }

  // VIF — 커넥션(dxcon-) 또는 LAG(dxlag-)에 걸림. attachment는 DXGW/VGW/퍼블릭.
  for (const v of a.vifs) {
    const bgp = v.bgpPeersTotal > 0 ? ` · BGP ${v.bgpPeersUp}/${v.bgpPeersTotal}` : '';
    add({ id: v.id, kind: 'vif', label: v.name || v.id, sub: `${v.type}${v.vlan != null ? ` · VLAN ${v.vlan}` : ''}${bgp}`, state: v.down ? 'down' : 'ok', row: v });
    if (seen.has(v.connectionId)) {
      edges.push({ id: `${v.connectionId}→${v.id}`, source: v.connectionId, target: v.id, state: v.down ? 'down' : 'ok' });
    } else if (v.connectionId) {
      // 호스티드 VIF의 크로스 계정 부모(dxcon-*) 또는 비가시 LAG(dxlag-*) 합성 — DXGW 합성과 동일 관례.
      // 합성 노드는 state 'ok' — 실데이터 없는 down/warn을 발명하지 않는다.
      add(v.connectionId.startsWith('dxlag-')
        ? { id: v.connectionId, kind: 'lag', label: v.connectionId, sub: '(다른 계정)', state: 'ok' }
        : { id: v.connectionId, kind: 'connection', label: v.connectionId, sub: '(다른 계정)', state: 'ok' });
      edges.push({ id: `${v.connectionId}→${v.id}`, source: v.connectionId, target: v.id, state: v.down ? 'down' : 'ok' });
    }
    if (v.type === 'public') {
      add({ id: 'awspub', kind: 'awspub', label: 'AWS 퍼블릭 서비스', sub: 'S3 · DynamoDB …', state: 'ok' });
      edges.push({ id: `${v.id}→awspub`, source: v.id, target: 'awspub', state: v.down ? 'down' : 'ok' });
    } else if (v.attachedTo) {
      if (!seen.has(v.attachedTo)) {
        // 크로스 계정 DXGW 또는 gateways[]에 없는 VGW를 합성
        add(v.attachmentType === 'dx-gateway'
          ? { id: v.attachedTo, kind: 'dxgw', label: v.attachedTo, sub: '(다른 계정)', state: 'ok' }
          : { id: v.attachedTo, kind: 'vgw', label: v.attachedTo, state: 'ok' });
      }
      edges.push({ id: `${v.id}→${v.attachedTo}`, source: v.id, target: v.attachedTo, state: v.down ? 'down' : 'ok' });
    }
    // attachedTo 없음 = 미연결 VIF — 엣지 없이 남긴다 (dangling으로 시각화)
  }

  return { nodes, edges };
}

// ── 복원력(SLA 티어) 평가 — sample-network-resilience-agent의 resilience-engine 티어 규칙 ──
export type DxSlaTier = 'maximum' | 'high' | 'single' | 'none';

export interface DxResiliencyCheck {
  /** 체크 라벨 (i18n 키 — 한국어 리터럴). */
  label: string;
  ok: boolean;
  /** 심각도: critical = SLA/가용성 직접 영향, warn = 권고. */
  severity: 'critical' | 'warn';
  detail?: string;
}

/**
 * tier==='none'일 때 '왜' none인지 — 이 세 가지는 화면에 서로 다른 문구가 필요하다:
 * - 'no-connections': 커넥션이 정말 하나도 없음 (상태 무관).
 * - 'all-hosted': 커넥션은 있지만 전부(상태 무관) 호스티드 — AWS SLA 산정 대상 자체가 없음.
 * - 'no-deployed-owned': owned 커넥션이 존재하긴 하지만 전부 미배포(pending/ordering 등)
 *   상태이거나, owned+호스티드가 혼재하는데 배포된 owned가 0개 — "전량 호스티드"도
 *   "커넥션 없음"도 아니다("일부는 호스티드고 일부는 아직 배포 전"일 수도 있음).
 * tier !== 'none'이면 null.
 */
export type DxNoneReason = 'no-connections' | 'all-hosted' | 'no-deployed-owned';

export interface DxResiliency {
  tier: DxSlaTier;
  /** AWS Direct Connect SLA 공표 수치. */
  slaPct: string | null;
  /** 로케이션 수 / 로케이션당 '검증된' 고유 디바이스 2개 이상인 로케이션 수 (owned 커넥션 기준). */
  locations: number;
  dualConnLocations: number;
  /** 호스티드(파트너 경유) 커넥션 수 — AWS DX SLA 적용 제외 대상 (배포 상태 커넥션 기준). */
  hostedConnections: number;
  /** tier==='none'일 때만 non-null — 위 DxNoneReason 참고. */
  noneReason: DxNoneReason | null;
  /** 일부 로케이션에서 awsDevice 정보가 없어 디바이스 이중화 여부를 확정할 수 없음. */
  deviceRedundancyUnverifiable: boolean;
  checks: DxResiliencyCheck[];
}

export function assessResiliency(a: Pick<DxAnalysis, 'connections' | 'vifs' | 'gateways'>): DxResiliency {
  // SLA 티어는 '배포된 아키텍처'의 속성 — 삭제/거절/개통 전 커넥션은 산정에서 제외한다
  // (잔존 deleted 행이 티어를 부풀리는 것 방지). 현재 헬스는 체크리스트가 별도 표기.
  const NOT_DEPLOYED = new Set(['deleted', 'rejected', 'ordering', 'requested', 'pending']);
  const deployedAll = a.connections.filter((c) => !NOT_DEPLOYED.has(c.state));
  // AWS Direct Connect SLA(99.99%/99.9%/95%)는 owned(AWS 소유) 커넥션에만 적용된다 — 호스티드
  // (파트너 경유) 커넥션은 파트너 자신의 SLA 소관이라 AWS 티어 산정에서 완전히 제외해야 한다.
  // 이전 버전은 호스티드 커넥션도 locations/dualConnLocations에 포함시켜, 전부 호스티드인
  // 배포도 "Maximum 99.99%" 배지를 달면서 동시에 "호스티드는 SLA 적용 제외"라고 고지하는
  // 자기 모순을 냈다 — 자격 없는 설계에 인증을 내준 셈이라 아예 owned만으로 산정한다.
  const isHosted = (c: DxConnectionRow) => c.partnerName != null && c.partnerName !== '';
  const deployed = deployedAll.filter((c) => !isHosted(c));
  const hostedConnections = deployedAll.filter(isHosted).length;

  // 이중화는 로케이션당 '고유 AWS 디바이스' 수 기준 (sample sla-gating.ts와 동일 —
  // 같은 디바이스의 커넥션 2개는 디바이스 장애에 함께 죽는다). awsDevice가 없는 커넥션은
  // 커넥션 id로 폴백하지 않는다 — 폴백하면 "디바이스 정보 없음"을 "커넥션마다 별개 디바이스
  // 확인됨"으로 조작해, 실제로는 검증 불가능한 이중화를 확정 인증해버린다(미검증 설계에
  // 인증을 내주는 두 번째 경로). 대신 awsDevice가 있는 커넥션만으로 검증된 고유 디바이스
  // 집합을 만들고, 그 집합이 2개 미만인 로케이션 중 awsDevice 미노출 커넥션이 있으면
  // "확인 불가"로 별도 표시한다 — 이중화가 '없다'가 아니라 '모른다'로 정직하게 남긴다.
  const byLoc = new Map<string, { devices: Set<string>; deviceUnknown: boolean }>();
  for (const c of deployed) {
    const loc = c.location || 'unknown';
    if (!byLoc.has(loc)) byLoc.set(loc, { devices: new Set(), deviceUnknown: false });
    const entry = byLoc.get(loc)!;
    if (c.awsDevice) entry.devices.add(c.awsDevice);
    else entry.deviceUnknown = true;
  }
  const locations = byLoc.size;
  const dualConnLocations = [...byLoc.values()].filter((v) => v.devices.size >= 2).length;
  const deviceRedundancyUnverifiable = [...byLoc.values()].some((v) => v.deviceUnknown && v.devices.size < 2);
  const total = deployed.length;

  const tier: DxSlaTier = total === 0 ? 'none'
    : locations >= 2 && dualConnLocations >= 2 ? 'maximum'
      : locations >= 2 ? 'high'
        : 'single';
  const slaPct = tier === 'maximum' ? '99.99%' : tier === 'high' ? '99.9%' : tier === 'single' ? '95%' : null;

  const connsDown = a.connections.filter((c) => c.down).length;
  const totalAll = a.connections.length;
  // tier==='none'인 '이유' — 화면 라벨이 세 경우를 구분해야 한다(리뷰, 라운드 3: hostedConnections/
  // allConnectionsHosted 둘 다 '배포 상태'나 '상태 무관 전체'라는 단일 축만 봐서 owned+호스티드가
  // 혼재하는데 배포된 owned가 0인 경우를 여전히 오분류했다). totalAll(상태 무관 전체 커넥션 수)과
  // 상태 무관 전체가 전부 호스티드인지를 함께 봐야 세 경우가 정확히 갈린다.
  const noneReason: DxNoneReason | null = tier !== 'none' ? null
    : totalAll === 0 ? 'no-connections'
      : a.connections.every(isHosted) ? 'all-hosted'
        : 'no-deployed-owned';
  const vifsDown = a.vifs.filter((v) => v.down).length;
  const unassociated = a.gateways.filter((g) => g.unassociated).length;
  const unattachedVifs = a.vifs.filter((v) => v.type !== 'public' && !v.attachedTo).length;

  const checks: DxResiliencyCheck[] = [
    { label: '모든 커넥션 정상 (기간 내 다운 없음)', ok: connsDown === 0, severity: 'critical', detail: connsDown > 0 ? `${connsDown}/${totalAll}` : undefined },
    { label: '모든 VIF·BGP 정상', ok: vifsDown === 0, severity: 'critical', detail: vifsDown > 0 ? `${vifsDown}/${a.vifs.length}` : undefined },
    { label: '로케이션 이중화 — 99.9% SLA 요건 (2개 이상 로케이션, 호스티드 제외)', ok: locations >= 2, severity: 'critical', detail: `${locations}` },
    { label: '로케이션당 디바이스 이중화 — 99.99% SLA 요건 (2개 로케이션 × 각 검증된 고유 디바이스 2개 이상)', ok: locations >= 2 && dualConnLocations >= 2, severity: 'warn', detail: `${dualConnLocations}/${locations}` },
    { label: '디바이스 정보로 이중화 확인 가능 (일부 로케이션에 awsDevice 미노출)', ok: !deviceRedundancyUnverifiable, severity: 'warn' },
    { label: '미연결 DX Gateway 없음', ok: unassociated === 0, severity: 'warn', detail: unassociated > 0 ? `${unassociated}` : undefined },
    { label: '미연결 VIF 없음 (게이트웨이 attachment)', ok: unattachedVifs === 0, severity: 'warn', detail: unattachedVifs > 0 ? `${unattachedVifs}` : undefined },
  ];

  return { tier, slaPct, locations, dualConnLocations, hostedConnections, noneReason, deviceRedundancyUnverifiable, checks };
}

// ── dagre 레이아웃 (flow-layout.ts와 동일 기법 — LR 계층 배치, 중심→좌상단 변환) ──
const NODE_W = 200;
const NODE_H = 56;

export function layoutDxTopology(g: DxTopology): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  if (g.nodes.length === 0) return out;
  const dg = new dagre.graphlib.Graph();
  dg.setGraph({ rankdir: 'LR', ranksep: 70, nodesep: 20, marginx: 16, marginy: 16 });
  dg.setDefaultEdgeLabel(() => ({}));
  for (const n of g.nodes) dg.setNode(n.id, { width: NODE_W, height: NODE_H });
  const present = new Set(g.nodes.map((n) => n.id));
  for (const e of g.edges) if (present.has(e.source) && present.has(e.target)) dg.setEdge(e.source, e.target);
  dagre.layout(dg);
  for (const n of g.nodes) {
    const p = dg.node(n.id);
    out.set(n.id, { x: (p?.x ?? 0) - NODE_W / 2, y: (p?.y ?? 0) - NODE_H / 2 });
  }
  return out;
}
