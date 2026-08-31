import {
  NetworkFirewallClient,
  ListFirewallsCommand,
  DescribeFirewallCommand,
  ListFirewallPoliciesCommand,
  DescribeFirewallPolicyCommand,
  ListRuleGroupsCommand,
  DescribeRuleGroupCommand,
  DescribeLoggingConfigurationCommand,
} from '@aws-sdk/client-network-firewall';
import { CloudWatchClient, ListMetricsCommand, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { getPool } from './db';

// AWS Network Firewall 리스트 + 분석 (Network 메뉴): 방화벽/정책/룰 그룹을 인벤토리 VPC
// 리전으로 fan-out(리전별 degrade)하고 AWS/NetworkFirewall 메트릭(Received/Passed/Dropped/
// Rejected 등, 기간 Sum)으로 트래픽·드롭을 집계한다. 분석 렌즈:
// ① 보호 설정 — Delete/SubnetChange/PolicyChange protection off (변경·삭제 사고 노출)
// ② 로깅 갭 — ALERT 로그 미설정이면 위협 탐지 가시성 없음 (FLOW/TLS도 표시)
// ③ 정책 보안 신호 — stateless 기본 액션 aws:pass = 스테이트풀 엔진 우회(전량 통과)
// ④ 룰 그룹 — 용량 사용률(≥80% 증설 검토) + 미연결(association 0 = 정리 후보)
// ⑤ 엔드포인트/동기화 — AZ 어태치먼트 READY 아님 / ConfigurationSync IN_SYNC 아님
// 주의: 룰 그룹 **룰 본문(RulesSource) 전체는 의도적으로 미탑재** — 메타데이터만 응답에 싣는다.
// (2026-08 룰 히트 카운트 기능부터 sid/msg/action/noalert만 룰 본문에서 파싱해 예외적으로
// 응답에 포함한다 — parseStatefulSids 참고. 그 외 매치 조건(RulesString 전체 등)은 여전히
// 서버 밖으로 나가지 않는다.)
// 메트릭 차원은 (AvailabilityZone, Engine, FirewallName) 3-dim만 채택 — EndpointName이
// 포함된 4-dim 변형을 함께 합산하면 이중 집계가 된다(실측: 두 변형이 동시 발행).

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const nfwClients = new Map<string, NetworkFirewallClient>();
const nfw = (r: string) => {
  let c = nfwClients.get(r);
  if (!c) { c = new NetworkFirewallClient({ region: r }); nfwClients.set(r, c); }
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
export function _resetAnfwCacheForTests() { cache.clear(); inflight.clear(); nfwClients.clear(); cwClients.clear(); }

export interface AnfwEndpoint { az: string; subnetId: string; endpointId: string; status: string }

export interface AnfwFirewallRow {
  name: string; region: string; vpcId: string;
  /** 연결된 방화벽 정책 이름 (ARN 마지막 세그먼트). */
  policyName: string;
  status: string;
  /** ConfigurationSyncStateSummary — IN_SYNC 외 값은 구성 미반영. */
  syncSummary: string | null;
  endpoints: AnfwEndpoint[];
  endpointsNotReady: number;
  deleteProtection: boolean; subnetChangeProtection: boolean; policyChangeProtection: boolean;
  /** 꺼진 보호 설정 수 (0~3). */
  protectionsOff: number;
  /** 로깅 구성 조회 성공 여부 — false면 아래 3필드는 "확인 불가"(미설정 아님).
   *  실측: DescribeLoggingConfiguration만 SCP류로 거부되는 환경 존재(신원 정책 allow인데 AccessDenied). */
  loggingKnown: boolean;
  /** 로그 타입별 목적지 ("CloudWatchLogs:/aws/..." 형식, 미설정 = null). */
  alertLogging: string | null; flowLogging: string | null; tlsLogging: string | null;
  encryptionType: string | null;
  /** AWS/NetworkFirewall 기간 Sum (null=메트릭 없음). recv/bytes는 Engine=Stateless만
   *  (와이어 패킷 — SFE 포워딩 분이 Stateful recv에 중복 발행됨), 나머지는 AZ×엔진 합산. */
  receivedPackets: number | null; receivedBytes: number | null;
  passedPackets: number | null; droppedPackets: number | null;
  rejectedPackets: number | null; invalidDropped: number | null; otherDropped: number | null;
  streamExceptionPackets: number | null;
  /** TLS 검사 계열 (미사용 환경은 null/0 — 정직 표기). */
  tlsReceivedPackets: number | null; tlsPassedPackets: number | null;
  tlsDroppedPackets: number | null; tlsRejectedPackets: number | null;
  /** (드롭+무효+기타+거부) ÷ 수신 ×100 — 소수 2자리 (null=산출 불가). */
  dropRatePct: number | null;
  /** AZ·엔진별 표시용 요약 행 (상세 패널 idlist). */
  metricRows: string[];
  /** 상태 비정상, 동기화 미완료 또는 READY 아닌 엔드포인트 존재. */
  down: boolean;
}

export interface AnfwPolicyRow {
  name: string; region: string; status: string;
  associations: number;
  statelessGroups: string[]; statefulGroups: string[];
  /** statefulGroups와 같은 순서의 전체 ARN — 리뷰 MAJOR(Codex stop-hook, PR #225 라운드27):
   *  statefulGroups는 표시용으로 ARN 마지막 세그먼트(이름)만 남긴 값이라, `ListRuleGroups`
   *  (Scope 미지정 — 계정 소유 그룹만 열거)로 만들어진 rgKeys와 이름만으로 대조하면 같은
   *  리전에서 AWS 관리형 그룹과 계정 소유 그룹의 이름이 우연히 같을 때 관리형 그룹 참조를
   *  "존재함(안전)"으로 오판한다. 계정 소유 그룹의 ARN과 정확히 일치해야만 안전하다고
   *  판정하려면 전체 ARN이 필요하다. */
  statefulGroupArns: string[];
  statelessDefaultActions: string[]; statelessFragmentDefaultActions: string[];
  statefulDefaultActions: string[];
  statefulRuleOrder: string | null; streamExceptionPolicy: string | null;
  consumedStatelessCapacity: number | null; consumedStatefulCapacity: number | null;
  /** stateless(또는 fragment) 기본 액션에 aws:pass — 매치 안 된 트래픽이 검사 없이 통과. */
  passthroughDefault: boolean;
  lastModified: string | null;
}

export interface AnfwRuleGroupRow {
  name: string; arn: string; region: string; type: string; status: string;
  capacity: number | null; consumedCapacity: number | null;
  /** 소비 용량 ÷ 총 용량 ×100 (소수 1자리). */
  capacityPct: number | null;
  associations: number;
  /** 어느 정책에도 연결 안 됨 — 정리 후보. */
  unassociated: boolean;
  lastModified: string | null;
  /** stateful 룰 SID 목록 (sid·msg·action만 — 룰 본문 아님). Alert 로그 히트와 조인해
   *  "기간 내 매칭 0인 설정 룰"(정책 사각지대)을 표면화 — 2026-08 룰 히트 카운트 기능. */
  statefulSids: StatefulSid[];
  /** true면 이 STATEFUL 룰 그룹의 SID 집합을 파싱할 수 없음(도메인 리스트 `RulesSourceList`
   *  등) — statefulSids가 완전한 목록이 아니라는 뜻. 리뷰 MAJOR(확정, PR #225 라운드11):
   *  도메인 리스트도 AWS 생성 SID로 Alert 로그를 남길 수 있고, 그 SID가 사용자 설정 룰의
   *  sid와 우연히 같으면 병합 시 구분이 안 된다 — statefulSids가 빈 배열이라 이 그룹은
   *  rgs에는 "존재"하므로(attributionUnsafe의 "rgKeys에 없는 그룹" 판정을 통과), 소비처가
   *  이 필드로 별도 판정해야 한다. */
  sidsUnparseable: boolean;
}

export interface AnfwAnalysis {
  firewalls: AnfwFirewallRow[];
  policies: AnfwPolicyRow[];
  ruleGroups: AnfwRuleGroupRow[];
  /** List / Describe 호출 실패로 해당 리전의 리소스가 누락됐거나 개수가 과소집계된 리전.
   *  빈 배열이 아니면 firewalls/policies/ruleGroups·totals는 "리전에 리소스 없음"이 아니라
   *  "AWS 조회 실패로 알 수 없음" — 0/빈 결과를 그대로 신뢰하면 안 됨. */
  degradedRegions: string[];
  /** degradedRegions의 부분집합 — firewalls 자체(List 실패 또는 List가 돌려준 개수보다 적게
   *  Describe됨)만 부분 실패한 리전. policies/ruleGroups만 실패해 degradedRegions에는 들어가지만
   *  firewalls 자체는 완전한 리전은 여기 포함되지 않는다. 리뷰 MINOR(PR #221 라운드5, wording
   *  정정): 이 필드는 방화벽 "목록"의 부분 실패만 가리킨다 — DescribeLoggingConfiguration이
   *  거부돼도 그 자체는 catch되어 `loggingKnown:false`로 강등될 뿐 이 필드를 켜지 않는다
   *  (그 방화벽은 firewalls[]에 정상 포함, 다만 alertLogging/flowLogging이 unknown). "이 리전의
   *  방화벽 목록 자체를 확인할 수 있었는가"만 필요한 소비처(예: anfw-logs.ts)는 degradedRegions
   *  대신 이 필드를 써야 한다. */
  firewallListDegradedRegions: string[];
  /** 이번 분석이 실제로 조회를 시도한 전 리전 목록(인벤토리 기반) — firewalls[].region은
   *  현재 방화벽이 있는 리전만 담아 "리전의 마지막 방화벽이 삭제됨" 케이스를 놓친다.
   *  audit 등 firewalls 목록과 무관하게 "우리가 감시하는 리전 전체"가 필요한 호출자는
   *  이 목록을 써야 한다(리뷰 MAJOR). */
  scannedRegions: string[];
  /** CloudWatch(ListMetrics 미순회 잔여분·100튜플 캡·쿼리 단위 실패)로 트래픽/드롭 수치가
   *  실측보다 낮게 나올 수 있는 리전 — List/Describe는 성공했지만 메트릭만 저하됨.
   *  degradedRegions와 달리 firewalls/policies/ruleGroups 자체는 완전하다. */
  metricsDegradedRegions: string[];
  totals: {
    firewalls: number; firewallsDown: number;
    endpoints: number; endpointsNotReady: number;
    policies: number; policiesPassthrough: number;
    ruleGroups: number; ruleGroupsUnassociated: number; ruleGroupsHighCapacity: number;
    /** 보호 설정이 1개 이상 꺼진 방화벽 수. */
    protectionsOffFirewalls: number;
    alertLoggingMissing: number;
    /** loggingKnown === false인 방화벽 수(SCP류로 로깅 구성 조회 자체가 거부됨) — 1건이라도
     *  있으면 "모든 방화벽 이상 없음"을 주장할 수 없다(해당 방화벽의 실제 로깅 상태를 모른다). */
    loggingUnknownFirewalls: number;
    receivedPackets: number | null; passedPackets: number | null;
    droppedPackets: number | null; rejectedPackets: number | null;
  };
  rangeSec: number;
  /** 서버가 이 분석을 생성한 시각(ms epoch) — 리뷰 MAJOR(Codex stop-hook, PR #225 라운드20):
   *  range 시작 시점(now - rangeSec)을 클라이언트가 브라우저 Date.now()로 계산하면 클라이언트
   *  시계가 서버보다 빠를 때 range 시작을 실제보다 늦은 시점으로 잘못 계산해, 그 사이(진짜
   *  range 시작 ~ 잘못 계산된 range 시작)에 수정된 룰그룹/정책이 "range 밖에서 수정됨"으로
   *  오판돼 attributionUnsafe/ruleGroupModifiedInRange 가드가 fail-open한다. 서버 시각을
   *  응답에 실어 클라이언트가 자기 시계 대신 이 값을 기준으로 계산하게 한다. */
  generatedAt: number;
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

/** List* 페이지네이션 공용 — NextToken 소진까지. */
async function listAll<T>(fn: (nextToken?: string) => Promise<{ items: T[]; nextToken?: string }>): Promise<T[]> {
  const out: T[] = [];
  let nextToken: string | undefined;
  do {
    const r = await fn(nextToken);
    out.push(...r.items);
    nextToken = r.nextToken;
  } while (nextToken);
  return out;
}

const arnName = (arn?: string) => (arn ?? '').split('/').pop() ?? '';

// ---- CW 메트릭 ----
const FW_METRICS = [
  { key: 'recv', name: 'ReceivedPackets' },
  { key: 'bytes', name: 'ReceivedBytes' },
  { key: 'pass', name: 'PassedPackets' },
  { key: 'drop', name: 'DroppedPackets' },
  { key: 'invdrop', name: 'InvalidDroppedPackets' },
  { key: 'othdrop', name: 'OtherDroppedPackets' },
  { key: 'rej', name: 'RejectedPackets' },
  { key: 'sep', name: 'StreamExceptionPolicyPackets' },
  // TLS 검사 계열 (owner 가이드: 복호화 실패/검사 트래픽 모니터링) — 미사용이면 0/부재
  { key: 'tlsrecv', name: 'TLSReceivedPackets' },
  { key: 'tlspass', name: 'TLSPassedPackets' },
  { key: 'tlsdrop', name: 'TLSDroppedPackets' },
  { key: 'tlsrej', name: 'TLSRejectedPackets' },
] as const;
type FwMetricKey = (typeof FW_METRICS)[number]['key'];

interface TupleMetrics { az: string; engine: string; values: Partial<Record<FwMetricKey, number>> }

interface AnfwMetricsResult {
  byFw: Record<string, TupleMetrics[]>;
  /** false면 이 리전의 트래픽/드롭 수치가 실측보다 적을 수 있다(ListMetrics 미순회 잔여분,
   *  100-튜플 캡, CloudWatch 쿼리 단위 실패) — dx.ts의 RegionMetrics.ok와 동일 계약. */
  ok: boolean;
}

/** 방화벽별 (AZ, Engine) 튜플 발견 후 8종 카운터 기간 Sum — 3-dim 변형만 채택. */
async function anfwMetrics(region: string, rangeSec: number, fwNames: string[]): Promise<AnfwMetricsResult> {
  const out: Record<string, TupleMetrics[]> = {};
  if (fwNames.length === 0) return { byFw: out, ok: true };
  let ok = true;
  try {
    const nameSet = new Set(fwNames);
    const tuples: { fw: string; az: string; engine: string; dims: { Name: string; Value: string }[] }[] = [];
    const seen = new Set<string>();
    // NextToken 순회 — 페이지당 500 metric 캡이라 미순회면 튜플이 조용히 누락돼 ok=true인
    // 채로 receivedPackets 등이 null 강등된다(리뷰 MAJOR — dx.ts:284-299와 동일 계약).
    let nextToken: string | undefined;
    do {
      const lm = await cw(region).send(new ListMetricsCommand({ Namespace: 'AWS/NetworkFirewall', MetricName: 'ReceivedPackets', NextToken: nextToken }));
      for (const m of lm.Metrics ?? []) {
        const dims = m.Dimensions ?? [];
        // EndpointName 포함 4-dim 변형은 제외 — 3-dim과 동시 발행되어 합산 시 이중 집계.
        if (dims.length !== 3) continue;
        const fw = dims.find((d) => d.Name === 'FirewallName')?.Value;
        const az = dims.find((d) => d.Name === 'AvailabilityZone')?.Value;
        const engine = dims.find((d) => d.Name === 'Engine')?.Value;
        if (!fw || !az || !engine || !nameSet.has(fw)) continue;
        const key = `${fw}|${az}|${engine}`;
        if (seen.has(key)) continue;
        seen.add(key);
        tuples.push({ fw, az, engine, dims: dims.map((d) => ({ Name: d.Name ?? '', Value: d.Value ?? '' })) });
      }
      nextToken = lm.NextToken;
    } while (nextToken);

    const capped = tuples.slice(0, 100);
    // 캡은 API 제약이 아니라 우리 상한 — 물리는 순간만 degrade로 표기(무신호 금지, dx.ts와 동일).
    if (tuples.length > capped.length) ok = false;
    if (capped.length === 0) return { byFw: out, ok };

    const queries = capped.flatMap((t, i) => FW_METRICS.map((m) => ({
      Id: `${m.key}_i${i}`, ReturnData: true,
      MetricStat: {
        Metric: { Namespace: 'AWS/NetworkFirewall', MetricName: m.name, Dimensions: t.dims },
        Period: rangeSec, Stat: 'Sum',
      },
    })));
    const results: { Id?: string; Values?: number[]; StatusCode?: string }[] = [];
    for (let i = 0; i < queries.length; i += 500) {
      const r = await cw(region).send(new GetMetricDataCommand({
        StartTime: new Date(Date.now() - rangeSec * 1000), EndTime: new Date(),
        MetricDataQueries: queries.slice(i, i + 500),
      }));
      for (const res of r.MetricDataResults ?? []) {
        // CloudWatch는 HTTP 200 안에 쿼리 단위 실패(PartialData/InternalError/Forbidden)를
        // 실을 수 있다 — 무검사면 그 쿼리만 조용히 null 강등되면서 ok=true로 남는다
        // (리뷰 MAJOR, dx.ts:338과 동일 계약). Complete 외는 degrade.
        if (res.StatusCode && res.StatusCode !== 'Complete') ok = false;
        results.push(res);
      }
    }
    const byTuple: Partial<Record<FwMetricKey, number>>[] = capped.map(() => ({}));
    for (const res of results) {
      const mm = (res.Id ?? '').match(/^(\w+?)_i(\d+)$/);
      // Period가 rangeSec 전체라도 CloudWatch는 epoch 정렬 버킷으로 나눠 응답할 수 있어
      // Values가 여러 개일 수 있다 — 첫 값만 쓰면(구 코드) 최신 부분 버킷만 반영돼 기간
      // Sum이 실제보다 훨씬 작게 나온다(리뷰 MAJOR). 전체 Values를 합산해야 진짜 기간 합계.
      const v = res.Values?.length ? res.Values.reduce((s, x) => s + x, 0) : undefined;
      if (!mm || typeof v !== 'number') continue;
      const idx = Number(mm[2]);
      const key = FW_METRICS.find((m) => m.key === mm[1])?.key;
      if (key && byTuple[idx]) byTuple[idx][key] = v;
    }
    capped.forEach((t, i) => {
      (out[t.fw] ??= []).push({ az: t.az, engine: t.engine, values: byTuple[i] });
    });
  } catch { ok = false; /* region degrade — 메트릭 없이 리스트만, 호출자에 노출 */ }
  return { byFw: out, ok };
}

// ---- raw API shapes (필요 필드만) ----
interface RawFw {
  FirewallName?: string; FirewallPolicyArn?: string; VpcId?: string;
  SubnetMappings?: { SubnetId?: string }[];
  DeleteProtection?: boolean; SubnetChangeProtection?: boolean; FirewallPolicyChangeProtection?: boolean;
  EncryptionConfiguration?: { Type?: string };
}
interface RawFwStatus {
  Status?: string; ConfigurationSyncStateSummary?: string;
  SyncStates?: Record<string, { Attachment?: { SubnetId?: string; EndpointId?: string; Status?: string } }>;
}
interface RawPolicyResp {
  FirewallPolicyResponse?: {
    FirewallPolicyName?: string; FirewallPolicyStatus?: string; NumberOfAssociations?: number;
    ConsumedStatelessRuleCapacity?: number; ConsumedStatefulRuleCapacity?: number;
    LastModifiedTime?: string | Date;
  };
  FirewallPolicy?: {
    StatelessRuleGroupReferences?: { ResourceArn?: string }[];
    StatefulRuleGroupReferences?: { ResourceArn?: string }[];
    StatelessDefaultActions?: string[];
    StatelessFragmentDefaultActions?: string[];
    StatefulDefaultActions?: string[];
    StatefulEngineOptions?: { RuleOrder?: string; StreamExceptionPolicy?: string };
  };
}
interface RawRgResp {
  RuleGroupResponse?: {
    RuleGroupName?: string; Type?: string; RuleGroupStatus?: string;
    Capacity?: number; ConsumedCapacity?: number; NumberOfAssociations?: number;
    LastModifiedTime?: string | Date;
  };
  /** 룰 본문 — SID/msg/action 파싱에만 사용, 응답(row)에는 절대 싣지 않음. */
  RuleGroup?: {
    RulesSource?: {
      RulesString?: string;
      StatefulRules?: { Action?: string; RuleOptions?: { Keyword?: string; Settings?: string[] }[] }[];
      /** 도메인 리스트(계정 소유, AWS가 SID를 내부 생성) — 존재 유무만 확인, 내용은 안 씀. */
      RulesSourceList?: unknown;
    };
  };
}

/** Suricata 룰 텍스트/StatefulRules에서 SID·msg·action만 추출 (2026-08 룰 히트 카운트 조인용).
 *  도메인 리스트(RulesSourceList)는 내부 생성 룰이라 사용자 SID가 없음 — 대상 아님. */
// 리뷰 MAJOR(PLAUSIBLE, PR #225 라운드9): noalert 룰(예: alert ... noalert; ...)은 액션이
// alert/drop이어도 Suricata가 Alert 로그를 내지 않는다 — pass 룰과 동일하게 매칭 0을
// 확정 idle로 잡으면 안 된다.
export interface StatefulSid { sid: string; msg: string | null; action: string | null; noalert: boolean }
export function parseStatefulSids(rs?: RawRgResp['RuleGroup']): StatefulSid[] {
  const out = new Map<string, StatefulSid>();
  const src = rs?.RulesSource;
  for (const line of (src?.RulesString ?? '').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    // content/pcre 등 따옴표 문자열 내부의 "sid:" 오탐 방지 — sid 추출 전에 문자열 리터럴 제거
    // (Suricata는 문자열 내 따옴표를 \"로 강제 이스케이프 — escape-aware 패턴 필수)
    const LITERAL = /"((?:\\.|[^"\\])*)"/g;
    const scan = t.replace(LITERAL, '""');
    const sid = /\bsid\s*:\s*(\d+)\s*;/.exec(scan)?.[1];
    if (!sid) continue;
    // 리뷰 MAJOR(확정, PR #225 라운드10·11 반복 지적): `[^"]*`는 이스케이프된 따옴표에서
    // 잘렸다. 그래서 escape-aware 패턴으로 바꿨지만, sid와 달리 원문 `t`에서 그냥 처음
    // 매칭되는 "msg:...""를 찾는 방식이라, 다른 옵션의 문자열 리터럴을 "닫는" 따옴표가
    // 우연히 "msg:" 바로 뒤에 오면(예: `content:"foo msg:"; msg:"real";` — content 값
    // 끝의 "가 가짜 msg 옵션의 시작 따옴표로 오인됨) 그 리터럴의 닫는 따옴표부터 실제 msg
    // 리터럴의 여는 따옴표까지를 통째로 캡처해버린다 — 여전히 리터럴을 넘어간다. sid처럼
    // "msg:" 뒤에 문자열이 오는지는 blank된 scan에서 판정하고(scan은 모든 리터럴을 ""로
    // 지워버려 리터럴 *안*에 있던 가짜 "msg:" 텍스트도 함께 사라지므로 진짜 옵션 키워드
    // 위치만 남는다), 그 위치가 원문 리터럴 등장 순서상 몇 번째인지 세어 원문에서 이스케
    // 이프 그대로 보존된 실제 값을 되찾는다.
    const literalsInOrder = [...t.matchAll(LITERAL)].map((m) => m[1]);
    const msgKeyword = /\bmsg\s*:\s*"/.exec(scan);
    const msg = msgKeyword
      ? literalsInOrder[(scan.slice(0, msgKeyword.index + msgKeyword[0].length - 1).match(/""/g) ?? []).length] ?? null
      : null;
    out.set(sid, {
      sid,
      msg,
      action: /^(pass|drop|reject|alert)\b/i.exec(t)?.[1]?.toLowerCase() ?? null,
      noalert: /\bnoalert\s*;/.test(scan),
    });
  }
  for (const r of src?.StatefulRules ?? []) {
    const sid = r.RuleOptions?.find((o) => o.Keyword === 'sid')?.Settings?.[0];
    if (!sid || out.has(sid)) continue;
    const msg = r.RuleOptions?.find((o) => o.Keyword === 'msg')?.Settings?.[0]?.replace(/^"|"$/g, '') ?? null;
    // 리뷰 MAJOR(확정, PR #225 라운드10): Suricata의 레거시 별칭 `flowbits:noalert;`는 구조화된
    // StatefulRules에서 독립 키워드가 아니라 `{Keyword:"flowbits", Settings:["noalert"]}`로도
    // 인코딩된다 — `Keyword === 'noalert'`만 보면 이 형태를 놓쳐, 실제로는 로그가 안 남는
    // alert/drop 룰이 매칭 0을 확정 idle(정책 사각지대)로 오탐하게 만든다.
    const noalert = r.RuleOptions?.some((o) =>
      o.Keyword === 'noalert' || (o.Keyword === 'flowbits' && (o.Settings ?? []).includes('noalert'))) ?? false;
    out.set(sid, { sid, msg, action: r.Action?.toLowerCase() ?? null, noalert });
  }
  return [...out.values()];
}
interface RawLogging {
  LoggingConfiguration?: {
    LogDestinationConfigs?: { LogType?: string; LogDestinationType?: string; LogDestination?: Record<string, string> }[];
  };
}

const sum = (vals: (number | undefined)[]): number | null => {
  const nums = vals.filter((v): v is number => typeof v === 'number');
  return nums.length ? nums.reduce((s, v) => s + v, 0) : null;
};

/** 전 리전 Network Firewall 방화벽/정책/룰 그룹 + 메트릭 분석. */
export async function anfwAnalysis(rangeSec: number): Promise<AnfwAnalysis> {
  return cached(`a|${rangeSec}`, async () => {
    const regions = await regionsFromInventory();
    const perRegion = await Promise.all(regions.map(async (region) => {
      const empty = { firewalls: [] as AnfwFirewallRow[], policies: [] as AnfwPolicyRow[], ruleGroups: [] as AnfwRuleGroupRow[], degraded: false, metricsDegraded: false, firewallListDegraded: false };
      try {
        // 리뷰 MAJOR(확정, PR #221 라운드4): 세 List*를 하나의 Promise.all로 묶으면 정책/룰그룹
        // List 하나만 실패해도(스로틀 등) 방화벽 List가 이미 성공했더라도 전체가 거부되어
        // firewallListDegraded까지 켜진다 — "firewalls 자체만의 부분 실패"라는 그 필드 자신의
        // 계약을 어긴다. Promise.allSettled로 세 List를 독립시켜, 방화벽 List 실패만
        // firewallListDegraded에 반영한다.
        const [fwListR, policyListR, rgListR] = await Promise.allSettled([
          listAll(async (nextToken) => {
            const r: { Firewalls?: { FirewallName?: string }[]; NextToken?: string } =
              await nfw(region).send(new ListFirewallsCommand({ NextToken: nextToken }));
            return { items: (r.Firewalls ?? []).map((f) => f.FirewallName ?? '').filter(Boolean), nextToken: r.NextToken };
          }),
          listAll(async (nextToken) => {
            const r: { FirewallPolicies?: { Name?: string }[]; NextToken?: string } =
              await nfw(region).send(new ListFirewallPoliciesCommand({ NextToken: nextToken }));
            return { items: (r.FirewallPolicies ?? []).map((p) => p.Name ?? '').filter(Boolean), nextToken: r.NextToken };
          }),
          listAll(async (nextToken) => {
            const r: { RuleGroups?: { Name?: string; Arn?: string }[]; NextToken?: string } =
              await nfw(region).send(new ListRuleGroupsCommand({ NextToken: nextToken }));
            return {
              // 리뷰 MAJOR: 타입을 ARN 세그먼트로 이분(stateless-rulegroup/ vs 그 외=STATEFUL)
              // 추정하면 STATEFUL_DOMAIN 타입(도메인 리스트 룰 그룹)이 STATEFUL로 오분류되고,
              // 그 잘못된 Type으로 DescribeRuleGroup을 호출하면 실패해 행이 통째로 드롭된다.
              // ARN으로 describe하면 Type 파라미터 자체가 불필요해 이 클래스의 오분류가 사라진다.
              items: (r.RuleGroups ?? []).map((g) => ({ name: g.Name ?? '', arn: g.Arn ?? '' })).filter((g) => g.name && g.arn),
              nextToken: r.NextToken,
            };
          }),
        ]);
        const fwListFailed = fwListR.status === 'rejected';
        const listFailed = fwListFailed || policyListR.status === 'rejected' || rgListR.status === 'rejected';
        const fwList = fwListR.status === 'fulfilled' ? fwListR.value : [];
        const policyList = policyListR.status === 'fulfilled' ? policyListR.value : [];
        const rgList = rgListR.status === 'fulfilled' ? rgListR.value : [];
        // 셋 다 실패 없이 정말 비어 있을 때만 "이 리전엔 리소스가 없다"로 조기 반환한다 —
        // List 중 하나라도 실패했는데 나머지가 우연히 0건이면 degraded:false인 empty를
        // 돌려줘 조회실패를 무-리소스로 오인시킬 위험이 있다.
        if (!listFailed && fwList.length === 0 && policyList.length === 0 && rgList.length === 0) return empty;

        const metricsResult = await anfwMetrics(region, rangeSec, fwList);
        const metricsByFw = metricsResult.byFw;

        const firewalls = await Promise.all(fwList.map(async (name): Promise<AnfwFirewallRow | null> => {
          try {
            const [d, logging] = await Promise.all([
              nfw(region).send(new DescribeFirewallCommand({ FirewallName: name })) as Promise<{ Firewall?: RawFw; FirewallStatus?: RawFwStatus }>,
              // 조회 거부(SCP 등)와 "미설정"은 다르다 — 실패 시 known:false로 강등해 off 오표기 방지.
              (nfw(region).send(new DescribeLoggingConfigurationCommand({ FirewallName: name })) as Promise<RawLogging>)
                .then((r) => ({ known: true, r }))
                .catch(() => ({ known: false, r: {} as RawLogging })),
            ]);
            const fw = d.Firewall ?? {};
            const st = d.FirewallStatus ?? {};
            const endpoints: AnfwEndpoint[] = Object.entries(st.SyncStates ?? {}).map(([az, s]) => ({
              az,
              subnetId: s.Attachment?.SubnetId ?? '?',
              endpointId: s.Attachment?.EndpointId ?? '?',
              status: s.Attachment?.Status ?? '?',
            }));
            const notReady = endpoints.filter((e) => e.status !== 'READY').length;
            const logs = logging.r.LoggingConfiguration?.LogDestinationConfigs ?? [];
            // 리뷰 MINOR: Object.values(LogDestination)[0]는 키 순서에 의존한다 — S3는
            // bucketName과 prefix를 함께 가질 수 있어 순서가 바뀌면 prefix가 버킷명 자리에
            // 뜬다. LogDestinationType으로 실제 필드를 명시 선택.
            const logOf = (type: string) => {
              const c = logs.find((l) => l.LogType === type);
              if (!c) return null;
              const destType = c.LogDestinationType ?? '?';
              const destMap = c.LogDestination ?? {};
              const dest = destType === 'S3' ? destMap.bucketName
                : destType === 'CloudWatchLogs' ? destMap.logGroup
                : destType === 'KinesisDataFirehose' ? destMap.deliveryStream
                : Object.values(destMap)[0];
              return `${destType}${dest ? `:${dest}` : ''}`;
            };
            const tuples = metricsByFw[name] ?? [];
            const pick = (k: FwMetricKey) => sum(tuples.map((t) => t.values[k]));
            // 수신(recv/bytes)은 Engine=Stateless만 — 모든 패킷이 stateless를 먼저 통과하므로
            // forward_to_sfe로 넘어간 패킷은 Stateful recv에도 다시 잡힌다(엔진 합산 = 이중 집계).
            // 반면 Passed/Dropped/Rejected는 최종 처분 엔진에서 한 번만 발행 → 엔진 합산 유지.
            const pickWire = (k: FwMetricKey) => sum(tuples.filter((t) => t.engine === 'Stateless').map((t) => t.values[k]));
            const recv = pickWire('recv');
            const droppedAll = sum([pick('drop') ?? undefined, pick('invdrop') ?? undefined, pick('othdrop') ?? undefined, pick('rej') ?? undefined].map((v) => v ?? undefined));
            const status = st.Status ?? '?';
            const syncSummary = st.ConfigurationSyncStateSummary ?? null;
            const protections = [fw.DeleteProtection, fw.SubnetChangeProtection, fw.FirewallPolicyChangeProtection];
            return {
              name, region, vpcId: fw.VpcId ?? '',
              policyName: arnName(fw.FirewallPolicyArn),
              status, syncSummary,
              endpoints, endpointsNotReady: notReady,
              deleteProtection: fw.DeleteProtection ?? false,
              subnetChangeProtection: fw.SubnetChangeProtection ?? false,
              policyChangeProtection: fw.FirewallPolicyChangeProtection ?? false,
              protectionsOff: protections.filter((p) => !p).length,
              loggingKnown: logging.known,
              alertLogging: logOf('ALERT'), flowLogging: logOf('FLOW'), tlsLogging: logOf('TLS'),
              encryptionType: fw.EncryptionConfiguration?.Type ?? null,
              receivedPackets: recv, receivedBytes: pickWire('bytes'),
              passedPackets: pick('pass'), droppedPackets: pick('drop'),
              rejectedPackets: pick('rej'), invalidDropped: pick('invdrop'), otherDropped: pick('othdrop'),
              streamExceptionPackets: pick('sep'),
              // 리뷰 라운드10 되돌림: 라운드10에서 "TLS 검사는 stateful 엔진에서만 일어나므로
              // pickWire가 값을 걸러낸다"는 근거로 pick(엔진 합산)으로 바꿨었으나, AWS 문서
              // (monitoring-cloudwatch.html)가 TLSReceivedPackets를 "recv/bytes와 동일하게
              // stateless→stateful TCP/TLS 종료 경계를 두고 두 엔진 모두에 값이 존재할 수
              // 있다"고 명시한다 — 즉 recv/bytes와 같은 이중 집계 위험이 실재해 pickWire
              // (Stateless만)가 맞았다(라운드10 stop-hook 리뷰가 이 되돌림을 지적). 최종
              // 처분(pass/drop/rej)은 한 엔진에서만 발행되므로 pick(엔진 합산) 유지.
              tlsReceivedPackets: pickWire('tlsrecv'), tlsPassedPackets: pick('tlspass'),
              tlsDroppedPackets: pick('tlsdrop'), tlsRejectedPackets: pick('tlsrej'),
              // toPrecision(2)(유효숫자 2자리)는 아주 작은 비율에서 "1e-4%"처럼 지수 표기로
              // 렌더링된다(리뷰 MINOR) — 소수 2자리 고정으로 항상 일반 표기 유지.
              dropRatePct: recv != null && recv > 0 && droppedAll != null
                ? Math.round((droppedAll / recv) * 10000) / 100
                : null,
              metricRows: tuples.map((t) =>
                `${t.az} ${t.engine} · recv ${t.values.recv ?? '—'} · pass ${t.values.pass ?? '—'} · drop ${t.values.drop ?? '—'}`),
              down: status !== 'READY' || (syncSummary != null && syncSummary !== 'IN_SYNC') || notReady > 0,
            };
          } catch { return null; }
        }));

        const policies = await Promise.all(policyList.map(async (name): Promise<AnfwPolicyRow | null> => {
          try {
            const d = await nfw(region).send(new DescribeFirewallPolicyCommand({ FirewallPolicyName: name })) as RawPolicyResp;
            const resp = d.FirewallPolicyResponse ?? {};
            const pol = d.FirewallPolicy ?? {};
            const statelessDefaults = pol.StatelessDefaultActions ?? [];
            const fragmentDefaults = pol.StatelessFragmentDefaultActions ?? [];
            return {
              name: resp.FirewallPolicyName ?? name, region,
              status: resp.FirewallPolicyStatus ?? '?',
              associations: resp.NumberOfAssociations ?? 0,
              statelessGroups: (pol.StatelessRuleGroupReferences ?? []).map((g) => arnName(g.ResourceArn)),
              statefulGroups: (pol.StatefulRuleGroupReferences ?? []).map((g) => arnName(g.ResourceArn)),
              statefulGroupArns: (pol.StatefulRuleGroupReferences ?? []).map((g) => g.ResourceArn ?? ''),
              statelessDefaultActions: statelessDefaults,
              statelessFragmentDefaultActions: fragmentDefaults,
              statefulDefaultActions: pol.StatefulDefaultActions ?? [],
              statefulRuleOrder: pol.StatefulEngineOptions?.RuleOrder ?? null,
              streamExceptionPolicy: pol.StatefulEngineOptions?.StreamExceptionPolicy ?? null,
              consumedStatelessCapacity: resp.ConsumedStatelessRuleCapacity ?? null,
              consumedStatefulCapacity: resp.ConsumedStatefulRuleCapacity ?? null,
              passthroughDefault: statelessDefaults.includes('aws:pass') || fragmentDefaults.includes('aws:pass'),
              lastModified: resp.LastModifiedTime ? new Date(resp.LastModifiedTime).toISOString() : null,
            };
          } catch { return null; }
        }));

        const ruleGroups = await Promise.all(rgList.map(async (g): Promise<AnfwRuleGroupRow | null> => {
          try {
            const d = await nfw(region).send(new DescribeRuleGroupCommand({ RuleGroupArn: g.arn })) as RawRgResp;
            const resp = d.RuleGroupResponse ?? {};
            const capacity = resp.Capacity ?? null;
            const consumed = resp.ConsumedCapacity ?? null;
            const associations = resp.NumberOfAssociations ?? 0;
            const isStateful = resp.Type === 'STATEFUL';
            const statefulSids = isStateful ? parseStatefulSids(d.RuleGroup) : [];
            // 리뷰 MAJOR(확정, PR #225 라운드11 — 라운드12에서 자체 수정의 결함 재수정):
            // 도메인 리스트 룰 그룹의 실제 API Type은 'STATEFUL'이 아니라 별도 값
            // 'STATEFUL_DOMAIN'이다(이 파일의 다른 회귀 테스트가 이미 이 사실을 실측
            // 검증해 두었다 — ARN 이분 추정이 STATEFUL로 오분류하던 걸 고친 그 케이스).
            // 그런데 이 필드를 `isStateful &&`로 게이트해서, 정작 실제로 존재하는
            // STATEFUL_DOMAIN 그룹에는 전혀 적용되지 않는 죽은 코드가 됐다 — isStateful이
            // false라서 statefulSids가 원래도 []이지만, sidsUnparseable도 함께 false로
            // 굳어버려 이 리뷰가 고치려던 attributionUnsafe 우회를 그대로 방치했다.
            // STATEFUL_DOMAIN은 정의상 항상 파싱 불가이므로 무조건 true, 나머지
            // STATEFUL 경우(RulesSourceList/용량 소비인데 파싱 0개)는 기존 로직 유지.
            const sidsUnparseable = resp.Type === 'STATEFUL_DOMAIN'
              || (isStateful
                && (!!d.RuleGroup?.RulesSource?.RulesSourceList
                  || (statefulSids.length === 0 && (consumed ?? 0) > 0)));
            return {
              name: resp.RuleGroupName ?? g.name, arn: g.arn, region,
              type: resp.Type ?? '?',
              status: resp.RuleGroupStatus ?? '?',
              capacity, consumedCapacity: consumed,
              capacityPct: capacity != null && capacity > 0 && consumed != null
                ? Math.round((consumed / capacity) * 1000) / 10
                : null,
              associations, unassociated: associations === 0,
              lastModified: resp.LastModifiedTime ? new Date(resp.LastModifiedTime).toISOString() : null,
              statefulSids, sidsUnparseable,
            };
          } catch { return null; }
        }));

        const firewallsOk = firewalls.filter((f): f is AnfwFirewallRow => f != null);
        const policiesOk = policies.filter((p): p is AnfwPolicyRow => p != null);
        const ruleGroupsOk = ruleGroups.filter((r): r is AnfwRuleGroupRow => r != null);
        // Describe* 개별 실패(null)는 조용히 드롭되면 "리소스 없음"으로 오독된다 —
        // List*가 돌려준 개수보다 적게 채워졌거나 List 자체가 실패했으면 이 리전도 degraded로 표시.
        const partial = listFailed
          || firewallsOk.length < fwList.length
          || policiesOk.length < policyList.length
          || ruleGroupsOk.length < rgList.length;
        return {
          firewalls: firewallsOk, policies: policiesOk, ruleGroups: ruleGroupsOk,
          degraded: partial, metricsDegraded: !metricsResult.ok,
          // 리뷰 MAJOR(PR #221 라운드2, anfw-logs.ts firewallDiscoveryDegraded 소비처): degradedRegions는
          // firewalls·policies·ruleGroups 중 어느 것 하나라도 부분 실패하면 켜지는 포괄 신호라,
          // 방화벽 자체의 로깅 구성과 무관한 정책/룰그룹 List·Describe 실패에도 켜진다. 로그 발견
          // 계층처럼 "방화벽 목록(따라서 로깅 구성)을 확인할 수 있었는가"만 필요한 소비처를
          // 위해 firewalls만의 부분 실패를 별도로 노출한다 — 라운드4: 정책/룰그룹 List만 실패한
          // 경우까지 켜지지 않도록 fwListFailed(방화벽 List 자체의 성공 여부)만 반영한다.
          firewallListDegraded: fwListFailed || firewallsOk.length < fwList.length,
        };
      } catch { return { ...empty, degraded: true, firewallListDegraded: true }; }
    }));

    const degradedRegions = perRegion.flatMap((r, i) => (r.degraded ? [regions[i]] : []));
    const metricsDegradedRegions = perRegion.flatMap((r, i) => (r.metricsDegraded ? [regions[i]] : []));
    const firewallListDegradedRegions = perRegion.flatMap((r, i) => (r.firewallListDegraded ? [regions[i]] : []));
    const firewalls = perRegion.flatMap((r) => r.firewalls);
    const policies = perRegion.flatMap((r) => r.policies);
    const ruleGroups = perRegion.flatMap((r) => r.ruleGroups);

    const totals: AnfwAnalysis['totals'] = {
      firewalls: firewalls.length,
      firewallsDown: firewalls.filter((f) => f.down).length,
      endpoints: firewalls.reduce((s, f) => s + f.endpoints.length, 0),
      endpointsNotReady: firewalls.reduce((s, f) => s + f.endpointsNotReady, 0),
      policies: policies.length,
      policiesPassthrough: policies.filter((p) => p.passthroughDefault).length,
      ruleGroups: ruleGroups.length,
      ruleGroupsUnassociated: ruleGroups.filter((r) => r.unassociated).length,
      ruleGroupsHighCapacity: ruleGroups.filter((r) => (r.capacityPct ?? 0) >= 80).length,
      protectionsOffFirewalls: firewalls.filter((f) => f.protectionsOff > 0).length,
      // "확인 불가"(loggingKnown=false)는 미설정으로 세지 않음 — 거짓 경고 방지.
      alertLoggingMissing: firewalls.filter((f) => f.loggingKnown && f.alertLogging == null).length,
      loggingUnknownFirewalls: firewalls.filter((f) => !f.loggingKnown).length,
      receivedPackets: sum(firewalls.map((f) => f.receivedPackets ?? undefined)),
      passedPackets: sum(firewalls.map((f) => f.passedPackets ?? undefined)),
      droppedPackets: sum(firewalls.map((f) => f.droppedPackets ?? undefined)),
      rejectedPackets: sum(firewalls.map((f) => f.rejectedPackets ?? undefined)),
    };
    return { firewalls, policies, ruleGroups, degradedRegions, firewallListDegradedRegions, scannedRegions: regions, metricsDegradedRegions, totals, rangeSec, generatedAt: Date.now() };
  });
}
