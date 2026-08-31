import { describe, it, expect, vi, beforeEach } from 'vitest';

// REGION은 모듈 로드 시점에 읽으므로 import 전에 고정 (테스트 결정성)
process.env.AWS_REGION = 'ap-northeast-2';

const dcSend = vi.fn();
vi.mock('@aws-sdk/client-direct-connect', () => ({
  DirectConnectClient: class {
    constructor(public cfg: { region: string }) {}
    send(cmd: unknown) { return dcSend(cmd, this.cfg.region); }
  },
  DescribeConnectionsCommand: class { constructor(public input: unknown) {} },
  DescribeVirtualInterfacesCommand: class { constructor(public input: unknown) {} },
  DescribeDirectConnectGatewaysCommand: class { constructor(public input: unknown) {} },
  DescribeDirectConnectGatewayAssociationsCommand: class { constructor(public input: unknown) {} },
  DescribeLagsCommand: class { constructor(public input: unknown) {} },
  ListVirtualInterfaceRoutesCommand: class { constructor(public input: unknown) {} },
}));

const cwSend = vi.fn();
vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class {
    constructor(public cfg: { region: string }) {}
    send(cmd: unknown) { return cwSend(cmd, this.cfg.region); }
  },
  ListMetricsCommand: class { constructor(public input: unknown) {} },
  GetMetricDataCommand: class { constructor(public input: unknown) {} },
}));

const mockQuery = vi.fn();
vi.mock('./db', () => ({ getPool: () => ({ query: mockQuery }) }));

beforeEach(async () => {
  dcSend.mockReset();
  cwSend.mockReset();
  mockQuery.mockReset();
  const { _resetDxCacheForTests } = await import('./dx');
  _resetDxCacheForTests();
});

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

function mockDb(regions: string[]) {
  mockQuery.mockImplementation(async () => ({ rows: regions.map((region) => ({ region })) }));
}

/** 표준 커넥션 2개 (같은 로케이션 TLS10, 50Mbps) — 스테이징 실측 형태. */
const CONNS = [
  {
    connectionId: 'dxcon-1', connectionName: 'awsdx1_305', connectionState: 'available',
    region: 'ap-northeast-2', location: 'TLS10', bandwidth: '50Mbps', vlan: 305,
    partnerName: 'AWS Korea Lab Partner', awsDeviceV2: 'TLS10-a', jumboFrameCapable: true,
    macSecCapable: false, hasLogicalRedundancy: 'no',
  },
  {
    connectionId: 'dxcon-2', connectionName: 'awsdx2_405', connectionState: 'available',
    region: 'ap-northeast-2', location: 'TLS10', bandwidth: '50Mbps', vlan: 405,
    partnerName: 'AWS Korea Lab Partner', awsDeviceV2: 'TLS10-b', jumboFrameCapable: true,
    macSecCapable: false, hasLogicalRedundancy: 'no',
  },
];

/** transit VIF 2개 — 1개는 BGP down. authKey/customerRouterConfig 민감 필드 포함(응답 원형). */
const VIFS = [
  {
    virtualInterfaceId: 'dxvif-1', virtualInterfaceName: 'VIF305', virtualInterfaceType: 'transit',
    virtualInterfaceState: 'available', region: 'ap-northeast-2', connectionId: 'dxcon-1',
    vlan: 305, mtu: 1500, jumboFrameCapable: true, asn: 65011, amazonSideAsn: 65001,
    addressFamily: 'ipv4', amazonAddress: '169.254.96.25/29', customerAddress: '169.254.96.30/29',
    authKey: '0xTOPSECRET-BGP-KEY', customerRouterConfig: '<xml>0xTOPSECRET-BGP-KEY</xml>',
    directConnectGatewayId: 'dxgw-abc', virtualGatewayId: '', siteLinkEnabled: false,
    bgpPeers: [{ bgpPeerId: 'dxpeer-1', addressFamily: 'ipv4', authKey: '0xTOPSECRET-BGP-KEY', bgpPeerState: 'available', bgpStatus: 'up' }],
  },
  {
    virtualInterfaceId: 'dxvif-2', virtualInterfaceName: 'VIF405', virtualInterfaceType: 'transit',
    virtualInterfaceState: 'available', region: 'ap-northeast-2', connectionId: 'dxcon-2',
    vlan: 405, mtu: 1500, jumboFrameCapable: true, asn: 65011, amazonSideAsn: 65001,
    addressFamily: 'ipv4',
    authKey: '0xTOPSECRET-BGP-KEY',
    directConnectGatewayId: 'dxgw-abc', virtualGatewayId: '', siteLinkEnabled: false,
    bgpPeers: [{ bgpPeerId: 'dxpeer-2', addressFamily: 'ipv4', authKey: '0xTOPSECRET-BGP-KEY', bgpPeerState: 'available', bgpStatus: 'down' }],
  },
];

const GW = {
  directConnectGatewayId: 'dxgw-abc', directConnectGatewayName: 'DXGW-01',
  directConnectGatewayState: 'available', amazonSideAsn: 65001, ownerAccount: '061525506239',
};
const ASSOC = {
  associationState: 'associated',
  associatedGateway: { id: 'tgw-1', type: 'transitGateway', region: 'ap-northeast-2' },
  allowedPrefixesToDirectConnectGateway: [{ cidr: '10.0.0.0/8' }],
};

/** 실 API 형태의 라우트 응답 (accepted 2 + advertised 1 — 스테이징 실측). */
const ROUTES = [
  {
    cidr: '10.0.0.0/8', routeDirection: 'accepted', addressFamily: 'ipv4',
    asPath: [{ pathType: 'seq', path: [65011, 65001] }], communities: [],
    routeInstalledAt: '2026-08-05T07:47:06.114Z',
  },
  {
    cidr: '172.20.5.0/24', routeDirection: 'accepted', addressFamily: 'ipv4',
    asPath: [{ pathType: 'seq', path: [65011] }], communities: ['65011:100'],
    routeInstalledAt: '2026-08-05T07:47:06.114Z',
  },
  {
    cidr: '10.0.0.0/8', routeDirection: 'advertised', addressFamily: 'ipv4',
    asPath: [{ pathType: 'seq', path: [65001] }], communities: [],
    routeInstalledAt: '2026-08-05T07:46:22.114Z',
  },
];

/** DirectConnect send 디스패치 — 커맨드 이름별 리전별 응답. */
function mockDc(opts: {
  conns?: Record<string, unknown[]>; vifs?: Record<string, unknown[]>;
  gws?: unknown[]; assocs?: unknown[]; failRegions?: string[];
  lags?: unknown[]; routes?: Record<string, unknown[]>; routesFail?: boolean; assocsFail?: boolean;
} = {}) {
  dcSend.mockImplementation(async (cmd: Cmd, region: string) => {
    if (opts.failRegions?.includes(region)) throw new Error(`boom ${region}`);
    switch (cmd.constructor.name) {
      case 'DescribeConnectionsCommand': return { connections: opts.conns?.[region] ?? [] };
      case 'DescribeVirtualInterfacesCommand': return { virtualInterfaces: opts.vifs?.[region] ?? [] };
      case 'DescribeDirectConnectGatewaysCommand': return { directConnectGateways: opts.gws ?? [] };
      case 'DescribeDirectConnectGatewayAssociationsCommand': {
        if (opts.assocsFail) throw new Error('AccessDenied');
        return { directConnectGatewayAssociations: opts.assocs ?? [] };
      }
      case 'DescribeLagsCommand': return { lags: opts.lags ?? [] };
      case 'ListVirtualInterfaceRoutesCommand': {
        if (opts.routesFail) throw new Error('UnknownOperationException');
        const vifId = (cmd.input as { virtualInterfaceId: string }).virtualInterfaceId;
        return { routes: opts.routes?.[vifId] ?? [] };
      }
      default: throw new Error(`unexpected ${cmd.constructor.name}`);
    }
  });
}

/** CW 응답 — ListMetrics(BgpStatus 튜플) + GetMetricData(Id→값). */
function mockCw(bgpVifIds: string[], data: Record<string, number>) {
  cwSend.mockImplementation(async (cmd: Cmd) => {
    if (cmd.constructor.name === 'ListMetricsCommand') {
      return {
        Metrics: bgpVifIds.map((id) => ({
          Dimensions: [
            { Name: 'ConnectionId', Value: 'dxcon-x' },
            { Name: 'IpAddressFamily', Value: 'IPv4' },
            { Name: 'VirtualInterfaceId', Value: id },
          ],
        })),
      };
    }
    return { MetricDataResults: Object.entries(data).map(([Id, v]) => ({ Id, Values: [v] })) };
  });
}

describe('parseBandwidth', () => {
  it('Mbps/Gbps 파싱, 미지 포맷은 0', async () => {
    const { parseBandwidth } = await import('./dx');
    expect(parseBandwidth('50Mbps')).toBe(50_000_000);
    expect(parseBandwidth('1Gbps')).toBe(1_000_000_000);
    expect(parseBandwidth('10Gbps')).toBe(10_000_000_000);
    expect(parseBandwidth('weird')).toBe(0);
    expect(parseBandwidth(undefined)).toBe(0);
  });
});

describe('dxAnalysis', () => {
  it('표준 시나리오: 이중화·BGP down·사용률·프리픽스·라우트·게이트웨이 연계', async () => {
    mockDb([]);
    mockDc({
      conns: { 'ap-northeast-2': CONNS }, vifs: { 'ap-northeast-2': VIFS },
      gws: [GW], assocs: [ASSOC], routes: { 'dxvif-1': ROUTES },
    });
    // dxvif-1: 피크 수신 25Mbps → 50Mbps 대비 50%(util 메트릭 부재 → 폴백 산출) / dxvif-2: 메트릭 없음(null 유지)
    mockCw(['dxvif-1'], {
      cs_i0: 1, cs_i1: 1,
      bpsinavg_i0: 1_000_000, bpsoutavg_i0: 500_000,
      bpsinmax_i0: 25_000_000, bpsoutmax_i0: 10_000_000,
      ppsinavg_i0: 3.86, ppsoutavg_i0: 1.2,
      bgp_i0: 1, pfxacc_i0: 2, pfxadv_i0: 1,
    });
    const { dxAnalysis } = await import('./dx');
    const a = await dxAnalysis(3600);

    expect(a.totals).toMatchObject({
      connections: 2, connectionsDown: 0,
      vifs: 2, vifsDown: 1, bgpPeersDown: 1,
      gateways: 1, gatewaysUnassociated: 0,
      totalBandwidthBps: 100_000_000, locations: 1,
      maxUtilizationPct: 50, singleLocation: true,
    });

    const v1 = a.vifs.find((v) => v.id === 'dxvif-1')!;
    expect(v1.peakUtilizationPct).toBe(50);
    expect(v1.bpsIngress).toBe(1_000_000);
    expect(v1.ppsIngress).toBe(3.86);
    expect(v1.ppsEgress).toBe(1.2);
    expect(v1.bgpStatusMin).toBe(1);
    expect(v1.prefixesAccepted).toBe(2);
    expect(v1.prefixesAdvertised).toBe(1);
    expect(v1.down).toBe(false);
    expect(v1.attachedTo).toBe('dxgw-abc');
    expect(v1.attachmentType).toBe('dx-gateway');
    // BGP 라우트 가시성 (ListVirtualInterfaceRoutes)
    expect(v1.routesAvailable).toBe(true);
    expect(v1.routes).toHaveLength(3);
    expect(v1.routes[0]).toEqual({
      vifId: 'dxvif-1', cidr: '10.0.0.0/8', direction: 'accepted', family: 'ipv4',
      asPath: '65011 65001', communities: [], installedAt: '2026-08-05T07:47:06.114Z',
    });
    expect(v1.routes[1].communities).toEqual(['65011:100']);
    expect(v1.routes.filter((r) => r.direction === 'advertised')).toHaveLength(1);

    const v2 = a.vifs.find((v) => v.id === 'dxvif-2')!;
    expect(v2.down).toBe(true); // BGP peer down
    expect(v2.peakUtilizationPct).toBeNull(); // 메트릭 없음
    expect(v2.bpsIngress).toBeNull();
    expect(v2.prefixesAccepted).toBeNull();
    expect(v2.routes).toEqual([]);

    const c1 = a.connections.find((c) => c.id === 'dxcon-1')!;
    expect(c1.bandwidthBps).toBe(50_000_000);
    expect(c1.vifCount).toBe(1);
    expect(c1.stateMetricMin).toBe(1);
    expect(c1.down).toBe(false);

    const g = a.gateways[0];
    expect(g.associations).toEqual([
      { id: 'tgw-1', type: 'transitGateway', state: 'associated', region: 'ap-northeast-2', cidrs: ['10.0.0.0/8'] },
    ]);
    expect(g.vifCount).toBe(2);
    expect(g.unassociated).toBe(false);

    expect(a.locations).toEqual([
      { location: 'TLS10', region: 'ap-northeast-2', connections: 2, bandwidthBps: 100_000_000 },
    ]);
    expect(a.degradedRegions).toEqual([]);
    expect(a.metricsDegradedRegions).toEqual([]);
    expect(a.gatewaysDegraded).toBe(false);
  });

  it('민감정보(authKey/customerRouterConfig)는 어떤 형태로도 응답에 실리지 않음', async () => {
    mockDb([]);
    mockDc({ conns: { 'ap-northeast-2': CONNS }, vifs: { 'ap-northeast-2': VIFS }, gws: [GW], assocs: [ASSOC] });
    mockCw([], {});
    const { dxAnalysis } = await import('./dx');
    const a = await dxAnalysis(3600);
    const serialized = JSON.stringify(a);
    expect(serialized).not.toContain('TOPSECRET');
    expect(serialized).not.toContain('authKey');
    expect(serialized).not.toContain('customerRouterConfig');
    // 피어 요약은 상태만 노출
    expect(a.vifs[0].bgpPeers).toEqual(['dxpeer-1 ipv4 up']);
  });

  it('멀티 로케이션 → singleLocation false, 커넥션 down 상태 집계', async () => {
    mockDb([]);
    mockDc({
      conns: {
        'ap-northeast-2': [
          { ...CONNS[0] },
          { ...CONNS[1], connectionId: 'dxcon-3', location: 'SEL62', connectionState: 'down' },
        ],
      },
      vifs: { 'ap-northeast-2': [] },
      gws: [],
    });
    mockCw([], { cs_i0: 1 });
    const { dxAnalysis } = await import('./dx');
    const a = await dxAnalysis(3600);
    expect(a.totals.singleLocation).toBe(false);
    expect(a.totals.locations).toBe(2);
    expect(a.totals.connectionsDown).toBe(1);
    expect(a.connections.find((c) => c.id === 'dxcon-3')!.down).toBe(true);
  });

  it('기간 내 ConnectionState 0 감지 → API state available이어도 down 표기', async () => {
    mockDb([]);
    mockDc({ conns: { 'ap-northeast-2': [CONNS[0]] }, vifs: { 'ap-northeast-2': [] }, gws: [] });
    mockCw([], { cs_i0: 0 });
    const { dxAnalysis } = await import('./dx');
    const a = await dxAnalysis(3600);
    expect(a.connections[0].stateMetricMin).toBe(0);
    expect(a.connections[0].down).toBe(true);
    expect(a.totals.connectionsDown).toBe(1);
  });

  it('리전 degrade: 실패 리전은 건너뛰고 나머지 리전+게이트웨이 유지, degradedRegions에 노출', async () => {
    mockDb(['us-west-2']);
    mockDc({
      conns: { 'ap-northeast-2': [CONNS[0]] },
      vifs: { 'ap-northeast-2': [VIFS[0]] },
      gws: [GW], assocs: [ASSOC],
      failRegions: ['us-west-2'],
    });
    mockCw([], {});
    const { dxAnalysis } = await import('./dx');
    const a = await dxAnalysis(3600);
    expect(a.connections).toHaveLength(1);
    expect(a.vifs).toHaveLength(1);
    expect(a.gateways).toHaveLength(1);
    // 실패 리전을 조용히 삼키지 않고 노출 — UI가 singleLocation/다운/대역폭 집계가
    // 낙관적일 수 있음을 경고할 근거.
    expect(a.degradedRegions).toEqual(['us-west-2']);
    expect(a.metricsDegradedRegions).toEqual([]);
    expect(a.gatewaysDegraded).toBe(false);
  });

  it('메트릭 degrade: CloudWatch 호출 자체 실패 → metricsDegradedRegions에 노출, 리소스 목록은 유지', async () => {
    mockDb([]);
    mockDc({ conns: { 'ap-northeast-2': [CONNS[0]] }, vifs: { 'ap-northeast-2': [VIFS[0]] }, gws: [GW], assocs: [ASSOC] });
    cwSend.mockImplementation(async () => { throw new Error('boom cw'); });
    const { dxAnalysis } = await import('./dx');
    const a = await dxAnalysis(3600);
    expect(a.connections).toHaveLength(1);
    expect(a.vifs).toHaveLength(1);
    expect(a.degradedRegions).toEqual([]);
    expect(a.metricsDegradedRegions).toEqual(['ap-northeast-2']);
    expect(a.gatewaysDegraded).toBe(false);
  });

  it('DX Gateway degrade: DescribeDirectConnectGateways 실패 → gatewaysDegraded true, 나머지 데이터 유지', async () => {
    mockDb([]);
    mockDc({ conns: { 'ap-northeast-2': [CONNS[0]] }, vifs: { 'ap-northeast-2': [VIFS[0]] } });
    dcSend.mockImplementation(async (cmd: Cmd, region: string) => {
      if (cmd.constructor.name === 'DescribeDirectConnectGatewaysCommand') throw new Error('boom gw');
      switch (cmd.constructor.name) {
        case 'DescribeConnectionsCommand': return { connections: region === 'ap-northeast-2' ? [CONNS[0]] : [] };
        case 'DescribeVirtualInterfacesCommand': return { virtualInterfaces: region === 'ap-northeast-2' ? [VIFS[0]] : [] };
        case 'DescribeLagsCommand': return { lags: [] };
        case 'ListVirtualInterfaceRoutesCommand': return { routes: [] };
        default: return {};
      }
    });
    mockCw([], {});
    const { dxAnalysis } = await import('./dx');
    const a = await dxAnalysis(3600);
    expect(a.connections).toHaveLength(1);
    expect(a.gateways).toEqual([]);
    expect(a.gatewaysDegraded).toBe(true);
  });

  it('메트릭 전무(CW 미발행) → 트래픽/사용률 null, API 상태만으로 판정', async () => {
    mockDb([]);
    mockDc({ conns: { 'ap-northeast-2': [CONNS[0]] }, vifs: { 'ap-northeast-2': [VIFS[0]] }, gws: [] });
    cwSend.mockImplementation(async (cmd: Cmd) =>
      cmd.constructor.name === 'ListMetricsCommand' ? { Metrics: [] } : { MetricDataResults: [] });
    const { dxAnalysis } = await import('./dx');
    const a = await dxAnalysis(3600);
    const v = a.vifs[0];
    expect(v.bpsIngress).toBeNull();
    expect(v.peakUtilizationPct).toBeNull();
    expect(v.bgpStatusMin).toBeNull();
    expect(a.connections[0].stateMetricMin).toBeNull();
    expect(a.connections[0].down).toBe(false);
    expect(a.totals.maxUtilizationPct).toBeNull();
  });

  it('미연결 DX Gateway 플래그', async () => {
    mockDb([]);
    mockDc({ conns: {}, vifs: {}, gws: [GW], assocs: [] });
    mockCw([], {});
    const { dxAnalysis } = await import('./dx');
    const a = await dxAnalysis(3600);
    expect(a.gateways[0].unassociated).toBe(true);
    expect(a.gateways[0].vifCount).toBe(0);
    expect(a.totals.gatewaysUnassociated).toBe(1);
    expect(a.totals.singleLocation).toBe(false); // 커넥션 0 → 경고 아님
  });

  it('대역폭 파싱 불가 커넥션의 VIF → 사용률 null (0 나눗셈 방지)', async () => {
    mockDb([]);
    mockDc({
      conns: { 'ap-northeast-2': [{ ...CONNS[0], bandwidth: 'unknown' }] },
      vifs: { 'ap-northeast-2': [VIFS[0]] },
      gws: [],
    });
    mockCw([], { bpsinmax_i0: 25_000_000 });
    const { dxAnalysis } = await import('./dx');
    const a = await dxAnalysis(3600);
    expect(a.vifs[0].peakBpsIngress).toBe(25_000_000);
    expect(a.vifs[0].peakUtilizationPct).toBeNull();
  });

  it('기간 내 BgpStatus 0 감지 → 현재 피어 up이어도 VIF down + vifsDown 집계', async () => {
    mockDb([]);
    mockDc({ conns: { 'ap-northeast-2': [CONNS[0]] }, vifs: { 'ap-northeast-2': [VIFS[0]] }, gws: [] });
    mockCw(['dxvif-1'], { cs_i0: 1, bgp_i0: 0 });
    const { dxAnalysis } = await import('./dx');
    const a = await dxAnalysis(3600);
    expect(a.vifs[0].bgpPeersUp).toBe(1); // 현재는 up
    expect(a.vifs[0].bgpStatusMin).toBe(0);
    expect(a.vifs[0].down).toBe(true); // 기간 내 플랩 감지
    expect(a.totals.vifsDown).toBe(1);
  });

  it('Utilization 메트릭(퍼센트 발행)이 있으면 bps 산출보다 우선 — 미세값도 0으로 뭉개지지 않음', async () => {
    mockDb([]);
    mockDc({ conns: { 'ap-northeast-2': [CONNS[0]] }, vifs: { 'ap-northeast-2': [VIFS[0]] }, gws: [] });
    // 산출값(25e6/50e6=50%)과 다른 메트릭 값 → 메트릭이 이겨야 함
    mockCw([], { bpsinmax_i0: 25_000_000, utilinmax_i0: 0.0033, utiloutmax_i0: 0.001 });
    const { dxAnalysis } = await import('./dx');
    const a = await dxAnalysis(3600);
    expect(a.vifs[0].peakUtilizationPct).toBe(0.0033); // 유효숫자 2자리 유지
  });

  it('미구성 패밀리(IPv6) BgpStatus 튜플은 채택하지 않음 — 상시 0 발행에 의한 영구 다운 오탐 방지', async () => {
    mockDb([]);
    // VIFS[0]는 ipv4 피어만 보유 — ListMetrics가 IPv4+IPv6 튜플을 모두 반환(실측 형태)
    mockDc({ conns: { 'ap-northeast-2': [CONNS[0]] }, vifs: { 'ap-northeast-2': [VIFS[0]] }, gws: [] });
    cwSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'ListMetricsCommand') {
        return {
          Metrics: ['IPv4', 'IPv6'].map((fam) => ({
            Dimensions: [
              { Name: 'ConnectionId', Value: 'dxcon-1' },
              { Name: 'IpAddressFamily', Value: fam },
              { Name: 'VirtualInterfaceId', Value: 'dxvif-1' },
            ],
          })),
        };
      }
      // 필터링 후 튜플은 IPv4 1개뿐 → bgp_i0만 질의됨. IPv6이 채택됐다면 bgp_i1(0)이 min을 오염.
      return { MetricDataResults: [{ Id: 'bgp_i0', Values: [1] }, { Id: 'bgp_i1', Values: [0] }] };
    });
    const { dxAnalysis } = await import('./dx');
    const a = await dxAnalysis(3600);
    expect(a.vifs[0].bgpStatusMin).toBe(1);
    expect(a.vifs[0].down).toBe(false);
    // 실제 질의된 BgpStatus 튜플이 IPv4 1개뿐인지 확인
    const gmdCalls = cwSend.mock.calls.filter(([c]) => (c as Cmd).constructor.name === 'GetMetricDataCommand');
    const bgpQueries = gmdCalls.flatMap(([c]) => ((c as Cmd).input as { MetricDataQueries: { Id: string }[] }).MetricDataQueries)
      .filter((q) => q.Id.startsWith('bgp_'));
    expect(bgpQueries).toHaveLength(1);
  });

  it('LAG 위 VIF: DescribeLags 대역폭(개별 대역폭 × 커넥션 수)으로 사용률 산출', async () => {
    mockDb([]);
    mockDc({
      conns: { 'ap-northeast-2': [] },
      vifs: { 'ap-northeast-2': [{ ...VIFS[0], connectionId: 'dxlag-1' }] },
      gws: [],
      lags: [{ lagId: 'dxlag-1', connectionsBandwidth: '10Gbps', numberOfConnections: 2 }],
    });
    mockCw([], { bpsinmax_i0: 10_000_000_000 }); // 10Gbps 피크 / 20Gbps LAG = 50%
    const { dxAnalysis } = await import('./dx');
    const a = await dxAnalysis(3600);
    expect(a.vifs[0].peakUtilizationPct).toBe(50);
  });

  it('ListMetrics만 실패(BGP 튜플 발견 불가, 스로틀링 전형) → metricsDegradedRegions 표기', async () => {
    // PR #210 리뷰 MAJOR: 기존 테스트는 CW 명령 전체를 throw시켜 outer catch만 커버했다 —
    // ListMetrics-only 실패는 bgpMin/pfx*가 전부 null로 강등되는데 무신호였다.
    mockDb([]);
    mockDc({ conns: { 'ap-northeast-2': [CONNS[0]] }, vifs: { 'ap-northeast-2': [VIFS[0]] }, gws: [] });
    cwSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'ListMetricsCommand') throw new Error('Throttling');
      return { MetricDataResults: [] };
    });
    const { dxAnalysis } = await import('./dx');
    const a = await dxAnalysis(3600);
    expect(a.metricsDegradedRegions).toContain('ap-northeast-2');
    expect(a.connections).toHaveLength(1); // 리소스 목록은 정상 유지
  });

  it('커넥션 100건 캡 초과 → 잘린 리소스 무신호 금지, metricsDegradedRegions 표기', async () => {
    // 리뷰 라운드3 MAJOR L2-1: slice(0,100) 캡이 물면 잘린 커넥션의 connState가 조용히
    // null 강등되는데 ok=true로 남아 새 degrade 계약을 우회했다.
    mockDb([]);
    const many = Array.from({ length: 101 }, (_, i) => ({ ...CONNS[0], connectionId: `dxcon-${i}` }));
    mockDc({ conns: { 'ap-northeast-2': many }, vifs: { 'ap-northeast-2': [] }, gws: [] });
    mockCw([], {});
    const { dxAnalysis } = await import('./dx');
    const a = await dxAnalysis(3600);
    expect(a.metricsDegradedRegions).toContain('ap-northeast-2');
    expect(a.connections).toHaveLength(101); // 리소스 목록 자체는 전량 유지 (메트릭만 캡)
  });

  it('association 조회만 실패 → associationsAvailable false, unassociated 오탐/집계 없음', async () => {
    // PR #210 리뷰 MAJOR: inner catch가 associations:[]를 남겨 unassociated=true가
    // "위험을 발명"했다 — 판정 불가는 미할당이 아니다.
    mockDb([]);
    mockDc({
      conns: {}, vifs: {},
      gws: [{ directConnectGatewayId: 'dxgw-1', directConnectGatewayName: 'gw', directConnectGatewayState: 'available' }],
      assocsFail: true,
    });
    mockCw([], {});
    const { dxAnalysis } = await import('./dx');
    const a = await dxAnalysis(3600);
    expect(a.gateways[0].associationsAvailable).toBe(false);
    expect(a.gateways[0].unassociated).toBe(false);
    expect(a.totals.gatewaysUnassociated).toBe(0);
    expect(a.totals.gatewaysAssociationsUnknown).toBe(1); // 집계·배너 신호 (리뷰 MAJOR: 행에서만 멈추면 안 됨)
    expect(a.gatewaysDegraded).toBe(false); // 게이트웨이 목록 자체는 성공
  });

  it('라우트 API 실패(미지원 리전 등) → routesAvailable false, 나머지 데이터 유지', async () => {
    mockDb([]);
    mockDc({ conns: { 'ap-northeast-2': [CONNS[0]] }, vifs: { 'ap-northeast-2': [VIFS[0]] }, gws: [], routesFail: true });
    mockCw([], {});
    const { dxAnalysis } = await import('./dx');
    const a = await dxAnalysis(3600);
    expect(a.vifs[0].routesAvailable).toBe(false);
    expect(a.vifs[0].routes).toEqual([]);
    expect(a.vifs[0].id).toBe('dxvif-1'); // VIF 자체는 정상
  });

  it('라우트 200건 캡 → truncated 표기', async () => {
    mockDb([]);
    const many = Array.from({ length: 250 }, (_, i) => ({
      cidr: `10.${Math.floor(i / 250 * 200)}.${i % 250}.0/24`, routeDirection: 'accepted', addressFamily: 'ipv4',
      asPath: [{ pathType: 'seq', path: [65011] }], communities: [],
    }));
    mockDc({
      conns: { 'ap-northeast-2': [CONNS[0]] }, vifs: { 'ap-northeast-2': [VIFS[0]] }, gws: [],
      routes: { 'dxvif-1': many },
    });
    mockCw([], {});
    const { dxAnalysis } = await import('./dx');
    const a = await dxAnalysis(3600);
    expect(a.vifs[0].routes).toHaveLength(200);
    expect(a.vifs[0].routesTruncated).toBe(true);
  });

  it('GetMetricData 쿼리는 호출당 500개 이하로 청크 분할', async () => {
    mockDb([]);
    const conns = Array.from({ length: 60 }, (_, i) => ({ ...CONNS[0], connectionId: `dxcon-${i}` }));
    const vifs = Array.from({ length: 80 }, (_, i) => ({
      ...VIFS[0], virtualInterfaceId: `dxvif-${i}`, connectionId: `dxcon-${i % 60}`, bgpPeers: [],
    }));
    mockDc({ conns: { 'ap-northeast-2': conns }, vifs: { 'ap-northeast-2': vifs }, gws: [] });
    const sizes: number[] = [];
    cwSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'ListMetricsCommand') return { Metrics: [] };
      sizes.push((cmd.input as { MetricDataQueries: unknown[] }).MetricDataQueries.length);
      return { MetricDataResults: [] };
    });
    const { dxAnalysis } = await import('./dx');
    await dxAnalysis(3600);
    // 60 conns + 80 vifs × 8 = 700 queries → 500 + 200 두 번 호출
    expect(sizes.reduce((s, n) => s + n, 0)).toBe(700);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(500);
    expect(sizes.length).toBe(2);
  });
});
