import { describe, it, expect } from 'vitest';
import { buildDxTopology, assessResiliency, layoutDxTopology } from './dx-topology';
import type { DxAnalysis, DxConnectionRow, DxVifRow, DxGatewayRow } from './dx';
import { isDeployedDxConnection, summarizeDxLocations } from './dx-evidence';

const conn = (o: Partial<DxConnectionRow>): DxConnectionRow => ({
  id: 'dxcon-1', name: 'c1', state: 'available', region: 'ap-northeast-2', location: 'SEL1',
  bandwidth: '1Gbps', bandwidthBps: 1e9, vlan: null, partnerName: null, awsDevice: null,
  jumboFrameCapable: false, macSecCapable: false, encryptionMode: null, portEncryptionStatus: null,
  hasLogicalRedundancy: null, lagId: null, vifCount: 0, stateMetricMin: 1, down: false, ...o,
});
const vif = (o: Partial<DxVifRow>): DxVifRow => ({
  id: 'dxvif-1', name: 'v1', type: 'private', state: 'available', region: 'ap-northeast-2',
  connectionId: 'dxcon-1', vlan: 100, mtu: 1500, jumboFrameCapable: false,
  asn: 65000, amazonSideAsn: 64512, addressFamily: 'ipv4', amazonAddress: null, customerAddress: null,
  attachedTo: null, attachmentType: null, siteLinkEnabled: false,
  bgpPeers: [], bgpPeersUp: 1, bgpPeersTotal: 1,
  bpsIngress: null, bpsEgress: null, peakBpsIngress: null, peakBpsEgress: null,
  ppsIngress: null, ppsEgress: null, peakUtilizationPct: null, bgpStatusMin: 1,
  prefixesAccepted: null, prefixesAdvertised: null, routes: [], routesTruncated: false,
  routesAvailable: true, down: false, ...o,
});
const gw = (o: Partial<DxGatewayRow>): DxGatewayRow => ({
  id: 'dxgw-1', name: 'gw1', state: 'available', amazonSideAsn: 64512, ownerAccount: '1',
  associations: [], vifCount: 0, associationsAvailable: true, unassociated: false, ...o,
});

describe('buildDxTopology', () => {
  it.each(['pending', 'ordering', 'requested', 'unknown', 'available'])(
    'never infers up from down=false for an unassessed %s LAG member', state => {
      const g = buildDxTopology({
        connections: [conn({ state, stateMetricMin: null, lagId: 'dxlag-1' })],
        vifs: [], gateways: [],
      });
      expect(g.nodes.find(n => n.id === 'dxcon-1')!.state).toBe('none');
      expect(g.nodes.find(n => n.id === 'loc|SEL1')!.state).toBe('none');
      expect(g.nodes.find(n => n.id === 'dxlag-1')).toMatchObject({
        state: 'none', sub: 'LAG · 0/1 up',
        connectionHealth: { unknown: state === 'available' ? 1 : 0, excluded: state === 'available' ? 0 : 1 },
      });
      expect(g.edges.filter(e => e.source === 'onprem' || e.source === 'loc|SEL1' || e.target === 'dxlag-1')
        .every(e => e.state === 'none')).toBe(true);
    },
  );

  it('keeps unknown and excluded LAG members out of up counts while retaining metric-zero observations', () => {
    const g = buildDxTopology({
      connections: [
        conn({ id: 'healthy', lagId: 'dxlag-1' }),
        conn({ id: 'pending', state: 'pending', stateMetricMin: null, lagId: 'dxlag-1' }),
        conn({ id: 'unknown', stateMetricMin: null, lagId: 'dxlag-1' }),
        conn({ id: 'observed', state: 'deleting', stateMetricMin: 0, lagId: 'dxlag-1' }),
      ], vifs: [], gateways: [],
    });
    expect(g.nodes.find(n => n.id === 'healthy')!.state).toBe('ok');
    expect(g.nodes.find(n => n.id === 'observed')!.state).toBe('down');
    expect(g.nodes.find(n => n.id === 'dxlag-1')).toMatchObject({
      state: 'warn', sub: 'LAG · 1/4 up',
      connectionHealth: { down: 0, unknown: 1, excluded: 2, excludedObservedDown: 1 },
    });
    expect(g.edges.find(e => e.source === 'onprem')!.state).toBe('warn');
  });

  it('계층 그래프: 온프레미스→로케이션→커넥션→VIF→DXGW→TGW, association 상태·cidr 라벨', () => {
    const g = buildDxTopology({
      connections: [conn({})],
      vifs: [vif({ attachedTo: 'dxgw-1', attachmentType: 'dx-gateway' })],
      gateways: [gw({ associations: [{ id: 'tgw-1', type: 'transitGateway', state: 'associated', region: 'ap-northeast-2', cidrs: ['10.0.0.0/8'] }] })],
    });
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(['onprem', 'loc|SEL1', 'dxcon-1', 'dxvif-1', 'dxgw-1', 'tgw-1']));
    expect(g.nodes.find((n) => n.id === 'tgw-1')!.kind).toBe('tgw');
    const es = g.edges.map((e) => `${e.source}→${e.target}`);
    expect(es).toEqual(expect.arrayContaining(['onprem→loc|SEL1', 'loc|SEL1→dxcon-1', 'dxcon-1→dxvif-1', 'dxvif-1→dxgw-1', 'dxgw-1→tgw-1']));
    expect(g.edges.find((e) => e.target === 'tgw-1')!.label).toBe('10.0.0.0/8');
  });

  it('LAG: 커넥션→LAG 엣지 + dxlag connectionId VIF는 LAG에 연결, 멤버 일부 다운 = warn', () => {
    const g = buildDxTopology({
      connections: [conn({ id: 'dxcon-1', lagId: 'dxlag-1' }), conn({ id: 'dxcon-2', lagId: 'dxlag-1', down: true })],
      vifs: [vif({ connectionId: 'dxlag-1' })],
      gateways: [],
    });
    const lag = g.nodes.find((n) => n.id === 'dxlag-1')!;
    expect(lag.kind).toBe('lag');
    expect(lag.state).toBe('warn');
    expect(lag.sub).toContain('1/2 up');
    expect(g.edges.some((e) => e.source === 'dxlag-1' && e.target === 'dxvif-1')).toBe(true);
  });

  it('public VIF→AWS 퍼블릭, 크로스 계정 DXGW 합성, 다운 상태 전파, 미연결 VIF는 엣지 없음', () => {
    const g = buildDxTopology({
      connections: [conn({ down: true })],
      vifs: [
        vif({ id: 'dxvif-pub', type: 'public' }),
        vif({ id: 'dxvif-x', attachedTo: 'dxgw-other', attachmentType: 'dx-gateway' }),
        vif({ id: 'dxvif-dangling' }),
      ],
      gateways: [],
    });
    expect(g.nodes.find((n) => n.id === 'awspub')).toBeTruthy();
    const synth = g.nodes.find((n) => n.id === 'dxgw-other')!;
    expect(synth.kind).toBe('dxgw');
    expect(g.nodes.find((n) => n.id === 'dxcon-1')!.state).toBe('down');
    expect(g.edges.some((e) => e.source === 'dxvif-dangling')).toBe(false);
    expect(layoutDxTopology(g).size).toBe(g.nodes.length);
  });

  it('리소스 0건 = 빈 그래프 (온프레미스 노드도 없음)', () => {
    expect(buildDxTopology({ connections: [], vifs: [], gateways: [] }).nodes).toEqual([]);
  });
});

describe('buildDxTopology — 리뷰 수정 회귀', () => {
  it('호스티드 VIF: 크로스 계정 부모 커넥션(dxcon-)/LAG(dxlag-)를 합성해 엣지 연결', () => {
    const g = buildDxTopology({
      connections: [],
      vifs: [
        vif({ id: 'dxvif-h1', connectionId: 'dxcon-hosted', attachedTo: 'dxgw-other', attachmentType: 'dx-gateway' }),
        vif({ id: 'dxvif-h2', connectionId: 'dxlag-hidden' }),
      ],
      gateways: [],
    });
    const parent = g.nodes.find((n) => n.id === 'dxcon-hosted')!;
    expect(parent.kind).toBe('connection');
    expect(parent.sub).toBe('(다른 계정)');
    expect(g.nodes.find((n) => n.id === 'dxlag-hidden')!.kind).toBe('lag');
    // 합성 LAG는 멤버 비가시 — '0/0 up'으로 덮이지 않음
    expect(g.nodes.find((n) => n.id === 'dxlag-hidden')!.sub).toBe('(다른 계정)');
    expect(g.edges.some((e) => e.source === 'dxcon-hosted' && e.target === 'dxvif-h1')).toBe(true);
    // 커넥션 0건이어도 VIF가 있으면 온프레미스 노드 존재
    expect(g.nodes.some((n) => n.id === 'onprem')).toBe(true);
  });

  it('onprem→로케이션 엣지는 로케이션당 1개 — 멤버 상태 집계 (일부 다운 = warn)', () => {
    const g = buildDxTopology({
      connections: [conn({}), conn({ id: 'dxcon-2', down: true })],
      vifs: [], gateways: [],
    });
    const trunk = g.edges.filter((e) => e.source === 'onprem' && e.target === 'loc|SEL1');
    expect(trunk).toHaveLength(1);
    expect(trunk[0].state).toBe('warn');
  });
});

describe('assessResiliency (DX SLA 티어 — sample-network-resilience-agent 규칙)', () => {
  it('none: 커넥션 0', () => {
    const r = assessResiliency({ connections: [], vifs: [], gateways: [] });
    expect(r.tier).toBe('none');
    expect(r.slaPct).toBeNull();
    expect(r.noneReason).toBe('no-connections');
  });
  it('single 95%: 로케이션 1곳', () => {
    const r = assessResiliency({ connections: [conn({}), conn({ id: 'dxcon-2' })], vifs: [], gateways: [] });
    expect(r.tier).toBe('single');
    expect(r.slaPct).toBe('95%');
  });
  it('high 99.9%: 로케이션 2곳, 각 1개', () => {
    const r = assessResiliency({ connections: [conn({}), conn({ id: 'dxcon-2', location: 'SEL2' })], vifs: [], gateways: [] });
    expect(r.tier).toBe('high');
    expect(r.slaPct).toBe('99.9%');
  });
  it('maximum 99.99%: 2개 로케이션 × 각 검증된 고유 디바이스 2개 이상', () => {
    const r = assessResiliency({
      connections: [
        conn({ id: 'c1', awsDevice: 'devA' }), conn({ id: 'c2', awsDevice: 'devB' }),
        conn({ id: 'c3', location: 'SEL2', awsDevice: 'devC' }), conn({ id: 'c4', location: 'SEL2', awsDevice: 'devD' }),
      ],
      vifs: [], gateways: [],
    });
    expect(r.tier).toBe('maximum');
    expect(r.slaPct).toBe('99.99%');
    expect(r.dualConnLocations).toBe(2);
    expect(r.deviceRedundancyUnverifiable).toBe(false);
  });

  it('리뷰(Codex stop-hook): awsDevice가 없으면 커넥션 id로 폴백해 이중화를 확정하지 않는다 — 검증 불가는 unverifiable로 표시, maximum 인증 안 함', () => {
    const r = assessResiliency({
      connections: [conn({}), conn({ id: 'c2' }), conn({ id: 'c3', location: 'SEL2' }), conn({ id: 'c4', location: 'SEL2' })],
      vifs: [], gateways: [],
    });
    expect(r.tier).toBe('high'); // 디바이스 정보가 전혀 없어 maximum을 확정 인증할 수 없음
    expect(r.dualConnLocations).toBe(0);
    expect(r.deviceRedundancyUnverifiable).toBe(true);
  });
  it('deleted/rejected/개통 전 커넥션은 티어 산정에서 제외 (아키텍처 부풀림 방지)', () => {
    const r = assessResiliency({
      connections: [conn({}), conn({ id: 'c2', location: 'SEL2', state: 'deleted', down: true })],
      vifs: [], gateways: [],
    });
    expect(r.tier).toBe('single'); // deleted 로케이션은 계상 안 함
    expect(r.locations).toBe(1);
    const r2 = assessResiliency({
      connections: [conn({}), conn({ id: 'c2', location: 'SEL2', state: 'ordering' })],
      vifs: [], gateways: [],
    });
    expect(r2.tier).toBe('single'); // 개통 전(ordering)도 제외
  });

  it('이중화는 로케이션당 고유 디바이스 기준 — 같은 디바이스 커넥션 2개는 이중화 아님', () => {
    const r = assessResiliency({
      connections: [
        conn({ id: 'c1', awsDevice: 'devA' }), conn({ id: 'c2', awsDevice: 'devA' }),
        conn({ id: 'c3', location: 'SEL2', awsDevice: 'devB' }), conn({ id: 'c4', location: 'SEL2', awsDevice: 'devC' }),
      ],
      vifs: [], gateways: [],
    });
    expect(r.tier).toBe('high'); // SEL1은 디바이스 1개뿐 → maximum 불충족
    expect(r.dualConnLocations).toBe(1);
  });

  it('호스티드(파트너) 커넥션 수를 노출 — SLA 적용 제외 고지용, 티어 산정에는 포함 안 함', () => {
    const r = assessResiliency({
      connections: [conn({ partnerName: 'SomePartner' }), conn({ id: 'c2', location: 'SEL2' })],
      vifs: [], gateways: [],
    });
    expect(r.hostedConnections).toBe(1);
    expect(r.locations).toBe(1); // 호스티드(SEL1)는 제외 — owned인 SEL2만 계상
    expect(r.tier).toBe('single');
  });

  it('리뷰(Codex stop-hook): 전부 호스티드면 로케이션이 여러 곳이라도 none(자격 없음) — "Maximum" 배지 오인증 방지', () => {
    const r = assessResiliency({
      connections: [
        conn({ id: 'c1', partnerName: 'PartnerA' }), conn({ id: 'c2', partnerName: 'PartnerA' }),
        conn({ id: 'c3', location: 'SEL2', partnerName: 'PartnerB' }), conn({ id: 'c4', location: 'SEL2', partnerName: 'PartnerB' }),
      ],
      vifs: [], gateways: [],
    });
    expect(r.hostedConnections).toBe(4);
    expect(r.tier).toBe('none');
    expect(r.slaPct).toBeNull();
    expect(r.locations).toBe(0);
    expect(r.noneReason).toBe('all-hosted');
  });

  it('리뷰(Codex stop-hook, 3라운드): pending 상태의 owned 커넥션 + 배포된 호스티드 커넥션이 혼재하면 "전량 호스티드"도 "커넥션 없음"도 아닌 별도 사유(no-deployed-owned)로 구분된다', () => {
    const r = assessResiliency({
      connections: [
        // owned지만 아직 미배포(pending) — deployedAll/total/hostedConnections 어디에도 안 잡힘.
        conn({ id: 'c1', state: 'pending' }),
        // 호스티드 & 배포됨 — hostedConnections에 잡혀 tier==='none'이 되는 원인.
        conn({ id: 'c2', location: 'SEL2', partnerName: 'PartnerA' }),
      ],
      vifs: [], gateways: [],
    });
    expect(r.tier).toBe('none'); // 배포된 owned 커넥션이 0개라 SLA 티어 산정 대상이 없음
    expect(r.hostedConnections).toBe(1);
    // pending owned 커넥션이 존재하므로 "전량 호스티드"(all-hosted)도, 커넥션이 실제로 있으므로
    // "커넥션 없음"(no-connections)도 아니다 — 세 번째 사유로 정확히 구분돼야 한다.
    expect(r.noneReason).toBe('no-deployed-owned');
  });

  it('체크: 다운 커넥션·미연결 DXGW·미연결 VIF가 실패로 표시', () => {
    const r = assessResiliency({
      connections: [conn({ down: true })],
      vifs: [vif({ id: 'v-dangling' })],
      gateways: [gw({ unassociated: true })],
      degradedRegions: [], metricsDegradedRegions: [], gatewaysDegraded: false,
    });
    const by = (label: string) => r.checks.find((c) => c.label.includes(label))!;
    expect(by('배포된 커넥션').ok).toBe(false);
    expect(by('미연결 DX Gateway').ok).toBe(false);
    expect(by('미연결 VIF').ok).toBe(false);
    expect(by('모든 VIF').ok).toBe(true);
  });
});

describe('resilience evidence coverage', () => {
  const snapshot = (over: Partial<DxAnalysis> = {}) => ({
    connections: [conn({})],
    vifs: [vif({ attachedTo: 'dxgw-1', attachmentType: 'dx-gateway' })],
    gateways: [gw({ associations: [
      { id: 'tgw-1', type: 'transitGateway', state: 'associated', region: 'ap-northeast-2', cidrs: [] },
    ] })],
    degradedRegions: [], metricsDegradedRegions: [], gatewaysDegraded: false,
    ...over,
  });
  const check = (data: ReturnType<typeof snapshot>, label: string) =>
    assessResiliency(data).checks.find(c => c.label.includes(label))!.ok;

  it('keeps missing metric, peer and association evidence unknown', () => {
    const data = snapshot({
      connections: [conn({ stateMetricMin: null })],
      vifs: [vif({ attachedTo: 'dxgw-1', bgpStatusMin: null, bgpPeersTotal: 0, bgpPeersUp: 0 })],
      gateways: [gw({ associationsAvailable: false, unassociated: false })],
      metricsDegradedRegions: ['ap-northeast-2'],
    });
    expect(check(data, '배포된 커넥션')).toBeNull();
    expect(check(data, '모든 VIF')).toBeNull();
    expect(check(data, '미연결 DX Gateway')).toBeNull();
  });

  it.each([
    { connections: [conn({ stateMetricMin: null })] },
    { connections: [conn({ state: 'pending', stateMetricMin: 1 })] },
    { metricsDegradedRegions: ['ap-northeast-2'] },
    { degradedRegions: ['us-west-2'] },
    { connections: [] },
  ])('withholds an all-connections pass for incomplete evidence: %j', over => {
    expect(check(snapshot(over), '배포된 커넥션')).toBeNull();
  });

  it.each([
    { vifs: [vif({ bgpStatusMin: null })] },
    { vifs: [vif({ bgpPeersTotal: 0, bgpPeersUp: 0 })] },
    { metricsDegradedRegions: ['ap-northeast-2'] },
    { degradedRegions: ['us-west-2'] },
    { vifs: [] },
  ])('withholds a VIF/BGP pass for incomplete evidence: %j', over => {
    expect(check(snapshot(over), '모든 VIF')).toBeNull();
  });

  it('does not interpret absent coverage metadata as a confirmed successful inventory read', () => {
    expect(check(snapshot({ degradedRegions: undefined }), '배포된 커넥션')).toBeNull();
    expect(check(snapshot({ metricsDegradedRegions: undefined }), '모든 VIF')).toBeNull();
    expect(check(snapshot({ gatewaysDegraded: undefined }), '미연결 DX Gateway')).toBeNull();
  });

  it('withholds absence-based gateway and VIF checks after their inventory reads fail', () => {
    expect(check(snapshot({ gateways: [], gatewaysDegraded: true }), '미연결 DX Gateway')).toBeNull();
    expect(check(snapshot({ vifs: [], degradedRegions: ['ap-northeast-2'] }), '미연결 VIF')).toBeNull();
  });

  it('keeps observed failures even when other evidence is unavailable', () => {
    const data = snapshot({
      connections: [conn({ down: true, stateMetricMin: null })],
      vifs: [vif({ down: true, bgpStatusMin: null })],
      gateways: [gw({ unassociated: true })],
      degradedRegions: ['us-west-2'], metricsDegradedRegions: ['ap-northeast-2'], gatewaysDegraded: true,
    });
    expect(check(data, '배포된 커넥션')).toBe(false);
    expect(check(data, '모든 VIF')).toBe(false);
    expect(check(data, '미연결 DX Gateway')).toBe(false);
    expect(check(data, '미연결 VIF')).toBe(false);
  });

  it('retains passes for complete observed health and successful empty absence checks', () => {
    expect(check(snapshot(), '배포된 커넥션')).toBe(true);
    expect(check(snapshot(), '모든 VIF')).toBe(true);
    expect(check(snapshot(), '미연결 DX Gateway')).toBe(true);
    expect(check(snapshot({ gateways: [] }), '미연결 DX Gateway')).toBe(true);
    expect(check(snapshot({ vifs: [] }), '미연결 VIF')).toBe(true);
  });

  it.each(['?', 'unknown', ' UNKNOWN ', '', '   '])('does not certify an unknown site as a second location: %j', location => {
    const r = assessResiliency(snapshot({ connections: [
      conn({ id: 'c1', awsDevice: 'a' }), conn({ id: 'c2', awsDevice: 'b' }),
      conn({ id: 'c3', location, awsDevice: 'c' }), conn({ id: 'c4', location, awsDevice: 'd' }),
    ] }));
    expect(r.locations).toBe(1);
    expect(r.dualConnLocations).toBe(1);
    expect(r.tier).toBe('single');
    expect(r.unknownLocationConnections).toBe(2);
    expect(r.checks.find(c => c.label.startsWith('로케이션 이중화'))!.ok).toBeNull();
    expect(r.checks.find(c => c.label.startsWith('로케이션당 디바이스'))!.ok).toBeNull();
  });

  it('preserves verified redundancy while disclosing additional unknown locations', () => {
    const r = assessResiliency(snapshot({ connections: [
      conn({ id: 'c1', awsDevice: 'a' }), conn({ id: 'c2', awsDevice: 'b' }),
      conn({ id: 'c3', location: 'SEL2', awsDevice: 'c' }), conn({ id: 'c4', location: 'SEL2', awsDevice: 'd' }),
      conn({ id: 'c5', location: '?' }),
    ] }));
    expect(r.tier).toBe('maximum');
    expect(r.unknownLocationConnections).toBe(1);
    expect(r.checks.find(c => c.label.startsWith('로케이션 이중화'))!.ok).toBe(true);
  });

  it('keeps unverified device redundancy unknown and confirmed single-site redundancy failed', () => {
    const unknown = assessResiliency(snapshot({ connections: [conn({}), conn({ id: 'c2', location: 'SEL2' })] }));
    expect(unknown.checks.find(c => c.label.startsWith('로케이션당 디바이스'))!.ok).toBeNull();
    const single = assessResiliency(snapshot({ connections: [conn({ awsDevice: 'a' })] }));
    expect(single.checks.find(c => c.label.startsWith('로케이션 이중화'))!.ok).toBe(false);
  });

  it('fails missing device metadata availability without asserting a network failure', () => {
    const data = snapshot({ degradedRegions: ['us-west-2'] });
    expect(check(data, '디바이스 정보로')).toBe(false);
    expect(check(data, '배포된 커넥션')).toBeNull();
    expect(check(snapshot({ connections: [conn({ awsDevice: 'a', location: '?' })] }), '디바이스 정보로')).toBeNull();
  });

  it.each(['pending', 'ordering', 'requested', 'deleted', 'rejected', 'deleting', 'unknown', 'other', '', undefined])('excludes %s from deployed health with explicit coverage', state => {
    const r = assessResiliency(snapshot({ connections: [
      conn({}), conn({ id: 'not-deployed', state, stateMetricMin: null, down: state === 'deleted' }),
    ] }));
    const health = r.checks.find(c => c.label.includes('배포된 커넥션'))!;
    expect(health.ok).toBe(true);
    expect(health.detail).toContain('1/2');
    expect(r.connectionHealthCoverage).toEqual({ total: 2, assessed: 1, excluded: 1, unknown: 0, down: 0, excludedObservedDown: 0 });
  });

  it.each(['deleting', 'unknown', 'other', '', undefined])('cannot certify locations or SLA from state %s', state => {
    const connections = [
      conn({ id: 'c1', awsDevice: 'a' }), conn({ id: 'c2', awsDevice: 'b' }),
      conn({ id: 'c3', state, location: 'SEL2', awsDevice: 'c' }),
      conn({ id: 'c4', state, location: 'SEL2', awsDevice: 'd' }),
    ];
    expect(isDeployedDxConnection(connections[2])).toBe(false);
    const summary = summarizeDxLocations(connections);
    expect(summary).toMatchObject({ knownLocations: 1, excludedConnections: 2, assessedConnections: 2 });
    expect(summary.locations.map(l => l.location)).toEqual(['SEL1']);
    const result = assessResiliency(snapshot({ connections }));
    expect(result).toMatchObject({ tier: 'single', locations: 1, dualConnLocations: 1 });
    const unassessed = assessResiliency(snapshot({ connections: connections.slice(2) }));
    expect(unassessed).toMatchObject({ tier: 'none', slaPct: null, locations: 0 });
    expect(unassessed.checks.find(c => c.label.startsWith('배포된 커넥션'))!.ok).toBeNull();
  });

  it.each(['available', 'down'])('keeps %s deployed for location/SLA and reports observed down health', state => {
    const connections = [conn({}), conn({ id: 'c2', state, location: 'SEL2', down: state === 'down' })];
    expect(isDeployedDxConnection(connections[1])).toBe(true);
    expect(summarizeDxLocations(connections).knownLocations).toBe(2);
    const result = assessResiliency(snapshot({ connections }));
    expect(result.tier).toBe('high');
    expect(result.checks.find(c => c.label.startsWith('배포된 커넥션'))!.ok).toBe(state === 'available');
  });

  it('supports hosted ConnectionState independently of unsupported connection throughput', () => {
    const hosted = conn({ partnerName: 'partner', bandwidth: '50Mbps', bandwidthBps: 50e6 });
    expect(check(snapshot({ connections: [hosted] }), '배포된 커넥션')).toBe(true);
    expect(check(snapshot({ connections: [{ ...hosted, stateMetricMin: null }] }), '배포된 커넥션')).toBeNull();
    expect(check(snapshot({ connections: [{ ...hosted, stateMetricMin: 0, down: true }], metricsDegradedRegions: ['other'] }), '배포된 커넥션')).toBe(false);
  });

  it('retains the confirmed single-site failure even when its device identities are missing', () => {
    const single = assessResiliency(snapshot());
    expect(single.checks.find(c => c.label.startsWith('로케이션당 디바이스'))!.ok).toBe(false);
  });
});
