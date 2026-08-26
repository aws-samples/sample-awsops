import { describe, it, expect, vi, beforeEach } from 'vitest';

// REGION은 모듈 로드 시점에 읽으므로 import 전에 고정 (테스트 결정성)
process.env.AWS_REGION = 'ap-northeast-2';

const ec2Send = vi.fn();
vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: class {
    constructor(public cfg: { region: string }) {}
    send(cmd: unknown) { return ec2Send(cmd, this.cfg.region); }
  },
  DescribeVpcEndpointsCommand: class { constructor(public input: unknown) {} },
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
  ec2Send.mockReset();
  cwSend.mockReset();
  mockQuery.mockReset();
  const { _resetVpceCacheForTests } = await import('./vpce');
  _resetVpceCacheForTests();
});

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

/** getPool().query 모킹 — SQL 텍스트로 regions/vpc 목록 쿼리 dispatch. */
function mockDb(regions: string[], vpcs: { resource_id: string; region: string | null }[]) {
  mockQuery.mockImplementation(async (sql: string) =>
    sql.includes('DISTINCT region')
      ? { rows: regions.map((region) => ({ region })) }
      : { rows: vpcs });
}

const listMetricsFor = (ids: string[]) => ({
  Metrics: ids.map((id) => ({
    Dimensions: [
      { Name: 'VPC Endpoint Id', Value: id },
      { Name: 'Endpoint Type', Value: 'Interface' },
    ],
  })),
});

/** GetMetricData 응답 — { 'bytesProcessed_i0': 0, ... } 형태로 Values 구성. */
const metricData = (entries: Record<string, number>) => ({
  MetricDataResults: Object.entries(entries).map(([Id, v]) => ({ Id, Values: [v] })),
});

const openPolicy = JSON.stringify({ Statement: [{ Effect: 'Allow', Action: '*', Principal: '*', Resource: '*' }] });

describe('policyIsOpen (vpceAnalysis 경유)', () => {
  it("Action '*' + Principal '*' → policyOpen true, 제한 정책/파싱 불가 → false", async () => {
    mockDb([], []); // regions = [REGION]
    cwSend.mockResolvedValue({ Metrics: [] });
    ec2Send.mockResolvedValue({
      VpcEndpoints: [
        { VpcEndpointId: 'vpce-open', VpcEndpointType: 'Gateway', ServiceName: 'com.amazonaws.ap-northeast-2.s3', PolicyDocument: openPolicy },
        {
          VpcEndpointId: 'vpce-open-arr', VpcEndpointType: 'Gateway', ServiceName: 'com.amazonaws.ap-northeast-2.dynamodb',
          PolicyDocument: JSON.stringify({ Statement: [{ Effect: 'Allow', Action: ['*'], Principal: { AWS: '*' } }] }),
        },
        {
          VpcEndpointId: 'vpce-restricted', VpcEndpointType: 'Gateway', ServiceName: 'com.amazonaws.ap-northeast-2.s3',
          PolicyDocument: JSON.stringify({ Statement: [{ Effect: 'Allow', Action: ['s3:GetObject'], Principal: { AWS: 'arn:aws:iam::111122223333:root' } }] }),
        },
        { VpcEndpointId: 'vpce-garbage', VpcEndpointType: 'Gateway', ServiceName: 'com.amazonaws.ap-northeast-2.s3', PolicyDocument: 'not-json {{{' },
        { VpcEndpointId: 'vpce-nopolicy', VpcEndpointType: 'Gateway', ServiceName: 'com.amazonaws.ap-northeast-2.s3' },
      ],
    });
    const { vpceAnalysis } = await import('./vpce');
    const a = await vpceAnalysis(3600);
    expect(a.rows.map((r) => [r.id, r.policyOpen])).toEqual([
      ['vpce-open', true],
      ['vpce-open-arr', true],
      ['vpce-restricted', false],
      ['vpce-garbage', false],
      ['vpce-nopolicy', false],
    ]);
    expect(a.totals.policyOpen).toBe(2);
  });
});

/** Interface 2개(idle/busy) + Gateway 1개 표준 시나리오 셋업. */
function setupMixedEndpoints() {
  mockDb([], []);
  ec2Send.mockResolvedValue({
    VpcEndpoints: [
      {
        VpcEndpointId: 'vpce-idle', VpcId: 'vpc-a', VpcEndpointType: 'Interface', State: 'available',
        ServiceName: 'com.amazonaws.ap-northeast-2.ssm',
        SubnetIds: ['subnet-1', 'subnet-2'], NetworkInterfaceIds: ['eni-1', 'eni-2'],
        PrivateDnsEnabled: false, CreationTimestamp: '2026-01-01T00:00:00.000Z',
      },
      {
        VpcEndpointId: 'vpce-busy', VpcId: 'vpc-a', VpcEndpointType: 'Interface', State: 'available',
        ServiceName: 'com.amazonaws.ap-northeast-2.ecr.dkr',
        SubnetIds: ['subnet-1', 'subnet-2', 'subnet-3'], NetworkInterfaceIds: ['eni-3', 'eni-4', 'eni-5'],
        PrivateDnsEnabled: true,
      },
      {
        VpcEndpointId: 'vpce-gw', VpcId: 'vpc-a', VpcEndpointType: 'Gateway', State: 'available',
        ServiceName: 'com.amazonaws.ap-northeast-2.s3',
        PrivateDnsEnabled: true, // Gateway는 row에서 null이어야 함
      },
    ],
  });
  cwSend.mockImplementation(async (cmd: Cmd) => {
    if (cmd.constructor.name === 'ListMetricsCommand') return listMetricsFor(['vpce-idle', 'vpce-busy']);
    if (cmd.constructor.name === 'GetMetricDataCommand') {
      return metricData({
        bytesProcessed_i0: 0, // idle: 트래픽 0 → unused
        bytesProcessed_i1: 5_000_000, activeConnections_i1: 42, newConnections_i1: 10, packetsDropped_i1: 1,
      });
    }
    throw new Error(`unexpected ${cmd.constructor.name}`);
  });
}

describe('vpceAnalysis rows (unused 감지 + service 접두사 제거)', () => {
  it('Interface: bytesProcessed 0 → unused true, 트래픽 있으면 false; Gateway: unused false + privateDnsEnabled null', async () => {
    setupMixedEndpoints();
    const { vpceAnalysis } = await import('./vpce');
    const a = await vpceAnalysis(3600);

    const idle = a.rows.find((r) => r.id === 'vpce-idle');
    expect(idle).toMatchObject({
      service: 'ssm', serviceName: 'com.amazonaws.ap-northeast-2.ssm',
      type: 'Interface', region: 'ap-northeast-2', vpcId: 'vpc-a',
      subnetCount: 2, eniCount: 2, privateDnsEnabled: false,
      bytesProcessed: 0, activeConnections: null, // GetMetricData에 없는 시리즈는 null 유지
      unused: true, createdAt: '2026-01-01T00:00:00.000Z',
    });

    const busy = a.rows.find((r) => r.id === 'vpce-busy');
    expect(busy).toMatchObject({
      service: 'ecr.dkr', // com.amazonaws.<region>. 접두사만 제거
      bytesProcessed: 5_000_000, activeConnections: 42, newConnections: 10, packetsDropped: 1,
      privateDnsEnabled: true, unused: false, createdAt: null,
    });

    const gw = a.rows.find((r) => r.id === 'vpce-gw');
    expect(gw).toMatchObject({ service: 's3', type: 'Gateway', unused: false, privateDnsEnabled: null });
  });
});

describe('coverageGaps', () => {
  it('s3 gateway 있는 VPC는 dynamodb만 missing, 없는 VPC는 둘 다 missing', async () => {
    mockDb(['ap-northeast-2'], [
      { resource_id: 'vpc-a', region: 'ap-northeast-2' },
      { resource_id: 'vpc-b', region: null }, // region null → REGION 폴백
    ]);
    cwSend.mockResolvedValue({ Metrics: [] });
    ec2Send.mockResolvedValue({
      VpcEndpoints: [
        { VpcEndpointId: 'vpce-s3', VpcId: 'vpc-a', VpcEndpointType: 'Gateway', ServiceName: 'com.amazonaws.ap-northeast-2.s3' },
        // Interface ssm은 gateway 커버리지에 기여하지 않음
        { VpcEndpointId: 'vpce-if', VpcId: 'vpc-b', VpcEndpointType: 'Interface', ServiceName: 'com.amazonaws.ap-northeast-2.ssm' },
      ],
    });
    const { vpceAnalysis } = await import('./vpce');
    const a = await vpceAnalysis(3600);
    expect(a.coverageGaps).toEqual([
      { vpcId: 'vpc-a', region: 'ap-northeast-2', missing: ['dynamodb'] },
      { vpcId: 'vpc-b', region: 'ap-northeast-2', missing: ['s3', 'dynamodb'] },
    ]);
  });
});

describe('totals + 캐시', () => {
  it('estMonthlyUsd = Interface ENI 합 × 0.0126 × 720 (반올림); 재호출 시 send 증가 0', async () => {
    setupMixedEndpoints();
    const { vpceAnalysis } = await import('./vpce');
    const a = await vpceAnalysis(3600);

    expect(a.totals).toEqual({
      total: 3, interface: 2, gateway: 1, gwlb: 0,
      unused: 1, policyOpen: 0, privateDnsOff: 1,
      estMonthlyUsd: 45.36, // (2+3) ENI × 0.0126 × 24 × 30 = 45.36
    });
    expect(a.rangeSec).toBe(3600);

    const ec2Calls = ec2Send.mock.calls.length;
    const cwCalls = cwSend.mock.calls.length;
    const dbCalls = mockQuery.mock.calls.length;
    const b = await vpceAnalysis(3600); // 캐시 히트
    expect(b).toEqual(a);
    expect(ec2Send.mock.calls.length).toBe(ec2Calls);
    expect(cwSend.mock.calls.length).toBe(cwCalls);
    expect(mockQuery.mock.calls.length).toBe(dbCalls);
  });
});

describe('리전 degrade', () => {
  it('한 리전 DescribeVpcEndpoints 실패 시 나머지 리전 rows는 유지', async () => {
    mockDb(['us-east-1', 'ap-northeast-2'], []);
    cwSend.mockResolvedValue({ Metrics: [] });
    ec2Send.mockImplementation(async (_cmd: Cmd, region: string) => {
      if (region === 'us-east-1') throw new Error('AccessDenied');
      return {
        VpcEndpoints: [
          { VpcEndpointId: 'vpce-ok', VpcId: 'vpc-x', VpcEndpointType: 'Interface', ServiceName: 'com.amazonaws.ap-northeast-2.ssm' },
        ],
      };
    });
    const { vpceAnalysis } = await import('./vpce');
    const a = await vpceAnalysis(3600);
    // 두 리전 모두 시도했고, 실패 리전만 조용히 제외
    expect(ec2Send).toHaveBeenCalledTimes(2);
    expect(a.rows.map((r) => [r.id, r.region])).toEqual([['vpce-ok', 'ap-northeast-2']]);
    expect(a.totals.total).toBe(1);
  });
});
