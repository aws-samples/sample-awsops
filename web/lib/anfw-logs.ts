import { CloudWatchLogsClient, StartQueryCommand, GetQueryResultsCommand, StopQueryCommand, DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { anfwAnalysis } from './anfw';

// Network Firewall Alert/Flow 로그 분석 (owner 가이드 2계층): 방화벽 로깅 구성의
// **CloudWatch Logs 대상만** Logs Insights로 집계한다 (S3/Firehose 대상은 Insights 불가 —
// dns-logs와 동일 제약, 화면에 정직 고지). 로그는 Suricata EVE JSON — 중첩 필드는
// `event.alert.signature_id` 도트 표기로 접근.
// 함정: 스테이징 태스크 롤은 DescribeLoggingConfiguration이 SCP류로 거부(loggingKnown=false)
// → 이때는 `/aws/network-firewall/` 접두사 DescribeLogGroups로 **휴리스틱 발견** 폴백
// (이름에 alert/flow 포함 여부로 분류, discovered=true로 표시).

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
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
  /** alertTotals 쿼리 자체가 실패하면 null — 0과 구분해 "0건"이 "조회 실패"를 가리지 않게 함. */
  totalAlerts: number | null;
  byAction: { name: string; value: number }[];
  topSignatures: { sid: string; signature: string; value: number }[];
  /** Stateful 룰 히트 카운트 (2026-08 신기능과 동일 소스 — Alert 로그 집계):
   *  (sid, signature, action)별 매칭 수, 상위 100. 설정 룰 SID와 조인해 매칭 0 룰을 표면화. */
  ruleHits: { sid: string; signature: string; action: string; hits: number }[];
  topSources: { name: string; value: number }[];
  topDests: { name: string; value: number }[];
}

export interface AnfwFlowAnalytics {
  /** flowTotals 쿼리 자체가 실패하면 둘 다 null — alertTotals와 동일 계약(0 ≠ 조회 실패). */
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
  const firewallDiscoveryDegraded = (a.degradedRegions ?? []).length > 0;
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
          if (lower.includes('alert')) { targets.push({ firewall: '(discovered)', region, type: 'ALERT', group: name, discovered: true }); foundByType.ALERT = true; }
          if (lower.includes('flow')) { targets.push({ firewall: '(discovered)', region, type: 'FLOW', group: name, discovered: true }); foundByType.FLOW = true; }
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
    const deadlineAt = Date.now() + LOGS_BUDGET_MS;
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
    // 방화벽 목록 조회 자체가 실패한 리전이 있으면(anfwAnalysis().degradedRegions) 그
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

    // 리뷰 MAJOR(확정, 라운드6): 같은 리전의 그룹은 logGroupNames로 묶었지만, 리전이
    // 여럿이면 여전히 리전별로 `limit 10`까지 잘린 뒤 병합한다 — 모든 리전에서 11위인
    // 항목이 실제 전역 1위여도 사라질 수 있다. 병합 전 리전별 상한을 표시 컷오프(10)보다
    // 훨씬 크게(100) 잡아 오차 범위를 "리전 수 × (100-10)" 꼬리로 좁힌다(완전 제거는
    // 아니지만 실사용 규모에서 사실상 무시 가능한 수준으로 축소).
    const PER_REGION_OVERFETCH = 100;
    // 리뷰 MAJOR(라운드10): alertTargets는 flowTargets와 동일하게 50개 초과 시 리전별로
    // 여러 청크로 쪼개진다(위 groupByRegion) — flow 쪽만 anyRegionChunked로 신호를 남기고
    // alert 쪽은 없었다. 청크당 limit(PER_REGION_OVERFETCH)이 사실상 "리전 전체"가 아니라
    // "청크"에 적용돼 무신호 truncation이 재도입되므로 alert에도 동일 신호를 남긴다.
    if (anyRegionChunked(alertTargets)) failed.push('alertTopNPartial');
    let alert: AnfwAlertAnalytics | null = null;
    if (alertTargets.length > 0) {
      const [totals, byAction, topSig, ruleHitRows, topSrc, topDst] = await Promise.all([
        runMerged(alertTargets, 'alertTotals', `filter event.event_type = 'alert' | stats count(*) as cnt`),
        runMerged(alertTargets, 'alertByAction', `fields event.alert.action as action | filter event.event_type = 'alert' | stats count(*) as cnt by action | sort cnt desc`),
        runMerged(alertTargets, 'alertTopSignatures', `fields event.alert.signature_id as sid, event.alert.signature as sig | filter event.event_type = 'alert' | stats count(*) as cnt by sid, sig | sort cnt desc | limit ${PER_REGION_OVERFETCH}`),
        // 룰 히트 카운트 — owner 확인 쿼리와 동일 형태 (sid+sig+action, limit 100)
        runMerged(alertTargets, 'alertRuleHits', `fields event.alert.signature_id as sid, event.alert.signature as sig, event.alert.action as act | filter ispresent(event.alert.signature_id) | stats count(*) as cnt by sid, sig, act | sort cnt desc | limit 100`),
        runMerged(alertTargets, 'alertTopSources', `fields event.src_ip as src | filter event.event_type = 'alert' | stats count(*) as cnt by src | sort cnt desc | limit ${PER_REGION_OVERFETCH}`),
        runMerged(alertTargets, 'alertTopDests', `fields concat(event.dest_ip, ':', event.dest_port) as dst | filter event.event_type = 'alert' | stats count(*) as cnt by dst | sort cnt desc | limit ${PER_REGION_OVERFETCH}`),
      ]);
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
      const hitMap = new Map<string, { sid: string; signature: string; action: string; hits: number }>();
      for (const r of ruleHitRows) {
        if (!r.sid) continue;
        const key = `${r.sid}|${r.sig}|${r.act}`;
        const cur = hitMap.get(key) ?? { sid: r.sid, signature: r.sig ?? '', action: r.act ?? '', hits: 0 };
        cur.hits += num(r.cnt);
        hitMap.set(key, cur);
      }
      alert = {
        // 리뷰 MAJOR(라운드10): alertTotals 쿼리 자체가 실패하면 totals=[]가 되고
        // reduce의 결과는 "0건 발생"과 구분 안 되는 0이 된다 — 이 페이지가 다른 모든
        // 경로(failed[] 배너)에서 지키는 "unknown ≠ absent" 계약을 이 필드 자신이
        // 어긴 것. 게다가 그 확정 0이 아래 topSignatures 그리드의 표시 여부까지
        // 가려서, topN 쿼리는 성공했는데 totals만 실패한 경우 이미 받아온 표까지
        // 숨겨졌다(그리드 게이트는 아래에서 topSignatures.length로 교체).
        totalAlerts: failed.includes('alertTotals') ? null : totals.reduce((s, r) => s + num(r.cnt), 0),
        byAction: merge(byAction, 'action'),
        topSignatures: [...sigMap.values()].sort((a, b) => b.value - a.value).slice(0, 10),
        ruleHits: [...hitMap.values()].sort((a, b) => b.hits - a.hits).slice(0, 100),
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
      const flowTotalsFailed = failed.includes('flowTotals');
      flow = {
        totalFlows: flowTotalsFailed ? null : totals.reduce((s, r) => s + num(r.cnt), 0),
        totalBytes: flowTotalsFailed ? null : totals.reduce((s, r) => s + num(r.bytes), 0),
        talkersWindowSec,
        topTalkers: [...talkerMap.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 10),
        byProto: [...protoMap.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value),
      };
    }

    return { targets, unsupportedDestinations: unsupported, alert, flow, failed, rangeSec };
  });
}
