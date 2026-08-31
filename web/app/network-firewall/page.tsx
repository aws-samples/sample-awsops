'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Flame, Layers, Scroll, Shield, ShieldAlert, Unplug } from 'lucide-react';
import PageHeader from '@/components/ui/PageHeader';
import Card from '@/components/ui/Card';
import StatTile from '@/components/ui/StatTile';
import Badge from '@/components/ui/Badge';
import DetailPanel from '@/components/ui/DetailPanel';
import MetricTable, { type MetricCol } from '@/components/inventory/metrics/MetricTable';
import { RangePicker, TH, MONO, TD, dash } from '@/components/inventory/metrics/shared';
import DonutBreakdown from '@/components/charts/DonutBreakdown';
import HBarList from '@/components/charts/HBarList';
import DiagnosisGuide from '@/components/inventory/metrics/DiagnosisGuide';
import { ANFW_GUIDE } from '@/components/inventory/metrics/guides';
import { useI18n } from '@/components/shell/LanguageProvider';
import type { AnfwAnalysis, AnfwFirewallRow, AnfwPolicyRow, AnfwRuleGroupRow } from '@/lib/anfw';
import type { AnfwLogsAnalysis } from '@/lib/anfw-logs';
import { classifyHits, type Observability, type RuleHitRow } from '@/lib/anfw-hits';
import type { InvType } from '@/lib/inventory-types';

/** /api/anfw?view=audit 응답 행 (라우트와 lockstep). */
interface AuditEvent {
  time: string; name: string; user: string; region: string;
  resourceType: string; resourceName: string; readOnly: boolean;
}

// /network-firewall — AWS Network Firewall 리스트+분석 (Network 메뉴). 방화벽/정책/룰 그룹을
// 리전 fan-out으로 수집하고 AWS/NetworkFirewall 메트릭(기간 Sum)으로 트래픽·드롭을 집계한다.
// 분석 렌즈: 보호 설정 off(변경·삭제 사고 노출) · ALERT 로깅 갭(위협 가시성 없음) ·
// stateless 기본 aws:pass(스테이트풀 엔진 우회) · 룰 그룹 용량(≥80%)·미연결(정리 후보) ·
// 엔드포인트/동기화 이상. 데이터 계층은 lib/anfw.ts(4분 TTL 캐시).

// 정적 셀 마크 — props/state에 의존하지 않으므로 모듈 스코프 상수(참조 안정성 → 아래
// useMemo/useCallback deps에 안전하게 넣을 수 있음).
const offBadge = <Badge tone="negative" variant="soft">off</Badge>;
const onMark = <span className="text-emerald-700">on</span>;

/** 사람 단위 수치 포맷 (패킷 카운트). null=메트릭 없음. */
function fmtCount(v: number | null): string | null {
  if (v == null) return null;
  if (v < 10_000) return v.toLocaleString();
  const units = ['', 'K', 'M', 'B'];
  let n = v;
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return `${n >= 100 ? Math.round(n) : n.toFixed(1)}${units[i]}`;
}

/** 사람 단위 바이트 포맷. */
function fmtBytes(v: number | null): string | null {
  if (v == null) return null;
  if (v === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = v;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(1)} ${units[i]}`;
}

const FW_DETAIL_SPEC: InvType = {
  label: 'Network Firewall', group: 'Network', stateKey: 'status',
  columns: [
    { key: 'name', label: 'Firewall' }, { key: 'region', label: 'Region' }, { key: 'vpc_id', label: 'VPC' },
    { key: 'policy_name', label: 'Firewall Policy' }, { key: 'status', label: 'Status' },
    { key: 'sync_summary', label: 'Config Sync' }, { key: 'encryption_type', label: 'Encryption' },
    { key: 'endpoints', label: 'Endpoints (AZ)' },
    { key: 'delete_protection', label: 'Delete Protection' },
    { key: 'subnet_change_protection', label: 'Subnet Change Protection' },
    { key: 'policy_change_protection', label: 'Policy Change Protection' },
    { key: 'alert_logging', label: 'ALERT Log' }, { key: 'flow_logging', label: 'FLOW Log' }, { key: 'tls_logging', label: 'TLS Log' },
    { key: 'received_packets', label: 'Received Packets' }, { key: 'received_bytes', label: 'Received Bytes' },
    { key: 'passed_packets', label: 'Passed Packets' }, { key: 'dropped_packets', label: 'Dropped Packets' },
    { key: 'rejected_packets', label: 'Rejected Packets' }, { key: 'invalid_dropped', label: 'Invalid Dropped' },
    { key: 'other_dropped', label: 'Other Dropped' }, { key: 'stream_exception_packets', label: 'Stream Exception' },
    { key: 'tls_received_packets', label: 'TLS Received' }, { key: 'tls_passed_packets', label: 'TLS Passed' },
    { key: 'tls_dropped_packets', label: 'TLS Dropped' }, { key: 'tls_rejected_packets', label: 'TLS Rejected' },
    { key: 'drop_rate_pct', label: 'Drop Rate %' }, { key: 'az_engine_metrics', label: 'Per AZ / Engine' },
  ],
  sections: [
    { label: 'Identity', keys: ['name', 'region', 'vpc_id', 'policy_name', 'status', 'sync_summary', 'encryption_type'] },
    { label: 'Endpoints', keys: ['endpoints'] },
    { label: 'Protection', keys: ['delete_protection', 'subnet_change_protection', 'policy_change_protection'] },
    { label: 'Logging', keys: ['alert_logging', 'flow_logging', 'tls_logging'] },
    { label: 'Traffic', keys: ['received_packets', 'received_bytes', 'passed_packets', 'dropped_packets', 'rejected_packets', 'invalid_dropped', 'other_dropped', 'stream_exception_packets', 'tls_received_packets', 'tls_passed_packets', 'tls_dropped_packets', 'tls_rejected_packets', 'drop_rate_pct', 'az_engine_metrics'] },
  ],
};

const POLICY_DETAIL_SPEC: InvType = {
  label: 'Firewall Policy', group: 'Network', stateKey: 'status',
  columns: [
    { key: 'name', label: 'Policy' }, { key: 'region', label: 'Region' }, { key: 'status', label: 'Status' },
    { key: 'associations', label: 'Associations' }, { key: 'last_modified', label: 'Last Modified' },
    { key: 'stateless_groups', label: 'Stateless Rule Groups' }, { key: 'stateful_groups', label: 'Stateful Rule Groups' },
    { key: 'stateless_default_actions', label: 'Stateless Default' },
    { key: 'stateless_fragment_default_actions', label: 'Fragment Default' },
    { key: 'stateful_default_actions', label: 'Stateful Default' },
    { key: 'stateful_rule_order', label: 'Rule Order' }, { key: 'stream_exception_policy', label: 'Stream Exception Policy' },
    { key: 'consumed_stateless_capacity', label: 'Consumed Stateless Capacity' },
    { key: 'consumed_stateful_capacity', label: 'Consumed Stateful Capacity' },
  ],
  sections: [
    { label: 'Identity', keys: ['name', 'region', 'status', 'associations', 'last_modified'] },
    { label: 'Rule Groups', keys: ['stateless_groups', 'stateful_groups'] },
    { label: 'Defaults', keys: ['stateless_default_actions', 'stateless_fragment_default_actions', 'stateful_default_actions', 'stateful_rule_order', 'stream_exception_policy'] },
    { label: 'Capacity', keys: ['consumed_stateless_capacity', 'consumed_stateful_capacity'] },
  ],
};

const RG_DETAIL_SPEC: InvType = {
  label: 'Rule Group', group: 'Network', stateKey: 'status',
  columns: [
    { key: 'name', label: 'Rule Group' }, { key: 'region', label: 'Region' }, { key: 'type', label: 'Type' },
    { key: 'status', label: 'Status' }, { key: 'last_modified', label: 'Last Modified' },
    { key: 'capacity', label: 'Capacity' }, { key: 'consumed_capacity', label: 'Consumed' },
    { key: 'capacity_pct', label: 'Capacity %' }, { key: 'associations', label: 'Associations' },
    { key: 'unassociated', label: 'Unassociated' },
  ],
  sections: [
    { label: 'Identity', keys: ['name', 'region', 'type', 'status', 'last_modified'] },
    { label: 'Capacity', keys: ['capacity', 'consumed_capacity', 'capacity_pct', 'associations', 'unassociated'] },
  ],
};

const compact = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== ''));

function fwDetail(r: AnfwFirewallRow): Record<string, unknown> {
  return compact({
    name: r.name, region: r.region, vpc_id: r.vpcId, policy_name: r.policyName,
    status: r.status, sync_summary: r.syncSummary, encryption_type: r.encryptionType,
    endpoints: r.endpoints.length ? r.endpoints.map((e) => `${e.az} ${e.endpointId} ${e.subnetId} ${e.status}`) : undefined,
    delete_protection: r.deleteProtection, subnet_change_protection: r.subnetChangeProtection,
    policy_change_protection: r.policyChangeProtection,
    alert_logging: r.alertLogging ?? (r.loggingKnown ? '(not configured)' : '(unknown — describe denied)'),
    flow_logging: r.flowLogging ?? (r.loggingKnown ? '(not configured)' : '(unknown — describe denied)'),
    tls_logging: r.tlsLogging ?? undefined,
    received_packets: fmtCount(r.receivedPackets), received_bytes: fmtBytes(r.receivedBytes),
    passed_packets: fmtCount(r.passedPackets), dropped_packets: fmtCount(r.droppedPackets),
    rejected_packets: fmtCount(r.rejectedPackets), invalid_dropped: fmtCount(r.invalidDropped),
    other_dropped: fmtCount(r.otherDropped), stream_exception_packets: fmtCount(r.streamExceptionPackets),
    tls_received_packets: fmtCount(r.tlsReceivedPackets), tls_passed_packets: fmtCount(r.tlsPassedPackets),
    tls_dropped_packets: fmtCount(r.tlsDroppedPackets), tls_rejected_packets: fmtCount(r.tlsRejectedPackets),
    drop_rate_pct: r.dropRatePct == null ? undefined : `${r.dropRatePct}%`,
    az_engine_metrics: r.metricRows.length ? r.metricRows : undefined,
  });
}

function policyDetail(r: AnfwPolicyRow): Record<string, unknown> {
  return compact({
    name: r.name, region: r.region, status: r.status, associations: r.associations,
    last_modified: r.lastModified,
    stateless_groups: r.statelessGroups.length ? r.statelessGroups : undefined,
    stateful_groups: r.statefulGroups.length ? r.statefulGroups : undefined,
    stateless_default_actions: r.statelessDefaultActions.join(', ') || undefined,
    stateless_fragment_default_actions: r.statelessFragmentDefaultActions.join(', ') || undefined,
    stateful_default_actions: r.statefulDefaultActions.join(', ') || undefined,
    stateful_rule_order: r.statefulRuleOrder, stream_exception_policy: r.streamExceptionPolicy,
    consumed_stateless_capacity: r.consumedStatelessCapacity, consumed_stateful_capacity: r.consumedStatefulCapacity,
  });
}

function rgDetail(r: AnfwRuleGroupRow): Record<string, unknown> {
  return compact({
    name: r.name, region: r.region, type: r.type, status: r.status, last_modified: r.lastModified,
    capacity: r.capacity, consumed_capacity: r.consumedCapacity,
    capacity_pct: r.capacityPct == null ? undefined : `${r.capacityPct}%`,
    associations: r.associations, unassociated: r.unassociated,
  });
}

// Observability/RuleHitRow/classifyHits는 lib/anfw-hits.ts로 추출 —
// order-sensitive 판정 매트릭스가 anfw-hits.test.ts로 고정된다(파일 상단 import 참조).

const RULEHIT_DETAIL_SPEC: InvType = {
  label: 'Stateful Rule Hit', group: 'Network',
  columns: [
    { key: 'sid', label: 'SID' }, { key: 'msg', label: 'Msg / Signature' },
    { key: 'actions', label: 'Actions' }, { key: 'rule_groups', label: 'Rule Groups' },
    { key: 'configured', label: 'Configured Rule' }, { key: 'pass_rule', label: 'Pass / No-Alert Rule' },
    { key: 'observability', label: 'ALERT Observability' }, { key: 'shared_sid', label: 'SID Shared Across Groups' },
    { key: 'hits', label: 'Hits (range)' }, { key: 'hit_basis', label: 'Hit Basis' }, { key: 'hit_note', label: 'Hit Note' },
  ],
  sections: [
    { label: 'Rule Identity', keys: ['sid', 'msg', 'actions', 'rule_groups', 'configured', 'pass_rule', 'observability', 'shared_sid'] },
    { label: 'Hit Metrics', keys: ['hits', 'hit_basis', 'hit_note'] },
  ],
};

// 표의 hits 컬럼과 반드시 같은 classifyHits() 결과를 써야 한다 — 그래야 "hits: 0"과
// hit_note가 서로 모순되는 조합(리뷰 MAJOR, PR #229)이 나오지 않는다.
function ruleHitDetail(r: RuleHitRow, alertCoverageComplete: boolean, ruleHitsPartial: boolean, alertObservabilityIncomplete: boolean, tt: (s: string) => string): Record<string, unknown> {
  const d = classifyHits(r, alertCoverageComplete, ruleHitsPartial, alertObservabilityIncomplete);
  const note = d.kind === 'na' ? `n/a — ${tt(d.reason)}`
    : d.kind === 'unknown' ? `unknown — ${tt(d.reason)}`
      : d.kind === 'lowerbound' ? `lower bound — ${tt(d.reason)}`
        : undefined;
  return compact({
    sid: r.sid, msg: r.msg || undefined,
    actions: r.actions.join(', ') || undefined,
    rule_groups: r.ruleGroups.length ? r.ruleGroups : '(not found in configured rule groups — managed rule group?)',
    configured: r.configured, pass_rule: r.isPass,
    observability: r.configured ? r.observability : undefined,
    shared_sid: r.sharedSid,
    hits: d.kind === 'na' || d.kind === 'unknown' ? undefined : r.hits,
    hit_basis: 'Alert-log Insights aggregation over CloudWatch Logs destinations (same source as the AWS rule hit counts feature)',
    hit_note: note,
  });
}

type Selected =
  | { kind: 'rulehit'; row: RuleHitRow }
  | { kind: 'fw'; row: AnfwFirewallRow }
  | { kind: 'policy'; row: AnfwPolicyRow }
  | { kind: 'rg'; row: AnfwRuleGroupRow };

type Variant = 'default' | 'danger' | 'warn';

/** KPI 배지 판정 — 확인된 위험(danger)은 절대 저하(degraded)로 강등하지 않는다.
 *  degraded는 "더 나쁠 수도 있다"는 뜻일 뿐, 이미 확인된 위험을 무효화하는 근거가
 *  아니다. danger가 아닐 때만 degraded가 warn으로 격상된다. (dx.ts와 동일 계약) */
function kpiVariant(hasRealDanger: boolean, degraded: boolean): Variant {
  if (hasRealDanger) return 'danger';
  if (degraded) return 'warn';
  return 'default';
}

/** kpiVariant의 warn-only 변형 — 룰 그룹 용량 임박·보호 미설정처럼 원래도 'danger'가
 *  아니라 'warn'까지만 올라가는 조건에 쓴다. degraded든 실측 경고든 danger로 승격하지 않는다
 *  (kpiVariant를 그대로 쓰면 원래 warn이던 조건이 danger로 잘못 격상된다). */
function warnVariant(hasWarn: boolean, degraded: boolean): Variant {
  return hasWarn || degraded ? 'warn' : 'default';
}

export default function NetworkFirewallPage() {
  const { tt } = useI18n();
  const [range, setRange] = useState(86400);
  const [data, setData] = useState<AnfwAnalysis | null>(null);
  const [err, setErr] = useState('');
  const [selected, setSelected] = useState<Selected | null>(null);
  // 로그 분석(Insights)·변경 감사(CloudTrail)는 별도 lazy fetch — 메인 리스트를 막지 않음.
  const [logsData, setLogsData] = useState<AnfwLogsAnalysis | null>(null);
  const [logsErr, setLogsErr] = useState('');
  const [audit, setAudit] = useState<AuditEvent[] | null>(null);
  const [auditErr, setAuditErr] = useState('');
  const [auditDegradedRegions, setAuditDegradedRegions] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    // 리뷰 MINOR: range 변경 시 이전 range의 data/열린 DetailPanel이 새 응답이 올 때까지(또는
    // 실패 시 영원히) 그대로 남아있었다 — 로딩 표시 없이 이전 기간 수치를 보여주는 오정보.
    setData(null);
    setSelected(null);
    setErr('');
    fetch(`/api/anfw?range=${range}`)
      .then(async (r) => {
        const d = await r.json().catch(() => null);
        if (!r.ok) throw new Error(d?.message ?? `HTTP ${r.status}`);
        return d as AnfwAnalysis;
      })
      .then((d) => { if (alive) { setData(d); setErr(''); } })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [range]);

  useEffect(() => {
    let alive = true;
    setLogsData(null);
    fetch(`/api/anfw?view=logs&range=${range}`)
      .then(async (r) => {
        const d = await r.json().catch(() => null);
        if (!r.ok) throw new Error(d?.message ?? `HTTP ${r.status}`);
        return d as AnfwLogsAnalysis;
      })
      .then((d) => { if (alive) { setLogsData(d); setLogsErr(''); } })
      .catch((e) => { if (alive) setLogsErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [range]);

  useEffect(() => {
    let alive = true;
    fetch('/api/anfw?view=audit')
      .then(async (r) => {
        const d = await r.json().catch(() => null);
        if (!r.ok) throw new Error(d?.message ?? `HTTP ${r.status}`);
        return d as { events: AuditEvent[]; degradedRegions: string[] };
      })
      .then((d) => { if (alive) { setAudit(d.events); setAuditDegradedRegions(d.degradedRegions ?? []); setAuditErr(''); } })
      .catch((e) => { if (alive) setAuditErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, []);

  const fws = useMemo(() => data?.firewalls ?? [], [data]);
  const policies = useMemo(() => data?.policies ?? [], [data]);
  const rgs = useMemo(() => data?.ruleGroups ?? [], [data]);

  // 도넛: 룰 그룹 타입 분포.
  const rgTypeDist = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rgs) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
    return [...counts.entries()].map(([name, value]) => ({ name, value }));
  }, [rgs]);

  // 룰 그룹 용량 사용률 Top 10 (%).
  const rgCapacity = useMemo(() =>
    rgs
      .filter((r) => r.capacityPct != null)
      .map((r) => ({ rg: `${r.name} (${r.type.toLowerCase()})`, pct: Math.round(r.capacityPct!) }))
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 10),
  [rgs]);

  // 룰 그룹이 실제로 ALERT 로그를 관측할 수 있는가: 룰 그룹 → (같은 리전) 정책의
  // statefulGroups에 포함 → 그 정책을 쓰는 방화벽 → 그 방화벽이 logsData.targets에 ALERT
  // CWL 타깃으로 존재. 리뷰 MAJOR(확정): `!rg.unassociated`(정책 연결 개수>0)만으로는
  // 관측 가능성이 서지 않는다 — 그 정책을 쓰는 방화벽이 하나도 없거나, 있어도 ALERT
  // 로깅이 꺼짐/unknown/S3·Firehose 대상이면 여전히 트래픽을 볼 수 없다.
  // 리뷰 MAJOR(확정): targets는 로깅 구성 조회가 거부된 리전에서 `/aws/network-firewall`
  // 접두사 발견 폴백으로 `firewall: '(discovered)'` 항목을 낸다(anfw-logs.ts 리뷰 라운드12
  // 계약) — 실제 방화벽 이름이 아니라서 region|firewall 키가 절대 매칭되지 않고, 그 결과
  // 폴백이 도는 리전의 모든 설정 룰이 "관측 불가"로 오판되어 실제 히트가 있어도 숨겨진다.
  // '(discovered)'는 리전 단위 신호로 별도 처리해 해당 리전 방화벽을 'unknown'(확정도
  // 부정도 아님)으로 분류한다. 리뷰 MAJOR(확정): 룰 그룹이 여러 방화벽에 서빙되면 그중
  // 하나만 관측돼도(some()) "관측됨"으로 쳐서, 나머지 관측 불가 방화벽을 지나는 트래픽이
  // 안 보이는데도 hits=0을 확정 idle로 표시했다 — "관측됨"(0을 신뢰)엔 전체 커버리지
  // (every)가 필요하다. 3상태(observed/unknown/unobserved)로 모델링: 전부 observed면
  // observed(0 신뢰 가능), 하나라도 unknown/observed가 섞이면 unknown(0 불신, 히트값은
  // 그래도 실측이라 표시), 전부 확정 미관측(로깅이 확인상 꺼짐)이거나 서빙 방화벽이 전혀
  // 없으면 unobserved(어떤 히트가 보이더라도 이 룰 귀속으로 볼 수 없음 — 숫자 자체를 숨김).
  const firewallObservability = useMemo(() => {
    const observed = new Set<string>();
    const unknownRegions = new Set<string>();
    for (const t of logsData?.targets ?? []) {
      if (t.type !== 'ALERT') continue;
      if (t.discovered) unknownRegions.add(t.region);
      else observed.add(`${t.region}|${t.firewall}`);
    }
    return (fw: AnfwFirewallRow): Observability => {
      if (observed.has(`${fw.region}|${fw.name}`)) return 'observed';
      if (!fw.loggingKnown || unknownRegions.has(fw.region)) return 'unknown';
      return 'unobserved';
    };
  }, [logsData]);
  const combineObservability = (states: Observability[]): Observability => {
    if (states.length === 0) return 'unobserved';
    if (states.every((s) => s === 'observed')) return 'observed';
    if (states.some((s) => s === 'observed' || s === 'unknown')) return 'unknown';
    return 'unobserved';
  };
  // 리뷰 확정(Codex stop-hook, PR #225 — 두 방향의 과오 교정): 룰 그룹의 리전이
  // degradedRegions에 있으면(정책/방화벽/룰그룹 셋 중 하나라도 부분 실패) 두 가지가
  // 동시에 위협받는다 — (1) 서빙 방화벽 목록이 불완전할 수 있어 firewall observability의
  // every()가 과신할 수 있고, (2) 룰 그룹 목록 자체가 불완전할 수 있어 sidGroupCount(전체
  // rgs 순회 전제)가 "공유 SID 아님"을 잘못 결론 내릴 수 있다. 이 둘은 "0을 신뢰해도
  // 되는가"와 "양수 히트를 이 룰에 귀속해도 되는가"라는 서로 다른 질문에 서로 다르게
  // 영향을 준다 — 전자는 리전이 degraded면 항상 불신, 후자는 sharedSid처럼 귀속 자체가
  // 근본적으로 불가능한 경우에만 불신해야 한다(단순 loggingKnown=false 같은 흔한 firewall
  // 단위 unknown은 그 방화벽이 실제로 관측하지 못했다는 뜻일 뿐 — 그런데도 로그에 진짜
  // 매칭이 찍혔다면 그 자체가 우리 토폴로지 추정이 틀렸다는 더 강한 증거이므로 숫자를
  // 숨길 이유가 없다). 그래서 firewall 기반 observability는 순수하게 유지하고,
  // attributionUnsafe는 별도 신호로 노출해 0-신뢰·양수-귀속 판정에 결합한다.
  // 리뷰 MAJOR(확정, PR #225 라운드8): 히트는 sid로 리전 불문 전역 병합되므로, "이 룰의
  // 리전만 degraded가 아니면 안전하다"는 전제 자체가 틀렸다 — 다른 리전의 룰그룹 목록이
  // 불완전해도, 그 리전에 있는(놓친) 룰그룹의 sid가 이 룰의 sidGroupCount 판정에 안 잡힌
  // 채로 계정 전체 어느 설정 룰에든 잘못 귀속될 수 있다. 같은 이유로 우리가 파싱하지
  // 못하는(AWS 관리형 등) stateful 룰그룹을 정책이 참조하고 있으면 — 그 그룹은 rgs에
  // 전혀 나타나지 않으므로 리전 degraded 여부와 무관하게 동일한 위험이 있다. 그래서
  // 이 판정은 리전별이 아니라 계정(현재 조회 스코프) 전체 단위의 단일 boolean이다.
  const attributionUnsafe = useMemo(() => {
    if ((data?.degradedRegions ?? []).length > 0) return true;
    // 리뷰 MAJOR(Codex stop-hook, PR #225 라운드27): `ListRuleGroups`는 Scope 미지정이라
    // 계정 소유 그룹만 열거한다 — 정책이 참조하는 그룹이 AWS 관리형이면 rgs에 나타나지
    // 않아야 "관리형 참조"로 잡히는데, 이 판정을 이름(`region|name`)만으로 하면 같은
    // 리전에서 관리형 그룹과 계정 소유 그룹의 이름이 우연히 같을 때 관리형 참조를
    // "존재함(안전)"으로 오판한다 — 전체 ARN으로 정확히 일치해야만 안전하다고 판정한다.
    const rgArns = new Set(rgs.map((rg) => rg.arn));
    // 리뷰 MAJOR(확정, PR #225 라운드11): 도메인 리스트(RulesSourceList) 룰 그룹은 rgs에
    // "존재"하지만(rgArns 통과) statefulSids가 항상 비어 있다 — AWS가 SID를 내부 생성하고
    // 우리는 그 SID를 알 수 없다. rgArns 부재만 보면 이 케이스를 놓친다 — 파싱 불가
    // (anfw.ts의 sidsUnparseable) 그룹을 참조하는 정책도 계정 전체 귀속 불안전으로 간주한다.
    const unparseableRgArns = new Set(rgs.filter((rg) => rg.sidsUnparseable).map((rg) => rg.arn));
    if (policies.some((p) => p.statefulGroupArns.some((arn) =>
      !rgArns.has(arn) || unparseableRgArns.has(arn)))) return true;
    // 리뷰 MAJOR(확정, PR #225 라운드19): 위 검사는 "현재" policy.statefulGroups 목록만
    // 훑는다 — 정책이 range 도중 수정됐을 때 그 정책이 *지금* 참조하는 그룹들만 안전하지
    // 않다고 표시했을 뿐, range 도중 그 정책에서 제거되거나
    // (그 그룹 자체가 삭제됐을 수도 있는) 그룹은 현재 목록에 아예 없어 어떤 신호에도 걸리지
    // 않는다 — 그런 그룹의 과거 히트는 sid로 전역 병합되며, 별개의 안 바뀐 룰 그룹에 같은
    // sid가 있으면 sharedSid도 못 잡고 exact/확정idle로 오귀속된다. 정책이 range 도중
    // 수정됐다는 사실 자체가 "그 시점의 statefulGroups 스냅샷을 알 수 없다"는 뜻이므로,
    // round8과 동일한 논리(히트는 전역 병합 — 지역적 안전 판정은 성립 불가)로 계정 전체를
    // 불안전 처리한다(제거된 그룹을 열거할 수 없어 로컬 taint로는 대체 불가).
    // 리뷰 MAJOR(Codex stop-hook, PR #225 라운드20): range 시작을 브라우저 Date.now()로
    // 계산하면 클라이언트 시계가 서버보다 빠를 때 실제보다 늦은 시점으로 잘못 계산돼, 그
    // 사이에 수정된 정책이 "range 밖"으로 오판돼 이 가드가 fail-open한다 — data.generatedAt
    // (서버가 이 분석을 만든 시각)을 기준으로 계산해 클라이언트 시계 왜곡을 배제한다.
    // 리뷰 MAJOR(Codex stop-hook, PR #225 라운드21): data(/api/anfw?range=)와
    // logsData(?view=logs&range=)는 서로 독립된 4분 TTL 캐시를 가진 별도 fetch다 —
    // 토폴로지가 방금 갱신됐어도 로그 분석은 최대 4분 전 캐시일 수 있어, 그 시차 구간에
    // 수정된 정책은 data.generatedAt 하나만 기준으로 하면 range 밖으로 오판돼 fail-open
    // 한다. 두 anchor 중 더 이른(과거) 쪽을 써야 어느 쪽이 캐시로 오래됐어도 안전하다.
    const rangeStartMs = Math.min(data?.generatedAt ?? Date.now(), logsData?.generatedAt ?? Date.now()) - range * 1000;
    // lastModified가 null이면 "안 바뀜"이 아니라 "모름"이다 — fail-closed 원칙(unknown ≠
    // 부재/확신)에 맞춰 null도 range 도중 수정된 것과 동일하게 불안전 처리한다.
    const modifiedOrUnknown = (lm: string | null) => lm == null || Date.parse(lm) > rangeStartMs;
    if (policies.some((p) => modifiedOrUnknown(p.lastModified))) return true;
    // 리뷰 MAJOR(확정, Codex stop-hook, PR #225 라운드22): 라운드19는 "정책이 range 도중
    // 수정되면 계정 전체 불안전"만 다뤘다 — 정책이 안 바뀌어도 룰 그룹 자체가 range 도중
    // in-place로 수정(SID 추가/삭제)되면, 그 그룹의 *현재* 행만 ruleGroupModifiedInRange로
    // 타인트되고, 삭제된 SID가 다른(안 바뀐) 룰 그룹에도 있었다면 그 SID는 sidGroupCount에서
    // 이제 하나로만 보여 sharedSid=false로 오판돼 그 SID의 과거 히트가 그 다른 그룹에
    // exact로 오귀속된다 — round19가 정책에 적용한 것과 동일한 논리(히트는 전역 병합 —
    // 제거된 SID는 현재 토폴로지로 열거 불가)를 룰 그룹 자체의 수정에도 적용해야 한다.
    // 리뷰 MAJOR(Codex stop-hook, PR #225 라운드23): stateless 룰 그룹은 statefulSids가
    // 항상 비어 있어 이 조인/귀속 판정과 무관하다 — stateless 그룹 수정(운영상 훨씬 잦음)
    // 까지 계정 전체를 불안전 처리하면 실제로는 안전한 대다수 케이스에서 과도하게 넓게
    // 발동해 유효한 양수 히트까지 불필요하게 가린다. STATEFUL·STATEFUL_DOMAIN만 본다.
    if (rgs.some((rg) => rg.type !== 'STATELESS' && modifiedOrUnknown(rg.lastModified))) return true;
    // 리뷰 MAJOR(확정, Codex stop-hook, PR #225 라운드24): 로깅 구성 조회가 거부된 리전은
    // `/aws/network-firewall` 접두사 발견으로 로그 그룹을 찾는다(discovered=true) — 발견에
    // 성공하면 ruleHits는 null화되지 않고 그 그룹의 히트가 다른 리전과 똑같이 sid로 전역
    // 병합된다. 하지만 이 리전의 방화벽/룰그룹 서빙 관계는 조회가 거부된 상태라 확인할 수
    // 없다 — round8의 원칙(히트는 전역 병합되므로 지역적 안전 판정은 성립 불가)이 여기도
    // 적용된다: 이 리전에서 방화벽이나 룰 그룹이 range 도중 삭제됐다면 lastModified 흔적이
    // 아예 안 남으므로 위의 모든 검사(rgs/policies)를 통과해도 그 리전이 발견한 로그의
    // 히트가 무관한(observed) 다른 룰에 exact로 오귀속될 수 있다 — ALERT 발견 대상이
    // 하나라도 있으면 계정 전체를 불안전 처리한다.
    return (logsData?.targets ?? []).some((t) => t.type === 'ALERT' && t.discovered);
  }, [data, rgs, policies, range, logsData]);
  // 리뷰 MAJOR(Codex stop-hook, PR #225 라운드27): 이 맵도 attributionUnsafe와 동일한 이유로
  // ARN 키를 쓴다 — 이름만으로 매칭하면 관리형 그룹과 이름이 같은 계정 소유 그룹에 관측성이
  // 잘못 옮겨붙을 수 있다.
  const ruleGroupObservability = useMemo(() => {
    const byKey = new Map<string, Observability[]>();
    for (const rg of rgs) byKey.set(rg.arn, []);
    for (const policy of policies) {
      for (const rgArn of policy.statefulGroupArns) {
        if (!byKey.has(rgArn)) continue;
        for (const fw of fws) {
          if (fw.region === policy.region && fw.policyName === policy.name) byKey.get(rgArn)!.push(firewallObservability(fw));
        }
      }
    }
    const m = new Map<string, Observability>();
    for (const [k, states] of byKey) m.set(k, combineObservability(states));
    return m;
  }, [rgs, policies, fws, firewallObservability]);
  // 리뷰 MAJOR(확정, Codex/kiro-gpt, PR #225 라운드17): ruleGroupModifiedInRange는 룰 그룹
  // 자체의 lastModified만 봤다 — 룰 그룹을 참조하는 정책이 range 시작 이후 수정됐다면(그
  // 룰 그룹이 그 시점에 정책에 새로 추가/제거됐을 수 있음), 룰 그룹 자체는 안 바뀌었어도
  // "이 룰이 range 내내 이 방화벽에 배포돼 있었다"는 전제가 깨진다 — 정확히 이 기능이
  // 막으려는 거짓 정책 사각지대 경고다. AnfwPolicyRow.lastModified는 이미 있었지만
  // (round15까지) 이 검증에 쓰이지 않았다.
  // 리뷰 MAJOR(확정, PR #225 라운드19): 라운드17-18의 "정책이 range 도중 수정되면 그
  // 정책이 *지금* 참조하는 그룹만 taint"는 그룹이 그 수정으로 정책에서 제거됐거나 그 룰
  // 그룹 자체가 삭제된 경우를 놓친다 — 그런 그룹은 지금의 policy.statefulGroups에 아예
  // 없으므로 taint가 안 붙는다. attributionUnsafe가 이제 "어느 정책이든 range 도중
  // 수정됐으면 계정 전체 불안전"으로 이 케이스를 상위 레벨에서 이미 흡수하므로(제거된
  // 그룹은 로컬 taint로 열거 불가 — round8과 동일 논리), 정책 쪽 국지적 taint 맵은
  // attributionUnsafe의 부분집합이 돼 중복이라 제거했다 — rg 자체의 lastModified만 남긴다.

  // Stateful 룰 히트 카운트 (2026-08 신기능과 동일 소스 — Alert 로그 집계):
  // 설정 룰 1개당 1행 (region×rg×sid 키 — SID는 룰 그룹 내에서만 유일하므로 sid 단독 키는
  // 병합 오류이고, 룰 그룹 이름은 여러 리전에 동일하게 배포될 수 있어 region도 필요 —
  // 리뷰 MAJOR: region 없는 키는 멀티 리전에서 React key 충돌을 낸다). 로그 히트는 sid
  // 단위로만 집계되고 리전을 구분하지 않아 같은 sid가 여러 룰 그룹(리전 불문)에 있으면
  // 그 그룹들 사이에 귀속 불가 — sharedSid 툴팁으로 명시하고 hits를 신뢰 가능한 숫자로
  // 취급하지 않는다. idle(매칭 0) 판정 제외: pass 룰(Alert 로그 미발생) · 관측 불가 룰
  // 그룹(정책 미연결/방화벽 없음/ALERT 로깅 꺼짐-unknown-S3대상) · 로그 히트 집계 자체가
  // 실패/청크 truncation됐거나(ruleHits=null) top-100으로 잘린 경우(hits 0 ≠ 매칭 없음).
  const ruleHitRows = useMemo<RuleHitRow[]>(() => {
    const ruleHits = logsData?.alert?.ruleHits;
    // 리뷰 MAJOR(확정): 쿼리 실패/청크 truncation을 null로 신호받으면 "매칭 0"이 아니라
    // 전체를 불명으로 처리 — 실패를 확정 idle로 오판하면 정책 사각지대 경고가 거짓 양성.
    const ruleHitsFailed = ruleHits == null;
    const hits = ruleHits ?? [];
    const truncated = logsData?.alert?.ruleHitsTruncated ?? false;
    // 리뷰 확정(Codex stop-hook, PR #225 라운드10): ruleHitsTruncated는 병합 "후" 전체 sid
    // 개수가 join 컷오프를 넘었는지만 본다 — 어느 한 리전이 자기 상한(150)에 걸려 그
    // 리전에만 있던 sid가 병합 전 단계에서 통째로 빠지면(다른 리전에 전혀 없던 sid), 전체
    // sid 개수는 여전히 100 이하일 수 있어 ruleHitsTruncated=false인 채로 이 sid가
    // hitsBySid에서 완전히 부재(undefined)해 확정 0(idle)으로 오판된다. ruleHitsPartial
    // (리전별 상한 도달 신호)도 "부재 sid를 0으로 확정할 수 없다" 판정에 반영해야 한다.
    const partial = logsData?.alert?.ruleHitsPartial ?? false;
    // 리뷰 MAJOR(확정, PR #225 라운드9): 백엔드가 이제 sid 단위로 이미 합산해서 넘겨주므로
    // (컷오프 적용 전에 sid로 먼저 합산 — 튜플 단위 컷오프의 부분합 문제 해소), 여기서는
    // sid당 행이 하나뿐이다. 그래도 병합 로직은 그대로 둬 방어적으로 안전하게 유지한다.
    const hitsBySid = new Map<string, { hits: number; actions: Set<string>; sig: string }>();
    for (const h of hits) {
      const cur = hitsBySid.get(h.sid) ?? { hits: 0, actions: new Set<string>(), sig: h.signature };
      cur.hits += h.hits;
      for (const act of h.actions) cur.actions.add(act);
      hitsBySid.set(h.sid, cur);
    }
    // 리뷰 MAJOR(확정, PR #225 라운드15): pass/noalert 룰은 Alert 로그를 원천적으로 남기지
    // 못하므로 다른 룰의 SID 귀속을 방해할 수 없다 — sidGroupCount/configuredSids 계산에서
    // 제외한다. 안 그러면 (a) pass 룰이 alert/drop 룰과 SID를 공유할 때 그 alert/drop 룰의
    // 실제 히트가 sharedSid=true로 오판돼 n/a로 숨겨지고, (b) pass 룰의 SID가 관리형 룰그룹
    // 등에서도 쓰이면 configuredSids가 그 SID를 "설정됨"으로 잘못 표시해 로그 전용 fallback
    // 행(진짜 트래픽 증거)이 억제된다.
    const sidGroupCount = new Map<string, number>();
    for (const rg of rgs) for (const s of rg.statefulSids) {
      if (s.action === 'pass' || s.noalert) continue;
      sidGroupCount.set(s.sid, (sidGroupCount.get(s.sid) ?? 0) + 1);
    }

    // 리뷰 MAJOR(확정, PR #225 라운드15): 과거 히트를 현재 룰 토폴로지에 조인하므로, 룰
    // 그룹이 조회 range 시작 이후 수정됐으면 지금의 SID 목록이 range 전체에 걸쳐 동일했다고
    // 보장할 수 없다(SID가 range 중간에 추가/재정의됐을 수 있음) — 그런 룰 그룹의 SID는
    // hits=0이어도 확정 idle로 표시하지 않는다.
    // 리뷰 MAJOR(Codex stop-hook, PR #225 라운드20): 브라우저 Date.now() 대신 이 rgs가
    // 나온 data.generatedAt(서버 시각)을 기준으로 계산 — 클라이언트 시계가 빠르면 range
    // 시작을 실제보다 늦게 계산해 가드가 fail-open하는 것을 방지한다.
    // 리뷰 MAJOR(Codex stop-hook, PR #225 라운드21): 여기서 조인하는 히트는 logsData
    // (독립된 4분 TTL 캐시)에서 온다 — rgs가 나온 data.generatedAt만 쓰면, logsData가
    // 더 오래된 캐시일 때 그 시차 구간의 룰 그룹 수정을 놓친다. 두 anchor 중 더 이른
    // 쪽을 쓴다(attributionUnsafe와 동일 논리).
    const rangeStartMs = Math.min(data?.generatedAt ?? Date.now(), logsData?.generatedAt ?? Date.now()) - range * 1000;

    const rows: RuleHitRow[] = [];
    const configuredSids = new Set<string>();
    for (const rg of rgs) {
      const ruleGroupModifiedInRange = rg.lastModified != null && Date.parse(rg.lastModified) > rangeStartMs;
      for (const s of rg.statefulSids) {
        const isPass = s.action === 'pass' || s.noalert;
        if (!isPass) configuredSids.add(s.sid);
        const h = hitsBySid.get(s.sid);
        const observability = ruleGroupObservability.get(rg.arn) ?? 'unobserved';
        const sharedSid = (sidGroupCount.get(s.sid) ?? 0) > 1;
        const unknown = ruleHitsFailed || ((truncated || partial) && !h); // 쿼리 실패/잘린 집계 밖 — 매칭 여부 불명
        rows.push({
          key: `${rg.region}|${rg.name}|${s.sid}`, sid: s.sid,
          msg: s.msg ?? h?.sig ?? '',
          actions: [...new Set([s.action, ...(h?.actions ?? [])].filter((x): x is string => !!x))],
          hits: h?.hits ?? 0,
          ruleGroups: [rg.name], configured: true,
          isPass,
          observability, attributionUnsafe, sharedSid, unknown,
          unknownReason: ruleHitsFailed ? 'failed' : ((truncated || partial) && !h) ? 'truncated' : null,
          // noalert 룰도 pass처럼 로그가 원천적으로 안 남으므로, 표시되는 양수 히트가 있다면
          // 그 자체가 오귀속 증거다(unobserved와 동일한 논리) — hitsAttributable에서 제외.
          // 리뷰 MAJOR(Codex stop-hook, PR #225 라운드16): ruleGroupModifiedInRange는 처음엔
          // "0을 확정 idle로 볼 수 없다"에만 반영했지만, 대칭적으로 양수 히트도 이 룰그룹에
          // 안전하게 귀속할 수 없다 — SID가 range 도중 이 그룹으로 옮겨왔거나 재정의됐다면,
          // 지금 보이는 양수 히트 중 일부는 실제로 range 앞쪽에서 "다른" 룰/그룹 설정이
          // 만든 것일 수 있다. 그런데도 hitsAttributable=true로 두면 DANGER(차단 트래픽)
          // 강조와 exact 표시가 잘못된 룰그룹에 확정 귀속되는 오귀속을 그대로 만든다.
          hitsAttributable: !isPass && !sharedSid && !unknown && !attributionUnsafe && observability !== 'unobserved' && !ruleGroupModifiedInRange,
          ruleGroupModifiedInRange,
        });
      }
    }
    // 어느 설정 룰 그룹에도 없는 SID (관리형 룰 그룹 등) — pass 룰이 흡수했던 SID도
    // configuredSids에서 빠졌으므로 여기서 진짜 트래픽 증거로 다시 드러난다.
    if (!ruleHitsFailed) {
      for (const [sid, h] of hitsBySid) {
        if (configuredSids.has(sid)) continue;
        rows.push({
          key: `log|${sid}`, sid, msg: h.sig, actions: [...h.actions], hits: h.hits,
          ruleGroups: [], configured: false, isPass: false, observability: 'observed', attributionUnsafe: false, sharedSid: false, unknown: false, unknownReason: null,
          hitsAttributable: true, ruleGroupModifiedInRange: false,
        });
      }
    }
    // 리뷰 확정(Codex stop-hook, PR #225): 정렬은 화면에 실제로 보여주는 값(hitsAttributable일
    // 때만 hits, 아니면 0)을 기준으로 해야 — 안 그러면 표시상 n/a/"?"인 행이 큰 hits로
    // 정렬돼 top-50 표시 슬롯을 정보 없는 행이 차지하고 진짜 신뢰 가능한 행을 밀어낸다.
    return rows.sort((a, b) => {
      const av = a.hitsAttributable ? a.hits : 0;
      const bv = b.hitsAttributable ? b.hits : 0;
      return bv - av || Number(a.sid) - Number(b.sid);
    });
  }, [logsData, rgs, ruleGroupObservability, attributionUnsafe, range, data]);
  // 0을 확정 idle로 신뢰 가능한 행만 — pass 룰 · 관측 불가/불확실 룰 그룹 · 계정 전체
  // 토폴로지 불완전 · 공유 SID · 로그 집계 자체 불명은 제외(빨간 배지에서 제외).
  // 리뷰 MAJOR(확정, PR #225 라운드14): observability는 "지금" 서빙 방화벽이 관측되는지만
  // 보는 공간적 신호다 — 로깅이 선택한 range 중간에 켜졌거나 로그 그룹이 range 시작보다
  // 늦게 생성됐으면(alertCoverageComplete=false), 지금 관측되고 있어도 range 앞쪽 구간의
  // 실제 매칭은 로그가 없어 hits=0으로 보인다. 시간적 커버리지가 불완전하면 0을 확정
  // idle로 표시하지 않는다.
  const alertCoverageComplete = logsData?.alert?.alertCoverageComplete ?? false;
  const zeroTrustworthy = (r: RuleHitRow) => r.configured && !r.isPass && r.observability === 'observed' && !r.attributionUnsafe && !r.sharedSid && !r.unknown && alertCoverageComplete && !r.ruleGroupModifiedInRange;
  // upstream v2 UI 리워크 병합: MetricTable의 maxRender 컷·rowClass 디밍에 재사용하는 "확정
  // idle" 판정 — zeroTrustworthy와 동일 기준이라야 badge 카운트·행 디밍·행 보존이 어긋나지
  // 않는다(모듈 스코프의 예전 isIdleRule은 alertCoverageComplete 등 컴포넌트 상태를 못 봐서
  // 이 판정을 재현할 수 없었다 — 컴포넌트 내부 클로저로 이동).
  const isIdleRule = (r: RuleHitRow) => zeroTrustworthy(r) && r.hits === 0;
  const idleConfiguredRules = useMemo(
    () => ruleHitRows.filter(isIdleRule).length,
  [ruleHitRows]);

  // 리뷰(Codex stop-hook, PR #229 라운드10): 라운드7~9의 `f.alertLogging != null &&
  // !startsWith('CloudWatchLogs:')` 체크는 "ALERT 목적지가 CWL이 아닌" 방화벽만 잡고,
  // "ALERT 로깅 자체가 꺼져 있는"(alertLogging === null) 방화벽은 조건의 `!= null`에서
  // 걸려 빠져나간다 — 그 방화벽도 Insights 쿼리 대상이 아니므로 똑같이 관측 불가다.
  // 도넛 게이트/바 차트의 과소집계 고지/빈 상태 판정이 모두 같은 신호를 써야 하므로
  // 한 곳에서 계산해 공유한다.
  // 리뷰 MAJOR(확정, PR #229 AI Code Review): `fws`는 토폴로지 fetch(`data`)가 아직
  // 해석되지 않았거나 실패했을 때 `[]`로 폴백한다(위 useMemo) — 그러면 `[].some(...)`가
  // false를 반환해 "관측 완전"으로 fail-open된다. 이 저장소의 명시적 관례("null은 unknown,
  // 안 바뀜이 아님" — fail-closed)와 반대다. `data == null`(fetch 미완료/실패)을 명시적으로
  // 불완전 취급해 fail-closed로 뒤집는다 — 방화벽이 실제로 0개인 계정(data는 로드됐고
  // fws=[])과는 구분된다(그 경우는 관측할 것이 없으므로 정직하게 완전).
  const alertObservabilityIncomplete = data == null || fws.some((f) => !(f.alertLogging?.startsWith('CloudWatchLogs:') ?? false));

  // 룰 히트 MetricTable 컬럼 — 헤더 클릭 정렬(num/str)·검색·facet은 MetricTable이 제공.
  // hits의 정렬 value는 hitsAttributable일 때만 실 값, 아니면 null(MetricTable 규약상 항상
  // 마지막 정렬) — round17의 "화면 표시와 같은 기준으로 정렬" 요구를 그대로 반영한다.
  const ruleHitColumns = useMemo<MetricCol<RuleHitRow>[]>(() => [
    {
      key: 'sid', label: 'SID', mono: true, type: 'num',
      // 리뷰 MINOR(확정): 비숫자 SID를 Number()에 넣으면 NaN — MetricTable의 null-정렬-마지막
      // 규약이 깨지고 검색 시 'NaN' 문자열로 취급된다. 비숫자는 null로 표시한다.
      value: (r) => { const n = Number(r.sid); return Number.isNaN(n) ? null : n; },
      render: (r) => (
        <>
          {r.sid}
          {r.sharedSid && <span className="ml-1 text-ink-400" title={tt('여러 룰 그룹이 같은 SID 사용 — Alert 로그는 룰 그룹을 식별하지 못해 히트를 그룹별로 귀속할 수 없음')}>*</span>}
        </>
      ),
    },
    { key: 'msg', label: 'Msg / Signature', value: (r) => r.msg || null },
    // facet은 원소 단위(facetValues) — joined 표시값 exact-match면 'blocked' 선택 시 'drop, blocked' 행이 누락된다.
    { key: 'action', label: tt('액션'), mono: true, facet: true, facetValues: (r) => (r.actions.length ? r.actions : ['—']), value: (r) => r.actions.join(', ') || null },
    {
      key: 'rg', label: tt('룰 그룹'), mono: true, facet: true,
      value: (r) => r.ruleGroups.join(', ') || null,
      render: (r) => r.ruleGroups.length
        ? <>{r.ruleGroups.join(', ')}</>
        : <span className="text-ink-300" title={tt('룰 그룹에서 SID를 찾지 못함 (관리형 룰 그룹 등)')}>{dash}</span>,
    },
    {
      key: 'hits', label: tt('히트'), type: 'num',
      // classifyHits()가 이 컬럼과 ruleHitDetail(상세 패널) 모두의 단일 판정 기준이다 —
      // 리뷰 MAJOR(확정, PR #229): 이전엔 각자 다른 조건식을 써서 표는 "?"인데 상세 패널은
      // hitsAttributable만 보고 "hits: 0"을 확정처럼 보여주는 모순이 있었다.
      value: (r) => {
        const d = classifyHits(r, alertCoverageComplete, logsData?.alert?.ruleHitsPartial ?? false, alertObservabilityIncomplete);
        return d.kind === 'na' || d.kind === 'unknown' ? null : r.hits;
      },
      danger: (r) => {
        const d = classifyHits(r, alertCoverageComplete, logsData?.alert?.ruleHitsPartial ?? false, alertObservabilityIncomplete);
        return (d.kind === 'exact' || d.kind === 'lowerbound') && r.hits > 0 && r.actions.includes('blocked');
      },
      render: (r) => {
        const d = classifyHits(r, alertCoverageComplete, logsData?.alert?.ruleHitsPartial ?? false, alertObservabilityIncomplete);
        if (d.kind === 'na') return <span className="text-ink-300" title={tt(d.reason)}>n/a</span>;
        if (d.kind === 'unknown') return <span className="text-ink-300" title={tt(d.reason)}>?</span>;
        if (d.kind === 'lowerbound') return <span title={tt(d.reason)}>{`≥${r.hits.toLocaleString()}`}</span>;
        return <>{r.hits.toLocaleString()}</>;
      },
    },
  ], [tt, alertCoverageComplete, logsData, alertObservabilityIncomplete]);
  // 히트 바 — 로그 원본(ruleHits)에서 sid 단위 집계: 공유 SID의 설정 행 중복 합산 방지.
  // ruleHitsTruncated는 서버가 이미 계산한 값을 그대로 쓴다(join 컷오프 로직과 중복 계산 방지 —
  // length>=100 같은 로컬 재추정은 병합 후 sid 개수만 보고 리전별 상한(ruleHitsPartial)으로
  // 인한 별도 절단을 못 잡는다).
  const ruleHitsTruncated = logsData?.alert?.ruleHitsTruncated ?? false;
  const ruleHitBars = useMemo(() => {
    const m = new Map<string, { rule: string; hits: number }>();
    for (const h of logsData?.alert?.ruleHits ?? []) {
      const cur = m.get(h.sid) ?? { rule: `${h.sid} · ${(h.signature || '').slice(0, 42) || '—'}`, hits: 0 };
      cur.hits += h.hits;
      m.set(h.sid, cur);
    }
    return [...m.values()].sort((a, b) => b.hits - a.hits).slice(0, 10);
  }, [logsData]);

  // Flow 로그 시각화 — 프로토콜 도넛(플로우 수) + Top talker 바(HBarList는 정수 표시라 MB 단위).
  const flowProtoDist = useMemo(() => logsData?.flow?.byProto ?? [], [logsData]);
  const talkerBars = useMemo(() =>
    (logsData?.flow?.topTalkers ?? []).map((t) => ({
      pair: `${t.src} → ${t.dst}`,
      mb: Math.round(t.bytes / 1e6),
    })),
  [logsData]);

  // 점검 카드: 보호 off 또는 (조회 성공했는데) ALERT 미설정 방화벽만 나열 — "확인 불가"는 경고 아님.
  const issueFws = useMemo(() => fws.filter((f) => f.protectionsOff > 0 || (f.loggingKnown && f.alertLogging == null)), [fws]);

  // 로깅 셀 3상태: on / off / 확인 불가(조회 거부 — 미설정과 구분).
  // 리뷰 MINOR: offBadge/onMark/logCell가 렌더마다 새 참조로 재생성돼 fwColumns의 useMemo가
  // 매번 깨졌다 — offBadge/onMark는 모듈 스코프 상수로, logCell은 useCallback(deps=[tt])으로 고정.
  const logCell = useCallback((f: AnfwFirewallRow, dest: string | null) => !f.loggingKnown
    ? <span className="text-ink-400" title={tt('로깅 구성 조회가 거부되어 설정 여부를 알 수 없음 (미설정과 다름)')}>{tt('확인 불가')}</span>
    : dest ? onMark : offBadge, [tt]);

  const fwColumns = useMemo<MetricCol<AnfwFirewallRow>[]>(() => [
    {
      key: 'name', label: 'Firewall', mono: true,
      title: tt('상태 비정상, 구성 미동기화 또는 READY 아닌 엔드포인트가 있는 방화벽은 빨간색'),
      value: (r) => r.name,
      danger: (r) => r.down,
    },
    { key: 'region', label: 'Region', facet: true, value: (r) => r.region },
    { key: 'vpc', label: 'VPC', mono: true, facet: true, value: (r) => r.vpcId || null },
    { key: 'policy', label: 'Policy', mono: true, value: (r) => r.policyName || null },
    { key: 'status', label: 'State', facet: true, value: (r) => r.status },
    {
      key: 'sync', label: 'Sync',
      title: tt('ConfigurationSyncStateSummary — IN_SYNC 외 값은 구성 미반영'),
      value: (r) => r.syncSummary,
      danger: (r) => r.syncSummary != null && r.syncSummary !== 'IN_SYNC',
    },
    {
      key: 'endpoints', label: tt('엔드포인트'), type: 'num',
      title: tt('AZ별 방화벽 엔드포인트 수 — READY 아닌 엔드포인트는 빨간색'),
      value: (r) => r.endpoints.length,
      render: (r) => r.endpointsNotReady > 0
        ? <span className="font-semibold text-rose-600">{`${r.endpoints.length - r.endpointsNotReady}/${r.endpoints.length}`}</span>
        : String(r.endpoints.length),
      danger: (r) => r.endpointsNotReady > 0,
    },
    {
      key: 'recv', label: tt('수신 패킷'), type: 'num',
      title: tt('기간 내 ReceivedPackets 합계 (AZ 합산, Engine=Stateless만 — 와이어 패킷)'),
      value: (r) => r.receivedPackets,
      render: (r) => fmtCount(r.receivedPackets) ?? dash,
    },
    {
      key: 'passed', label: tt('통과'), type: 'num',
      title: tt('기간 내 PassedPackets 합계'),
      value: (r) => r.passedPackets,
      render: (r) => fmtCount(r.passedPackets) ?? dash,
    },
    {
      key: 'dropped', label: tt('드롭'), type: 'num',
      title: tt('기간 내 DroppedPackets 합계 (무효/기타 드롭·거부는 상세 참조)'),
      value: (r) => r.droppedPackets,
      render: (r) => fmtCount(r.droppedPackets) ?? dash,
    },
    {
      key: 'droprate', label: tt('드롭율'), type: 'num',
      title: tt('(드롭+무효+기타+거부) ÷ 수신 — 방화벽이 실제로 걸러낸 비율'),
      value: (r) => r.dropRatePct,
      render: (r) => (r.dropRatePct == null ? dash : `${r.dropRatePct}%`),
    },
    {
      key: 'protect', label: tt('보호'), type: 'num',
      title: tt('꺼진 보호 설정 수 (삭제/서브넷 변경/정책 변경)'),
      value: (r) => r.protectionsOff,
      render: (r) => r.protectionsOff === 0
        ? onMark
        : <Badge tone="negative" variant="soft">{`${r.protectionsOff} off`}</Badge>,
      danger: (r) => r.protectionsOff > 0,
    },
    {
      key: 'alert', label: 'ALERT',
      title: tt('ALERT 로그 미설정이면 위협 탐지 이벤트를 볼 수 없음'),
      value: (r) => (!r.loggingKnown ? null : r.alertLogging ? 'on' : 'off'),
      render: (r) => logCell(r, r.alertLogging),
      danger: (r) => r.loggingKnown && r.alertLogging == null,
    },
  ], [tt, logCell]);

  const policyColumns = useMemo<MetricCol<AnfwPolicyRow>[]>(() => [
    {
      key: 'name', label: 'Policy', mono: true,
      title: tt('stateless 기본 액션이 aws:pass인 정책은 빨간색 — 매치 안 된 트래픽이 검사 없이 통과'),
      value: (r) => r.name,
      danger: (r) => r.passthroughDefault,
    },
    { key: 'region', label: 'Region', facet: true, value: (r) => r.region },
    { key: 'status', label: 'State', facet: true, value: (r) => r.status },
    {
      key: 'assoc', label: tt('연결 수'), type: 'num',
      title: tt('이 정책을 사용하는 방화벽 수 — 0이면 미사용 정책'),
      value: (r) => r.associations,
      render: (r) => (r.associations === 0 ? <Badge variant="outline">{tt('미사용')}</Badge> : String(r.associations)),
    },
    { key: 'slg', label: 'Stateless RG', type: 'num', value: (r) => r.statelessGroups.length },
    { key: 'sfg', label: 'Stateful RG', type: 'num', value: (r) => r.statefulGroups.length },
    {
      key: 'sldef', label: tt('기본 액션'),
      title: tt('StatelessDefaultActions — aws:forward_to_sfe가 정상 경로, aws:pass는 스테이트풀 우회 (fragment 기본이 aws:pass면 병기)'),
      // fragment 기본만 aws:pass인 경우 — 위험 원인이 셀에 보이도록 병기 (danger 기준과 표시 일치)
      value: (r) => {
        const fragPass = r.statelessFragmentDefaultActions.includes('aws:pass');
        return (r.statelessDefaultActions.join(',') + (fragPass ? ' frag:aws:pass' : '')) || null;
      },
      render: (r) => {
        const fragPass = r.statelessFragmentDefaultActions.includes('aws:pass');
        const text = r.statelessDefaultActions.join(', ') + (fragPass ? ' (frag: aws:pass)' : '');
        return text === ''
          ? dash
          : r.passthroughDefault
            ? <Badge tone="negative" variant="soft">{text}</Badge>
            : <span className="font-mono text-[12px]">{text}</span>;
      },
      danger: (r) => r.passthroughDefault,
    },
    {
      key: 'capsl', label: tt('용량 SL'), type: 'num',
      title: tt('소비한 stateless 룰 용량'),
      value: (r) => r.consumedStatelessCapacity,
    },
    {
      key: 'capsf', label: tt('용량 SF'), type: 'num',
      title: tt('소비한 stateful 룰 용량'),
      value: (r) => r.consumedStatefulCapacity,
    },
    {
      key: 'modified', label: tt('수정 시각'), type: 'num',
      value: (r) => (r.lastModified ? Date.parse(r.lastModified) : null),
      render: (r) => (r.lastModified ? r.lastModified.replace('T', ' ').slice(0, 19) : dash),
    },
  ], [tt]);

  const rgColumns = useMemo<MetricCol<AnfwRuleGroupRow>[]>(() => [
    {
      key: 'name', label: 'Rule Group', mono: true,
      title: tt('용량 80% 이상인 룰 그룹은 빨간색 — 룰 추가가 곧 막힘'),
      value: (r) => r.name,
      danger: (r) => (r.capacityPct ?? 0) >= 80,
    },
    { key: 'region', label: 'Region', facet: true, value: (r) => r.region },
    { key: 'type', label: 'Type', facet: true, value: (r) => r.type },
    { key: 'status', label: 'State', facet: true, value: (r) => r.status },
    {
      key: 'cap', label: tt('용량 사용률'), type: 'num',
      title: tt('소비 용량 ÷ 총 용량 — 생성 후 변경 불가라 80% 이상이면 재생성 계획 필요'),
      value: (r) => r.capacityPct,
      render: (r) => (r.capacityPct == null ? dash : `${r.capacityPct}%`),
      danger: (r) => (r.capacityPct ?? 0) >= 80,
    },
    {
      key: 'consumed', label: tt('소비/총'),
      value: (r) => (r.consumedCapacity == null || r.capacity == null ? null : `${r.consumedCapacity}/${r.capacity}`),
      render: (r) => (r.consumedCapacity == null || r.capacity == null ? dash : `${r.consumedCapacity} / ${r.capacity}`),
    },
    {
      key: 'assoc', label: tt('연결 수'), type: 'num',
      title: tt('이 룰 그룹을 참조하는 정책 수 — 0이면 정리 후보'),
      value: (r) => r.associations,
      render: (r) => (r.unassociated ? <Badge variant="outline">{tt('미연결')}</Badge> : String(r.associations)),
    },
    {
      key: 'modified', label: tt('수정 시각'), type: 'num',
      value: (r) => (r.lastModified ? Date.parse(r.lastModified) : null),
      render: (r) => (r.lastModified ? r.lastModified.replace('T', ' ').slice(0, 19) : dash),
    },
  ], [tt]);

  const t = data?.totals;

  return (
    <>
      <PageHeader
        title="Network Firewall"
        subtitle="방화벽·정책·룰 그룹 인벤토리 + AWS/NetworkFirewall 메트릭 트래픽·드롭 집계 — 보호 설정·로깅 갭·전량 통과 기본 액션·룰 용량 분석"
        right={<RangePicker value={range} onChange={setRange} />}
      />
      <div className="px-4 lg:px-8 py-8 flex flex-col gap-6">
        {err && (
          <div className="text-[13px] text-rose-600">{tt('Network Firewall 조회 실패')}: {err}</div>
        )}
        {!data && !err && <div className="text-ink-400">{tt('로딩 중…')}</div>}

        {data && (data.degradedRegions.length > 0 || data.metricsDegradedRegions.length > 0) && (
          <div className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-[12px] text-warning-text">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>
              {data.degradedRegions.length > 0 && (
                <>{tt('일부 리전 조회 실패')} ({data.degradedRegions.join(', ')}) — {tt('해당 리전의 방화벽·정책·룰 그룹이 누락되거나 실제보다 적게 집계되어 보호·로깅·트래픽·용량 분석이 실제보다 낙관적일 수 있습니다.')} </>
              )}
              {data.metricsDegradedRegions.length > 0 && (
                <>{tt('일부 리전 메트릭 조회 실패')} ({data.metricsDegradedRegions.join(', ')}) — {tt('해당 리전은 CloudWatch 미순회·용량 캡·쿼리 실패로 트래픽·드롭 수치가 실제보다 적을 수 있습니다.')}</>
              )}
            </span>
          </div>
        )}

        {data && t && (() => {
          // 리전 통째 누락(degradedRegions)이 있으면 모든 카운트/합계가 하한이다 —
          // "0건"·"이상 없음"을 확정값처럼 보여주면 실제보다 낙관적인 오탐이 된다.
          const resourcesDegraded = data.degradedRegions.length > 0;
          const metricsDegraded = data.metricsDegradedRegions.length > 0;
          // 트래픽/드롭 수치는 방화벽 자체가 누락됐을 때(resourcesDegraded)뿐 아니라
          // CloudWatch만 저하됐을 때(metricsDegraded)도 실제보다 적게 나올 수 있다.
          const trafficDegraded = resourcesDegraded || metricsDegraded;
          // loggingKnown===false(로깅 구성 조회 자체가 거부됨)인 방화벽이 하나라도 있으면
          // "모든 방화벽 이상 없음"을 주장할 수 없다 — 그 방화벽의 실제 로깅 상태를 모른다
          // (리뷰 MAJOR: per-row는 "확인 불가"를 정직하게 표시하면서 요약 카드만 초록 단정).
          const loggingUnverifiable = t.loggingUnknownFirewalls > 0;
          const lb = (n: number) => (resourcesDegraded ? `${n}+` : String(n));
          const degradedHint = tt('일부 리전 조회 실패 — 실제보다 적을 수 있음');
          const metricsDegradedHint = tt('일부 리전 메트릭 조회 실패 — 실제보다 적을 수 있음');
          // 원래 힌트를 지우지 않고 뒤에 붙인다 — 저하됐다고 실측 카운트를 숨기면
          // 그 자체가 또 다른 형태의 오정보가 된다.
          const withDegradedNote = (hint: string) => (resourcesDegraded ? `${hint} · ${degradedHint}` : hint);
          const withTrafficDegradedNote = (hint: string) => {
            const notes = [resourcesDegraded && degradedHint, metricsDegraded && metricsDegradedHint].filter(Boolean);
            return notes.length ? `${hint} · ${notes.join(' · ')}` : hint;
          };
          const droppedStr = fmtCount(t.droppedPackets);
          return (
          <>
            {/* ① KPI — 다운/보호 off/ALERT 갭/전량 통과 정책이 경고 축 */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
              <StatTile
                label="방화벽"
                value={lb(t.firewalls)}
                variant={resourcesDegraded ? 'warn' : 'default'}
                hint={withDegradedNote(`${tt('엔드포인트')} ${t.endpoints}`)}
                icon={<Flame size={16} />}
              />
              <StatTile
                label="다운 감지"
                value={lb(t.firewallsDown)}
                variant={kpiVariant(t.firewallsDown > 0, resourcesDegraded)}
                hint={withDegradedNote(`${tt('엔드포인트 미준비')} ${t.endpointsNotReady}`)}
                icon={<Unplug size={16} />}
              />
              <StatTile
                label="정책"
                value={lb(t.policies)}
                variant={kpiVariant(t.policiesPassthrough > 0, resourcesDegraded)}
                hint={withDegradedNote(`${tt('전량 통과 기본')} ${t.policiesPassthrough}`)}
                icon={<Scroll size={16} />}
              />
              <StatTile
                label="룰 그룹"
                value={lb(t.ruleGroups)}
                variant={warnVariant(t.ruleGroupsHighCapacity > 0, resourcesDegraded)}
                hint={withDegradedNote(`${tt('미연결')} ${t.ruleGroupsUnassociated} · ${tt('용량 80%+')} ${t.ruleGroupsHighCapacity}`)}
                icon={<Layers size={16} />}
              />
              <StatTile
                label="보호 미설정"
                value={lb(t.protectionsOffFirewalls)}
                variant={warnVariant(t.protectionsOffFirewalls > 0, resourcesDegraded)}
                hint={withDegradedNote(tt('삭제/서브넷/정책 변경 보호'))}
                icon={<ShieldAlert size={16} />}
              />
              <StatTile
                label="드롭 패킷"
                value={droppedStr == null ? '—' : trafficDegraded ? `≥ ${droppedStr}` : droppedStr}
                variant={droppedStr != null && trafficDegraded ? 'warn' : 'default'}
                hint={withTrafficDegradedNote(`${tt('거부')} ${fmtCount(t.rejectedPackets) ?? '—'} · ${tt('통과')} ${fmtCount(t.passedPackets) ?? '—'}`)}
                icon={<Shield size={16} />}
              />
            </div>

            {/* ② 분포 — 룰 그룹 타입 도넛 + 용량 사용률 바 */}
            <div className="grid gap-6 lg:grid-cols-2">
              <DonutBreakdown title="룰 그룹 타입 분포" data={rgTypeDist} nameKey="name" valueKey="value" />
              <HBarList title="룰 그룹 용량 사용률 (%)" data={rgCapacity} labelKey="rg" valueKey="pct" highlightMax />
            </div>

            {/* ③ 방화벽 점검 — 보호 설정 off / ALERT 로깅 미설정 방화벽 */}
            <Card
              title="방화벽 점검"
              subtitle="보호 설정(삭제·서브넷·정책 변경)과 ALERT 로깅이 꺼진 방화벽"
              padded={false}
            >
              {fws.length === 0 && !resourcesDegraded ? (
                <div className="px-4 py-3 text-[13px] text-ink-400">{tt('방화벽 없음')}</div>
              ) : issueFws.length === 0 ? (
                resourcesDegraded || loggingUnverifiable ? (
                  // 리전이 통째로 빠졌거나(resourcesDegraded), 점검한 방화벽은 전부 정상이지만
                  // 일부 방화벽의 로깅 구성 조회 자체가 거부돼(loggingUnverifiable) 그 방화벽들의
                  // 실제 로깅 상태를 모르는 상태다 — 어느 쪽이든 "이상 없음"을 확정할 수 없다.
                  <div className="flex items-start gap-2 px-4 py-3 text-[13px] text-warning-text">
                    <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                    <span>
                      {resourcesDegraded && (
                        <>{tt('일부 리전 조회 실패로 점검 결과를 신뢰할 수 없습니다')} ({data.degradedRegions.join(', ')}) </>
                      )}
                      {loggingUnverifiable && (
                        <>{tt('일부 방화벽의 로깅 구성 조회가 거부되어 점검 결과를 신뢰할 수 없습니다')} ({t.loggingUnknownFirewalls})</>
                      )}
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 px-4 py-3 text-[13px] text-emerald-700">
                    <CheckCircle2 size={15} />
                    {tt('이상 없음 — 모든 방화벽에 보호 설정과 ALERT 로깅이 켜져 있습니다')}
                  </div>
                )
              ) : (
                <>
                  <div className="px-4 pt-3 text-[12px] text-ink-500">
                    {tt('보호 설정이 꺼진 방화벽은 실수로 삭제·변경될 수 있고, ALERT 로그가 없으면 룰이 잡은 위협을 볼 수 없습니다')}
                    {resourcesDegraded && (
                      <> · {tt('일부 리전 조회 실패로 이 목록은 실제보다 짧을 수 있습니다')} ({data.degradedRegions.join(', ')})</>
                    )}
                    {loggingUnverifiable && (
                      <> · {tt('일부 방화벽의 로깅 구성 조회가 거부되어 점검 결과를 신뢰할 수 없습니다')} ({t.loggingUnknownFirewalls})</>
                    )}
                  </div>
                  <div className="overflow-x-auto pb-2">
                    <table className="w-full">
                      <thead><tr className="border-b border-ink-100">
                        <th className={TH}>Firewall</th>
                        <th className={TH}>{tt('삭제 보호')}</th>
                        <th className={TH}>{tt('서브넷 변경 보호')}</th>
                        <th className={TH}>{tt('정책 변경 보호')}</th>
                        <th className={TH}>ALERT</th>
                        <th className={TH}>FLOW</th>
                      </tr></thead>
                      <tbody>
                        {issueFws.map((f) => (
                          <tr
                            key={`${f.region}|${f.name}`}
                            onClick={() => setSelected({ kind: 'fw', row: f })}
                            className="cursor-pointer border-b border-ink-50 last:border-0 hover:bg-ink-50"
                          >
                            <td className={MONO}>{f.name}</td>
                            <td className={TD}>{f.deleteProtection ? onMark : offBadge}</td>
                            <td className={TD}>{f.subnetChangeProtection ? onMark : offBadge}</td>
                            <td className={TD}>{f.policyChangeProtection ? onMark : offBadge}</td>
                            <td className={TD}>{logCell(f, f.alertLogging)}</td>
                            <td className={TD}>{logCell(f, f.flowLogging)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
              {/* owner 제공 모니터링 계층 가이드 — 지표/로그/보완 소스 + 목적별 우선순위 */}
              <DiagnosisGuide spec={ANFW_GUIDE} />
            </Card>

            {/* ④ 방화벽 — 상태/동기화/트래픽, 행 클릭 → 상세 */}
            <Card
              title="방화벽"
              subtitle="행 클릭 → 엔드포인트·보호·로깅·트래픽 상세"
              padded={false}
            >
              <MetricTable
                columns={fwColumns}
                items={fws}
                rowKey={(r) => `${r.region}|${r.name}`}
                emptyText="방화벽 없음"
                onRowClick={(r) => setSelected({ kind: 'fw', row: r })}
              />
            </Card>

            {/* ⑤ 방화벽 정책 — 기본 액션/룰 그룹 참조/용량 */}
            <Card
              title="방화벽 정책"
              subtitle="행 클릭 → 룰 그룹·기본 액션 상세"
              padded={false}
            >
              <MetricTable
                columns={policyColumns}
                items={policies}
                rowKey={(r) => `${r.region}|${r.name}`}
                emptyText="정책 없음"
                onRowClick={(r) => setSelected({ kind: 'policy', row: r })}
              />
            </Card>

            {/* ⑥ 룰 그룹 — 용량 사용률·미연결 */}
            <Card
              title="룰 그룹"
              subtitle="행 클릭 → 용량 상세 (룰 본문은 표시하지 않음)"
              padded={false}
            >
              <MetricTable
                columns={rgColumns}
                items={rgs}
                rowKey={(r) => `${r.region}|${r.type}|${r.name}`}
                emptyText="룰 그룹 없음"
                onRowClick={(r) => setSelected({ kind: 'rg', row: r })}
              />
            </Card>

            {/* ⑦ Alert 로그 분석 — stateful alert/drop 매칭 (Logs Insights, CWL 대상만) */}
            <Card
              title="Alert 로그 분석 · Stateful 룰 히트 카운트"
              subtitle="어떤 규칙(sid)이 얼마나 매칭됐는지 — Alert 로그 Insights 집계 (AWS 룰 히트 카운트 기능과 동일 소스), 설정 룰과 조인해 매칭 없는 룰 표면화"
              padded={false}
            >
              {logsErr && <div className="px-4 py-3 text-[13px] text-rose-600">{tt('로그 분석 실패')}: {logsErr}</div>}
              {!logsData && !logsErr && <div className="px-4 py-3 text-[13px] text-ink-400">{tt('로그 집계 중… (Logs Insights)')}</div>}
              {logsData && (
                <>
                  {(logsData.targets.some((t) => t.discovered) || logsData.unsupportedDestinations > 0) && (
                    <div className="px-4 pt-3 text-[12px] text-ink-500">
                      {logsData.targets.some((t) => t.discovered) && <span>{tt('로깅 구성 조회가 거부되어 관례 접두사(/aws/network-firewall)로 로그 그룹을 발견했습니다')} </span>}
                      {logsData.unsupportedDestinations > 0 && <span>{tt('S3/Firehose 대상 로그는 이 화면에서 집계할 수 없습니다 (Athena 등 별도 분석)')}</span>}
                    </div>
                  )}
                  {logsData.failed.length > 0 && (
                    // 리뷰 MAJOR: 이 배열이 이전엔 어디에도 렌더링되지 않아, 로그 그룹 조회가
                    // 전부 실패해도 화면은 "정상 0건"과 똑같이 보였다 — 실패한 집계 키를 그대로 노출.
                    <div className="flex items-start gap-2 px-4 pt-3 text-[12px] text-warning-text">
                      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                      <span>{tt('일부 로그 그룹 조회 실패')} ({logsData.failed.join(', ')}) — {tt('해당 집계는 실제보다 적을 수 있습니다.')}</span>
                    </div>
                  )}
                  {logsData.alert == null ? (
                    <div className="px-4 py-3 text-[13px] text-ink-400">
                      {/* Flow 카드와 동일하게 발견 실패(firewallDiscovery/logDiscovery/
                          logDiscoveryEmpty:*:ALERT)는 "로그 없음"이 아니라 "확인 불가"로
                          구분 표시. 리뷰 MAJOR(라운드12): logDiscoveryEmpty는 이제 타입별
                          키(:ALERT/:FLOW)라 이 카드는 자기 타입 키만 봐야 한다 — FLOW만
                          unknown인 리전을 ALERT 카드가 잘못 "확인 불가"로 표시하면 안 됨. */}
                      {logsData.failed.some((k) => k === 'firewallDiscovery' || k === 'logDiscovery' || k.startsWith('logDiscoveryEmpty:') && k.endsWith(':ALERT'))
                        ? tt('확인 불가 (로깅 구성 조회 실패 — ALERT 로그 유무 미확인)')
                        : tt('CloudWatch Logs 대상 ALERT 로그 없음')}
                    </div>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-center gap-3 px-4 py-3 text-[13px]">
                        {/* 리뷰 MAJOR(라운드10): totalAlerts는 조회 실패 시 null(0과 구분) —
                            그대로 0으로 렌더링하면 "조회 실패"가 "알럿 0건"처럼 보인다. */}
                        <span className="font-semibold">{tt('알럿')} {logsData.alert.totalAlerts == null ? tt('확인 불가') : logsData.alert.totalAlerts.toLocaleString()}</span>
                        {logsData.alert.byAction.map((a) => (
                          <Badge key={a.name} tone={a.name === 'blocked' ? 'negative' : 'neutral'} variant="soft">
                            {`${a.name} ${a.value.toLocaleString()}`}
                          </Badge>
                        ))}
                        <span>{tt('설정 stateful 룰')} {ruleHitRows.filter((r) => r.configured).length}</span>
                        {idleConfiguredRules > 0 && (
                          <span title={tt('로그 그룹 생성 시각/보존기간으로 기간 전체 커버리지를 추정한 것 — 로깅이 같은 그룹에서 껐다 켜졌다 했는지는 증명하지 않음')}>
                            <Badge tone="negative" variant="soft">{tt('매칭 없는 설정 룰')} {idleConfiguredRules}</Badge>
                          </span>
                        )}
                      </div>
                      {/* 리뷰 MAJOR(확정, PR #225 라운드3 — 라운드8에서 게이트 조건 수정): ruleHits가
                          null(쿼리 실패/discovery unknown)이면 이 카드에서 "어떤 SID가 있었는지" 조인된
                          정보 자체가 사라진다. topSignatures는 이 경로들과 독립적으로 채워지므로
                          (alertTotals/ruleHits 실패와 무관), ruleHits가 null일 때 최소한의 SID 표면
                          (설정 룰과 조인 없는 원시 Top 시그니처)으로 폴백한다. 리뷰 MAJOR(확정, 라운드8 —
                          라운드3 자체 수정의 결함): 게이트를 ruleHitRows.length===0으로 잡으면, ruleHits가
                          null이어도 rgs(설정 룰 그룹)가 있는 한 ruleHitRows는 전부 "?" 행으로 채워져
                          비지 않으므로(라운드3/4에서 만든 unknown 행들) 이 폴백이 절대 안 뜬다 — 정확히
                          ruleHits==null 여부로만 게이트해야 한다. */}
                      {logsData.alert.ruleHits == null && (logsData.alert.topSignatures.length > 0) && (
                        <>
                          <div className="px-4 text-[12px] font-medium text-ink-600">{tt('Top 시그니처 (룰 그룹 정보 없음)')}</div>
                          <div className="px-4 pb-1 text-[12px] text-ink-500">
                            {tt('설정 룰과 조인할 수 없어 히트 카운트 대신 원시 Alert 시그니처만 표시합니다')}
                          </div>
                          <div className="overflow-x-auto px-4 pb-3">
                            <table className="w-full">
                              <thead><tr className="border-b border-ink-100">
                                <th className={TH}>SID</th>
                                <th className={TH}>Signature</th>
                                <th className={TH}>{tt('건수')}</th>
                              </tr></thead>
                              <tbody>
                                {logsData.alert.topSignatures.map((s) => (
                                  <tr key={`${s.sid}|${s.signature}`} className="border-b border-ink-50 last:border-0">
                                    <td className={MONO}>{s.sid}</td>
                                    <td className={TD}>{s.signature || dash}</td>
                                    <td className={TD}>{s.value.toLocaleString()}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </>
                      )}
                      {/* ruleHits===null이면 조인된 표는 전부 "?" 행뿐이라 위 원시 시그니처 폴백과
                          중복·혼란만 준다 — 이때는 이 표를 건너뛴다. */}
                      {logsData.alert.ruleHits != null && ruleHitRows.length > 0 && (
                        <div className="border-t border-ink-100">
                          <div className="px-4 pt-3 text-[12px] font-medium text-ink-600">
                            {tt('Stateful 룰 히트 카운트')} <span className="font-normal text-ink-400">— {tt('행 클릭 → 상세')}</span>
                          </div>
                          <div className="px-4 pb-1 text-[12px] text-ink-500">
                            {tt('Alert 로그 집계 기반 — pass 룰은 Alert 로그를 남기지 않아 집계할 수 없습니다 (매칭 없음으로 세지 않음)')}
                          </div>
                          <MetricTable
                            columns={ruleHitColumns}
                            items={ruleHitRows}
                            rowKey={(r) => r.key}
                            defaultSortKey="hits"
                            emptyText="데이터 없음"
                            onRowClick={(r) => setSelected({ kind: 'rulehit', row: r })}
                            maxRender={50}
                            // 리뷰 MAJOR(확정, PR #225 라운드17): 귀속 불확실(hitsAttributable=false)
                            // 이라도 실제 hits>0인 행은 정보 없는 행이 아니다 — maxRender 컷에서
                            // 통째로 사라지면 실제 로그 증거가 무음으로 누락된다. idle(zeroTrustworthy
                            // && hits===0) 행과는 별개 조건이라 OR로 결합한다.
                            capKeep={(r) => r.hits > 0 || isIdleRule(r)}
                            rowClass={(r) => (isIdleRule(r) ? 'opacity-60' : '')}
                          />
                        </div>
                      )}
                      {/* 리뷰 MAJOR(라운드10, stop-hook 재수정): totalAlerts>0 게이트를 단일 조건으로
                          바꿨더니, 한쪽 표만 실패해도 성공한 다른 표까지 가려지는 동일 계급의
                          버그가 자리만 옮겼다 — 이 표는 자기 데이터 유무로 독립 게이트한다. */}
                      {(logsData.alert.topSources.length > 0 || logsData.alert.topDests.length > 0) && (
                        <div className="grid gap-4 px-4 pb-3">
                          <div className="overflow-x-auto">
                            <table className="w-full">
                              <thead><tr className="border-b border-ink-100">
                                <th className={TH}>{tt('소스 IP')}</th>
                                <th className={TH}>{tt('건수')}</th>
                                <th className={TH}>{tt('목적지')}</th>
                                <th className={TH}>{tt('건수')}</th>
                              </tr></thead>
                              <tbody>
                                {Array.from({ length: Math.max(logsData.alert.topSources.length, logsData.alert.topDests.length) }).map((_, i) => (
                                  <tr key={i} className="border-b border-ink-50 last:border-0">
                                    <td className={MONO}>{logsData.alert?.topSources[i]?.name ?? ''}</td>
                                    <td className={TD}>{logsData.alert?.topSources[i]?.value.toLocaleString() ?? ''}</td>
                                    <td className={MONO}>{logsData.alert?.topDests[i]?.name ?? ''}</td>
                                    <td className={TD}>{logsData.alert?.topDests[i]?.value.toLocaleString() ?? ''}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}

                      {/* ⑦-b 히트 시각화 — 도넛=byAction 완전 집계(카드 배지와 일치), 바=ruleHits sid 단위 집계(top-100 잘림 시 고지, 공유 SID 중복 합산 없음).
                          리뷰 MAJOR(확정): 도넛(byAction)과 바(ruleHits)는 서로 독립적인 Insights 쿼리라 — 하나만
                          실패해도 다른 하나는 성공할 수 있다. 각자 자기 데이터/실패 키로 독립 게이트한다.
                          리뷰(Codex stop-hook, PR #229 라운드2 — 위 라운드1 수정의 회귀 2건): (a) length 기준
                          게이트는 "실패"와 "진짜 매칭 0(정상)"을 구분 못 해 — 실패가 아닌데도 byAction이 정말
                          0건이면 도넛이 통째로 사라져 이전엔 항상 보이던 "0" 도넛조차 못 보게 됐다. 실패 여부로만
                          게이트해야 진짜 0은 그대로 도넛(0)으로, 실패만 별도 문구로 구분된다. (b) 두 칸을 각자
                          다른 조건으로 껐다 켰다 하면 lg:grid-cols-2에서 한쪽만 비어 빈 칸이 남는다 — 항상 두
                          칸 모두 무언가(차트 또는 안내 문구)를 채워 그리드가 어긋나지 않게 한다.
                          리뷰(Codex stop-hook, PR #229 라운드3 — 라운드2 수정도 여전히 불완전): byAction은
                          totalAlerts/ruleHits와 달리 discovery unknown(alertDiscoveryUnknown)이어도 null화되지
                          않고 그냥 빈 배열([])로 남는다 — failed.includes('alertByAction')만 보면 discovery
                          unknown 케이스(쿼리 자체가 "실패"로 기록되지 않음)를 놓쳐 여전히 "확정 0" 도넛으로
                          오판한다. totalAlerts==null은 이미 (failed.includes('alertTotals') ||
                          alertDiscoveryUnknown)로 계산돼 있어 이 둘을 포함하는 신호다.
                          리뷰(Codex stop-hook, PR #229 라운드4 — 라운드3 수정도 여전히 불완전): totalAlerts와
                          byAction은 Promise.all 안에서 서로 "독립된" runMerged 호출이다 — alertTotals 쿼리는
                          성공(totalAlerts != null)했는데 alertByAction 쿼리만 개별적으로 실패(스로틀/일시적
                          오류 등)할 수 있다. totalAlerts==null 단독으로는 이 케이스(불명 원인이 discovery가
                          아니라 alertByAction 자체 쿼리 실패)를 못 잡아 다시 "확정 0" 도넛으로 오판한다.
                          리뷰(Codex stop-hook, PR #229 라운드5 — 라운드4 수정의 반대 방향 결함): OR의 한쪽을
                          totalAlerts==null로 쓰면, "discovery unknown"뿐 아니라 "alertTotals 쿼리 자체의
                          개별 실패"까지 함께 섞여 들어온다 — alertTotals만 실패하고 alertByAction은 성공했어도
                          totalAlerts==null이 true라서 정상적으로 받아온 byAction 결과까지 "확인 불가"로 숨긴다
                          (독립 쿼리 원칙 위반, 이번엔 반대 방향). discovery-unknown 신호는 totalAlerts의 null
                          계산에 뒤섞여 있지 않고 `failed` 배열의 별도 키(firewallDiscovery/logDiscovery/
                          logDiscoveryEmpty:*:ALERT)로 이미 독립돼 있다 — 위 1157번째 줄의 ALERT 카드 "확인
                          불가" 판정과 동일한 키 셋을 직접 검사해 byAction 전용 실패 키와 OR로 합친다.
                          리뷰(Codex stop-hook, PR #229 라운드6 — "ALERT 로그 대상 없음"이 "매칭 0"으로
                          오판되는 남은 경로): ALERT 목적지가 CWL이 아니라 S3/Firehose인 방화벽(anfw-logs.ts의
                          `unsupported` 카운트 — anyNonCwl)은 alertTargets에도, failed[] 키에도 전혀 나타나지
                          않는다(loggingKnown=true라 "unknown" 스캔 경로도 안 타고, 실패도 아니라 failed도 안
                          찍힘) — 조용히 targets에서만 빠진다. 그런 방화벽이 섞여 있는 리전에서 다른(CWL)
                          방화벽의 표본만으로 만든 byAction이 "매칭 0"으로 보이면, 실제로는 "S3 대상이라 이
                          화면에서 집계 불가능한 ALERT 로그가 더 있을 수 있음"을 의미하는데 확정 0처럼
                          오독된다.
                          리뷰(Codex stop-hook, PR #229 라운드7 — 라운드6 수정이 과도하게 넓었음):
                          unsupportedDestinations는 ALERT/FLOW 구분 없는 계정 전체 카운트다 — FLOW만
                          S3(ALERT는 정상 CWL)인 방화벽이 있으면, ALERT 도넛과 아무 관련 없는 FLOW 쪼개짐
                          때문에 정상적인 ALERT 도넛까지 "확인 불가"로 잘못 가려진다(round1~5가 고치려던
                          "무관한 신호로 유효한 결과 숨기기"를 이번엔 FLOW→ALERT 방향으로 재현). `fws`(현재
                          방화벽 목록, 이미 이 컴포넌트에 있음)에서 직접 alertLogging이 CWL 접두사가 아닌
                          방화벽이 있는지를 본다 — ALERT 전용이라 FLOW 쪼개짐과 무관하다(라운드10에서
                          alertLogging===null인 방화벽도 포함하도록 확장 — 아래 alertObservabilityIncomplete 참고).
                          리뷰 MAJOR(라운드8): 이 그리드가 Alert Card의 `logsData &&`/`logsData.alert
                          != null` 가드 바깥(Card와 Card 사이)에 있어, 로딩 중이거나 로그 조회 자체가
                          실패했거나 alert==null인 상태에서도 내부 조건이 전부 false로 평가돼 빈 배열로
                          도넛을 "확정 0"처럼 그렸다 — 이 블록을 Card 내부, 위 Top 소스/목적지 표 바로
                          다음(즉 logsData && logsData.alert != null 분기 안)으로 이동해 로딩/에러/
                          대상 없음 상태를 Alert Card 본문과 동일하게 상속받도록 한다. */}
                      <div className="grid gap-6 lg:grid-cols-2">
                        {/* 리뷰 MAJOR(확정, PR #229 AI Code Review): 이 도넛은 alertObservabilityIncomplete/
                            failed[] 만 게이트하고 !alertCoverageComplete(시간적 커버리지 미확보 — 로깅이
                            range 도중 시작됐거나 로그 그룹 조회가 거부/시간 초과됨)는 반영하지 않아, 옆의
                            Top-10 바 차트(위 right= 고지)·조인 테이블(hits===0 && !alertCoverageComplete
                            분기)과 달리 부분 구간 집계를 확정치처럼 그렸다 — 같은 신호를 여기도 반영한다. */}
                        {(logsData?.failed?.some((k) => k === 'firewallDiscovery' || k === 'logDiscovery' || (k.startsWith('logDiscoveryEmpty:') && k.endsWith(':ALERT')) || k === 'alertByAction') ?? false) || alertObservabilityIncomplete || !alertCoverageComplete ? (
                          <div className="flex items-center justify-center px-4 py-8 text-[12px] text-ink-400">{tt('액션 분포 확인 불가')}</div>
                        ) : (
                          <DonutBreakdown title="히트 액션 분포" data={logsData?.alert?.byAction ?? []} nameKey="name" valueKey="value" />
                        )}
                        {(logsData?.alert?.ruleHits?.length ?? 0) > 0 ? (
                          <HBarList
                            title="Stateful 룰 히트 Top 10 (sid)"
                            data={ruleHitBars}
                            labelKey="rule"
                            valueKey="hits"
                            highlightMax
                            // 리뷰 MAJOR(확정): ruleHitsTruncated(top-100 join 컷오프) 하나만 고지하면,
                            // 리전별 상한(ruleHitsPartial)이나 시간적 커버리지 미확보(!alertCoverageComplete)로
                            // present sid의 값 자체가 과소집계된 경우를 놓친다 — 이 top-10 "정확한 순위"처럼
                            // 보이는 바 차트는 표의 ≥N/？ 판정과 같은 결손 신호를 모두 반영해야 한다.
                            // 리뷰 MAJOR(라운드8): 도넛의 라운드7 수정(비-CWL ALERT 목적지 방화벽 존재
                            // 여부)이 이 바 차트의 과소집계 고지에는 빠져 있었다 — 같은 fws 기반 체크를
                            // 여기에도 추가해 도넛/바가 같은 신호로 과소집계 경고를 낸다.
                            right={(ruleHitsTruncated || (logsData?.alert?.ruleHitsPartial ?? false) || !alertCoverageComplete || alertObservabilityIncomplete) ? <span className="text-[12px] text-ink-400">{tt('상위 100 집계 기준이거나 일부 값이 과소집계됐을 수 있음 — 실제 합계·순위와 다를 수 있음')}</span> : undefined}
                          />
                        ) : (
                          <div className="flex items-center justify-center px-4 py-8 text-[12px] text-ink-400">
                            {/* 리뷰(Codex stop-hook, 라운드9~10): ruleHits가 null이 아니라 빈 배열([])
                                이어도, ALERT 로깅이 CWL이 아니거나(비-CWL) 아예 꺼져 있는(null) 방화벽이
                                섞여 있으면 그 방화벽의 히트는 Insights 쿼리 대상 자체가 아니라서 "0건
                                확인"이 아니라 "일부 방화벽은 집계 불가"다 — null 체크만으로는 이 케이스를
                                "룰 히트 없음"(확정 0)으로 오판한다.
                                리뷰 MAJOR(확정, PR #229 AI Code Review): 같은 이유로 !alertCoverageComplete
                                (기간 전체 커버 미확보)도 확정 0을 막아야 한다 — 로깅이 range 도중 시작됐다면
                                range 앞쪽 구간의 매칭은 로그가 없어 "룰 히트 없음"이 아니라 "그 구간은 확인
                                못함"이다. 위 조인 테이블의 hits===0 && !alertCoverageComplete 분기와 동일한
                                기준. */}
                            {/* 리뷰 MINOR(확정, PR #229 AI Code Review): "위 원시 시그니처 표 참고"는
                                ruleHits===null && topSignatures.length>0(위 폴백 표가 실제로 렌더된
                                경우)에만 유효한 안내다 — alertObservabilityIncomplete/!alertCoverageComplete
                                만으로 여기 들어오면(ruleHits는 null이 아닐 수 있음, 또는 topSignatures가
                                비었을 수 있음) 존재하지 않는 표를 가리키는 무의미한 포인터가 된다. */}
                            {logsData?.alert?.ruleHits == null
                              ? ((logsData?.alert?.topSignatures?.length ?? 0) > 0
                                ? tt('룰 히트 집계 불명 — 위 원시 시그니처 표 참고')
                                : tt('룰 히트 집계 불명'))
                              : (alertObservabilityIncomplete || !alertCoverageComplete)
                                ? tt('룰 히트 집계 불명 — 일부 방화벽의 ALERT 로그가 이 기간을 완전히 커버하지 않음')
                                : tt('룰 히트 없음')}
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </>
              )}
            </Card>

            {/* ⑧ Flow 로그 분석 — stateful 엔진이 본 플로우, Top talker */}
            <Card
              title="Flow 로그 분석"
              subtitle="Stateful 엔진이 본 플로우(5-tuple·바이트) — Top talker와 프로토콜 분포"
              padded={false}
            >
              {logsErr && <div className="px-4 py-3 text-[13px] text-rose-600">{tt('로그 분석 실패')}: {logsErr}</div>}
              {!logsData && !logsErr && <div className="px-4 py-3 text-[13px] text-ink-400">{tt('로그 집계 중… (Logs Insights)')}</div>}
              {/* 리뷰 MAJOR(라운드10): 이 카드에는 failed[] 배너가 없어, resolveTargets가
                  degrade(firewallDiscovery/logDiscovery*)돼 200으로 응답이 와도 "FLOW 로그
                  없음"이 확정 부재처럼 보였다 — Alert 카드와 동일하게 배너를 렌더링. */}
              {logsData && logsData.failed.length > 0 && (
                <div className="flex items-start gap-2 px-4 pt-3 text-[12px] text-warning-text">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  <span>{tt('일부 로그 그룹 조회 실패')} ({logsData.failed.join(', ')}) — {tt('해당 집계는 실제보다 적을 수 있습니다.')}</span>
                </div>
              )}
              {logsData && (logsData.flow == null ? (
                <div className="px-4 py-3 text-[13px] text-ink-400">
                  {/* 리뷰 MAJOR(라운드12): logDiscoveryEmpty가 타입별 키가 됐으므로 이
                      카드는 자기 타입(:FLOW) 키만 봐야 한다 — ALERT만 unknown인 리전을
                      이 카드가 잘못 "확인 불가"로 표시하면 안 됨. */}
                  {logsData.failed.some((k) => k === 'firewallDiscovery' || k === 'logDiscovery' || k.startsWith('logDiscoveryEmpty:') && k.endsWith(':FLOW'))
                    ? tt('확인 불가 (로깅 구성 조회 실패 — FLOW 로그 유무 미확인)')
                    : tt('CloudWatch Logs 대상 FLOW 로그 없음')}
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-3 px-4 py-3 text-[13px]">
                    {/* 리뷰 MAJOR(라운드11): flowTotals 실패 시 totalFlows/totalBytes는 null —
                        alert 카드와 동일하게 "확인 불가"로 표시(0건과 구분). 아래 표는 이미
                        topTalkers.length로 독립 게이트돼 있어 totals 실패의 영향을 받지 않음. */}
                    <span className="font-semibold">{tt('플로우')} {logsData.flow.totalFlows == null ? tt('확인 불가') : logsData.flow.totalFlows.toLocaleString()}</span>
                    <span>{tt('전송량')} {fmtBytes(logsData.flow.totalBytes) ?? dash}</span>
                    {logsData.flow.byProto.map((p) => (
                      <Badge key={p.name} variant="outline" mono>{`${p.name} ${p.value.toLocaleString()}`}</Badge>
                    ))}
                  </div>
                  {logsData.flow.talkersWindowSec < logsData.rangeSec && (
                    <div className="px-4 pb-1 text-[12px] text-ink-500">
                      {tt('Top talker는 최근 6시간 창 기준 — 플로우 볼륨이 커서 전체 범위 집계는 시간 초과')}
                    </div>
                  )}
                  {logsData.flow.topTalkers.length > 0 && (
                    <div className="overflow-x-auto pb-2">
                      <table className="w-full">
                        <thead><tr className="border-b border-ink-100">
                          <th className={TH}>{tt('소스')}</th>
                          <th className={TH}>{tt('목적지')}</th>
                          <th className={TH}>{tt('전송량')}</th>
                          <th className={TH}>{tt('플로우')}</th>
                        </tr></thead>
                        <tbody>
                          {logsData.flow.topTalkers.map((t2) => (
                            <tr key={`${t2.src}|${t2.dst}`} className="border-b border-ink-50 last:border-0">
                              <td className={MONO}>{t2.src}</td>
                              <td className={MONO}>{t2.dst}</td>
                              <td className={TD}>{fmtBytes(t2.bytes) ?? dash}</td>
                              <td className={TD}>{t2.flows.toLocaleString()}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              ))}
            </Card>

            {/* ⑧-b Flow 시각화 — 프로토콜 분포 도넛 + Top talker 전송량 바 */}
            {/* 리뷰 MAJOR(라운드11): totalFlows>0 게이트는 flowTotals만 실패해도(byProto/
                topTalkers 쿼리는 성공) 이미 로드된 차트 두 개를 통째로 숨겼다 — 두 차트가
                실제로 그릴 데이터 유무로 게이트를 교체(totalFlows는 위 카드에서 별도 표시). */}
            {logsData?.flow != null && (logsData.flow.byProto.length > 0 || logsData.flow.topTalkers.length > 0) && (
              <div className="grid gap-6 lg:grid-cols-2">
                <DonutBreakdown title="Flow 프로토콜 분포" data={flowProtoDist} nameKey="name" valueKey="value" />
                <HBarList title="Top talker 전송량 (MB)" data={talkerBars} labelKey="pair" valueKey="mb" highlightMax />
              </div>
            )}

            {/* ⑨ 구성 변경 감사 — CloudTrail 변경(mutation) 이벤트만 계정 전체에서 조회한 뒤
                클라이언트에서 NFW EventSource로 필터(라운드8: EventSource 단위 조회는 이 앱
                자신의 read 이벤트가 목록을 가득 채워 실제 변경 이벤트가 90일치가 아니라
                최근 몇 시간분만 보이는 문제가 있었음 — ReadOnly=false 필터로 전환) */}
            <Card
              title="구성 변경 감사"
              subtitle="CloudTrail 변경 이벤트 — 누가 방화벽/정책/룰을 바꿨는지 (조회 범위 90일, 전체 최근 50건까지)"
              padded={false}
            >
              {auditErr && <div className="px-4 py-3 text-[13px] text-rose-600">{tt('감사 이벤트 조회 실패')}: {auditErr}</div>}
              {!audit && !auditErr && <div className="px-4 py-3 text-[13px] text-ink-400">{tt('로딩 중…')}</div>}
              {audit && auditDegradedRegions.length > 0 && (
                // 리뷰 MAJOR: 이벤트명 단위 CloudTrail 조회가 일부 실패해도 조용히 삼키면
                // "조회 범위 내 변경 없음"과 "조회 자체가 실패함"을 구분할 수 없다 —
                // 감사(audit) 화면에서 가장 나쁜 오류 형태이므로 항상 배너로 노출한다.
                <div className="flex items-start gap-2 px-4 pt-3 text-[12px] text-warning-text">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  <span>{tt('일부 리전 조회 실패')} ({auditDegradedRegions.join(', ')}) — {tt('해당 리전은 변경 이벤트 조회 자체가 실패해 "변경 없음"을 확정할 수 없습니다.')}</span>
                </div>
              )}
              {audit && (audit.length === 0 ? (
                auditDegradedRegions.length > 0 ? (
                  <div className="px-4 py-3 text-[13px] text-ink-400">{tt('조회 실패로 변경 이벤트 유무를 확인할 수 없습니다')}</div>
                ) : (
                  <div className="px-4 py-3 text-[13px] text-ink-400">{tt('조회 범위(90일) 내 변경 이벤트 없음')}</div>
                )
              ) : (
                <div className="overflow-x-auto pb-2">
                  <table className="w-full">
                    <thead><tr className="border-b border-ink-100">
                      <th className={TH}>{tt('시각')}</th>
                      <th className={TH}>{tt('이벤트')}</th>
                      <th className={TH}>{tt('사용자')}</th>
                      <th className={TH}>{tt('리소스')}</th>
                      <th className={TH}>{tt('리전')}</th>
                    </tr></thead>
                    <tbody>
                      {audit.map((e, i) => (
                        <tr key={`${e.time}|${e.name}|${i}`} className="border-b border-ink-50 last:border-0">
                          <td className={TD}>{e.time.replace('T', ' ').slice(0, 19)}</td>
                          <td className={MONO}>{e.name}</td>
                          <td className={TD}>{e.user || dash}</td>
                          <td className={MONO}>{e.resourceName || dash}</td>
                          <td className={TD}>{e.region}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </Card>
          </>
          );
        })()}
      </div>

      <DetailPanel
        title={selected == null ? undefined : selected.kind === 'rulehit' ? `SID ${selected.row.sid}` : selected.row.name}
        data={selected
          ? selected.kind === 'fw'
            ? fwDetail(selected.row)
            : selected.kind === 'policy'
              ? policyDetail(selected.row)
              : selected.kind === 'rulehit'
                ? ruleHitDetail(selected.row, alertCoverageComplete, logsData?.alert?.ruleHitsPartial ?? false, alertObservabilityIncomplete, tt)
                : rgDetail(selected.row)
          : null}
        spec={selected?.kind === 'fw' ? FW_DETAIL_SPEC
          : selected?.kind === 'policy' ? POLICY_DETAIL_SPEC
            : selected?.kind === 'rulehit' ? RULEHIT_DETAIL_SPEC
              : RG_DETAIL_SPEC}
        onClose={() => setSelected(null)}
      />
    </>
  );
}
