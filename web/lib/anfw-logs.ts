import { CloudWatchLogsClient, StartQueryCommand, GetQueryResultsCommand, StopQueryCommand, DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { anfwAnalysis } from './anfw';

// Network Firewall Alert/Flow 로그 분석 (owner 가이드 2계층): 방화벽 로깅 구성의
// **CloudWatch Logs 대상만** Logs Insights로 집계한다 (S3/Firehose 대상은 Insights 불가 —
// dns-logs와 동일 제약, 화면에 정직 고지). 로그는 Suricata EVE JSON — 중첩 필드는
// `event.alert.signature_id` 도트 표기로 접근.
// 함정: 스테이징 태스크 롤은 DescribeLoggingConfiguration이 SCP류로 거부(loggingKnown=false)
// → 이때는 `/aws/network-firewall/` 접두사 DescribeLogGroups로 **휴리스틱 발견** 폴백.
// 리뷰(PR #221 라운드5): 분류는 2단계 — **쿼리 등록**은 이름에 alert/flow 부분 문자열
// 포함 여부(permissive substring, base와 동일 — 쿼리 커버리지는 절대 base보다 좁아지면
// 안 됨). **발견 확정**(foundByType, unknown 신호를 끄는 것)은 `/`-세그먼트 전체가
// ALERT_TOKENS/FLOW_TOKENS와 정확히 일치할 때만(부분 문자열 아님) + 그 이름의 다른
// 세그먼트에 반대 타입 세그먼트가 없을 때만 — 이름이 그저 그 타입을 우연히 포함한다는
// 것과 실제로 그 타입의 증거라는 것은 다르다.

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
// 리뷰 MINOR(PR #221): 접두사 발견 폴백은 리전당 수만 개 로그 그룹을 순회할 수 있다(round-9
// 코멘트) — 그룹마다 새 Set을 만들지 않도록 모듈 스코프로 끌어올린다.
// 리뷰 MAJOR(확정, PR #221 라운드6): 두 허용목록이 비대칭이고 하이픈 복합형을 못 커버했다 —
// ALERT엔 복합형이 전혀 없고 FLOW엔 "flowlog(s)"만 있어 "netflows"·"alertlog(s)"·
// "flow-logs"·"alert-logs"(AWS 콘솔 용어 "flow logs"의 가장 자연스러운 표기) 같은 관례적
// 이름이 세그먼트 전체 일치에 걸리지 않아 영구히 미확정 처리됐다 — 쿼리는 permissive
// substring이라 실제로 성공했는데도 헤드라인 total이 "확인 불가"로 굳어버리는, 이 PR이
// 고치려는 바로 그 버그의 반대 방향 재현. base·suffix·하이픈유무를 대칭으로 생성해 둘 다
// 동일한 파생 규칙을 따르게 한다(확정/거부 양쪽에서 여전히 세그먼트 전체 일치만 인정 —
// 부분 문자열은 아님).
const withLogSuffixes = (base: string): string[] => [
  base, `${base}s`, `${base}log`, `${base}logs`, `${base}-log`, `${base}-logs`,
];
const ALERT_TOKENS = new Set(withLogSuffixes('alert'));
const FLOW_TOKENS = new Set([...withLogSuffixes('flow'), ...withLogSuffixes('netflow')]);
const logsClients = new Map<string, CloudWatchLogsClient>();
const logs = (r: string) => {
  let c = logsClients.get(r);
  if (!c) { c = new CloudWatchLogsClient({ region: r }); logsClients.set(r, c); }
  return c;
};

const TTL_MS = 4 * 60_000; // Insights는 스캔 GB 과금 — 캐시 필수
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
export function _resetAnfwLogsCacheForTests() { cache.clear(); inflight.clear(); logsClients.clear(); }

type Row = Record<string, string>;

// 리뷰 MAJOR(확정): 이전엔 그룹별로 쿼리를 따로 실행해 각자 `| limit 10`으로 잘린 뒤
// 병합·재정렬했다 — 그룹 A·B 각각에서 11위인 항목이 실제 전역 1위여도 두 결과 모두에서
// 빠져 최종 Top-N에서 통째로 사라지고, 살아남은 항목의 합산 카운트도 실제보다 낮게
// 나온다(이 카드들의 핵심 산출물인 "어떤 sid가 무엇을 차단했는지"가 조용히 틀어짐).
// Logs Insights StartQuery는 같은 리전의 여러 로그 그룹을 `logGroupNames`로 한 쿼리에
// 묶을 수 있다 — 리전당 그룹 전체를 하나의 쿼리로 집계하면 `limit`이 진짜 전역 Top-N이
// 된다(리전이 여럿이면 리전 단위 결과를 병합하는데, 리전 수는 보통 1~소수라 오차 폭이
// 이전의 "그룹 수" 규모에서 "리전 수" 규모로 크게 줄어든다).
// 리뷰 MAJOR(확정, 라운드7): 폴링 상한이 호출마다 고정 45회(45s)였는데, anfwLogsAnalysis()는
// 이 함수를 부르기 전에 이미 anfwAnalysis()의 콜드 멀티 리전 fan-out을 기다린다 — 그 다음
// 45s+ 폴링이 겹치면 이 라우트의 maxDuration=60/CloudFront origin_read_timeout=60을 실제로
// 넘긴다(코드 자신의 실측 코멘트 "24h 566만 행에서 30s 미완료"가 45s+ 폴링이 드문 일이 아님을
// 증언). audit 경로(anfw/route.ts)가 이미 하는 것과 같은 패턴 — 요청 전체에 공유되는
// 데드라인을 anfwAnalysis() 호출 "전"에 계산해 폴링 루프에 흘려보낸다. 고정 반복 횟수가
// 아니라 남은 예산만큼만 기다리므로, 앞단(anfwAnalysis)이 오래 걸렸으면 폴링은 그만큼
// 짧게 남고 — 개별 쿼리가 실패로 끝나 failed[]에 표시될 뿐 전체 패널이 504로 죽지 않는다.
async function runInsights(region: string, groups: string[], query: string, rangeSec: number, deadlineAt: number): Promise<Row[]> {
  // 리뷰 MINOR(확정, 라운드8): 데드라인 검사가 폴링 루프 안에만 있어서, 예산이 이미
  // 소진된 뒤에도 새 StartQuery를 계속 만들어 냈다(billed) — 만들자마자 폴링 루프가
  // 0회 반복하고 StopQuery로 취소하니 결과는 같지만 불필요한 과금 쿼리가 나간다.
  if (Date.now() >= deadlineAt) throw new Error('Insights query deadline already exceeded');
  const end = Math.floor(Date.now() / 1000);
  const { queryId } = await logs(region).send(new StartQueryCommand({
    logGroupNames: groups, queryString: query, startTime: end - rangeSec, endTime: end, limit: 1000,
  }));
  if (!queryId) return [];
  // 리뷰 MINOR(확정, 라운드10): StopQuery는 데드라인 초과 경로에만 있었다 — GetQueryResults
  // 자체가 던지면(스로틀/일시적 5xx) 쿼리를 취소하지 않고 그대로 함수를 빠져나가, 이 파일에서
  // 가장 비싼 호출(GB 스캔 과금)이 백그라운드에서 계속 실행·과금된다. 완료 외의 모든 종료
  // 경로(예외/Failed·Cancelled·Timeout/데드라인)에서 StopQuery를 시도하도록 통일.
  try {
    while (Date.now() < deadlineAt) {
      const res = await logs(region).send(new GetQueryResultsCommand({ queryId }));
      if (res.status === 'Complete') {
        return (res.results ?? []).map((row) =>
          Object.fromEntries(row.filter((f) => f.field && f.field !== '@ptr').map((f) => [f.field as string, f.value ?? ''])));
      }
      if (res.status === 'Failed' || res.status === 'Cancelled' || res.status === 'Timeout') {
        throw new Error(`Insights query ${res.status}`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('Insights query deadline reached');
  } catch (e) {
    await logs(region).send(new StopQueryCommand({ queryId })).catch(() => {});
    throw e;
  }
}

export interface AnfwLogTarget {
  firewall: string; region: string; type: 'ALERT' | 'FLOW'; group: string;
  /** true = 로깅 구성 조회 불가로 접두사 휴리스틱 발견 (구성 확인 아님). */
  discovered: boolean;
}

export interface AnfwAlertAnalytics {
  /** alertTotals 쿼리 자체가 실패했거나, 이 리전의 ALERT 로그 그룹 발견 자체가 unknown이면 null —
   *  0과 구분해 "0건"이 "조회 실패/발견 unknown"을 가리지 않게 함. */
  totalAlerts: number | null;
  byAction: { name: string; value: number }[];
  topSignatures: { sid: string; signature: string; value: number }[];
  /** Stateful 룰 히트 카운트 (2026-08 신기능과 동일 소스 — Alert 로그 집계):
   *  sid 단위로 미리 합산된 매칭 수(리뷰 MAJOR, 라운드9 — 튜플(sid,signature,action) 단위로
   *  자르면 컷오프 경계에서 한 sid의 부분합만 남는 문제가 있어, 합산 후가 아니라 합산 전에
   *  sid로 먼저 묶는다), 상위 100(sid 개수 기준). 설정 룰 SID와 조인해 매칭 0 룰을 표면화.
   *  리뷰 MAJOR(확정): alertRuleHits 쿼리 자체가 실패/청크 truncation됐거나 발견이
   *  unknown이면 null — totalAlerts와 동일 계약. 이 게이트 없이는 조회 실패 리전의 설정
   *  룰이 "매칭 0(확정 idle)"로 오판되어 정책 사각지대 경고가 거짓 양성을 낸다. */
  ruleHits: { sid: string; signature: string; actions: string[]; hits: number }[] | null;
  /** true면 히트 집계가 top-100으로 잘렸음(hits=0인 SID가 실제로는 잘린 구간에 있을 수 있음) —
   *  소비자는 ruleHits에 없는 설정 SID를 "매칭 0"이 아니라 "불명"으로 표시해야 한다. */
  ruleHitsTruncated: boolean;
  /** true면 하나 이상의 리전이 자기 몫 조회에서 리전별 상한(RULE_HITS_PER_REGION_LIMIT)에
   *  정확히 도달함 — 그 리전에 실제로 더 있었을 수 있다는 뜻이라, ruleHits에 present인
   *  sid라도 hits가 그 리전의 몫만큼 과소집계됐을 수 있다(리뷰 MAJOR, 라운드8 — 병합
   *  후 존재 여부만 보는 ruleHitsTruncated와 달리, 존재하는 sid의 "정확한 값" 신뢰도를
   *  가리키는 별도 신호). 소비자는 양수 히트를 "≥N"(하한)으로 표시해야 한다. */
  ruleHitsPartial: boolean;
  /** false면 ALERT 로그 그룹 중 하나 이상이 range 시작 시점을 커버하지 못함(로깅이 range
   *  중간에 켜졌거나 그룹이 늦게 생성됨/보존기간 만료) — 이 range 안에서 hits=0인 설정
   *  룰이라도 "확정 idle"이 아니라 "커버리지 밖일 수 있음"이다(리뷰 MAJOR, 라운드14). */
  alertCoverageComplete: boolean;
  topSources: { name: string; value: number }[];
  topDests: { name: string; value: number }[];
}

export interface AnfwFlowAnalytics {
  /** flowTotals 쿼리 자체가 실패했거나 FLOW 로그 그룹 발견이 unknown이면 둘 다 null — alertTotals와
   *  동일 계약(0 ≠ 조회 실패/발견 unknown). */
  totalFlows: number | null; totalBytes: number | null;
  /** (src, dst) 호스트쌍 기준 — dest_port는 유동 포트라 group 카디널리티가 플로우 수와 같아져 시간 초과(실측). */
  topTalkers: { src: string; dst: string; bytes: number; flows: number }[];
  /** Top talker 집계 창(초) — 플로우 볼륨 과다로 요청 범위보다 좁을 수 있음 (rangeSec와 다르면 UI 고지). */
  talkersWindowSec: number;
  byProto: { name: string; value: number }[];
}

export interface AnfwLogsAnalysis {
  targets: AnfwLogTarget[];
  /** CloudWatch Logs 외 대상(S3/Firehose)만 있는 방화벽 수 — Insights 분석 불가 고지용. */
  unsupportedDestinations: number;
  alert: AnfwAlertAnalytics | null;
  flow: AnfwFlowAnalytics | null;
  /** 부분 실패한 분석 키 (해당 패널만 비움). */
  failed: string[];
  rangeSec: number;
  /** 이 분석 실행이 시작된 서버 시각(ms epoch) — 리뷰 MAJOR(Codex stop-hook, PR #225
   *  라운드21): AnfwAnalysis.generatedAt과 이 값은 서로 독립적인 4분 TTL 캐시를 가진
   *  별도 fetch(/api/anfw?range= vs ?view=logs&range=)에서 나온다 — 토폴로지는 방금
   *  갱신됐는데 로그 분석은 최대 4분 전 캐시일 수 있고(또는 반대), 그 시차 구간에 수정된
   *  정책/룰그룹은 data.generatedAt 하나만 기준으로 계산한 rangeStartMs로는 놓친다.
   *  실제 Insights 쿼리 startTime은 이 값 이후의 순간에서 샘플링되므로, 이 값은 "가능한
   *  가장 이른" 로그 윈도우 시작의 보수적 상한이다 — data.generatedAt과 이 값 중 더 이른
   *  쪽을 range 시작 기준으로 써야 두 캐시의 시차로 인한 fail-open을 막는다. */
  generatedAt: number;
}

const num = (s: string | undefined): number => (s != null && s !== '' ? Number(s) || 0 : 0);

/** 로깅 구성(알면 정확) 또는 접두사 발견(모르면 휴리스틱)으로 CWL 대상 도출. */
async function resolveTargets(rangeSec: number, deadlineAt: number): Promise<{ targets: AnfwLogTarget[]; unsupported: number; discoveryFailed: boolean; firewallDiscoveryDegraded: boolean; loggingUnknownByType: Record<'ALERT' | 'FLOW', string[]> }> {
  const a = await anfwAnalysis(rangeSec);
  const targets: AnfwLogTarget[] = [];
  let unsupported = 0;
  const discoverRegions = new Set<string>();
  // 리뷰 MAJOR(확정, 라운드6): List/Describe 자체가 실패한 리전은 anfwAnalysis()의
  // firewalls[]에서 통째로 빠지고 degradedRegions에만 남는다(anfw.ts 계약) — 이 함수는
  // a.firewalls만 순회하므로 그런 리전은 targets에 아무것도 안 남고 unsupported/
  // discoveryFailed도 안 켜진다. 결과적으로 "이 방화벽이 어떤 대상으로 로깅하는지도
  // 모르는" 상태가 "CloudWatch Logs 대상 로그 없음"으로 렌더링된다 — 이 PR이 다른
  // 모든 경로에서 지키는 "unknown ≠ off" 계약을 이 함수 자신이 어긴 것.
  // 리뷰 MAJOR(확정, PR #221 라운드2): a.degradedRegions는 firewalls·policies·ruleGroups 중
  // 어느 것 하나라도 부분 실패하면 켜지는 포괄 신호다 — 방화벽 로깅 구성과 무관한
  // DescribeFirewallPolicy/DescribeRuleGroup 실패(스로틀 등)에도 켜져서, 완전히 정상 조회된
  // 리전의 확정 alert/flow 총계까지 account-wide로 null 처리해버린다. 방화벽 목록(따라서
  // 로깅 구성) 자체를 확인할 수 있었는지만 보는 firewallListDegradedRegions로 좁힌다.
  const firewallDiscoveryDegraded = (a.firewallListDegradedRegions ?? []).length > 0;
  for (const f of a.firewalls) {
    if (!f.loggingKnown) { discoverRegions.add(f.region); continue; }
    // 리뷰 MINOR: ALERT→CWL + FLOW→S3처럼 섞인 방화벽은 anyCwl=true라 unsupported에서
    // 누락됐다 — S3 쪽 로그는 여전히 Insights 분석 불가인데 그 사실이 고지되지 않았다.
    // "CWL 아닌 대상이 하나라도 있으면" 기준으로 변경 — 전체/부분 미지원 모두 집계.
    let anyNonCwl = false;
    for (const [type, dest] of [['ALERT', f.alertLogging], ['FLOW', f.flowLogging]] as const) {
      if (!dest) continue;
      const m = /^CloudWatchLogs:(.+)$/.exec(dest);
      if (m) targets.push({ firewall: f.name, region: f.region, type, group: m[1], discovered: false });
      else anyNonCwl = true;
    }
    if (anyNonCwl) unsupported += 1;
  }
  // 폴백: 관례 접두사 스캔 (콘솔 기본 명명 /aws/network-firewall/...) — 이름으로 alert/flow 분류.
  // 리뷰 MAJOR(확정): 이전엔 DescribeLogGroups가 실패(스로틀/거부)해도 그냥 catch로 삼켜
  // "발견된 로그 없음"과 똑같이 보였다 — DescribeLoggingConfiguration이 이미 거부된
  // SCP류 환경에서 이 폴백까지 실패하면 "CloudWatch Logs 대상 로그 없음"으로 렌더링돼,
  // 이 폴백이 존재하는 이유였던 "unknown ≠ off" 계약을 이 경로 자신이 어겼다.
  // 또한 미순회였던 NextToken도 페이지네이션해 1페이지 너머의 로그 그룹을 놓치지 않는다.
  let discoveryFailed = false;
  // 리뷰 MAJOR(확정, 라운드7): loggingKnown=false(구성 조회 거부)인데 접두사 스캔이
  // "예외 없이 정상 실행되고 0건 반환"하면(관례 명명이 아닌 커스텀 로그 그룹이 흔한
  // 정상 상황) discoveryFailed는 그대로 false로 남아 targets:[]·failed:[] — 결과가
  // discoverRegions가 아예 없었던 경우("로깅 구성을 확인해 정말 CWL 대상이 없음")와
  // 구분이 안 된다. 두 케이스 모두 "unknown"인데 하나는 "off"로 렌더링된 것 —
  // 이 스캔이 무엇 하나도 못 찾은 리전을 별도로 기록해 confirmed-absence와 분리한다.
  // 리뷰 MAJOR(확정, 라운드12): unknown-ness를 리전 단위로만 기록하면(이전 방식: 그
  // 리전에서 ALERT/FLOW 둘 다 하나도 못 찾았을 때만 표시), 구성 조회가 거부됐는데
  // 관례 명명 ALERT 그룹만 발견되고 FLOW는 커스텀 명명이라 못 찾은 경우 그 리전은
  // "발견됨"으로 카운트돼 빠지고, FLOW 카드는 "unknown"을 "확정 없음"으로 렌더링한다
  // — 다른 모든 경로가 지키는 계약을 이 경로만 타입 단위에서 어긴 것. ALERT/FLOW를
  // 독립적으로 추적해, 한쪽만 발견돼도 다른 쪽의 unknown 신호가 죽지 않게 한다.
  const loggingUnknownByType: Record<'ALERT' | 'FLOW', string[]> = { ALERT: [], FLOW: [] };
  for (const region of discoverRegions) {
    const foundByType: Record<'ALERT' | 'FLOW', boolean> = { ALERT: false, FLOW: false };
    try {
      let nextToken: string | undefined;
      do {
        // 리뷰 MINOR(확정, 라운드9): 이 파이프라인의 다른 모든 AWS 페이지네이션(감사
        // 조회, Insights 폴링)은 deadlineAt을 공유해 예산을 넘기지 않는데, 이 루프만
        // 무제한이었다 — 극단적으로 로그 그룹이 많은 계정(수만 개)에서 이론상 45s
        // 예산을 이 발견 단계에서 다 써버릴 수 있다. 나머지 경로와 동일하게 데드라인
        // 도달 시 중단하고 discoveryFailed로 미완결을 표시한다.
        if (Date.now() >= deadlineAt) { discoveryFailed = true; break; }
        const r = await logs(region).send(new DescribeLogGroupsCommand({ logGroupNamePrefix: '/aws/network-firewall', nextToken }));
        for (const g of r.logGroups ?? []) {
          const name = g.logGroupName ?? '';
          const lower = name.toLowerCase();
          // 리뷰 MINOR(라운드12): "alert"/"flow" 접두사 매칭은 상호배타 우선순위였다 —
          // 둘 다 포함하는 이름(예: /flow-alerts)이면 ALERT 하나에만 등록됐다. 쿼리는
          // event_type으로 필터하므로 양쪽 다 걸리는 이름은 두 타입 모두에 등록해도
          // 안전 — 어느 한쪽으로 단정하는 것보다 낫다.
          // 리뷰 확정(라운드13, Codex stop-hook): 하지만 "안전하게 양쪽에 등록"과 "그
          // 매칭을 발견 확정 증거로 인정"은 다른 얘기다 — AWS는 로그 그룹 이름을
          // 임의로 허용하므로 /flow-alerts라는 이름 자체는 그 그룹이 실제로 FLOW
          // 이벤트를 담고 있다는 증거가 아니다(순전한 명명 우연일 수 있음). 이걸
          // foundByType로 인정하면, 진짜 FLOW 로그 그룹이 전혀 다른(추측 불가능한)
          // 이름이라 못 찾힌 상황에서도 "발견됨"으로 잘못 카운트되어 unknown 신호가
          // 죽고, 이 우연한 그룹의 텅 빈 결과가 "0 flows/0 B"라는 확정 부재처럼
          // 보인다 — 정확히 이 PR이 계속 고쳐온 계약 위반. 애매한(둘 다 포함) 이름은
          // 쿼리는 여전히 양쪽에 실행하되(실제로 둘 다/어느 한쪽 담고 있을 가능성에
          // 대비 — 헛다리 짚어도 event_type 필터 덕에 무해), 어느 쪽 unknown 신호도
          // 끄지 않는다. 한쪽 토큰만 포함한 명확한 이름만 그 타입의 발견 확정 증거로 인정.
          // 리뷰 MAJOR(확정, 라운드15): 위 판정을 whole-name substring(`includes`)으로
          // 하면 discriminator 토큰이 이름의 다른 부분(방화벽 이름 세그먼트 등)에 우연히
          // 박혀 있어도 매칭된다 — 예: `workflow-prod`엔 "flow"가 포함되지만 실제로는
          // alert 전용 컨벤션 그룹이다.
          // 리뷰 MAJOR(확정, PR #221 라운드2 — 라운드15 자체 수정의 회귀):
          // `startsWith('flow')` 토큰 판정으로 바꾼 결과 "netflow"라는 토큰 자체가
          // "flow"로 시작하지 않아 전혀 매칭되지 않았다 — netflow는 이 모듈이 필터하는
          // Suricata event_type("netflow")과 동일한, 콘솔에서도 흔히 쓰이는 정당한 FLOW
          // 명명이라 이건 base(`includes`)보다도 나쁜 회귀다(base는 최소한 매칭은 했다).
          // 또한 whole-name 토큰 판정은 위치를 안 가려서, 관례상 타입을 나타내는 마지막
          // 세그먼트가 명확한데도 다른(방화벽 이름) 세그먼트의 우연한 토큰 때문에 애매로
          // 오분류될 수 있었다(예: `/…/workflow-prod/alert` — 마지막 세그먼트 "alert"만
          // 보면 명확한데 "workflow-prod" 세그먼트도 함께 보는 whole-name 판정이면 계속
          // 잘못 애매해질 위험). 콘솔 명명 관례는 discriminator를 마지막 세그먼트에
          // 두므로, 마지막 세그먼트만 먼저 명시적 허용목록으로 판정하고, 그 결과가
          // 결론이 안 나면(둘 다/둘 다 아님) 전체 이름의 토큰으로 폴백한다. 허용목록은
          // 정확 일치만(부분 문자열/prefix 아님) 인정 — "alerting"·"flowchart"·
          // "alert-prod"(방화벽 이름) 같은 임의 접두사는 더 이상 증거로 인정되지 않는다.
          // 리뷰 MAJOR(확정, PR #221 라운드4 — 라운드2/3 자체 수정의 결함): 라운드2/3은 쿼리
          // 등록(isAlert/isFlow)까지 exact-token 판정(terminal ∪ whole-name)으로 좁혀서,
          // "alertlogs"/"netflows"처럼 정확히 "alert"/"flow"가 아닌 복합 토큰 이름은 쿼리조차
          // 안 나갔다 — base(`includes`)는 이런 이름도 쿼리했으므로 base보다 나쁜 회귀였다.
          // 고침: **쿼리 등록은 base와 동일한 permissive substring 매칭으로 되돌린다**(헛다리를
          // 짚어도 event_type 필터 덕에 무해 — 쿼리 커버리지는 절대 base보다 좁아지면 안 된다).
          // **발견 확정(foundByType)만** 엄격한 규칙을 쓴다: 이름의 `/`-세그먼트 중 하나가
          // discriminator 토큰과 정확히 일치하고(부분 문자열 아님 — "alert-prod"는 세그먼트
          // 전체가 "alert"가 아니므로 불일치), 그 이름 어디에도 반대 타입 토큰이 없을 때만
          // 확정한다. 세그먼트 전체 일치 조건 덕에 `/…/alert/<방화벽이름>`처럼 타입이 중간
          // 세그먼트에 있는 관례도 확정되고(라운드3이 놓친 케이스), "alert-prod"처럼 방화벽
          // 이름에 토큰이 섞여 들어간 경우는 세그먼트 전체 일치가 아니라 여전히 미확정이다.
          const isAlert = lower.includes('alert');
          const isFlow = lower.includes('flow');
          if (isAlert) targets.push({ firewall: '(discovered)', region, type: 'ALERT', group: name, discovered: true });
          if (isFlow) targets.push({ firewall: '(discovered)', region, type: 'FLOW', group: name, discovered: true });
          // 리뷰 MAJOR(확정, PR #221 라운드5 — 라운드4 자체 수정의 결함): 확정(segment 전체
          // 정확 일치)과 반대 타입 거부(veto)의 증거 기준이 서로 달랐다 — 확정은 세그먼트
          // 전체 일치만 인정하면서, veto는 tokenize()로 하이픈까지 쪼갠 토큰을 봐서
          // "alert-prod"(방화벽 이름 세그먼트) 안의 "alert" 토큰이 FLOW 확정을 막아버렸다.
          // `/aws/network-firewall/alert-prod/flow`처럼 방화벽 이름에 하이픈으로 discriminator
          // 토큰이 섞여 있으면, 마지막 세그먼트("flow")는 명확한데도 FLOW가 영구히 미확정
          // 처리되어 계정 전체 total이 null이 된다 — 이 PR이 고치려는 바로 그 버그를 반대
          // 방향(과다 unknown)으로 재현한 것. 고침: veto도 확정과 동일한 세그먼트 전체 일치
          // 기준을 쓴다(whole-name tokenize 폴백 제거) — 한 그룹 이름 안에 ALERT/FLOW 세그먼트가
          // 각각 독립적으로 존재하는 경우(예: "/alert/netflow-prod/flow")에만 서로를 거부한다.
          const segments = lower.split('/').filter(Boolean);
          const segmentHasAlert = segments.some((seg) => ALERT_TOKENS.has(seg));
          const segmentHasFlow = segments.some((seg) => FLOW_TOKENS.has(seg));
          if (segmentHasAlert && !segmentHasFlow) foundByType.ALERT = true;
          if (segmentHasFlow && !segmentHasAlert) foundByType.FLOW = true;
        }
        nextToken = r.nextToken;
      } while (nextToken);
      if (!foundByType.ALERT) loggingUnknownByType.ALERT.push(region);
      if (!foundByType.FLOW) loggingUnknownByType.FLOW.push(region);
    } catch { discoveryFailed = true; }
  }
  return { targets, unsupported, discoveryFailed, firewallDiscoveryDegraded, loggingUnknownByType };
}

/** Alert/Flow 로그 Insights 집계 — 그룹별 병렬 실행 후 병합, 개별 실패는 failed로 degrade. */
const LOGS_BUDGET_MS = 45_000; // maxDuration=60에서 응답 직렬화 여유 15s를 뺀 예산

export async function anfwLogsAnalysis(rangeSec: number): Promise<AnfwLogsAnalysis> {
  return cached(`l|${rangeSec}`, async () => {
    // 데드라인은 anfwAnalysis()의 콜드 멀티 리전 fan-out을 기다리기 "전"에 계산 —
    // audit 경로(anfw/route.ts)와 동일 패턴. 앞단이 오래 걸렸으면 Insights 폴링에
    // 남는 시간이 그만큼 줄어들 뿐, 전체 예산은 항상 60s 안에 수렴한다.
    const generatedAt = Date.now();
    const deadlineAt = generatedAt + LOGS_BUDGET_MS;
    const { targets, unsupported, discoveryFailed, firewallDiscoveryDegraded, loggingUnknownByType } = await resolveTargets(rangeSec, deadlineAt);
    const failed: string[] = [];
    // 로그 그룹 발견 자체가 실패(스로틀/거부)한 것과 "발견됐지만 로그가 없음"을 구분 —
    // 전자를 후자로 렌더링하면 SCP 거부 환경에서 "로그 없음"이라는 거짓 all-clear가 된다.
    if (discoveryFailed) failed.push('logDiscovery');
    // 구성 조회는 거부됐고(loggingKnown=false) 접두사 스캔은 예외 없이 실행됐지만 그
    // 리전에서 관례 명명과 일치하는 그룹을 하나도 못 찾은 경우(커스텀 명명이면 흔함) —
    // "이 리전은 CWL 대상이 없음이 확인됨"이 아니라 "여전히 모름"이다. 리전×타입별로 표시
    // (리뷰 MAJOR 라운드12: 리전 단위로만 묶으면 ALERT는 발견되고 FLOW만 커스텀 명명인
    // 경우 그 리전이 "발견됨"으로 빠져 FLOW 카드가 unknown을 확정 없음으로 렌더링했다).
    for (const region of loggingUnknownByType.ALERT) failed.push(`logDiscoveryEmpty:${region}:ALERT`);
    for (const region of loggingUnknownByType.FLOW) failed.push(`logDiscoveryEmpty:${region}:FLOW`);
    // 리뷰 MAJOR(확정, 라운드14 — 라운드13 자체 리뷰 게이트): logDiscoveryEmpty가
    // failed[]에 들어가 배너는 뜨지만, 그걸로 끝이었다 — targets는 이미 애매한 이름의
    // 그룹으로 채워져 있어(쿼리는 안전하게 실행) alert/flow 자체는 null이 아니고, 그
    // 성공한(그러나 무관할 수 있는) 쿼리가 진짜 0행을 반환하면 totalAlerts/totalFlows가
    // 확정 0으로 계산된다 — 배너 옆에 "0"이 뜨는 건 라운드10/11이 alertTotals/
    // flowTotals 쿼리 실패에 대해 이미 MAJOR로 고친 것과 정확히 같은 패턴. 이 리전이
    // unknown인 타입은 totals 자체를 null로 만들어 같은 계약을 여기도 적용한다.
    // 리뷰 MAJOR(확정, 라운드15): 위 null 판정을 loggingUnknownByType에만 걸면,
    // discoverRegions 루프 자체가 던져서 discoveryFailed=true가 된 리전이나 방화벽
    // 목록 조회 자체가 실패한 firewallDiscoveryDegraded 리전은 여기 반영되지 않는다 —
    // "접두사 스캔이 예외 없이 실행돼 0건"(덜 심각)은 null이 되는데 "스캔 자체가
    // 예외로 죽음"(더 심각)은 그대로 확정 숫자로 렌더링되는 역전이 발생한다. 두 실패
    // 모드 모두 두 타입 모두를 unknown으로 taint한다(어느 타입이 원인인지 구분할 수
    // 없으므로 보수적으로 둘 다).
    const alertDiscoveryUnknown = loggingUnknownByType.ALERT.length > 0 || discoveryFailed || firewallDiscoveryDegraded;
    const flowDiscoveryUnknown = loggingUnknownByType.FLOW.length > 0 || discoveryFailed || firewallDiscoveryDegraded;
    // 방화벽 목록 조회 자체가 실패한 리전이 있으면(anfwAnalysis().firewallListDegradedRegions) 그
    // 리전 방화벽들의 로깅 구성을 원래 확인조차 못 했다 — "로그 없음"과 구분되는 별도 키.
    if (firewallDiscoveryDegraded) failed.push('firewallDiscovery');
    // 리뷰 MAJOR: targets는 방화벽 단위라, 중앙 공용 로그 그룹으로 로깅하는 방화벽이
    // 2개 이상이면 같은 (region, group)이 그대로 두 번 나열된다 — 아래 query 단위 집계가
    // 그룹당 한 번이 아니라 대상 수만큼 실행돼 모든 합계·Top 리스트가 배로 부풀려진다.
    // (region, type, group) 단위로 중복 제거해 쿼리는 그룹당 정확히 한 번만 실행.
    const dedupeByGroup = (ts: AnfwLogTarget[]): AnfwLogTarget[] => {
      const seen = new Map<string, AnfwLogTarget>();
      for (const t of ts) {
        const key = `${t.region}|${t.type}|${t.group}`;
        if (!seen.has(key)) seen.set(key, t);
      }
      return [...seen.values()];
    };
    const alertTargets = dedupeByGroup(targets.filter((t) => t.type === 'ALERT'));
    const flowTargets = dedupeByGroup(targets.filter((t) => t.type === 'FLOW'));

    // 같은 리전의 그룹들을 하나의 쿼리로 묶는다 — `logGroupNames`는 리전당 한 번만
    // 호출 가능해 리전이 다른 그룹은 각자 별도 쿼리로 남는다(대개 리전 1개).
    // 리뷰 MAJOR(확정, 라운드8): `StartQuery`의 `logGroupNames`는 API 상한이 50개다 —
    // 접두사 발견 폴백이 `/aws/network-firewall` 전체를 훑으므로 그 리전에 51개 이상의
    // 그룹이 있으면(관례 명명이 흔한 계정에서 realistic) 청크 없이 한 번에 넘겨
    // InvalidParameterException으로 그 리전·카테고리 전체 분석이 죽는다. 50개씩 청크로
    // 쪼개 각 청크를 독립 쿼리로 실행 — runMerged/runMergedWindow는 이미 [region, groups]
    // 목록을 Promise.all로 병렬 실행해 병합하므로, 같은 리전이 여러 청크로 갈라져도
    // 그대로 추가 항목처럼 처리된다(로직 변경 불필요).
    const CWL_GROUPNAMES_MAX = 50;
    const groupByRegion = (ts: AnfwLogTarget[]): [string, string[]][] => {
      const m = new Map<string, string[]>();
      for (const t of ts) m.set(t.region, [...(m.get(t.region) ?? []), t.group]);
      const out: [string, string[]][] = [];
      for (const [region, groups] of m) {
        for (let i = 0; i < groups.length; i += CWL_GROUPNAMES_MAX) {
          out.push([region, groups.slice(i, i + CWL_GROUPNAMES_MAX)]);
        }
      }
      return out;
    };
    // 리뷰 MAJOR 라운드9 제안: 리전 하나가 50개 초과로 청크가 갈리면 청크별 overfetch
    // 상한(PER_REGION_OVERFETCH)이 사실상 "리전 전체" 대신 "청크"에 적용돼, 라운드6에서
    // 없앤 줄 알았던 per-group truncation이 재도입된다 — topTalkers처럼 무신호 병합에
    // 취약한 쿼리는 이 경우 결과가 불완전할 수 있다는 신호를 남긴다.
    const anyRegionChunked = (ts: AnfwLogTarget[]): boolean => {
      const counts = new Map<string, number>();
      for (const [region] of groupByRegion(ts)) counts.set(region, (counts.get(region) ?? 0) + 1);
      return [...counts.values()].some((n) => n > 1);
    };

    const runMerged = async (ts: AnfwLogTarget[], key: string, query: string): Promise<Row[]> => {
      const rows: Row[] = [];
      // 리뷰 MAJOR: "그룹 중 하나라도 성공하면 ok"였던 이전 계약은 실패한 그룹의 트래픽이
      // 조용히 누락된 채 완전한 결과처럼 보이게 만든다(무신호 총계 축소) — all-regions
      // 성공이어야 failed에서 빠진다(하나라도 실패하면 이 쿼리 키를 degrade로 표시).
      let anyFail = false;
      await Promise.all(groupByRegion(ts).map(async ([region, groups]) => {
        try {
          rows.push(...await runInsights(region, groups, query, rangeSec, deadlineAt));
        } catch { anyFail = true; /* 리전 단위 degrade */ }
      }));
      if (anyFail) failed.push(key);
      return rows;
    };
    // 리뷰 MAJOR(확정, PR #225 라운드8): runMerged는 리전별 결과를 그냥 이어붙이기만 해서,
    // 어느 리전이 자기 limit(perRegionLimit)에 정확히 도달했는지(= 그 리전에 더 있었을
    // 수 있다는 뜻) 신호가 사라진다 — 병합된 sid가 present로 보여도 실제로는 그 리전의
    // 몫이 잘려나가 총합이 실제보다 낮은데 "정확한 수치"처럼 표시된다. 리전별 결과
    // 개수를 limit과 비교해 "어느 한 리전이라도 캡에 도달했는가"를 별도로 반환한다.
    const runMergedWithCap = async (ts: AnfwLogTarget[], key: string, query: string, perRegionLimit: number): Promise<{ rows: Row[]; anyRegionAtCap: boolean }> => {
      const rows: Row[] = [];
      let anyFail = false;
      let anyRegionAtCap = false;
      await Promise.all(groupByRegion(ts).map(async ([region, groups]) => {
        try {
          const regionRows = await runInsights(region, groups, query, rangeSec, deadlineAt);
          if (regionRows.length >= perRegionLimit) anyRegionAtCap = true;
          rows.push(...regionRows);
        } catch { anyFail = true; }
      }));
      if (anyFail) failed.push(key);
      return { rows, anyRegionAtCap };
    };

    // 리뷰 MAJOR(확정, PR #225 라운드14): observability/zeroTrustworthy는 지금 이 순간의
    // 로깅 구성 스냅샷이 선택한 range(최대 7일) "전체"를 커버했다고 가정한다 — ALERT
    // 로깅이 range 중간에 켜졌거나 로그 그룹이 range 시작보다 늦게 생성됐으면, 그 이전
    // 구간의 실제 매칭은 로그가 없어 hits=0으로 보이고 확정 idle로 오판된다. 이건 이
    // 파일이 다른 곳에서 계속 고쳐온 "공간적 완전성"(리전/방화벽/룰그룹 커버리지)과는
    // 다른 축인 "시간적 완전성" 문제다. 각 ALERT 로그 그룹의 creationTime(+retentionInDays로
    // 실제 보존 구간까지 고려)을 조회해, range 시작 시점을 커버하지 못하는 그룹이 하나라도
    // 있으면 전체 커버리지를 불명으로 표시한다 — 페이지는 이를 근거로 확정 idle 판정을
    // 추가로 억제해야 한다.
    async function alertCoverageComplete(ts: AnfwLogTarget[]): Promise<boolean> {
      if (ts.length === 0) return true;
      const rangeStartMs = Date.now() - rangeSec * 1000;
      const byRegion = new Map<string, Set<string>>();
      for (const t of ts) {
        if (!byRegion.has(t.region)) byRegion.set(t.region, new Set());
        byRegion.get(t.region)!.add(t.group);
      }
      try {
        const perRegion = await Promise.all([...byRegion].map(async ([region, groups]) => {
          const perGroup = await Promise.all([...groups].map(async (group) => {
            if (Date.now() >= deadlineAt) throw new Error('coverage check deadline exceeded');
            const r = await logs(region).send(new DescribeLogGroupsCommand({ logGroupNamePrefix: group }));
            const lg = (r.logGroups ?? []).find((g) => g.logGroupName === group);
            if (!lg || lg.creationTime == null) return false; // 못 찾음/필드 없음 — 커버리지 확정 불가
            // retentionInDays가 설정돼 있으면 만료로 실제 보존 구간이 creationTime보다 늦게
            // 시작될 수 있다 — 둘 중 더 늦은(더 짧게 남은) 쪽을 실질 커버리지 시작으로 본다.
            const retentionStartMs = lg.retentionInDays != null ? Date.now() - lg.retentionInDays * 86_400_000 : -Infinity;
            return Math.max(lg.creationTime, retentionStartMs) <= rangeStartMs;
          }));
          return perGroup.every(Boolean);
        }));
        return perRegion.every(Boolean);
      } catch {
        return false; // 조회 실패 — 커버리지를 확정할 수 없으므로 보수적으로 불명 처리
      }
    }

    // 리뷰 MAJOR(확정, 라운드6): 같은 리전의 그룹은 logGroupNames로 묶었지만, 리전이
    // 여럿이면 여전히 리전별로 `limit 10`까지 잘린 뒤 병합한다 — 모든 리전에서 11위인
    // 항목이 실제 전역 1위여도 사라질 수 있다. 병합 전 리전별 상한을 표시 컷오프(10)보다
    // 훨씬 크게(100) 잡아 오차 범위를 "리전 수 × (100-10)" 꼬리로 좁힌다(완전 제거는
    // 아니지만 실사용 규모에서 사실상 무시 가능한 수준으로 축소).
    const PER_REGION_OVERFETCH = 100;
    // 룰 히트 조인 최종 컷오프(표시는 이보다 더 자름) — 리전별 상한은 이보다 커야 여유가 생긴다.
    const RULE_HITS_JOIN_CUTOFF = 100;
    const RULE_HITS_PER_REGION_LIMIT = 150;
    // 리뷰 MAJOR(라운드10): alertTargets는 flowTargets와 동일하게 50개 초과 시 리전별로
    // 여러 청크로 쪼개진다(위 groupByRegion) — flow 쪽만 anyRegionChunked로 신호를 남기고
    // alert 쪽은 없었다. 청크당 limit(PER_REGION_OVERFETCH)이 사실상 "리전 전체"가 아니라
    // "청크"에 적용돼 무신호 truncation이 재도입되므로 alert에도 동일 신호를 남긴다.
    if (anyRegionChunked(alertTargets)) failed.push('alertTopNPartial');
    let alert: AnfwAlertAnalytics | null = null;
    if (alertTargets.length > 0) {
      const [totals, byAction, topSig, ruleHitsResult, topSrc, topDst, coverageComplete] = await Promise.all([
        runMerged(alertTargets, 'alertTotals', `filter event.event_type = 'alert' | stats count(*) as cnt`),
        runMerged(alertTargets, 'alertByAction', `fields event.alert.action as action | filter event.event_type = 'alert' | stats count(*) as cnt by action | sort cnt desc`),
        runMerged(alertTargets, 'alertTopSignatures', `fields event.alert.signature_id as sid, event.alert.signature as sig | filter event.event_type = 'alert' | stats count(*) as cnt by sid, sig | sort cnt desc | limit ${PER_REGION_OVERFETCH}`),
        // 룰 히트 카운트 — owner 확인 쿼리와 동일 형태 (sid+sig+action, limit 100)
        // 리뷰 MINOR(확정, PR #225 라운드3): (1) 형제 쿼리들은 `event.event_type = 'alert'`로
        // 필터하는데 이 쿼리만 `ispresent(signature_id)`만 써서 합계가 totalAlerts와 어긋날
        // 여지가 있었다 — 형제와 동일 필터를 추가한다(signature_id 존재 필터는 sid 없는
        // 행을 배제하기 위해 유지). (2) 리전별 limit이 최종 join 컷오프(RULE_HITS_JOIN_CUTOFF,
        // 아래 hitMap.size 판정과 동일 값)와 같아 여유가 전혀 없었다 — 리전별 상한을 join
        // 컷오프보다 크게 잡아, 여러 리전이 각자 상한 근처인 SID를 합산해도 실제로는 더
        // 높은 순위였던 SID가 통째로 누락되는 경우를 줄인다. runMergedWithCap으로 리전별
        // 캡 도달 여부(ruleHitsPartial)까지 함께 반환한다(리뷰 MAJOR, 라운드8).
        runMergedWithCap(alertTargets, 'alertRuleHits', `fields event.alert.signature_id as sid, event.alert.signature as sig, event.alert.action as act | filter event.event_type = 'alert' and ispresent(event.alert.signature_id) | stats count(*) as cnt by sid, sig, act | sort cnt desc | limit ${RULE_HITS_PER_REGION_LIMIT}`, RULE_HITS_PER_REGION_LIMIT),
        runMerged(alertTargets, 'alertTopSources', `fields event.src_ip as src | filter event.event_type = 'alert' | stats count(*) as cnt by src | sort cnt desc | limit ${PER_REGION_OVERFETCH}`),
        runMerged(alertTargets, 'alertTopDests', `fields concat(event.dest_ip, ':', event.dest_port) as dst | filter event.event_type = 'alert' | stats count(*) as cnt by dst | sort cnt desc | limit ${PER_REGION_OVERFETCH}`),
        alertCoverageComplete(alertTargets),
      ]);
      const ruleHitRows = ruleHitsResult.rows;
      const merge = (rows: Row[], nameField: string) => {
        const m = new Map<string, number>();
        for (const r of rows) {
          const k = r[nameField];
          if (k == null || k === '') continue;
          m.set(k, (m.get(k) ?? 0) + num(r.cnt));
        }
        return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 10);
      };
      const sigMap = new Map<string, { sid: string; signature: string; value: number }>();
      for (const r of topSig) {
        const key = `${r.sid}|${r.sig}`;
        const cur = sigMap.get(key) ?? { sid: r.sid ?? '', signature: r.sig ?? '', value: 0 };
        cur.value += num(r.cnt);
        sigMap.set(key, cur);
      }
      // 리뷰 MAJOR(확정, PR #225 라운드9): 이전엔 (sid,sig,act) 튜플 단위로 맵을 만들고 그
      // 튜플 맵을 top-100으로 자른 뒤 화면에서 sid로 재합산했다 — 같은 sid가 기간 내에
      // action/signature가 바뀐 두 개 이상의 튜플로 나뉘어 있으면, 한 튜플만 top-100 안에
      // 살아남고 나머지는 잘려나가도 그 sid는 여전히 "present"라서 무신호 부분합이 "정확한
      // 값"처럼 표시된다(ruleHitsTruncated는 부재 sid만 잡고, ruleHitsPartial은 리전별
      // 150-캡만 잡아 이 케이스를 못 잡는다). 컷오프를 적용하기 "전에" sid 단위로 먼저
      // 합산해, 한 sid의 값이 컷오프 경계에서 쪼개지는 일이 없게 한다.
      const hitMap = new Map<string, { sid: string; signature: string; actions: Set<string>; hits: number }>();
      for (const r of ruleHitRows) {
        if (!r.sid) continue;
        const cur = hitMap.get(r.sid) ?? { sid: r.sid, signature: r.sig ?? '', actions: new Set<string>(), hits: 0 };
        if (!cur.signature && r.sig) cur.signature = r.sig;
        if (r.act) cur.actions.add(r.act);
        cur.hits += num(r.cnt);
        hitMap.set(r.sid, cur);
      }
      alert = {
        // 리뷰 MAJOR(라운드10): alertTotals 쿼리 자체가 실패하면 totals=[]가 되고
        // reduce의 결과는 "0건 발생"과 구분 안 되는 0이 된다 — 이 페이지가 다른 모든
        // 경로(failed[] 배너)에서 지키는 "unknown ≠ absent" 계약을 이 필드 자신이
        // 어긴 것. 게다가 그 확정 0이 아래 topSignatures 그리드의 표시 여부까지
        // 가려서, topN 쿼리는 성공했는데 totals만 실패한 경우 이미 받아온 표까지
        // 숨겨졌다(그리드 게이트는 아래에서 topSignatures.length로 교체).
        totalAlerts: (failed.includes('alertTotals') || alertDiscoveryUnknown) ? null : totals.reduce((s, r) => s + num(r.cnt), 0),
        byAction: merge(byAction, 'action'),
        topSignatures: [...sigMap.values()].sort((a, b) => b.value - a.value).slice(0, 10),
        ruleHits: (failed.includes('alertRuleHits') || failed.includes('alertTopNPartial') || alertDiscoveryUnknown)
          ? null
          : [...hitMap.values()]
            .map((h) => ({ sid: h.sid, signature: h.signature, actions: [...h.actions], hits: h.hits }))
            .sort((a, b) => b.hits - a.hits)
            .slice(0, RULE_HITS_JOIN_CUTOFF),
        // 리뷰 MINOR(확정, PR #225 라운드8): >=면 정확히 컷오프 개수(예: 100개)인, 실제로는
        // 아무것도 잘리지 않은 완전한 결과까지 truncated로 오표시해 확정 0을 "?"로 강등시켰다.
        // slice(0, CUTOFF)가 실제로 무언가를 잘라내는 경우는 size가 CUTOFF보다 클 때뿐이다.
        ruleHitsTruncated: hitMap.size > RULE_HITS_JOIN_CUTOFF,
        ruleHitsPartial: ruleHitsResult.anyRegionAtCap,
        alertCoverageComplete: coverageComplete,
        topSources: merge(topSrc, 'src'),
        topDests: merge(topDst, 'dst'),
      };
    }

    let flow: AnfwFlowAnalytics | null = null;
    if (flowTargets.length > 0) {
      // Top talker(3필드 group-by)는 대용량 스캔이라 창을 최대 6h로 제한 — 실측: 24h 566만 행에서
      // 폴링 상한 초과. totals/proto(단순 집계)는 요청 범위 그대로.
      const talkersWindowSec = Math.min(rangeSec, 21600);
      if (anyRegionChunked(flowTargets)) failed.push('flowTopTalkersPartial');
      const runMergedWindow = async (ts: AnfwLogTarget[], key: string, query: string, windowSec: number): Promise<Row[]> => {
        const rows: Row[] = [];
        let anyFail = false;
        await Promise.all(groupByRegion(ts).map(async ([region, groups]) => {
          try {
            rows.push(...await runInsights(region, groups, query, windowSec, deadlineAt));
          } catch { anyFail = true; /* 리전 단위 degrade */ }
        }));
        if (anyFail) failed.push(key);
        return rows;
      };
      const [totals, talkers, byProto] = await Promise.all([
        runMerged(flowTargets, 'flowTotals', `filter event.event_type = 'netflow' | stats count(*) as cnt, sum(event.netflow.bytes) as bytes`),
        runMergedWindow(flowTargets, 'flowTopTalkers', `fields event.src_ip as src, event.dest_ip as dst | filter event.event_type = 'netflow' | stats sum(event.netflow.bytes) as bytes, count(*) as cnt by src, dst | sort bytes desc | limit ${PER_REGION_OVERFETCH}`, talkersWindowSec),
        runMerged(flowTargets, 'flowByProto', `fields event.proto as proto | filter event.event_type = 'netflow' | stats count(*) as cnt by proto | sort cnt desc`),
      ]);
      const protoMap = new Map<string, number>();
      for (const r of byProto) {
        if (!r.proto) continue;
        protoMap.set(r.proto, (protoMap.get(r.proto) ?? 0) + num(r.cnt));
      }
      // 리뷰 MAJOR(확정, 라운드9): alert의 topSignatures/topSources/topDests는 (region×
      // 청크) 결과를 키로 합산(merge()/sigMap)한 뒤 정렬·자르는데, topTalkers는 그대로
      // concat→sort→slice만 했다 — 같은 (src,dst) 쌍이 리전/청크로 갈라지면 중복 행으로
      // 나뉘어 바이트가 쪼개진 채 표시되고, 실제로는 상위인 쌍이 순위에서 밀려난다.
      // alert 경로와 동일하게 (src,dst) 키로 먼저 합산한다.
      const talkerMap = new Map<string, { src: string; dst: string; bytes: number; flows: number }>();
      for (const r of talkers) {
        const src = r.src ?? ''; const dst = r.dst ?? '';
        if (!src) continue;
        const key = `${src}|${dst}`;
        const cur = talkerMap.get(key) ?? { src, dst, bytes: 0, flows: 0 };
        cur.bytes += num(r.bytes); cur.flows += num(r.cnt);
        talkerMap.set(key, cur);
      }
      // 리뷰 MAJOR(라운드11): alertTotals에 적용한 nullable 계약을 flowTotals에도
      // 그대로 적용 — 이전엔 flowTotals 실패 시에도 0으로 접혀 "0 flows / 0 B"가
      // "조회 실패"와 구분 안 됐고, 그 확정 0이 아래 시각화 게이트(totalFlows>0)까지
      // 가려 이미 성공한 byProto/topTalkers 차트를 숨겼다(alert 쪽에서 라운드10에
      // 고친 것과 정확히 같은 버그 계급 — flow 쪽에 반영이 빠졌던 것).
      const flowTotalsFailed = failed.includes('flowTotals') || flowDiscoveryUnknown;
      flow = {
        totalFlows: flowTotalsFailed ? null : totals.reduce((s, r) => s + num(r.cnt), 0),
        totalBytes: flowTotalsFailed ? null : totals.reduce((s, r) => s + num(r.bytes), 0),
        talkersWindowSec,
        topTalkers: [...talkerMap.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 10),
        byProto: [...protoMap.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value),
      };
    }

    return { targets, unsupportedDestinations: unsupported, alert, flow, failed, rangeSec, generatedAt };
  });
}
