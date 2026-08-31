import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.AWS_REGION = 'ap-northeast-2';

const logsSend = vi.fn();
vi.mock('@aws-sdk/client-cloudwatch-logs', () => ({
  CloudWatchLogsClient: class {
    constructor(public cfg: { region: string }) {}
    send(cmd: unknown) { return logsSend(cmd, this.cfg.region); }
  },
  StartQueryCommand: class { constructor(public input: unknown) {} },
  GetQueryResultsCommand: class { constructor(public input: unknown) {} },
  StopQueryCommand: class { constructor(public input: unknown) {} },
  DescribeLogGroupsCommand: class { constructor(public input: unknown) {} },
}));

const mockAnalysis = vi.fn();
vi.mock('./anfw', () => ({ anfwAnalysis: (r: number) => mockAnalysis(r) }));

beforeEach(async () => {
  logsSend.mockReset();
  mockAnalysis.mockReset();
  const { _resetAnfwLogsCacheForTests } = await import('./anfw-logs');
  _resetAnfwLogsCacheForTests();
});

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

const fw = (over: Record<string, unknown> = {}) => ({
  name: 'DMZVPC-nfw', region: 'ap-northeast-2', loggingKnown: true,
  alertLogging: 'CloudWatchLogs:/aws/network-firewall/DMZVPC/alert',
  flowLogging: 'CloudWatchLogs:/aws/network-firewall/DMZVPC/flow',
  ...over,
});

/** Insights 결과 행 생성 — [{field, value}] 형식. */
const row = (o: Record<string, string | number>) =>
  Object.entries(o).map(([field, value]) => ({ field, value: String(value) }));

/** 그룹×쿼리 문자열 매칭으로 결과 dispatch. */
function mockInsights(resultsFor: (group: string, query: string) => Record<string, string | number>[]) {
  const queries = new Map<string, { group: string; query: string }>();
  let n = 0;
  logsSend.mockImplementation(async (cmd: Cmd) => {
    switch (cmd.constructor.name) {
      case 'StartQueryCommand': {
        const id = `q${n++}`;
        const groups = (cmd.input.logGroupNames as string[]) ?? [];
        queries.set(id, { group: groups[0] ?? '', query: cmd.input.queryString as string });
        return { queryId: id };
      }
      case 'GetQueryResultsCommand': {
        const q = queries.get(cmd.input.queryId as string)!;
        return { status: 'Complete', results: resultsFor(q.group, q.query).map(row) };
      }
      case 'DescribeLogGroupsCommand':
        return { logGroups: [] };
      default: throw new Error(`unexpected ${cmd.constructor.name}`);
    }
  });
}

describe('anfwLogsAnalysis', () => {
  it('구성된 CWL 대상에서 alert/flow 집계 (스테이징 실측 형태)', async () => {
    mockAnalysis.mockResolvedValue({ firewalls: [fw()] });
    mockInsights((group, query) => {
      if (group.endsWith('/alert')) {
        if (query.includes('by action')) return [{ action: 'blocked', cnt: 7 }, { action: 'allowed', cnt: 3 }];
        if (query.includes('by sid, sig, act')) return [
          { sid: '5', sig: 'block outbound telnet', act: 'blocked', cnt: 7 },
          { sid: '9', sig: 'http watch', act: 'allowed', cnt: 3 },
        ];
        if (query.includes('by sid')) return [{ sid: '5', sig: 'block outbound telnet', cnt: 7 }];
        if (query.includes('by src')) return [{ src: '10.11.1.111', cnt: 8 }];
        if (query.includes('by dst')) return [{ dst: '10.12.2.34:23', cnt: 7 }];
        return [{ cnt: 10 }]; // totals
      }
      // flow 그룹
      if (query.includes('by src, dst')) return [{ src: '10.11.1.111', dst: '10.12.2.34', bytes: 12345, cnt: 4 }];
      if (query.includes('by proto')) return [{ proto: 'TCP', cnt: 9 }];
      return [{ cnt: 9, bytes: 20000 }]; // totals
    });
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const before = Date.now();
    const a = await anfwLogsAnalysis(86400);
    // 리뷰 MAJOR(Codex stop-hook, PR #225 라운드21): data(/api/anfw?range=)와 이 로그
    // 분석은 서로 독립된 4분 TTL 캐시라 시차가 날 수 있다 — 페이지가 두 anchor 중 더
    // 이른 쪽을 range 시작 기준으로 쓰려면 이 값이 응답에 있어야 한다.
    expect(a.generatedAt).toBeGreaterThanOrEqual(before);
    expect(a.generatedAt).toBeLessThanOrEqual(Date.now());

    expect(a.targets).toHaveLength(2);
    expect(a.targets.every((t) => !t.discovered)).toBe(true);
    expect(a.unsupportedDestinations).toBe(0);
    expect(a.failed).toEqual([]);

    expect(a.alert!.totalAlerts).toBe(10);
    expect(a.alert!.byAction).toEqual([{ name: 'blocked', value: 7 }, { name: 'allowed', value: 3 }]);
    expect(a.alert!.topSignatures).toEqual([{ sid: '5', signature: 'block outbound telnet', value: 7 }]);
    // 룰 히트 카운트 (sid+sig+action) — 2026-08 신기능과 동일한 Alert 로그 집계
    expect(a.alert!.ruleHits).toEqual([
      { sid: '5', signature: 'block outbound telnet', actions: ['blocked'], hits: 7 },
      { sid: '9', signature: 'http watch', actions: ['allowed'], hits: 3 },
    ]);
    expect(a.alert!.topSources[0]).toEqual({ name: '10.11.1.111', value: 8 });
    expect(a.alert!.topDests[0]).toEqual({ name: '10.12.2.34:23', value: 7 });

    expect(a.flow!.totalFlows).toBe(9);
    expect(a.flow!.totalBytes).toBe(20000);
    expect(a.flow!.talkersWindowSec).toBe(21600); // 24h 요청 → talker는 6h 창으로 제한
    expect(a.flow!.topTalkers[0]).toMatchObject({ src: '10.11.1.111', dst: '10.12.2.34', bytes: 12345, flows: 4 });
    expect(a.flow!.byProto).toEqual([{ name: 'TCP', value: 9 }]);
  });

  it('loggingKnown=false → 접두사 발견 폴백 (discovered=true, 이름으로 alert/flow 분류)', async () => {
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ loggingKnown: false, alertLogging: null, flowLogging: null })] });
    const base = mockInsightsWithDiscovery();
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    expect(a.targets.map((t) => [t.type, t.group, t.discovered])).toEqual([
      ['ALERT', '/aws/network-firewall/DMZVPC/alert', true],
      ['FLOW', '/aws/network-firewall/DMZVPC/flow', true],
    ]);
    expect(a.alert!.totalAlerts).toBe(base.alerts);
  });

  it('발견 폴백 DescribeLogGroups가 실패(스로틀/거부)하면 "발견된 로그 없음"과 구분해 failed에 표시 (리뷰 MAJOR)', async () => {
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ loggingKnown: false, alertLogging: null, flowLogging: null })] });
    logsSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'DescribeLogGroupsCommand') throw new Error('AccessDenied');
      return {};
    });
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    // DescribeLoggingConfiguration이 이미 거부된 환경에서 이 폴백까지 실패해도 targets:[]
    // 자체는 "발견된 로그 없음"과 똑같이 보인다 — failed에 별도 키가 있어야 "확인 불가"와
    // "정말 없음"이 구분된다.
    expect(a.targets).toEqual([]);
    expect(a.failed).toContain('logDiscovery');
  });

  it('발견 폴백 DescribeLogGroups는 NextToken을 순회해 1페이지 너머의 로그 그룹도 찾는다', async () => {
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ loggingKnown: false, alertLogging: null, flowLogging: null })] });
    logsSend.mockImplementation(async (cmd: Cmd) => {
      switch (cmd.constructor.name) {
        case 'DescribeLogGroupsCommand':
          if (!cmd.input.nextToken) {
            return { logGroups: [{ logGroupName: '/aws/network-firewall/DMZVPC/alert' }], nextToken: 'page2' };
          }
          return { logGroups: [{ logGroupName: '/aws/network-firewall/DMZVPC/flow' }] };
        case 'StartQueryCommand': return { queryId: 'q' };
        case 'GetQueryResultsCommand': return { status: 'Complete', results: [row({ cnt: 1, bytes: 1 })] };
        default: return {};
      }
    });
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    expect(a.targets.map((t) => t.type).sort()).toEqual(['ALERT', 'FLOW']);
  });

  it('ALERT는 CWL, FLOW는 S3처럼 섞인 대상도 unsupported로 집계 (리뷰 MINOR: 이전엔 누락)', async () => {
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ flowLogging: 'S3:my-log-bucket' })] });
    mockInsights(() => [{ cnt: 3 }]);
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    // ALERT 쪽은 여전히 CWL이라 분석은 정상 수행되지만, FLOW의 S3 leg는 고지 대상이어야 한다.
    expect(a.targets.map((t) => t.type)).toEqual(['ALERT']);
    expect(a.unsupportedDestinations).toBe(1);
    expect(a.alert).not.toBeNull();
  });

  it('S3/Firehose 대상만 있으면 unsupported 집계 + 분석 null (정직 고지)', async () => {
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ alertLogging: 'S3:my-log-bucket', flowLogging: 'KinesisDataFirehose:stream' })] });
    mockInsights(() => []);
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    expect(a.targets).toEqual([]);
    expect(a.unsupportedDestinations).toBe(1);
    expect(a.alert).toBeNull();
    expect(a.flow).toBeNull();
  });

  it('그룹 쿼리 실패는 해당 키만 failed로 degrade', async () => {
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ flowLogging: null })] });
    logsSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'StartQueryCommand') {
        const q = cmd.input.queryString as string;
        if (q.includes('by action')) throw new Error('boom');
        return { queryId: 'q' };
      }
      if (cmd.constructor.name === 'GetQueryResultsCommand') return { status: 'Complete', results: [row({ cnt: 5 })] };
      return {};
    });
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    expect(a.failed).toEqual(['alertByAction']);
    expect(a.alert!.totalAlerts).toBe(5);
    expect(a.flow).toBeNull(); // FLOW 대상 없음
  });

  it('두 방화벽이 같은 로그 그룹을 공유하면 쿼리를 한 번만 실행 — 이중 집계 방지 (리뷰 MAJOR)', async () => {
    // 중앙 공용 alert 로그 그룹으로 로깅하는 방화벽 2개 — (region, type, group) 동일.
    mockAnalysis.mockResolvedValue({
      firewalls: [
        fw({ name: 'fw-a', flowLogging: null }),
        fw({ name: 'fw-b', flowLogging: null }), // fw()의 alertLogging 기본값과 동일한 그룹 재사용
      ],
    });
    mockInsights(() => [{ cnt: 10 }]); // totals — 그룹당 한 번만 실행되면 합계는 10 그대로
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    // targets는 방화벽 단위로 2건 남아 있어도(어느 방화벽이 이 그룹을 쓰는지 표시 목적)
    // 실제 쿼리는 그룹당 1회만 — 중복 실행이었다면 같은 결과 행이 두 번 합산돼 20이 됐을 것.
    expect(a.targets).toHaveLength(2);
    expect(a.alert!.totalAlerts).toBe(10);
  });

  it('리전 중 하나라도 실패하면 다른 리전이 성공해도 failed로 표시 (all-regions 계약, 리뷰 MAJOR)', async () => {
    // 리뷰 MAJOR 수정으로 같은 리전의 그룹들은 이제 logGroupNames로 한 쿼리에 묶이므로,
    // 부분 실패를 검증하려면 그룹이 아니라 리전을 달리해야 한다(리전 = 실패 단위).
    mockAnalysis.mockResolvedValue({
      firewalls: [
        fw({ name: 'fw-a', flowLogging: null }), // ap-northeast-2 (기본)
        fw({ name: 'fw-b', flowLogging: null, region: 'us-east-1', alertLogging: 'CloudWatchLogs:/aws/network-firewall/other/alert' }),
      ],
    });
    logsSend.mockImplementation(async (cmd: Cmd, region: string) => {
      if (cmd.constructor.name === 'StartQueryCommand') {
        if (region === 'us-east-1') throw new Error('boom other region');
        return { queryId: 'q' };
      }
      if (cmd.constructor.name === 'GetQueryResultsCommand') return { status: 'Complete', results: [row({ cnt: 5 })] };
      return {};
    });
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    // 이전 계약("하나라도 성공하면 ok")이었다면 실패한 리전의 누락된 트래픽이 조용히
    // 사라진 채 totals만 부분치로 조용히 보였을 것 — 지금은 실패가 있었다는 신호를 남긴다.
    expect(a.failed).toContain('alertTotals');
  });

  it('anfwAnalysis()의 firewallListDegradedRegions가 있으면(방화벽 목록 자체 조회 실패) "로그 없음"과 구분해 failed에 표시 (리뷰 MAJOR)', async () => {
    // firewalls는 비어 있지만 firewallListDegradedRegions엔 실패 리전이 있다 — 그 리전의
    // 방화벽이 어떤 대상으로 로깅하는지 원래 확인조차 못 한 것이지 "로깅 대상이 없음"이 아니다.
    mockAnalysis.mockResolvedValue({ firewalls: [], degradedRegions: ['us-west-2'], firewallListDegradedRegions: ['us-west-2'] });
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    expect(a.targets).toEqual([]);
    expect(a.failed).toContain('firewallDiscovery');
  });

  it('degradedRegions는 있지만 firewallListDegradedRegions는 비어 있으면(정책/룰그룹만 실패, 방화벽 목록은 완전) totals를 taint하지 않음 (리뷰 MAJOR, PR #221 라운드2)', async () => {
    // degradedRegions는 firewalls·policies·ruleGroups 중 어느 것 하나라도 부분 실패하면
    // 켜지는 포괄 신호다 — 방화벽 로깅 구성과 무관한 정책/룰그룹 Describe 실패도 여기 섞인다.
    // 이 리전의 firewalls 자체는 완전히 조회됐으므로(firewallListDegradedRegions는 비어 있음)
    // 로그 발견/총계는 영향받지 않아야 한다.
    mockAnalysis.mockResolvedValue({ firewalls: [fw()], degradedRegions: ['ap-northeast-2'], firewallListDegradedRegions: [] });
    mockInsights(() => [{ cnt: 3 }]);
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    expect(a.failed).not.toContain('firewallDiscovery');
    expect(a.alert!.totalAlerts).not.toBeNull();
    expect(a.flow!.totalFlows).not.toBeNull();
  });

  it('리전별 top-N 쿼리는 표시 컷오프(10)보다 훨씬 큰 상한으로 오버페치 — 리전 간 병합 절단 축소 (리뷰 MAJOR)', async () => {
    mockAnalysis.mockResolvedValue({ firewalls: [fw()] });
    let sigQuery = '';
    logsSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'StartQueryCommand') {
        const q = cmd.input.queryString as string;
        // alertTopSignatures는 "by sid, sig |"로 끝나지만, alertRuleHits는 같은 접두사
        // "by sid, sig"를 공유하면서 ", act"가 더 붙는다(자체 오버페치 헤드룸 — 별도 검증,
        // 아래 alertRuleHits 전용 테스트) — 여기서는 시그니처 쿼리만 정확히 식별한다.
        if (q.includes('by sid, sig |')) sigQuery = q;
        return { queryId: 'q' };
      }
      if (cmd.constructor.name === 'GetQueryResultsCommand') return { status: 'Complete', results: [row({ cnt: 1 })] };
      return {};
    });
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    await anfwLogsAnalysis(3600);
    expect(sigQuery).toContain('limit 100');
  });

  it('alertRuleHits는 join 컷오프(100)보다 큰 리전별 상한(150)으로 오버페치 — 리전별 상한=컷오프였던 여유 없음 문제 해소 (리뷰 MINOR, PR #225 라운드3)', async () => {
    mockAnalysis.mockResolvedValue({ firewalls: [fw()] });
    let ruleHitsQuery = '';
    logsSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'StartQueryCommand') {
        const q = cmd.input.queryString as string;
        if (q.includes('by sid, sig, act')) ruleHitsQuery = q;
        return { queryId: 'q' };
      }
      if (cmd.constructor.name === 'GetQueryResultsCommand') return { status: 'Complete', results: [row({ cnt: 1 })] };
      return {};
    });
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    await anfwLogsAnalysis(3600);
    expect(ruleHitsQuery).toContain("filter event.event_type = 'alert' and ispresent(event.alert.signature_id)");
    expect(ruleHitsQuery).toContain('limit 150');
  });

  it('같은 리전의 여러 로그 그룹은 logGroupNames로 한 쿼리에 묶여 그룹별 limit이 진짜 전역 Top-N이 됨 (리뷰 MAJOR)', async () => {
    // 서로 다른 두 그룹(중복 제거 대상 아님, 같은 리전) — 이전엔 그룹별로 최대 10개까지
    // 잘라 병합해 11위 항목이 두 그룹 모두에서 통째로 사라질 수 있었다. 이제 한 쿼리로
    // 묶이므로 mock도 logGroupNames에 두 그룹이 모두 실려 있는지 검증한다.
    mockAnalysis.mockResolvedValue({
      firewalls: [
        fw({ name: 'fw-a', flowLogging: null }),
        fw({ name: 'fw-b', flowLogging: null, alertLogging: 'CloudWatchLogs:/aws/network-firewall/other/alert' }),
      ],
    });
    let seenGroups: string[] = [];
    logsSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'StartQueryCommand') {
        const groups = cmd.input.logGroupNames as string[];
        if (groups.length > 1) seenGroups = groups;
        return { queryId: 'q' };
      }
      if (cmd.constructor.name === 'GetQueryResultsCommand') return { status: 'Complete', results: [row({ cnt: 5 })] };
      return {};
    });
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    await anfwLogsAnalysis(3600);
    expect(seenGroups.sort()).toEqual([
      '/aws/network-firewall/DMZVPC/alert',
      '/aws/network-firewall/other/alert',
    ]);
  });

  it('구성 조회 거부(loggingKnown=false) + 접두사 스캔이 예외 없이 0건 반환하면 "로그 없음 확정"이 아니라 logDiscoveryEmpty로 표시 (리뷰 MAJOR 라운드7)', async () => {
    // 접두사 스캔이 실패한 게 아니라(discoveryFailed=false) 정상 실행됐는데 관례 명명과
    // 일치하는 그룹이 하나도 없는 경우(커스텀 명명이면 흔함) — 여전히 "모름"이지 "없음"이
    // 확인된 게 아니다. 이전엔 이 경우 targets:[], failed:[]로 확정 all-clear처럼 보였다.
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ loggingKnown: false, alertLogging: null, flowLogging: null })] });
    logsSend.mockImplementation(async (cmd: Cmd) =>
      cmd.constructor.name === 'DescribeLogGroupsCommand' ? { logGroups: [] } : {});
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    expect(a.targets).toEqual([]);
    // 라운드12: 키가 타입별로 갈라졌다 — 0건 발견이면 ALERT/FLOW 둘 다 unknown.
    expect(a.failed).toContain('logDiscoveryEmpty:ap-northeast-2:ALERT');
    expect(a.failed).toContain('logDiscoveryEmpty:ap-northeast-2:FLOW');
  });

  it('구성 조회 거부 + ALERT는 관례 명명으로 발견되지만 FLOW는 커스텀 명명이면, FLOW만 unknown으로 표시(ALERT는 아님) (리뷰 MAJOR 라운드12)', async () => {
    // 리전 단위로만 unknown을 기록하면 이 리전은 "무언가 발견됨"으로 카운트돼 빠지고
    // FLOW 카드가 unknown을 확정 없음("CloudWatch Logs 대상 FLOW 로그 없음")으로
    // 렌더링한다 — 타입별로 독립 추적해야 FLOW만 unknown 신호가 살아있어야 한다.
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ loggingKnown: false, alertLogging: null, flowLogging: null })] });
    logsSend.mockImplementation(async (cmd: Cmd) =>
      cmd.constructor.name === 'DescribeLogGroupsCommand'
        ? { logGroups: [{ logGroupName: '/aws/network-firewall/DMZVPC/alert' }] } // FLOW 그룹은 커스텀 명명이라 미발견
        : {});
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    expect(a.failed).toContain('logDiscoveryEmpty:ap-northeast-2:FLOW');
    expect(a.failed).not.toContain('logDiscoveryEmpty:ap-northeast-2:ALERT');
  });

  it('구성 조회 거부 + 발견된 그룹 이름이 alert/flow 토큰을 둘 다 포함(애매한 이름)하면 그 매칭만으로는 둘 중 어느 타입도 발견 확정 처리하지 않음 (리뷰 확정 라운드13, Codex stop-hook)', async () => {
    // AWS는 로그 그룹 이름을 임의로 허용 — "/flow-alerts"라는 이름은 그 그룹이 실제로
    // FLOW(또는 ALERT) 이벤트를 담고 있다는 증거가 아니라 순전한 명명 우연일 수 있다.
    // 이걸 발견 확정으로 인정하면 진짜 FLOW 그룹이 전혀 다른 이름이라 못 찾힌 경우에도
    // "발견됨"으로 잘못 카운트돼 unknown 신호가 죽고, 이 그룹의 텅 빈 결과가 "0 flows/
    // 0 B"라는 확정 부재처럼 보인다 — 둘 다 unknown으로 남아야 한다(쿼리 자체는 안전하게
    // 양쪽에 실행되므로 targets에는 여전히 등록됨).
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ loggingKnown: false, alertLogging: null, flowLogging: null })] });
    logsSend.mockImplementation(async (cmd: Cmd) =>
      cmd.constructor.name === 'DescribeLogGroupsCommand'
        ? { logGroups: [{ logGroupName: '/aws/network-firewall/DMZVPC/flow-alerts' }] }
        : {});
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    expect(a.failed).toContain('logDiscoveryEmpty:ap-northeast-2:ALERT');
    expect(a.failed).toContain('logDiscoveryEmpty:ap-northeast-2:FLOW');
    // 쿼리는 여전히 안전하게 양쪽 타입에 시도된다 — unknown 표시와 querying은 별개.
    expect(a.targets.map((t) => t.type).sort()).toEqual(['ALERT', 'FLOW']);
    // 리뷰 MAJOR(라운드14): unknown 신호가 failed[]에만 있고 값 계약에 반영 안 되면,
    // 애매한 그룹의 (실제로 무관할 수 있는) 성공한 빈 쿼리 결과가 확정 0으로 계산돼
    // 배너 옆에 "0"이 뜬다 — alertTotals/flowTotals 쿼리 실패와 동일하게 null이어야
    // "확인 불가"로 렌더링된다(page.tsx의 alert.totalAlerts==null / flow.totalFlows==null
    // 인라인 표시 분기).
    expect(a.alert!.totalAlerts).toBeNull();
    expect(a.flow!.totalFlows).toBeNull();
    expect(a.flow!.totalBytes).toBeNull();
  });

  it('구성 조회 거부 + 발견된 로그 그룹 이름에 discriminator 토큰이 방화벽 이름 세그먼트에 우연히 박혀 있어도(예: "workflow-prod") 관례 명명 ALERT 그룹은 정상 발견 확정됨 (리뷰 MAJOR 라운드15)', async () => {
    // "workflow-prod"는 "flow"를 부분 문자열로 포함하지만 토큰(비영숫자로 분리) 기준으로는
    // "workflow"이지 "flow"가 아니다 — whole-name substring 판정이면 이 리전의 ALERT조차
    // "애매함"으로 잘못 분류돼 영구히 unknown이 된다. 실제 관례 명명 ALERT 그룹은 정상
    // 발견 확정돼야 하고(FLOW는 커스텀 명명이라 여전히 못 찾았으므로 FLOW만 unknown).
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ loggingKnown: false, alertLogging: null, flowLogging: null })] });
    logsSend.mockImplementation(async (cmd: Cmd) =>
      cmd.constructor.name === 'DescribeLogGroupsCommand'
        ? { logGroups: [{ logGroupName: '/aws/network-firewall/workflow-prod/alert' }] }
        : {});
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    expect(a.failed).not.toContain('logDiscoveryEmpty:ap-northeast-2:ALERT');
    expect(a.failed).toContain('logDiscoveryEmpty:ap-northeast-2:FLOW');
  });

  it('"netflow"로 끝나는 관례 명명 그룹은 FLOW로 정상 발견 확정됨 (리뷰 MAJOR, PR #221 라운드2 — 라운드15 자체 수정의 회귀)', async () => {
    // netflow는 이 모듈이 필터하는 Suricata event_type("netflow")과 동일한 문자열이라
    // 콘솔에서도 흔히 쓰이는 정당한 FLOW 명명이다. `startsWith('flow')` 토큰 판정으로는
    // "netflow" 토큰 자체가 "flow"로 시작하지 않아 전혀 매칭되지 않는 회귀가 있었다 —
    // base(whole-name includes)보다도 나쁜 결과(이전엔 최소한 매칭은 됐다).
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ loggingKnown: false, alertLogging: null, flowLogging: null })] });
    logsSend.mockImplementation(async (cmd: Cmd) =>
      cmd.constructor.name === 'DescribeLogGroupsCommand'
        ? { logGroups: [{ logGroupName: '/aws/network-firewall/DMZVPC/netflow' }] }
        : {});
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    expect(a.failed).not.toContain('logDiscoveryEmpty:ap-northeast-2:FLOW');
    expect(a.failed).toContain('logDiscoveryEmpty:ap-northeast-2:ALERT');
    expect(a.targets.some((t) => t.type === 'FLOW' && t.group === '/aws/network-firewall/DMZVPC/netflow')).toBe(true);
  });

  it('"flow-logs"로 끝나는 관례 명명 그룹(AWS 콘솔 "flow logs" 용어의 가장 자연스러운 표기)은 FLOW로 정상 발견 확정됨 (리뷰 MAJOR, PR #221 라운드6)', async () => {
    // 라운드5까지 FLOW_TOKENS엔 "flowlog"/"flowlogs"(무하이픈)만 있어 "flow-logs"(하이픈)는
    // 세그먼트 전체 일치에 걸리지 않았다 — 쿼리는 성공(permissive substring)했는데도 발견은
    // 영구 미확정으로 남아 totalFlows가 계속 "확인 불가"였다.
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ loggingKnown: false, alertLogging: null, flowLogging: null })] });
    logsSend.mockImplementation(async (cmd: Cmd) =>
      cmd.constructor.name === 'DescribeLogGroupsCommand'
        ? { logGroups: [{ logGroupName: '/aws/network-firewall/DMZVPC/flow-logs' }] }
        : {});
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    expect(a.failed).not.toContain('logDiscoveryEmpty:ap-northeast-2:FLOW');
    expect(a.failed).toContain('logDiscoveryEmpty:ap-northeast-2:ALERT');
  });

  it('"alertlogs"로 끝나는 관례 명명 그룹은 ALERT로 정상 발견 확정됨 — ALERT_TOKENS도 FLOW_TOKENS와 동일한 파생 규칙(복수형/log/logs/하이픈)을 대칭으로 가짐 (리뷰 MAJOR, PR #221 라운드6)', async () => {
    // 라운드5까지 ALERT_TOKENS엔 "alert"/"alerts"뿐이라 복합형이 전혀 없었다 — FLOW만 복합형을
    // 인정하는 비대칭이 이 회귀의 근본 원인이었다.
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ loggingKnown: false, alertLogging: null, flowLogging: null })] });
    logsSend.mockImplementation(async (cmd: Cmd) =>
      cmd.constructor.name === 'DescribeLogGroupsCommand'
        ? { logGroups: [{ logGroupName: '/aws/network-firewall/DMZVPC/alertlogs' }] }
        : {});
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    expect(a.failed).not.toContain('logDiscoveryEmpty:ap-northeast-2:ALERT');
    expect(a.failed).toContain('logDiscoveryEmpty:ap-northeast-2:FLOW');
  });

  it('마지막 세그먼트는 결정적이지만 다른 세그먼트에 반대 타입 토큰이 있으면(예: "/…/alert/netflow-prod/flow") 발견 확정은 안 하되 양쪽 다 쿼리 대상으로 등록됨 (리뷰 MAJOR, PR #221 라운드3 — 라운드2의 두 결함 수정)', async () => {
    // 라운드2는 두 가지로 틀렸다: (1) 마지막 세그먼트가 결론이 안 나면 whole-name 폴백이
    // 발견 "확정"까지 겸해 방화벽 이름의 우연한 토큰으로도 확정될 수 있었고, (2) 마지막
    // 세그먼트가 결론이 나면(이 케이스처럼 "flow") whole-name은 전혀 안 봐서 앞선 "alert"
    // 세그먼트가 있어도 ALERT로는 쿼리조차 안 됐다(base보다 나쁜 회귀). 고침: 쿼리는
    // terminal ∪ whole-name 합집합(둘 다 등록), 발견 확정은 terminal이 결정적이고
    // whole-name이 반대 타입을 추가하지 않을 때만 — 이 이름은 whole-name에 "alert"가
    // 있어 FLOW 결론과 불일치하므로 어느 쪽도 확정하지 않지만, 쿼리는 양쪽 다 나간다.
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ loggingKnown: false, alertLogging: null, flowLogging: null })] });
    logsSend.mockImplementation(async (cmd: Cmd) =>
      cmd.constructor.name === 'DescribeLogGroupsCommand'
        ? { logGroups: [{ logGroupName: '/aws/network-firewall/alert/netflow-prod/flow' }] }
        : {});
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    expect(a.failed).toContain('logDiscoveryEmpty:ap-northeast-2:ALERT');
    expect(a.failed).toContain('logDiscoveryEmpty:ap-northeast-2:FLOW');
    expect(a.targets.map((t) => t.type).sort()).toEqual(['ALERT', 'FLOW']);
  });

  it('마지막 세그먼트가 결론이 안 나면(방화벽 이름 세그먼트에만 discriminator 토큰) 발견을 확정하지 않음 — whole-name 폴백은 쿼리 등록만, 확정 아님 (리뷰 MAJOR, PR #221 라운드3)', async () => {
    // "/…/alert-prod/logs" — 마지막 세그먼트 "logs"는 아무것도 매칭 안 해 결론이 안 난다.
    // whole-name에는 "alert-prod"의 "alert" 토큰이 남아있지만, 이건 방화벽 이름일 뿐 그
    // 그룹이 실제로 ALERT 이벤트를 담는다는 증거가 아니다 — 발견 확정은 하지 않는다
    // (다만 헛다리를 짚어도 무해하므로 쿼리 대상으로는 등록한다).
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ loggingKnown: false, alertLogging: null, flowLogging: null })] });
    logsSend.mockImplementation(async (cmd: Cmd) =>
      cmd.constructor.name === 'DescribeLogGroupsCommand'
        ? { logGroups: [{ logGroupName: '/aws/network-firewall/alert-prod/logs' }] }
        : {});
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    expect(a.failed).toContain('logDiscoveryEmpty:ap-northeast-2:ALERT');
    expect(a.failed).toContain('logDiscoveryEmpty:ap-northeast-2:FLOW');
    expect(a.targets.some((t) => t.type === 'ALERT')).toBe(true);
  });

  it('방화벽 이름 세그먼트에 하이픈으로 discriminator 토큰이 섞여 있어도(예: "alert-prod") 명확한 마지막 세그먼트("flow")는 정상 발견 확정됨 (리뷰 MAJOR, PR #221 라운드5 — 확정/거부 기준 불일치 수정)', async () => {
    // 라운드4는 확정에는 세그먼트 전체 일치를 쓰면서 거부(veto)에는 tokenize()로 하이픈까지
    // 쪼갠 토큰을 써서 기준이 서로 달랐다 — "alert-prod"(방화벽 이름)의 "alert" 토큰이
    // FLOW 확정을 막아 영구 unknown이 됐다(이 PR이 고치려는 버그를 반대 방향으로 재현).
    // 세그먼트 전체 일치 기준을 확정/거부 양쪽에 동일하게 적용하면 "alert-prod"는 세그먼트
    // 전체가 "alert"가 아니므로 거부 근거가 안 되고, 마지막 세그먼트 "flow"가 정상 확정된다.
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ loggingKnown: false, alertLogging: null, flowLogging: null })] });
    logsSend.mockImplementation(async (cmd: Cmd) =>
      cmd.constructor.name === 'DescribeLogGroupsCommand'
        ? { logGroups: [{ logGroupName: '/aws/network-firewall/alert-prod/flow' }] }
        : {});
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    expect(a.failed).not.toContain('logDiscoveryEmpty:ap-northeast-2:FLOW');
    expect(a.failed).toContain('logDiscoveryEmpty:ap-northeast-2:ALERT');
  });

  it('방화벽 목록 조회 자체가 실패(firewallDiscoveryDegraded)하면 그 리전에 실제 성공한 CWL 대상이 있어도 totalAlerts/totalFlows는 null (리뷰 MAJOR 라운드15, 라운드19에서 제목 오류 수정 — 이 테스트는 discoveryFailed가 아니라 firewallDiscoveryDegraded를 검증함)', async () => {
    // loggingUnknownByType에만 걸린 null 판정은 "스캔이 정상 실행되고 0건"(덜 심각)만
    // 잡는다 — "스캔 자체가 예외로 죽음"(discoveryFailed, 더 심각)이나 방화벽 목록 조회
    // 자체가 실패(firewallDiscoveryDegraded)한 경우는 반영되지 않아, 더 심각한 실패가
    // 확정 숫자로 렌더링되는 역전이 생긴다. 여기서는 firewallDiscoveryDegraded로 검증.
    mockAnalysis.mockResolvedValue({ firewalls: [fw()], degradedRegions: ['us-west-2'], firewallListDegradedRegions: ['us-west-2'] });
    mockInsights(() => [{ cnt: 3 }]);
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    expect(a.failed).toContain('firewallDiscovery');
    expect(a.alert!.totalAlerts).toBeNull();
    expect(a.flow!.totalFlows).toBeNull();
  });

  it('접두사 스캔 자체가 예외로 실패(discoveryFailed)하면 totalAlerts/totalFlows는 null (리뷰 MINOR, PR #221 — 실제로 discoveryFailed 경로를 검증하는 테스트가 없다는 지적)', async () => {
    // loggingKnown: false로 discoverRegions 루프에 들어가되, DescribeLogGroupsCommand 자체가
    // 예외를 던져 discoveryFailed=true가 되는 경로 — 위 테스트(firewallDiscoveryDegraded)와는
    // 다른 코드 경로다.
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ loggingKnown: false, alertLogging: null, flowLogging: null })] });
    logsSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'DescribeLogGroupsCommand') throw new Error('Throttling');
      return {};
    });
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    expect(a.failed).toContain('logDiscovery');
    expect(a.alert).toBeNull();
    expect(a.flow).toBeNull();
  });

  it('Insights 폴링은 anfwLogsAnalysis 진입 시점부터 계산된 공유 데드라인을 넘기면 중단(StopQuery)하고 failed로 표시 (리뷰 MAJOR 라운드7)', async () => {
    // anfwAnalysis()의 콜드 fan-out + 45s 폴링이 겹치면 60s 라우트 예산을 넘길 수 있다는
    // 것이 라운드7 MAJOR였다 — 데드라인이 anfwLogsAnalysis 호출 "시점"부터 공유돼야
    // 폴링이 스스로 멈춘다. Date.now를 조작해 "StartQuery 직후 이미 데드라인을 넘긴"
    // 상황을 시뮬레이션 — 폴링 루프가 한 번도 GetQueryResults를 완료로 못 보고 즉시
    // StopQuery로 빠져야 한다.
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ flowLogging: null })] });
    let stopped = false;
    let now = 1_000_000;
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    logsSend.mockImplementation(async (cmd: Cmd) => {
      switch (cmd.constructor.name) {
        case 'StartQueryCommand':
          now += 46_000; // 45s 예산을 이미 넘긴 상태로 진입
          return { queryId: 'q' };
        case 'GetQueryResultsCommand':
          return { status: 'Running' }; // 완료 신호가 없어도 데드라인 검사가 즉시 루프를 빠져나가야 함
        case 'StopQueryCommand':
          stopped = true;
          return {};
        default: return {};
      }
    });
    try {
      const { anfwLogsAnalysis } = await import('./anfw-logs');
      const a = await anfwLogsAnalysis(3600);
      expect(stopped).toBe(true);
      expect(a.failed).toContain('alertTotals');
    } finally {
      dateSpy.mockRestore();
    }
  });

  it('한 리전에 51개 이상의 발견된 로그 그룹이 있으면 50개씩 청크로 나눠 여러 StartQuery를 실행 (리뷰 MAJOR 라운드8)', async () => {
    // StartQuery의 logGroupNames는 API 상한이 50개 — 접두사 발견 폴백이 관례 명명과
    // 일치하는 그룹을 51개 발견하면(현실적인 시나리오), 청크 없이 한 번에 넘기면
    // InvalidParameterException으로 이 카테고리 분석 전체가 죽는다.
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ loggingKnown: false, alertLogging: null, flowLogging: null })] });
    const groupNames = Array.from({ length: 51 }, (_, i) => `/aws/network-firewall/fw${i}/alert`);
    logsSend.mockImplementation(async (cmd: Cmd) => {
      switch (cmd.constructor.name) {
        case 'DescribeLogGroupsCommand':
          return { logGroups: groupNames.map((logGroupName) => ({ logGroupName })) };
        case 'StartQueryCommand': return { queryId: 'q' };
        case 'GetQueryResultsCommand': return { status: 'Complete', results: [row({ cnt: 1 })] };
        default: return {};
      }
    });
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    // 51개 그룹이 발견됐으므로 최소 2개의 StartQuery(청크)가 나갔어야 하고, 어떤 단일
    // 호출도 50개를 넘지 않았어야 한다(안 그랬으면 mock이 그대로 통과시켜 이 assertion만
    // 으로는 API 거부를 재현하지 못하지만, 최소 "쪼갰다"는 사실은 검증 가능).
    const calls = logsSend.mock.calls.filter(([cmd]) => (cmd as Cmd).constructor.name === 'StartQueryCommand');
    const alertTotalsCalls = calls.filter((c) => ((c[0] as Cmd).input.queryString as string).includes("event_type = 'alert'") && ((c[0] as Cmd).input.queryString as string).includes('stats count'));
    for (const c of calls) {
      const groups = (c[0] as Cmd).input.logGroupNames as string[];
      expect(groups.length).toBeLessThanOrEqual(50);
    }
    expect(alertTotalsCalls.length).toBeGreaterThanOrEqual(1);
    expect(a.failed).not.toContain('alertTotals');
  });

  it('데드라인이 이미 지났으면 StartQuery 자체를 보내지 않음(폴링 진입 전에 차단) — 불필요한 과금 쿼리 방지', async () => {
    // deadlineAt은 anfwAnalysis() 호출 "전"에 고정되므로, 그 호출이 예산을 다 써버리면
    // (여기선 mock으로 시간을 앞당겨 시뮬레이션) runInsights 진입 시점엔 이미 데드라인을
    // 넘긴 상태 — StartQuery조차 나가면 안 된다(폴링 루프에 들어가서야 끊기면 그 사이
    // 이미 과금 쿼리가 생성된 뒤였다).
    let now = 1_000_000;
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    mockAnalysis.mockImplementation(async () => { now += 50_000; return { firewalls: [fw({ flowLogging: null })] }; });
    let startQueryCalled = false;
    logsSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'StartQueryCommand') { startQueryCalled = true; return { queryId: 'q' }; }
      return {};
    });
    try {
      const { anfwLogsAnalysis } = await import('./anfw-logs');
      const a = await anfwLogsAnalysis(3600);
      expect(startQueryCalled).toBe(false);
      expect(a.failed).toContain('alertTotals');
    } finally {
      dateSpy.mockRestore();
    }
  });

  it('Top talker는 리전/청크로 갈라진 동일 (src,dst) 쌍을 합산 — concat만 하면 바이트가 쪼개져 순위가 밀린다 (리뷰 MAJOR 라운드9)', async () => {
    // alert의 topSignatures/topSources/topDests는 merge()/sigMap으로 키 합산하는데
    // topTalkers는 이전엔 concat→sort→slice만 했다 — 두 리전에서 같은 (src,dst) 쌍이
    // 나오면 별개 행으로 남아 진짜 합계보다 작게(그리고 순위가 낮게) 보였다.
    mockAnalysis.mockResolvedValue({
      firewalls: [
        fw({ name: 'fw-a', alertLogging: null }),
        fw({ name: 'fw-b', alertLogging: null, region: 'us-east-1', flowLogging: 'CloudWatchLogs:/aws/network-firewall/other/flow' }),
      ],
    });
    logsSend.mockImplementation(async (cmd: Cmd, region: string) => {
      switch (cmd.constructor.name) {
        case 'StartQueryCommand': return { queryId: 'q' };
        case 'GetQueryResultsCommand': {
          if (region === 'us-east-1') return { status: 'Complete', results: [row({ src: '10.0.0.1', dst: '10.0.0.2', bytes: 400, cnt: 4 })] };
          return { status: 'Complete', results: [row({ src: '10.0.0.1', dst: '10.0.0.2', bytes: 600, cnt: 6 })] };
        }
        default: return {};
      }
    });
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    // 합산 안 됐다면 두 행(400/600)으로 쪼개져 있을 것 — 하나로 합쳐 1000이어야 한다.
    expect(a.flow!.topTalkers).toHaveLength(1);
    expect(a.flow!.topTalkers[0]).toMatchObject({ src: '10.0.0.1', dst: '10.0.0.2', bytes: 1000, flows: 10 });
  });

  it('51개 이상 그룹으로 청크가 갈린 리전이 있으면 flowTopTalkersPartial을 failed에 표시 (리뷰 MAJOR 라운드9 제안)', async () => {
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ loggingKnown: false, alertLogging: null, flowLogging: null })] });
    const groupNames = Array.from({ length: 51 }, (_, i) => `/aws/network-firewall/fw${i}/flow`);
    logsSend.mockImplementation(async (cmd: Cmd) => {
      switch (cmd.constructor.name) {
        case 'DescribeLogGroupsCommand': return { logGroups: groupNames.map((logGroupName) => ({ logGroupName })) };
        case 'StartQueryCommand': return { queryId: 'q' };
        case 'GetQueryResultsCommand': return { status: 'Complete', results: [row({ cnt: 1, bytes: 1 })] };
        default: return {};
      }
    });
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    expect(a.failed).toContain('flowTopTalkersPartial');
  });

  it('발견 폴백 DescribeLogGroups도 공유 데드라인을 넘기면 중단하고 discoveryFailed로 표시 (리뷰 MINOR 라운드9)', async () => {
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ loggingKnown: false, alertLogging: null, flowLogging: null })] });
    let now = 1_000_000;
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    let describeLogGroupsCalled = false;
    logsSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'DescribeLogGroupsCommand') {
        describeLogGroupsCalled = true;
        now += 50_000; // 다음 검사에서 데드라인 초과가 되도록 시간을 앞당김
        return { logGroups: [{ logGroupName: '/aws/network-firewall/DMZVPC/alert' }], nextToken: 'page2' };
      }
      return {};
    });
    try {
      const { anfwLogsAnalysis } = await import('./anfw-logs');
      const a = await anfwLogsAnalysis(3600);
      expect(describeLogGroupsCalled).toBe(true); // 첫 페이지는 데드라인 전이라 정상 호출
      expect(a.failed).toContain('logDiscovery'); // 두 번째 페이지 전 데드라인 초과 → discoveryFailed
    } finally {
      dateSpy.mockRestore();
    }
  });

  it('alertTotals 쿼리가 실패하면 totalAlerts는 0이 아니라 null — 성공한 다른 alert 쿼리는 유지 (리뷰 MAJOR 라운드10)', async () => {
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ flowLogging: null })] });
    logsSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'StartQueryCommand') {
        const q = cmd.input.queryString as string;
        // totals 쿼리(그룹by 없이 count(*)만)만 실패시키고 나머지 alert 쿼리는 성공시킨다.
        if (!q.includes('by') && q.includes('stats count')) throw new Error('boom totals');
        return { queryId: 'q' };
      }
      if (cmd.constructor.name === 'GetQueryResultsCommand') {
        return { status: 'Complete', results: [row({ sid: '5', sig: 'x', cnt: 3 })] };
      }
      return {};
    });
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    expect(a.failed).toContain('alertTotals');
    // totals만 실패했을 뿐 — 0건이 아니라 "확인 불가"로 표현되어야 하고, 이미 받아온
    // topSignatures 표는 살아 있어야 한다(totalAlerts>0 게이트였다면 여기서 숨겨졌을 것).
    expect(a.alert!.totalAlerts).toBeNull();
    expect(a.alert!.topSignatures).toEqual([{ sid: '5', signature: 'x', value: 3 }]);
  });

  it('alertRuleHits 쿼리가 실패하면 ruleHits는 빈 배열이 아니라 null — 실패한 리전의 설정 룰이 "매칭 0(확정 idle)"으로 오판되지 않아야 함 (리뷰 MAJOR, PR #225)', async () => {
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ flowLogging: null })] });
    logsSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'StartQueryCommand') {
        const q = cmd.input.queryString as string;
        // alertRuleHits 쿼리(ispresent(event.alert.signature_id) 필터로 식별)만 실패시키고
        // 나머지 alert 쿼리는 성공시킨다.
        if (q.includes('ispresent(event.alert.signature_id)')) throw new Error('boom rule hits');
        return { queryId: 'q' };
      }
      if (cmd.constructor.name === 'GetQueryResultsCommand') {
        return { status: 'Complete', results: [row({ sid: '5', sig: 'x', cnt: 3 })] };
      }
      return {};
    });
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    expect(a.failed).toContain('alertRuleHits');
    // ruleHits 쿼리만 실패했을 뿐 — 빈 배열(확정 매칭 0)이 아니라 null(불명)이어야 하고,
    // 이미 받아온 topSignatures 등 다른 alert 결과는 살아 있어야 한다.
    expect(a.alert!.ruleHits).toBeNull();
    expect(a.alert!.topSignatures).toEqual([{ sid: '5', signature: 'x', value: 3 }]);
  });

  it('룰 히트가 정확히 join 컷오프(100)개면 잘린 게 아니므로 ruleHitsTruncated=false (리뷰 MINOR off-by-one, PR #225 라운드8)', async () => {
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ flowLogging: null })] });
    mockInsights((group, query) => {
      if (query.includes('by sid, sig, act')) {
        return Array.from({ length: 100 }, (_, i) => ({ sid: String(i), sig: `sig${i}`, act: 'blocked', cnt: 1 }));
      }
      return [{ cnt: 100 }];
    });
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    // 정확히 100개 — slice(0, 100)이 아무것도 잘라내지 않았으므로 truncated가 아니다.
    // >=였다면 여기서 잘못 true가 됐을 것.
    expect(a.alert!.ruleHits).toHaveLength(100);
    expect(a.alert!.ruleHitsTruncated).toBe(false);
  });

  it('같은 sid가 기간 내에 여러 (signature, action) 튜플로 나뉘어도 sid 단위로 먼저 합산 — 컷오프가 한 sid의 값을 부분합으로 쪼개지 않음 (리뷰 MAJOR, PR #225 라운드9)', async () => {
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ flowLogging: null })] });
    mockInsights((group, query) => {
      if (query.includes('by sid, sig, act')) {
        // 같은 sid=1이 라운드10에서 action이 alert→blocked로 바뀌어 두 개의 튜플로 집계됨.
        // 튜플 단위로 자르는 이전 로직이었다면 이 중 하나가 top-N 밖으로 밀릴 수 있었다.
        return [
          { sid: '1', sig: 'old sig', act: 'allowed', cnt: 5 },
          { sid: '1', sig: 'new sig', act: 'blocked', cnt: 7 },
        ];
      }
      return [{ cnt: 12 }];
    });
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    // sid=1은 정확히 한 행으로 합산되어야 하고(12 = 5+7), 두 액션이 모두 보존돼야 한다.
    expect(a.alert!.ruleHits).toEqual([
      { sid: '1', signature: 'old sig', actions: ['allowed', 'blocked'], hits: 12 },
    ]);
  });

  it('ALERT 로그 그룹 생성 시각이 range 시작보다 이전이면 alertCoverageComplete=true (리뷰 MAJOR, PR #225 라운드14)', async () => {
    const now = 10_000_000_000; // 임의 고정 시각
    const rangeSec = 3600;
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      mockAnalysis.mockResolvedValue({ firewalls: [fw({ flowLogging: null })] });
      logsSend.mockImplementation(async (cmd: Cmd) => {
        switch (cmd.constructor.name) {
          case 'DescribeLogGroupsCommand':
            return { logGroups: [{ logGroupName: '/aws/network-firewall/DMZVPC/alert', creationTime: now - rangeSec * 1000 - 1_000_000 }] };
          case 'StartQueryCommand': return { queryId: 'q' };
          case 'GetQueryResultsCommand': return { status: 'Complete', results: [row({ cnt: 0 })] };
          default: return {};
        }
      });
      const { anfwLogsAnalysis } = await import('./anfw-logs');
      const a = await anfwLogsAnalysis(rangeSec);
      expect(a.alert!.alertCoverageComplete).toBe(true);
    } finally {
      dateSpy.mockRestore();
    }
  });

  it('ALERT 로그 그룹이 range 시작보다 늦게 생성됐으면(로깅이 기간 중간에 켜짐) alertCoverageComplete=false — hits=0을 확정 idle로 볼 수 없음 (리뷰 MAJOR 확정, PR #225 라운드14)', async () => {
    const now = 10_000_000_000;
    const rangeSec = 3600;
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      mockAnalysis.mockResolvedValue({ firewalls: [fw({ flowLogging: null })] });
      logsSend.mockImplementation(async (cmd: Cmd) => {
        switch (cmd.constructor.name) {
          case 'DescribeLogGroupsCommand':
            // 로그 그룹이 range 시작(now - rangeSec*1000)보다 나중에 생성됨 — 로깅이 최근에야 켜졌을 가능성.
            return { logGroups: [{ logGroupName: '/aws/network-firewall/DMZVPC/alert', creationTime: now - (rangeSec * 1000) / 2 }] };
          case 'StartQueryCommand': return { queryId: 'q' };
          case 'GetQueryResultsCommand': return { status: 'Complete', results: [row({ cnt: 0 })] };
          default: return {};
        }
      });
      const { anfwLogsAnalysis } = await import('./anfw-logs');
      const a = await anfwLogsAnalysis(rangeSec);
      expect(a.alert!.alertCoverageComplete).toBe(false);
    } finally {
      dateSpy.mockRestore();
    }
  });

  it('로그 그룹의 retentionInDays가 짧아 실제 보존 구간이 range 시작보다 늦게 시작되면 alertCoverageComplete=false (리뷰 MAJOR, PR #225 라운드14)', async () => {
    const now = 10_000_000_000;
    const rangeSec = 7 * 86400; // 7일
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      mockAnalysis.mockResolvedValue({ firewalls: [fw({ flowLogging: null })] });
      logsSend.mockImplementation(async (cmd: Cmd) => {
        switch (cmd.constructor.name) {
          case 'DescribeLogGroupsCommand':
            // 생성은 오래전이지만 보존기간이 1일뿐이라 7일 range의 앞쪽 6일은 이미 만료·삭제됨.
            return { logGroups: [{ logGroupName: '/aws/network-firewall/DMZVPC/alert', creationTime: now - 365 * 86400_000, retentionInDays: 1 }] };
          case 'StartQueryCommand': return { queryId: 'q' };
          case 'GetQueryResultsCommand': return { status: 'Complete', results: [row({ cnt: 0 })] };
          default: return {};
        }
      });
      const { anfwLogsAnalysis } = await import('./anfw-logs');
      const a = await anfwLogsAnalysis(rangeSec);
      expect(a.alert!.alertCoverageComplete).toBe(false);
    } finally {
      dateSpy.mockRestore();
    }
  });

  it('한 리전이 자기 상한(150)에 도달하면 ruleHitsPartial=true — present인 sid도 그 리전 몫이 잘려 과소집계됐을 수 있음 (리뷰 MAJOR, PR #225 라운드8)', async () => {
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ flowLogging: null })] });
    mockInsights((group, query) => {
      if (query.includes('by sid, sig, act')) {
        return Array.from({ length: 150 }, (_, i) => ({ sid: String(i), sig: `sig${i}`, act: 'blocked', cnt: 1 }));
      }
      return [{ cnt: 150 }];
    });
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    expect(a.alert!.ruleHitsPartial).toBe(true);
  });

  it('리전 상한에 못 미치면 ruleHitsPartial=false', async () => {
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ flowLogging: null })] });
    mockInsights((group, query) => {
      if (query.includes('by sid, sig, act')) return [{ sid: '1', sig: 'x', act: 'blocked', cnt: 1 }];
      return [{ cnt: 1 }];
    });
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    expect(a.alert!.ruleHitsPartial).toBe(false);
  });

  it('flowTotals 쿼리가 실패하면 totalFlows/totalBytes는 0이 아니라 null — byProto 등 다른 flow 쿼리 결과는 유지 (리뷰 MAJOR 라운드11)', async () => {
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ alertLogging: null })] });
    logsSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'StartQueryCommand') {
        const q = cmd.input.queryString as string;
        // totals 쿼리(group-by 없이 count+sum(bytes))만 실패시키고 나머지 flow 쿼리는 성공.
        // 주의: "bytes"는 부분문자열로 "by"를 포함하므로 " by "(공백 포함)로 group-by절만 매칭.
        if (q.includes('sum(event.netflow.bytes) as bytes') && !q.includes(' by ')) throw new Error('boom flow totals');
        return { queryId: 'q' };
      }
      if (cmd.constructor.name === 'GetQueryResultsCommand') {
        return { status: 'Complete', results: [row({ proto: 'TCP', cnt: 5 })] };
      }
      return {};
    });
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    expect(a.failed).toContain('flowTotals');
    expect(a.flow!.totalFlows).toBeNull();
    expect(a.flow!.totalBytes).toBeNull();
    // proto 쿼리는 별도 쿼리라 실패하지 않았어야 하고, 그 로드된 결과는 살아있어야 한다.
    expect(a.flow!.byProto).toEqual([{ name: 'TCP', value: 5 }]);
  });

  it('51개 이상 그룹으로 청크가 갈린 리전이 있으면 alertTopNPartial을 failed에 표시 (리뷰 MAJOR 라운드10)', async () => {
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ loggingKnown: false, alertLogging: null, flowLogging: null })] });
    const groupNames = Array.from({ length: 51 }, (_, i) => `/aws/network-firewall/fw${i}/alert`);
    logsSend.mockImplementation(async (cmd: Cmd) => {
      switch (cmd.constructor.name) {
        case 'DescribeLogGroupsCommand': return { logGroups: groupNames.map((logGroupName) => ({ logGroupName })) };
        case 'StartQueryCommand': return { queryId: 'q' };
        case 'GetQueryResultsCommand': return { status: 'Complete', results: [row({ cnt: 1 })] };
        default: return {};
      }
    });
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    expect(a.failed).toContain('alertTopNPartial');
  });

  it('GetQueryResults가 던지면(스로틀 등) 데드라인 초과 경로와 동일하게 StopQuery를 시도 — 과금 쿼리를 방치하지 않음 (리뷰 MINOR 라운드10)', async () => {
    mockAnalysis.mockResolvedValue({ firewalls: [fw({ flowLogging: null })] });
    let stopQueryCalled = false;
    logsSend.mockImplementation(async (cmd: Cmd) => {
      switch (cmd.constructor.name) {
        case 'StartQueryCommand': return { queryId: 'q' };
        case 'GetQueryResultsCommand': throw new Error('ThrottlingException');
        case 'StopQueryCommand': stopQueryCalled = true; return {};
        default: return {};
      }
    });
    const { anfwLogsAnalysis } = await import('./anfw-logs');
    const a = await anfwLogsAnalysis(3600);
    expect(stopQueryCalled).toBe(true);
    expect(a.failed).toContain('alertTotals');
  });
});

/** 발견 폴백용 mock: DescribeLogGroups가 관례 이름 2개 반환 + 최소 Insights 응답. */
function mockInsightsWithDiscovery() {
  const alerts = 3;
  logsSend.mockImplementation(async (cmd: Cmd) => {
    switch (cmd.constructor.name) {
      case 'DescribeLogGroupsCommand':
        return {
          logGroups: [
            { logGroupName: '/aws/network-firewall/DMZVPC/alert' },
            { logGroupName: '/aws/network-firewall/DMZVPC/flow' },
          ],
        };
      case 'StartQueryCommand': return { queryId: 'q' };
      case 'GetQueryResultsCommand': return { status: 'Complete', results: [row({ cnt: alerts, bytes: 1 })] };
      default: return {};
    }
  });
  return { alerts };
}
