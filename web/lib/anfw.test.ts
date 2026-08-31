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
    const before = Date.now();
    const a = await anfwAnalysis(86400);
    // 리뷰 MAJOR(Codex stop-hook, PR #225 라운드20): 클라이언트가 range 시작을 자기 시계로
    // 계산하면 시계 왜곡에 취약하다 — 서버가 이 분석을 생성한 실제 시각을 응답에 실어야
    // 클라이언트가 그 값을 기준으로 계산할 수 있다.
    expect(a.generatedAt).toBeGreaterThanOrEqual(before);
    expect(a.generatedAt).toBeLessThanOrEqual(Date.now());

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
    // 리뷰 MAJOR(Codex stop-hook, PR #225 라운드27): statefulGroups는 이름만(ARN 마지막
    // 세그먼트) 남긴 표시용 값이다 — 계정 소유 그룹과 이름이 같은 관리형 그룹을 안전하게
    // 구분하려면 전체 ARN이 필요하다. 이 필드가 실제로 채워지는지 확인.
    expect(p.statefulGroupArns).toEqual(['arn:aws:network-firewall:r:1:stateful-rulegroup/eksworkshop-container-attr-rg']);
    expect(p.passthroughDefault).toBe(false); // forward_to_sfe

    const rg = a.ruleGroups.find((r) => r.name === 'DMZVPC-stateful-default')!;
    expect(rg.arn).toBe('arn:aws:network-firewall:r:1:stateful-rulegroup/DMZVPC-stateful-default');
    expect(rg.unassociated).toBe(true);
    expect(rg.capacityPct).toBe(3);
    // 룰 히트 카운트 조인용 SID 파싱 — sid 없는 룰/주석은 제외, sid·msg·action만 추출
    expect(rg.statefulSids).toEqual([
      { sid: '1000001', msg: 'block outbound telnet', action: 'drop', noalert: false },
      { sid: '1000002', msg: 'http watch', action: 'alert', noalert: false },
    ]);
    const rgStateless = a.ruleGroups.find((r) => r.name === 'DMZVPC-stateless-allow-all')!;
    expect(rgStateless.statefulSids).toEqual([]); // STATELESS는 대상 아님
    expect(rgStateless.capacityPct).toBe(90);
    expect(rgStateless.unassociated).toBe(false);
  });

  it('STATEFUL_DOMAIN(도메인 리스트) 룰 그룹은 sidsUnparseable=true — AWS가 SID를 내부 생성해 statefulSids로 알 수 없음 (리뷰 MAJOR 확정, PR #225 라운드11)', async () => {
    mockDb([]);
    mockNfw({
      rgs: [{ Name: 'domain-deny-list', Arn: 'arn:aws:network-firewall:r:1:stateful-rulegroup/domain-deny-list' }],
    });
    // 리뷰 확정(PR #225 라운드12): 도메인 리스트의 실제 API Type은 'STATEFUL'이 아니라
    // 별도 값 'STATEFUL_DOMAIN'이다(이 파일의 다른 테스트가 실측 검증). isStateful로
    // 게이트한 첫 수정은 이 실제 Type에는 전혀 안 걸리는 죽은 코드였다 — 이 테스트는
    // 반드시 실제 Type 문자열로 검증해야 그 회귀를 잡는다.
    RG_DESCRIBE['domain-deny-list'] = {
      // RulesSourceList의 GeneratedRulesType(ALLOWLIST|DENYLIST)은 실제 API에서 필수
      // 필드 — 이게 빠진 응답은 AWS가 실제로 반환할 수 없는 형태였다(리뷰 확정, 라운드13).
      RuleGroup: { RulesSource: { RulesSourceList: { Targets: ['evil.example'], TargetTypes: ['TLS_SNI'], GeneratedRulesType: 'DENYLIST' } } },
      RuleGroupResponse: {
        RuleGroupName: 'domain-deny-list', Type: 'STATEFUL_DOMAIN', RuleGroupStatus: 'ACTIVE',
        Capacity: 100, ConsumedCapacity: 10, NumberOfAssociations: 1,
      },
    };
    const { anfwAnalysis } = await import('./anfw');
    const a = await anfwAnalysis(86400);
    const rg = a.ruleGroups.find((r) => r.name === 'domain-deny-list')!;
    expect(rg.type).toBe('STATEFUL_DOMAIN');
    expect(rg.statefulSids).toEqual([]); // 사용자 SID 없음 — 파싱 대상 아님
    expect(rg.sidsUnparseable).toBe(true); // 그런데도 SID 집합을 안다고 확정할 수 없음
    delete RG_DESCRIBE['domain-deny-list'];
  });

  it('parseStatefulSids: content/pcre 내부의 "sid:" 문자열에 속지 않음', async () => {
    const { parseStatefulSids } = await import('./anfw');
    expect(parseStatefulSids({ RulesSource: { RulesString: 'alert http any any -> any any (content:"sid: 999"; msg:"x"; sid:1234;)' } }))
      .toEqual([{ sid: '1234', msg: 'x', action: 'alert', noalert: false }]);
    expect(parseStatefulSids({ RulesSource: { RulesString: 'drop tcp any any -> any any (pcre:"/sid:55/"; sid:2000;)' } }))
      .toEqual([{ sid: '2000', msg: null, action: 'drop', noalert: false }]);
    expect(parseStatefulSids({ RulesSource: { RulesString: 'alert tcp any any -> any any (content:"\\"; sid: 12;\\""; sid:4000;)' } })[0].sid).toBe('4000');
  });

  it('parseStatefulSids: noalert 룰은 action이 alert/drop이어도 Alert 로그를 안 남기므로 별도 플래그로 표시 (리뷰 MAJOR PLAUSIBLE, PR #225 라운드9)', async () => {
    const { parseStatefulSids } = await import('./anfw');
    expect(parseStatefulSids({ RulesSource: { RulesString: 'alert tcp any any -> any any (msg:"silent"; flowbits:set,seen; noalert; sid:5000;)' } }))
      .toEqual([{ sid: '5000', msg: 'silent', action: 'alert', noalert: true }]);
    // 구조화된 StatefulRules 형태도 동일하게 처리
    expect(parseStatefulSids({
      RulesSource: {
        StatefulRules: [{
          Action: 'DROP',
          RuleOptions: [
            { Keyword: 'sid', Settings: ['5001'] },
            { Keyword: 'msg', Settings: ['"silent2"'] },
            { Keyword: 'noalert' },
          ],
        }],
      },
    })).toEqual([{ sid: '5001', msg: 'silent2', action: 'drop', noalert: true }]);
  });

  it('parseStatefulSids: 구조화된 StatefulRules의 flowbits:noalert 레거시 별칭(Keyword="flowbits", Settings=["noalert"])도 noalert로 인식 (리뷰 MAJOR 확정, PR #225 라운드10)', async () => {
    const { parseStatefulSids } = await import('./anfw');
    expect(parseStatefulSids({
      RulesSource: {
        StatefulRules: [{
          Action: 'ALERT',
          RuleOptions: [
            { Keyword: 'sid', Settings: ['5002'] },
            { Keyword: 'flowbits', Settings: ['noalert'] },
          ],
        }],
      },
    })).toEqual([{ sid: '5002', msg: null, action: 'alert', noalert: true }]);
    // 일반 flowbits 설정(콤마 인자가 있는 set/unset류)은 여전히 noalert가 아니어야 한다.
    expect(parseStatefulSids({
      RulesSource: {
        StatefulRules: [{
          Action: 'ALERT',
          RuleOptions: [
            { Keyword: 'sid', Settings: ['5003'] },
            { Keyword: 'flowbits', Settings: ['set,seen'] },
          ],
        }],
      },
    })).toEqual([{ sid: '5003', msg: null, action: 'alert', noalert: false }]);
  });

  it('parseStatefulSids: msg 추출이 이스케이프된 따옴표에서 잘리지 않고, 다른 문자열 리터럴을 넘어가며 오추출하지 않음 (리뷰 MAJOR 확정, PR #225 라운드10·11)', async () => {
    const { parseStatefulSids } = await import('./anfw');
    // 이스케이프된 내부 따옴표 — 이전엔 첫 \" 에서 잘려 'a '만 남았다.
    expect(parseStatefulSids({ RulesSource: { RulesString: 'alert tcp any any -> any any (msg:"a \\"b\\" c"; sid:6000;)' } })[0].msg)
      .toBe('a \\"b\\" c');
    // content 리터럴 "안"에 백슬래시로 이스케이프된 가짜 msg: 텍스트를 심어도, 실제 msg
    // 리터럴만 추출돼야 한다.
    expect(parseStatefulSids({ RulesSource: { RulesString: 'alert tcp any any -> any any (content:"msg:\\"decoy\\""; msg:"real"; sid:6001;)' } })[0].msg)
      .toBe('real');
    // 리뷰 MAJOR(확정, 라운드11 — 라운드10 자체 수정의 결함): content 리터럴이 "msg:"로
    // *끝나면*, 그 리터럴을 닫는 따옴표가 가짜 msg 옵션의 여는 따옴표로 오인되어 그
    // 지점부터 진짜 msg 리터럴의 여는 따옴표까지("; msg:")를 통째로 캡처해버렸다 —
    // 여전히 리터럴 경계를 넘어간 것. 순서 기반 대응(literalsInOrder)으로 고쳐 'real2'만
    // 나와야 한다.
    expect(parseStatefulSids({ RulesSource: { RulesString: 'alert tcp any any -> any any (content:"foo msg:"; msg:"real2"; sid:6002;)' } })[0].msg)
      .toBe('real2');
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
    // 리뷰 MINOR(PR #221): firewallListDegradedRegions는 firewalls 자체의 부분 실패에서만
    // 켜져야 한다 — 이 케이스는 DescribeFirewall이 실패했으므로 켜져야 함.
    expect(a.firewallListDegradedRegions).toEqual(['ap-northeast-2']);
  });

  it('정책 Describe만 실패하면 degradedRegions는 켜지지만 firewallListDegradedRegions는 비어 있음 — 방화벽 목록·로깅 구성 자체는 완전 (리뷰 MINOR, PR #221)', async () => {
    mockDb([]);
    nfwSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'DescribeFirewallPolicyCommand' && (cmd.input as { FirewallPolicyName: string }).FirewallPolicyName === 'p2') {
        throw new Error('Throttling');
      }
      switch (cmd.constructor.name) {
        case 'ListFirewallsCommand': return { Firewalls: [{ FirewallName: 'DMZVPC-nfw' }] };
        case 'DescribeFirewallCommand': return FW_DESCRIBE;
        case 'DescribeLoggingConfigurationCommand': return LOGGING;
        case 'ListFirewallPoliciesCommand': return { FirewallPolicies: [{ Name: 'p1' }, { Name: 'p2' }] };
        case 'DescribeFirewallPolicyCommand': return POLICY_DESCRIBE;
        case 'ListRuleGroupsCommand': return { RuleGroups: [] };
        default: throw new Error(`unexpected ${cmd.constructor.name}`);
      }
    });
    mockCw({});
    const { anfwAnalysis } = await import('./anfw');
    const a = await anfwAnalysis(3600);
    expect(a.firewalls).toHaveLength(1);
    expect(a.degradedRegions).toEqual(['ap-northeast-2']);
    expect(a.firewallListDegradedRegions).toEqual([]);
  });

  it('ListRuleGroupsCommand 자체가 던지면(스로틀) 방화벽 List는 성공했더라도 firewallListDegradedRegions는 비어 있음 — 세 List*는 서로 독립 (리뷰 MAJOR, PR #221 라운드4)', async () => {
    // 라운드3까지는 세 List*가 하나의 Promise.all로 묶여 있어, 룰그룹 List 하나만 실패해도
    // 방화벽 List가 이미 성공했든 상관없이 region 블록 전체가 catch로 떨어져
    // firewallListDegraded까지 켜졌다 — "firewalls 자체만의 부분 실패"라는 계약 위반.
    mockDb([]);
    nfwSend.mockImplementation(async (cmd: Cmd) => {
      switch (cmd.constructor.name) {
        case 'ListFirewallsCommand': return { Firewalls: [{ FirewallName: 'DMZVPC-nfw' }] };
        case 'DescribeFirewallCommand': return FW_DESCRIBE;
        case 'DescribeLoggingConfigurationCommand': return LOGGING;
        case 'ListFirewallPoliciesCommand': return { FirewallPolicies: [] };
        case 'ListRuleGroupsCommand': throw new Error('Throttling');
        default: throw new Error(`unexpected ${cmd.constructor.name}`);
      }
    });
    mockCw({});
    const { anfwAnalysis } = await import('./anfw');
    const a = await anfwAnalysis(3600);
    // 방화벽 자체는 정상 조회됐다 — degradedRegions(포괄 신호)는 켜지지만 firewallList는 아니다.
    expect(a.firewalls).toHaveLength(1);
    expect(a.degradedRegions).toEqual(['ap-northeast-2']);
    expect(a.firewallListDegradedRegions).toEqual([]);
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
