import { describe, it, expect, vi, beforeEach } from 'vitest';

// REGION은 모듈 로드 시점에 읽으므로 import 전에 고정 (테스트 결정성)
process.env.AWS_REGION = 'ap-northeast-2';

const nfwSend = vi.fn();
vi.mock('@aws-sdk/client-network-firewall', () => ({
  NetworkFirewallClient: class {
    constructor(public cfg: { region: string }) {}
    send(cmd: unknown) { return nfwSend(cmd, this.cfg.region); }
  },
  ListFirewallsCommand: class { constructor(public input: unknown) {} },
  DescribeFirewallCommand: class { constructor(public input: unknown) {} },
  ListFirewallPoliciesCommand: class { constructor(public input: unknown) {} },
  DescribeFirewallPolicyCommand: class { constructor(public input: unknown) {} },
  ListRuleGroupsCommand: class { constructor(public input: unknown) {} },
  DescribeRuleGroupCommand: class { constructor(public input: unknown) {} },
  DescribeLoggingConfigurationCommand: class { constructor(public input: unknown) {} },
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
  nfwSend.mockReset();
  cwSend.mockReset();
  mockQuery.mockReset();
  const { _resetAnfwCacheForTests } = await import('./anfw');
  _resetAnfwCacheForTests();
});

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

function mockDb(regions: string[]) {
  mockQuery.mockImplementation(async () => ({ rows: regions.map((region) => ({ region })) }));
}

// 스테이징 실측 형태 — 보호 3종 off, 로깅 FLOW+ALERT, AZ 2개 READY
const FW_DESCRIBE = {
  Firewall: {
    FirewallName: 'DMZVPC-nfw',
    FirewallPolicyArn: 'arn:aws:network-firewall:ap-northeast-2:1:firewall-policy/DMZVPC-fw-policy',
    VpcId: 'vpc-1',
    SubnetMappings: [{ SubnetId: 'subnet-a' }, { SubnetId: 'subnet-b' }],
    DeleteProtection: false, SubnetChangeProtection: false, FirewallPolicyChangeProtection: false,
    EncryptionConfiguration: { Type: 'AWS_OWNED_KMS_KEY' },
  },
  FirewallStatus: {
    Status: 'READY', ConfigurationSyncStateSummary: 'IN_SYNC',
    SyncStates: {
      'ap-northeast-2a': { Attachment: { SubnetId: 'subnet-a', EndpointId: 'vpce-1', Status: 'READY' } },
      'ap-northeast-2b': { Attachment: { SubnetId: 'subnet-b', EndpointId: 'vpce-2', Status: 'READY' } },
    },
  },
};
const LOGGING = {
  LoggingConfiguration: {
    LogDestinationConfigs: [
      { LogType: 'FLOW', LogDestinationType: 'CloudWatchLogs', LogDestination: { logGroup: '/nfw/flow' } },
      { LogType: 'ALERT', LogDestinationType: 'CloudWatchLogs', LogDestination: { logGroup: '/nfw/alert' } },
    ],
  },
};
const POLICY_DESCRIBE = {
  FirewallPolicyResponse: {
    FirewallPolicyName: 'DMZVPC-fw-policy', FirewallPolicyStatus: 'ACTIVE', NumberOfAssociations: 1,
    ConsumedStatelessRuleCapacity: 100, ConsumedStatefulRuleCapacity: 100,
    LastModifiedTime: '2026-07-02T09:22:12.503Z',
  },
  FirewallPolicy: {
    StatelessRuleGroupReferences: [{ ResourceArn: 'arn:aws:network-firewall:r:1:stateless-rulegroup/DMZVPC-stateless-allow-all' }],
    StatefulRuleGroupReferences: [{ ResourceArn: 'arn:aws:network-firewall:r:1:stateful-rulegroup/eksworkshop-container-attr-rg' }],
    StatelessDefaultActions: ['aws:forward_to_sfe'],
    StatelessFragmentDefaultActions: ['aws:forward_to_sfe'],
  },
};
const RG_LIST = [
  { Name: 'DMZVPC-stateful-default', Arn: 'arn:aws:network-firewall:r:1:stateful-rulegroup/DMZVPC-stateful-default' },
  { Name: 'DMZVPC-stateless-allow-all', Arn: 'arn:aws:network-firewall:r:1:stateless-rulegroup/DMZVPC-stateless-allow-all' },
];
// RulesSource(룰 본문)는 응답에 실리면 안 됨 — DescribeRuleGroup 원형에 포함해 회귀 검증
const RG_DESCRIBE: Record<string, unknown> = {
  'DMZVPC-stateful-default': {
    RuleGroup: { RulesSource: { RulesString: 'drop tcp $SECRET_RULE_BODY any -> any any\n# comment line\ndrop tcp $HOME_NET any -> any 23 (msg:"block outbound telnet"; sid:1000001; rev:1;)\nalert tcp any any -> any 80 (msg:"http watch"; sid:1000002;)' } },
    RuleGroupResponse: {
      RuleGroupName: 'DMZVPC-stateful-default', Type: 'STATEFUL', RuleGroupStatus: 'ACTIVE',
      Capacity: 100, ConsumedCapacity: 3, NumberOfAssociations: 0,
      LastModifiedTime: '2026-03-10T14:37:54.601Z',
    },
  },
  'DMZVPC-stateless-allow-all': {
    RuleGroupResponse: {
      RuleGroupName: 'DMZVPC-stateless-allow-all', Type: 'STATELESS', RuleGroupStatus: 'ACTIVE',
      Capacity: 100, ConsumedCapacity: 90, NumberOfAssociations: 1,
    },
  },
};

function mockNfw(overrides: {
  fws?: unknown[]; fwDescribe?: unknown; logging?: unknown;
  policies?: unknown[]; policyDescribe?: unknown;
  rgs?: unknown[]; failRegions?: string[];
} = {}) {
  nfwSend.mockImplementation(async (cmd: Cmd, region: string) => {
    if (overrides.failRegions?.includes(region)) throw new Error(`boom ${region}`);
    switch (cmd.constructor.name) {
      case 'ListFirewallsCommand': return { Firewalls: overrides.fws ?? [{ FirewallName: 'DMZVPC-nfw' }] };
      case 'DescribeFirewallCommand': return overrides.fwDescribe ?? FW_DESCRIBE;
      case 'DescribeLoggingConfigurationCommand': return overrides.logging ?? LOGGING;
      case 'ListFirewallPoliciesCommand': return { FirewallPolicies: overrides.policies ?? [{ Name: 'DMZVPC-fw-policy' }] };
      case 'DescribeFirewallPolicyCommand': return overrides.policyDescribe ?? POLICY_DESCRIBE;
      case 'ListRuleGroupsCommand': return { RuleGroups: overrides.rgs ?? RG_LIST };
      case 'DescribeRuleGroupCommand': {
        // 실제 코드처럼 ARN 세그먼트에서 이름을 뽑는다 — RuleGroupName+Type이 아니라
        // RuleGroupArn만으로 describe하는 회귀 검증(STATEFUL_DOMAIN 오분류 방지 수정).
        const arn = (cmd.input as { RuleGroupArn: string }).RuleGroupArn;
        const name = arn.split('/').pop() ?? '';
        return RG_DESCRIBE[name] ?? { RuleGroupResponse: { RuleGroupName: name, Type: 'STATEFUL' } };
      }
      default: throw new Error(`unexpected ${cmd.constructor.name}`);
    }
  });
}

/** CW — ListMetrics 튜플(3-dim + 4-dim 변형 실측 재현) + GetMetricData 값. */
function mockCw(data: Record<string, number>, opts: { includeEndpointVariant?: boolean } = {}) {
  cwSend.mockImplementation(async (cmd: Cmd) => {
    if (cmd.constructor.name === 'ListMetricsCommand') {
      const t3 = ['Stateless', 'Stateful'].flatMap((engine) => [{
        Dimensions: [
          { Name: 'AvailabilityZone', Value: 'ap-northeast-2a' },
          { Name: 'Engine', Value: engine },
          { Name: 'FirewallName', Value: 'DMZVPC-nfw' },
        ],
      }]);
      const t4 = opts.includeEndpointVariant
        ? ['Stateless', 'Stateful'].map((engine) => ({
          Dimensions: [
            { Name: 'AvailabilityZone', Value: 'ap-northeast-2a' },
            { Name: 'EndpointName', Value: 'vpce-1' },
            { Name: 'Engine', Value: engine },
            { Name: 'FirewallName', Value: 'DMZVPC-nfw' },
          ],
        }))
        : [];
      return { Metrics: [...t3, ...t4] };
    }
    return { MetricDataResults: Object.entries(data).map(([Id, v]) => ({ Id, Values: [v] })) };
  });
}

describe('anfwAnalysis', () => {
  it('표준 시나리오: 보호 off·로깅·용량·미연결·메트릭 집계', async () => {
    mockDb([]);
    mockNfw();
    // i0=Stateless, i1=Stateful (튜플 순서)
    mockCw({
      recv_i0: 1000, pass_i0: 950, drop_i0: 50,
      recv_i1: 900, pass_i1: 880, drop_i1: 10, rej_i1: 10,
    });
    const { anfwAnalysis } = await import('./anfw');
    const a = await anfwAnalysis(86400);

    expect(a.totals).toMatchObject({
      firewalls: 1, firewallsDown: 0,
      endpoints: 2, endpointsNotReady: 0,
      policies: 1, policiesPassthrough: 0,
      ruleGroups: 2, ruleGroupsUnassociated: 1, ruleGroupsHighCapacity: 1,
      protectionsOffFirewalls: 1, alertLoggingMissing: 0,
      // 수신은 Engine=Stateless(와이어 패킷)만 — Stateful recv(900)는 SFE 포워딩 중복이라 제외
      receivedPackets: 1000, passedPackets: 1830, droppedPackets: 60, rejectedPackets: 10,
    });

    const f = a.firewalls[0];
    expect(f.receivedPackets).toBe(1000); // Stateful recv 900은 분모에서 제외
    expect(f.protectionsOff).toBe(3);
    expect(f.alertLogging).toBe('CloudWatchLogs:/nfw/alert');
    expect(f.flowLogging).toBe('CloudWatchLogs:/nfw/flow');
    expect(f.tlsLogging).toBeNull();
    expect(f.policyName).toBe('DMZVPC-fw-policy');
    expect(f.endpoints).toHaveLength(2);
    expect(f.dropRatePct).toBe(7); // (50+10+10) ÷ 와이어 1000 = 7%
    expect(f.down).toBe(false);

    const p = a.policies[0];
    expect(p.statelessGroups).toEqual(['DMZVPC-stateless-allow-all']);
    expect(p.statefulGroups).toEqual(['eksworkshop-container-attr-rg']);
    expect(p.passthroughDefault).toBe(false); // forward_to_sfe

    const rg = a.ruleGroups.find((r) => r.name === 'DMZVPC-stateful-default')!;
    expect(rg.unassociated).toBe(true);
    expect(rg.capacityPct).toBe(3);
    // 룰 히트 카운트 조인용 SID 파싱 — sid 없는 룰/주석은 제외, sid·msg·action만 추출
    expect(rg.statefulSids).toEqual([
      { sid: '1000001', msg: 'block outbound telnet', action: 'drop' },
      { sid: '1000002', msg: 'http watch', action: 'alert' },
    ]);
    const rgStateless = a.ruleGroups.find((r) => r.name === 'DMZVPC-stateless-allow-all')!;
    expect(rgStateless.statefulSids).toEqual([]); // STATELESS는 대상 아님
    expect(rgStateless.capacityPct).toBe(90);
    expect(rgStateless.unassociated).toBe(false);
  });

  it('parseStatefulSids: content/pcre 내부의 "sid:" 문자열에 속지 않음', async () => {
    const { parseStatefulSids } = await import('./anfw');
    expect(parseStatefulSids({ RulesSource: { RulesString: 'alert http any any -> any any (content:"sid: 999"; msg:"x"; sid:1234;)' } }))
      .toEqual([{ sid: '1234', msg: 'x', action: 'alert' }]);
    expect(parseStatefulSids({ RulesSource: { RulesString: 'drop tcp any any -> any any (pcre:"/sid:55/"; sid:2000;)' } }))
      .toEqual([{ sid: '2000', msg: null, action: 'drop' }]);
    expect(parseStatefulSids({ RulesSource: { RulesString: 'alert tcp any any -> any any (content:"\\"; sid: 12;\\""; sid:4000;)' } })[0].sid).toBe('4000');
  });

  it('TLS 수신 패킷도 recv/bytes와 동일하게 Engine=Stateless만 채택 — Stateful 재발행 이중 집계 방지 (리뷰 MAJOR 라운드8, 라운드10 되돌림)', async () => {
    mockDb([]);
    mockNfw();
    // AWS 문서(monitoring-cloudwatch.html)가 TLSReceivedPackets도 recv/bytes와 동일하게
    // stateless→stateful TCP/TLS 종료 경계에서 두 엔진 모두에 값이 존재할 수 있다고
    // 명시 — pick(엔진 합산)으로 읽으면 recv/bytes에서 고친 이중 집계가 tlsrecv에서
    // 재발한다. pickWire(Stateless만)를 써야 한다(라운드10이 이걸 pick으로 잘못
    // 바꿨다가 stop-hook 리뷰로 되돌림).
    mockCw({ tlsrecv_i0: 500, tlsrecv_i1: 480, tlspass_i0: 490, tlspass_i1: 470 });
    const { anfwAnalysis } = await import('./anfw');
    const a = await anfwAnalysis(3600);
    const f = a.firewalls[0];
    expect(f.tlsReceivedPackets).toBe(500); // Stateful tlsrecv(480)는 제외
    // pass/drop/rej는 최종 처분 엔진에서 한 번만 발행되므로 엔진 합산 유지(변경 없음).
    expect(f.tlsPassedPackets).toBe(960);
  });

  it('룰 본문(RulesSource)은 어떤 형태로도 응답에 실리지 않음', async () => {
    mockDb([]);
    mockNfw();
    mockCw({});
    const { anfwAnalysis } = await import('./anfw');
    const a = await anfwAnalysis(3600);
    const s = JSON.stringify(a);
    expect(s).not.toContain('SECRET_RULE_BODY');
    expect(s).not.toContain('RulesSource');
  });

  it('EndpointName 포함 4-dim 튜플은 제외 — 이중 집계 방지', async () => {
    mockDb([]);
    mockNfw();
    mockCw({ recv_i0: 1000, recv_i1: 900, recv_i2: 999999, recv_i3: 999999 }, { includeEndpointVariant: true });
    const { anfwAnalysis } = await import('./anfw');
    const a = await anfwAnalysis(3600);
    // 4-dim이 채택됐다면 i2/i3까지 합산돼 커짐 — 3-dim Stateless 튜플(recv_i0)만 반영돼야 함
    expect(a.firewalls[0].receivedPackets).toBe(1000);
  });

  it('stateless 기본 액션 aws:pass → passthrough 플래그 + 집계', async () => {
    mockDb([]);
    mockNfw({
      policyDescribe: {
        ...POLICY_DESCRIBE,
        FirewallPolicy: { ...POLICY_DESCRIBE.FirewallPolicy, StatelessDefaultActions: ['aws:pass'] },
      },
    });
    mockCw({});
    const { anfwAnalysis } = await import('./anfw');
    const a = await anfwAnalysis(3600);
    expect(a.policies[0].passthroughDefault).toBe(true);
    expect(a.totals.policiesPassthrough).toBe(1);
  });

  it('엔드포인트 READY 아님 / 동기화 PENDING → down + 집계', async () => {
    mockDb([]);
    mockNfw({
      fwDescribe: {
        ...FW_DESCRIBE,
        FirewallStatus: {
          Status: 'READY', ConfigurationSyncStateSummary: 'PENDING',
          SyncStates: {
            'ap-northeast-2a': { Attachment: { SubnetId: 'subnet-a', EndpointId: 'vpce-1', Status: 'SCALING' } },
          },
        },
      },
    });
    mockCw({});
    const { anfwAnalysis } = await import('./anfw');
    const a = await anfwAnalysis(3600);
    expect(a.firewalls[0].down).toBe(true);
    expect(a.firewalls[0].endpointsNotReady).toBe(1);
    expect(a.totals.firewallsDown).toBe(1);
    expect(a.totals.endpointsNotReady).toBe(1);
  });

  it('ALERT 로깅 미설정 → alertLoggingMissing 집계 (FLOW만 설정)', async () => {
    mockDb([]);
    mockNfw({
      logging: {
        LoggingConfiguration: {
          LogDestinationConfigs: [
            { LogType: 'FLOW', LogDestinationType: 'S3', LogDestination: { bucketName: 'logs' } },
          ],
        },
      },
    });
    mockCw({});
    const { anfwAnalysis } = await import('./anfw');
    const a = await anfwAnalysis(3600);
    expect(a.firewalls[0].loggingKnown).toBe(true);
    expect(a.firewalls[0].alertLogging).toBeNull();
    expect(a.firewalls[0].flowLogging).toBe('S3:logs');
    expect(a.totals.alertLoggingMissing).toBe(1);
  });

  it('리전 degrade: 실패 리전 건너뛰고 나머지 유지 + degradedRegions에 노출 (조용히 0으로 보이면 안 됨)', async () => {
    mockDb(['us-west-2']);
    mockNfw({ failRegions: ['us-west-2'] });
    mockCw({});
    const { anfwAnalysis } = await import('./anfw');
    const a = await anfwAnalysis(3600);
    expect(a.firewalls).toHaveLength(1);
    expect(a.policies).toHaveLength(1);
    expect(a.degradedRegions).toEqual(['us-west-2']);
    // scannedRegions는 firewalls 유무와 무관하게 "실제로 조회를 시도한" 전 리전이다 —
    // 호출자(anfw/route.ts의 audit)가 "리전의 마지막 방화벽이 삭제됨" 케이스를 놓치지
    // 않도록 firewalls[].region보다 넓은 이 목록을 써야 한다(리뷰 MAJOR).
    expect(a.scannedRegions.sort()).toEqual(['ap-northeast-2', 'us-west-2']);
  });

  it('정상 리전만 있으면 degradedRegions는 빈 배열 (진짜 무-리소스와 조회실패를 혼동하지 않음)', async () => {
    mockDb([]);
    mockNfw();
    mockCw({});
    const { anfwAnalysis } = await import('./anfw');
    const a = await anfwAnalysis(3600);
    expect(a.degradedRegions).toEqual([]);
  });

  it('개별 방화벽 Describe 실패: List는 성공했는데 그 항목만 조용히 드롭 → 리전이 degraded로 표시됨', async () => {
    mockDb([]);
    mockNfw({ fws: [{ FirewallName: 'DMZVPC-nfw' }, { FirewallName: 'other-nfw' }] });
    nfwSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'DescribeFirewallCommand' && (cmd.input as { FirewallName: string }).FirewallName === 'other-nfw') {
        throw new Error('Throttling');
      }
      switch (cmd.constructor.name) {
        case 'ListFirewallsCommand': return { Firewalls: [{ FirewallName: 'DMZVPC-nfw' }, { FirewallName: 'other-nfw' }] };
        case 'DescribeFirewallCommand': return FW_DESCRIBE;
        case 'DescribeLoggingConfigurationCommand': return LOGGING;
        case 'ListFirewallPoliciesCommand': return { FirewallPolicies: [] };
        case 'ListRuleGroupsCommand': return { RuleGroups: [] };
        default: throw new Error(`unexpected ${cmd.constructor.name}`);
      }
    });
    mockCw({});
    const { anfwAnalysis } = await import('./anfw');
    const a = await anfwAnalysis(3600);
    // 실측 방화벽 2개 중 1개만 응답에 남음 — 조용히 "방화벽 1개"로 보이면 오탐/과소경고이므로 degraded 신호가 필수.
    expect(a.firewalls).toHaveLength(1);
    expect(a.degradedRegions).toEqual(['ap-northeast-2']);
  });

  it('메트릭 전무 → 트래픽 null, 드롭율 null, 리스트는 정상', async () => {
    mockDb([]);
    mockNfw();
    cwSend.mockImplementation(async (cmd: Cmd) =>
      cmd.constructor.name === 'ListMetricsCommand' ? { Metrics: [] } : { MetricDataResults: [] });
    const { anfwAnalysis } = await import('./anfw');
    const a = await anfwAnalysis(3600);
    expect(a.firewalls[0].receivedPackets).toBeNull();
    expect(a.firewalls[0].dropRatePct).toBeNull();
    expect(a.totals.droppedPackets).toBeNull();
  });

  it('로깅 조회 실패(SCP 거부 등) → loggingKnown false, "미설정" 경고로 세지 않음', async () => {
    mockDb([]);
    mockNfw();
    nfwSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'DescribeLoggingConfigurationCommand') throw new Error('AccessDenied');
      switch (cmd.constructor.name) {
        case 'ListFirewallsCommand': return { Firewalls: [{ FirewallName: 'DMZVPC-nfw' }] };
        case 'DescribeFirewallCommand': return FW_DESCRIBE;
        case 'ListFirewallPoliciesCommand': return { FirewallPolicies: [] };
        case 'ListRuleGroupsCommand': return { RuleGroups: [] };
        default: throw new Error(`unexpected ${cmd.constructor.name}`);
      }
    });
    mockCw({});
    const { anfwAnalysis } = await import('./anfw');
    const a = await anfwAnalysis(3600);
    expect(a.firewalls).toHaveLength(1);
    expect(a.firewalls[0].loggingKnown).toBe(false);
    expect(a.firewalls[0].alertLogging).toBeNull();
    // 확인 불가는 "미설정"이 아니다 — 거짓 경고 방지 (실측: 태스크 롤만 SCP류로 거부된 사례)
    expect(a.totals.alertLoggingMissing).toBe(0);
    // 하지만 "이상 없음" 요약 카드가 이 방화벽을 근거로 확정하면 안 된다 — 총계로 노출.
    expect(a.totals.loggingUnknownFirewalls).toBe(1);
  });

  it('ListMetrics NextToken 미순회 잔여분 → metricsDegradedRegions에 노출 (조용한 null 강등 금지)', async () => {
    mockDb([]);
    mockNfw();
    cwSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'ListMetricsCommand') {
        if (!(cmd.input as { NextToken?: string }).NextToken) {
          // 1페이지: NextToken을 돌려줘 다음 페이지에 실제 튜플이 있음을 알림
          return { Metrics: [], NextToken: 'page2' };
        }
        // 2페이지: 진짜 Stateless 튜플
        return {
          Metrics: [{
            Dimensions: [
              { Name: 'AvailabilityZone', Value: 'ap-northeast-2a' },
              { Name: 'Engine', Value: 'Stateless' },
              { Name: 'FirewallName', Value: 'DMZVPC-nfw' },
            ],
          }],
        };
      }
      return { MetricDataResults: [{ Id: 'recv_i0', Values: [1000] }] };
    });
    const { anfwAnalysis } = await import('./anfw');
    const a = await anfwAnalysis(3600);
    // 페이지 순회를 안 했다면 1페이지(빈 Metrics)에서 멈춰 recv가 null이 됐을 것.
    expect(a.firewalls[0].receivedPackets).toBe(1000);
    expect(a.metricsDegradedRegions).toEqual([]);
  });

  it('CloudWatch 쿼리 단위 실패(StatusCode!=Complete) → 무신호 아니라 metricsDegradedRegions', async () => {
    mockDb([]);
    mockNfw();
    cwSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'ListMetricsCommand') {
        return {
          Metrics: [{
            Dimensions: [
              { Name: 'AvailabilityZone', Value: 'ap-northeast-2a' },
              { Name: 'Engine', Value: 'Stateless' },
              { Name: 'FirewallName', Value: 'DMZVPC-nfw' },
            ],
          }],
        };
      }
      // recv 쿼리는 성공, pass 쿼리는 HTTP 200 안에서 실패(PartialData) — 예외는 없음.
      return {
        MetricDataResults: [
          { Id: 'recv_i0', Values: [1000], StatusCode: 'Complete' },
          { Id: 'pass_i0', Values: [], StatusCode: 'PartialData' },
        ],
      };
    });
    const { anfwAnalysis } = await import('./anfw');
    const a = await anfwAnalysis(3600);
    expect(a.firewalls[0].receivedPackets).toBe(1000);
    // StatusCode를 무시했다면 이 리전은 정상으로 보였을 것 — 실패 쿼리가 하나라도 있으면 degrade.
    expect(a.metricsDegradedRegions).toEqual(['ap-northeast-2']);
  });

  it('Sum 윈도우가 여러 datapoint를 반환하면 첫 값만이 아니라 전부 합산 (epoch 경계 분할 대응)', async () => {
    mockDb([]);
    mockNfw();
    cwSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'ListMetricsCommand') {
        return {
          Metrics: [{
            Dimensions: [
              { Name: 'AvailabilityZone', Value: 'ap-northeast-2a' },
              { Name: 'Engine', Value: 'Stateless' },
              { Name: 'FirewallName', Value: 'DMZVPC-nfw' },
            ],
          }],
        };
      }
      // CloudWatch가 요청 구간을 epoch 경계로 쪼개 2개 datapoint를 반환하는 실측 상황.
      return { MetricDataResults: [{ Id: 'recv_i0', Values: [700, 300], StatusCode: 'Complete' }] };
    });
    const { anfwAnalysis } = await import('./anfw');
    const a = await anfwAnalysis(86400);
    // Values[0]만 썼다면(구 코드) 700만 반영됐을 것 — 진짜 기간 합계는 1000.
    expect(a.firewalls[0].receivedPackets).toBe(1000);
  });

  it('STATEFUL_DOMAIN 룰 그룹: ARN 이분 추정이었다면 STATEFUL로 오분류돼 describe 실패로 드롭됐을 것', async () => {
    mockDb([]);
    mockNfw({
      rgs: [{ Name: 'domain-allowlist', Arn: 'arn:aws:network-firewall:r:1:stateful-rulegroup/domain-allowlist' }],
      policies: [],
    });
    // ARN 세그먼트만 보면 stateless-rulegroup/이 아니므로 구 코드는 STATEFUL로 단정했을 것 —
    // 실제로는 STATEFUL_DOMAIN(도메인 리스트)이라 Type을 잘못 넘긴 DescribeRuleGroup이 실패한다.
    // 새 코드는 RuleGroupArn만으로 describe해 Type 파라미터 자체가 필요 없다.
    nfwSend.mockImplementation(async (cmd: Cmd) => {
      switch (cmd.constructor.name) {
        case 'ListFirewallsCommand': return { Firewalls: [] };
        case 'ListFirewallPoliciesCommand': return { FirewallPolicies: [] };
        case 'ListRuleGroupsCommand': return { RuleGroups: [{ Name: 'domain-allowlist', Arn: 'arn:aws:network-firewall:r:1:stateful-rulegroup/domain-allowlist' }] };
        case 'DescribeRuleGroupCommand': {
          const { RuleGroupArn, RuleGroupName, Type } = cmd.input as { RuleGroupArn?: string; RuleGroupName?: string; Type?: string };
          // RuleGroupName+Type으로 호출했다면(구 코드) Type='STATEFUL'이 실제 STATEFUL_DOMAIN과
          // 안 맞아 AWS가 거부한다는 실측을 흉내 — RuleGroupArn 단독 호출만 허용.
          if (!RuleGroupArn || RuleGroupName || Type) throw new Error(`ResourceNotFoundException: no such STATEFUL rule group`);
          return { RuleGroupResponse: { RuleGroupName: 'domain-allowlist', Type: 'STATEFUL_DOMAIN', RuleGroupStatus: 'ACTIVE', Capacity: 50, ConsumedCapacity: 10, NumberOfAssociations: 1 } };
        }
        default: throw new Error(`unexpected ${cmd.constructor.name}`);
      }
    });
    mockCw({});
    const { anfwAnalysis } = await import('./anfw');
    const a = await anfwAnalysis(3600);
    expect(a.ruleGroups).toHaveLength(1);
    expect(a.ruleGroups[0].type).toBe('STATEFUL_DOMAIN');
  });
});
