'use client';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  Shield, ShieldCheck, DollarSign, TrendingUp, Bell, FileSearch, Cpu, Container,
} from 'lucide-react';
import StatTile, { passVariant } from '@/components/ui/StatTile';
import { TYPE_ICON } from '@/lib/type-icons';
import { INVENTORY_TYPES } from '@/lib/inventory-types';
import PageHeader from '@/components/ui/PageHeader';
import RefreshButton from '@/components/ui/RefreshButton';
import SectionLabel from '@/components/ui/SectionLabel';
import Card from '@/components/ui/Card';
import InsightCard from '@/components/insights/InsightCard';
import BarDistribution from '@/components/charts/BarDistribution';
import DonutBreakdown from '@/components/charts/DonutBreakdown';
import AreaTrend from '@/components/charts/AreaTrend';
import MultiLineTrend from '@/components/charts/MultiLineTrend';
import SegmentedControl from '@/components/ui/SegmentedControl';
import AiOps from '@/components/overview/AiOps';
import { useActiveScope, scopeParams } from '@/lib/account-context';
import { nearestSnapshot, netChange } from '@/lib/trend-utils';
import { estimateCostImpact, COST_IMPACT_WEIGHTS } from '@/lib/cost-impact';
import { useI18n } from '@/components/shell/LanguageProvider';
import { localeOf } from '@/lib/i18n';

interface Overview {
  jobs: { queued: number; running: number; succeeded: number; failed: number };
  clusterCount: number | null;
  mtdCost: number | null;
  compliance: { pass_rate: number | null; alarm: number | null; finished_at: string | null } | null;
}
interface ByType { type: string; label: string; count: number; [k: string]: unknown }
interface ByCategory { group: string; count: number; [k: string]: unknown }
interface Splits {
  ec2Running: number;
  ec2Stopped: number;
  ebsUnencrypted: number;
  iamUserNoMfa: number;
  sgOpenIngress: number;
  s3Public: number;
  cwAlarm?: number;
}
interface Ec2Type { name: string; count: number; [k: string]: unknown }
interface Summary { byType: ByType[]; byCategory: ByCategory[]; total: number; splits?: Splits; ec2Types?: Ec2Type[]; lastSyncAt?: string | null }
interface TrendPoint { date: string; amount: number; [k: string]: unknown }
interface Cost { trend: TrendPoint[]; monthly?: { month: string; total: number }[] }
interface ResourceTrendPoint { date: string; total: number; ec2?: number; [k: string]: unknown }
interface ResourceTrend { trend: ResourceTrendPoint[]; types?: string[] }
interface FleetCluster {
  name: string;
  reachable: boolean;
  counts: { nodes: number; nodesReady: number; pods: number; podsRunning: number; deployments: number; services: number };
  podStatus: Record<string, number>;
  events: { reason?: string; message?: string; object?: string; count?: number; lastSeenTs?: number; [k: string]: unknown }[];
}
interface Fleet { clusters: FleetCluster[] }

const DASH = '—';
const INV_LABEL = (t: string): string => INVENTORY_TYPES[t]?.label ?? t;
// Section gateways per ADR-004 (8). Named so the AgentCore tile isn't a bare magic literal.
const SECTION_GATEWAYS = 8;

// v1-parity: every KPI/resource tile carries a lucide glyph in its translucent top-right box.
// Resource tiles reuse the shared per-type map so icons match the inventory pages.
function typeIcon(type: string): ReactNode {
  const I = TYPE_ICON[type];
  return I ? <I size={13} /> : null;
}

export default function Home() {
  const { tt, lang } = useI18n();
  const [ov, setOv] = useState<Overview | null>(null);
  const [ovErr, setOvErr] = useState('');
  const [sum, setSum] = useState<Summary | null>(null);
  const [sumErr, setSumErr] = useState('');
  const [cost, setCost] = useState<Cost | null>(null);
  const [resTrend, setResTrend] = useState<ResourceTrend | null>(null);
  // Cost-impact baseline (gap L225, review round-1): a FIXED 35-day trend fetch, independent
  // of the chart-period selector — with the default 14d fetch the 30d baseline never exists
  // and the panel would be invisible on the default view.
  const [impactTrend, setImpactTrend] = useState<ResourceTrend | null>(null);
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const [busy, setBusy] = useState(false);
  const [capturedAt, setCapturedAt] = useState<string | null>(null);
  const [scope] = useActiveScope();
  const [trendDays, setTrendDays] = useState(14);

  const loadAll = useCallback(async () => {
    setBusy(true);
    // Core summaries (Aurora-backed, fast) gate the refresh spinner. Each degrades on its
    // own (allSettled) so one failure never blanks the others.
    await Promise.allSettled([
      fetch(`/api/overview?account=${encodeURIComponent(scope.accounts === '__all__' ? '__all__' : scope.accounts[0] ?? 'self')}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d) => { setOv(d); setOvErr(''); })
        .catch((e) => setOvErr(String(e))),
      fetch(`/api/inventory/summary?${scopeParams(scope)}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d) => { setSum(d); setSumErr(''); })
        .catch((e) => setSumErr(String(e))),
      fetch('/api/cost')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then(setCost)
        .catch(() => setCost({ trend: [] })),
      fetch(`/api/inventory/trend?days=${trendDays}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then(setResTrend)
        .catch(() => setResTrend({ trend: [] })),
      fetch('/api/inventory/trend?days=35')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then(setImpactTrend)
        .catch(() => setImpactTrend({ trend: [] })),
    ]);
    setBusy(false);

    // EKS fleet is a LIVE K8s read (nodes/pods/events per cluster). Kept OUT of the
    // busy-gated set so it never blocks the spinner, and bounded on BOTH ends: the client
    // AbortController (6s) drops the request here, while the server-side k8sGet timeout
    // (K8S_REQUEST_TIMEOUT_MS in eks-incluster) closes the actual K8s socket so a slow/stuck
    // API can't occupy the web task (thin-BFF). The charts fill in on resolve, else stay empty.
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    fetch('/api/eks/fleet', { signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setFleet)
      .catch(() => setFleet({ clusters: [] }))
      .finally(() => clearTimeout(t));
  }, [scope, trendDays]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Header freshness = when the inventory was last SYNCED (falls back to fetch time).
  useEffect(() => {
    setCapturedAt(sum?.lastSyncAt ?? (sum ? new Date().toISOString() : null));
  }, [sum]);

  // type → count lookup from the inventory summary (DASH when summary unavailable).
  const n = (type: string): number | string => {
    if (!sum) return DASH;
    return sum.byType.find((t) => t.type === type)?.count ?? 0;
  };

  const jobs = ov?.jobs;

  const barData = sum ? sum.byType.filter((t) => t.count > 0).slice(0, 12) : [];
  const trend = cost?.trend ?? [];
  const ec2Types = (sum?.ec2Types ?? []).filter((t) => t.count > 0);

  // Aggregate the EKS fleet across clusters (counts, pod phases, recent events).
  const clusters = fleet?.clusters ?? [];
  const eks = clusters.reduce(
    (a, c) => {
      a.nodes += c.counts?.nodes ?? 0;
      a.pods += c.counts?.pods ?? 0;
      a.deployments += c.counts?.deployments ?? 0;
      for (const [k, v] of Object.entries(c.podStatus ?? {})) a.podStatus[k] = (a.podStatus[k] ?? 0) + Number(v);
      return a;
    },
    { nodes: 0, pods: 0, deployments: 0, podStatus: {} as Record<string, number> },
  );
  const podStatusDonut = Object.entries(eks.podStatus)
    .map(([name, value]) => ({ name, value }))
    .filter((d) => d.value > 0);
  const recentEvents = clusters
    .flatMap((c) => (c.events ?? []).map((e) => ({ ...e, cluster: c.name })))
    .sort((a, b) => (Number(b.lastSeenTs) || 0) - (Number(a.lastSeenTs) || 0))
    .slice(0, 8);
  const hasFleet = clusters.length > 0;

  // Security-issue rollup across the four /security findings (public S3 + open ingress +
  // unencrypted EBS + IAM without MFA). The public-S3 count is produced by the summary
  // route using the SAME shared PUBLIC_S3_WHERE predicate as the /security page, so this
  // home tile stays consistent with /security (incl. Block-Public-Access-off buckets).
  const sp = sum?.splits;
  const secIssues = sp ? sp.sgOpenIngress + sp.ebsUnencrypted + sp.iamUserNoMfa + sp.s3Public : null;

  // Latest succeeded CIS run's pass rate, for the dashboard compliance tile.
  const compliancePassRate = ov?.compliance?.pass_rate != null ? Number(ov.compliance.pass_rate) : null;

  // Cost daily average (MTD ÷ elapsed days) for the cost tile subline.
  const dailyAvg =
    ov && ov.mtdCost != null ? ov.mtdCost / Math.max(1, new Date().getDate()) : null;

  // MoM delta vs last month's daily average (v1 parity: '전월 대비 ±N%').
  const monthly = cost?.monthly ?? [];
  const lastMonthTotal = monthly.length >= 2 ? monthly[monthly.length - 2].total : null;
  const now = new Date();
  const daysInLastMonth = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
  const momPct =
    dailyAvg != null && lastMonthTotal != null && lastMonthTotal > 0
      ? (dailyAvg / (lastMonthTotal / daysInLastMonth) - 1) * 100
      : null;

  // Straight-line month-end projection (design handoff 개선안 ①: "예상 청구액"). Client-side
  // only — no new API — daily average × days in the current month.
  const today = new Date();
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const projectedCost = dailyAvg != null ? dailyAvg * daysInMonth : null;

  // Active-warnings list (v1 parity, ADR design handoff §3): one row per active
  // condition with a link to its page. Distinct from the Tier-1 hero's counts —
  // this reads as sentences, not numbers, and only ever lists what's actually active.
  const warnings = [
    sp && sp.s3Public > 0 && { key: 's3', dot: 'var(--negative)', text: `공개 접근 가능한 S3 버킷 ${sp.s3Public}개`, href: '/security' },
    sp && sp.sgOpenIngress > 0 && { key: 'sg', dot: 'var(--negative)', text: `인그레스가 개방된 보안 그룹 ${sp.sgOpenIngress}개`, href: '/inventory/security_group' },
    sp && sp.ebsUnencrypted > 0 && { key: 'ebs', dot: 'var(--warning)', text: `미암호화 EBS 볼륨 ${sp.ebsUnencrypted}개`, href: '/inventory/ebs_volume' },
    sp && sp.iamUserNoMfa > 0 && { key: 'mfa', dot: 'var(--warning)', text: `MFA 미설정 IAM 사용자 ${sp.iamUserNoMfa}개`, href: '/inventory/iam_user' },
    jobs && jobs.failed > 0 && { key: 'jobs', dot: 'var(--negative)', text: `실패한 작업 ${jobs.failed}개`, href: '/jobs' },
    sp && (sp.cwAlarm ?? 0) > 0 && { key: 'cw', dot: 'var(--negative)', text: `ALARM 상태 CloudWatch 알람 ${sp.cwAlarm}개`, href: '/inventory/cloudwatch_alarm' },
    hasFleet && recentEvents.length > 0 && { key: 'k8s', dot: 'var(--warning)', text: `K8s Warning 이벤트 ${recentEvents.length}건`, href: '/eks' },
  ].filter((w): w is { key: string; dot: string; text: string; href: string } => Boolean(w));

  // Multi-line trend series + Current/7d/30d delta rows (v1 parity). L126: top 8 types as
  // toggle chips (the chart palette has exactly 8 hues — more would duplicate colors) — Core
  // (top 5) visible by default, Other default-hidden; colors stay pinned to each series'
  // original index inside MultiLineTrend.
  const trendTypes = (resTrend?.types ?? []).slice(0, 8);
  const trendSeries = trendTypes.map((t) => ({ key: t, label: INV_LABEL(t) }));
  const coreTypes = trendTypes.slice(0, 5);
  const otherTypes = trendTypes.slice(5);
  // L127: 7d net change (lib/trend-utils netChange — coverage-parity diff with honest-degrade
  // branches; see its doc). The trend endpoint is account_id='self'-fixed with no region
  // dimension (scoping it is a separately tracked open item), so a narrowed scope also renders
  // '—' — the adjacent 전체 리소스 IS scoped, and one KPI row must not silently mix the two.
  const scopeIsDefault =
    Array.isArray(scope.accounts) && scope.accounts.length === 1 && scope.accounts[0] === 'self'
    && scope.regions === '__all__' && scope.includeGlobal === true;
  const net7 = scopeIsDefault ? netChange(resTrend?.trend ?? [], 7) : null;

  const deltaRows = (() => {
    const pts = resTrend?.trend ?? [];
    if (pts.length < 2) return [];
    const last = pts[pts.length - 1];
    const w = nearestSnapshot(pts, 7);
    const m = nearestSnapshot(pts, 30);
    // Key ABSENCE means "no successful sync for that type that day" (the route no longer
    // pre-seeds zeros) — it must render '—', never a fabricated Current 0 / −100%.
    const val = (p: Record<string, unknown> | null, t: string): number | null =>
      p && typeof p[t] === 'number' ? (p[t] as number) : null;
    return (resTrend?.types ?? []).map((t) => {
      const cur = val(last, t);
      const wv = val(w, t);
      const mv = m && m !== w ? val(m, t) : null;
      const pct = (from: number | null) =>
        cur == null || from == null || from === 0 ? null : ((cur - from) / from) * 100;
      return { type: t, label: INV_LABEL(t), cur, w: wv, m: mv, wPct: pct(wv), mPct: pct(mv) };
    }).filter((r) => (r.cur ?? 0) > 0 || (r.w ?? 0) > 0);
  })();

  // Cost Impact Estimation (gap L225, v1 parity): 30d count delta × static monthly weight,
  // |impact| desc. Built from the dedicated 35d fetch over ALL trend types (NOT the delta
  // table's presentation-filtered rows — a type that went to zero >7d ago is precisely the
  // biggest genuine saving). Honest bounds: requires a non-stale latest point (the netChange
  // guard — a sync that died days ago must not be priced as a 30d delta), a 30d baseline
  // within tolerance, and the default scope (the trend history is host-account-only; a
  // narrowed scope must not show host-wide dollar impact — the net7 gate).
  const impactRows = (() => {
    if (!scopeIsDefault) return [];
    const pts = [...(impactTrend?.trend ?? [])].sort((a, b) => a.date.localeCompare(b.date));
    if (pts.length < 2) return [];
    const last = pts[pts.length - 1];
    if (nearestSnapshot(pts, 0) !== last) return []; // latest point itself is stale
    const base = nearestSnapshot(pts, 30);
    if (!base || base === last) return [];
    // actual-span validation (the netChange precedent): a ~26/34-day span must not be
    // priced and labeled as a 30-day delta.
    const spanDays = (new Date(last.date).getTime() - new Date(base.date).getTime()) / 86_400_000;
    if (Math.abs(spanDays - 30) > 2) return [];
    // Partial-LATEST guard, scoped to WEIGHTED types only (review: an equality check over all
    // types self-disabled the panel for ~30 days whenever any type — even an unweighted one —
    // appeared or failed once). Hide only when the latest day is missing a weighted type the
    // baseline has (a mid-fan-out latest day, or a died sync — indistinguishable, so fail
    // safe); a type new since the baseline is handled per-type (no baseline → excluded).
    const partialLatest = (impactTrend?.types ?? []).some(
      (t) => COST_IMPACT_WEIGHTS[t] != null && typeof base[t] === 'number' && typeof last[t] !== 'number',
    );
    if (partialLatest) return [];
    const val = (p: Record<string, unknown>, t: string): number | null =>
      typeof p[t] === 'number' ? (p[t] as number) : null;
    return estimateCostImpact(
      (impactTrend?.types ?? []).map((t) => ({ type: t, cur: val(last, t), m: val(base, t) })),
    );
  })();

  const loading = !ov && !ovErr && !sum && !sumErr;

  return (
    <>
      <PageHeader
        title="대시보드"
        subtitle="실시간 AWS · Kubernetes 운영 현황"
        right={<RefreshButton busy={busy} onClick={loadAll} capturedAt={capturedAt} />}
      />
      <div className="px-4 lg:px-8 py-8 flex flex-col gap-6">
        {loading && <div className="text-ink-400">{tt('로딩 중…')}</div>}
        {ovErr && (
          <div className="text-[13px] text-rose-600">
            {tt('운영 요약 로드 실패:')} {ovErr} {tt('(세션 만료면 새로고침)')}
          </div>
        )}

        {/* ---- AI INSIGHTS (operational anomalies — K8s/CloudWatch/cost, worker-synthesized) ---- */}
        <InsightCard />

        {/* ---- AI OPERATIONS (v1-parity: chat + analysis entry points) ---- */}
        <AiOps />

        {/* ---- Tier 1: NEEDS ATTENTION — security hero + CIS (design handoff 개선안 ①) ---- */}
        <section className="flex flex-col gap-3">
          <SectionLabel dot="var(--negative)">요주의 · 즉시 확인</SectionLabel>
          <div className="grid grid-cols-1 lg:grid-cols-[1.55fr_1fr] gap-4">
            <Link
              href="/security"
              className={
                'block rounded-lg border p-4 transition hover:shadow-md ' +
                (secIssues && secIssues > 0
                  ? 'border-negative-border border-l-[3px] bg-negative-surface'
                  : 'border-ink-100 bg-card')
              }
            >
              <div className="flex items-start justify-between">
                <div className="text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400">{tt('보안 이슈')}</div>
                <div className="flex items-center gap-2">
                  {secIssues != null && (
                    <span
                      className={
                        'rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none ' +
                        (secIssues > 0 ? 'bg-negative text-white' : 'bg-positive-surface text-positive-text')
                      }
                    >
                      {secIssues > 0 ? tt('위험') : tt('이상 없음')}
                    </span>
                  )}
                  <span
                    className={
                      'flex h-8 w-8 items-center justify-center rounded-lg ' +
                      (secIssues && secIssues > 0 ? 'bg-rose-500/10 text-rose-600' : 'bg-ink-500/10 text-ink-500')
                    }
                  >
                    <Shield size={16} />
                  </span>
                </div>
              </div>
              <div
                className={
                  'tabular text-[36px] font-semibold leading-tight mt-1 ' +
                  (secIssues && secIssues > 0 ? 'text-negative-text' : 'text-ink-800')
                }
              >
                {secIssues == null ? DASH : secIssues}
              </div>
              {sp && (
                <div className="grid grid-cols-4 gap-2 mt-3 border-t border-ink-100 pt-2.5">
                  {[
                    { label: '공개 S3', v: sp.s3Public },
                    { label: '개방 SG', v: sp.sgOpenIngress },
                    { label: '미암호화 EBS', v: sp.ebsUnencrypted },
                    { label: 'MFA 미설정', v: sp.iamUserNoMfa },
                  ].map((it) => (
                    <div key={it.label}>
                      <div className="tabular text-[19px] font-semibold text-ink-800">{it.v}</div>
                      <div className="text-[10.5px] text-ink-500">{tt(it.label)}</div>
                    </div>
                  ))}
                </div>
              )}
            </Link>
            <StatTile
              label="CIS 컴플라이언스"
              value={compliancePassRate != null ? `${compliancePassRate.toFixed(0)}%` : DASH}
              href="/compliance"
              icon={<ShieldCheck size={16} />}
              variant={compliancePassRate != null ? passVariant(compliancePassRate) : 'warn'}
              hint={
                compliancePassRate != null
                  ? `Alarm ${ov?.compliance?.alarm ?? 0}건 · 완료 ${
                      ov?.compliance?.finished_at ? new Date(ov.compliance.finished_at).toLocaleString(localeOf(lang)) : DASH
                    }`
                  : '벤치마크 실행 →'
              }
            />
          </div>
        </section>

        {/* ---- Active warnings (v1 parity) — sentence + link per active condition ---- */}
        {warnings.length > 0 && (
          <Card title={`활성 경고 (${warnings.length})`} padded={false}>
            <ul className="flex flex-col divide-y divide-ink-100">
              {warnings.map((w) => (
                <li key={w.key}>
                  <Link href={w.href} className="flex items-center gap-2.5 px-4 py-2.5 text-[13px] text-ink-700 hover:bg-ink-50">
                    <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: w.dot }} />
                    {tt(w.text)}
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {/* ---- Tier 2: COST ---- */}
        <section className="flex flex-col gap-3">
          <SectionLabel dot="var(--brand-500)">비용</SectionLabel>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatTile
              label="이번 달 비용 (USD)"
              value={ov ? (ov.mtdCost == null ? DASH : `$${ov.mtdCost.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`) : DASH}
              href="/cost"
              variant="accent"
              icon={<DollarSign size={16} />}
              trend={momPct != null ? `${momPct >= 0 ? '↑' : '↓'}${Math.abs(momPct).toFixed(1)}%` : undefined}
              hint={dailyAvg != null ? `약 $${dailyAvg.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/일${momPct != null ? ' · 전월 일평균 대비' : ''}` : undefined}
            />
            <StatTile
              label="예상 청구액 (USD)"
              value={projectedCost == null ? DASH : `$${projectedCost.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              href="/cost"
              icon={<TrendingUp size={16} />}
              hint="월말 예상"
            />
            <StatTile
              label="CloudWatch 알람"
              value={n('cloudwatch_alarm')}
              href="/inventory/cloudwatch_alarm"
              variant={sp && (sp.cwAlarm ?? 0) > 0 ? 'danger' : 'default'}
              icon={<Bell size={16} />}
              hint={sp && (sp.cwAlarm ?? 0) > 0 ? `ALARM ${sp.cwAlarm}건` : undefined}
            />
            <StatTile label="CloudTrail" value={n('cloudtrail')} href="/inventory/cloudtrail" icon={<FileSearch size={16} />} />
          </div>
        </section>

        {/* ---- Tier 3: RESOURCES — quiet compact tiles, no hints (all-clear by default) ---- */}
        <section className="flex flex-col gap-3">
          <SectionLabel dot="var(--positive)" right={secIssues === 0 && (
            <span className="rounded-full bg-positive-surface px-2 py-0.5 text-[10px] font-semibold text-positive-text">{tt('모두 정상')}</span>
          )}>
            리소스 현황
          </SectionLabel>
          <div className="flex flex-col gap-3">
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.04em] text-ink-400">COMPUTE &amp; CONTAINERS</div>
            <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-7 gap-3">
              <StatTile size="compact" label="EC2 인스턴스" value={n('ec2')} href="/inventory/ec2" icon={typeIcon('ec2')} />
              <StatTile size="compact" label="Lambda 함수" value={n('lambda')} href="/inventory/lambda" icon={typeIcon('lambda')} />
              <StatTile size="compact" label="ECS 클러스터" value={n('ecs_cluster')} href="/inventory/ecs_cluster" icon={typeIcon('ecs_cluster')} />
              <StatTile size="compact" label="AgentCore" value={`${SECTION_GATEWAYS} GW`} href="/assistant" icon={<Cpu size={13} />} />
              <StatTile size="compact" label="ECR 리포지토리" value={n('ecr')} href="/inventory/ecr" icon={typeIcon('ecr')} />
              <StatTile size="compact" label="EKS 클러스터" value={ov ? ov.clusterCount ?? DASH : DASH} href="/eks" icon={<Container size={13} />} />
              <StatTile size="compact" label="CloudFront" value={n('cloudfront')} href="/inventory/cloudfront" icon={typeIcon('cloudfront')} />
            </div>
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.04em] text-ink-400 mt-1">STORAGE &amp; NETWORK</div>
            <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-9 gap-3">
              <StatTile size="compact" label="VPC" value={n('vpc')} href="/inventory/vpc" icon={typeIcon('vpc')} />
              <StatTile size="compact" label="WAF" value={n('waf')} href="/inventory/waf" icon={typeIcon('waf')} />
              <StatTile size="compact" label="EBS 볼륨" value={n('ebs_volume')} href="/inventory/ebs_volume" icon={typeIcon('ebs_volume')} />
              <StatTile size="compact" label="S3 버킷" value={n('s3')} href="/inventory/s3" icon={typeIcon('s3')} />
              <StatTile size="compact" label="RDS 인스턴스" value={n('rds')} href="/inventory/rds" icon={typeIcon('rds')} />
              <StatTile size="compact" label="DynamoDB 테이블" value={n('dynamodb')} href="/inventory/dynamodb" icon={typeIcon('dynamodb')} />
              <StatTile size="compact" label="ElastiCache" value={n('elasticache')} href="/inventory/elasticache" icon={typeIcon('elasticache')} />
              <StatTile size="compact" label="OpenSearch" value={n('opensearch')} href="/inventory/opensearch" icon={typeIcon('opensearch')} />
              <StatTile size="compact" label="MSK" value={n('msk')} href="/inventory/msk" icon={typeIcon('msk')} />
            </div>
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.04em] text-ink-400 mt-1">IAM</div>
            <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-7 gap-3">
              <StatTile size="compact" label="IAM 역할" value={n('iam_role')} href="/inventory/iam_role" icon={typeIcon('iam_role')} />
              <StatTile size="compact" label="IAM 사용자" value={n('iam_user')} href="/inventory/iam_user" icon={typeIcon('iam_user')} />
              <StatTile size="compact" label="보안 그룹" value={n('security_group')} href="/inventory/security_group" icon={typeIcon('security_group')} />
            </div>
          </div>
        </section>

        {/* ---- Inventory summary KPI bar (gap L127, v1 parity): types · total · 7d net ---- */}
        {sum && (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg border border-ink-100 bg-card px-4 py-2 text-[12.5px] text-ink-600">
            <span>{tt('리소스 타입')} <b className="tabular text-ink-800">{sum.byType.length}</b></span>
            <span>{tt('전체 리소스')} <b className="tabular text-ink-800">{sum.total.toLocaleString()}</b></span>
            <span>
              {tt('7일 순증감')}{' '}
              {net7 == null ? (
                // honest-degrade: fewer than 2 snapshots, or no snapshot near 7d ago
                <b className="text-ink-400">—</b>
              ) : (
                <b className={`tabular ${net7 > 0 ? 'text-emerald-600' : net7 < 0 ? 'text-rose-600' : 'text-ink-800'}`}>
                  {net7 > 0 ? '+' : ''}{net7.toLocaleString()}
                </b>
              )}
            </span>
          </div>
        )}

        {/* ---- Resource trend (14d, DESIGN.md §3) + category donut ---- */}
        {resTrend && (
          <div className="grid grid-cols-1 lg:grid-cols-[1.6fr_1fr] gap-6">
            {resTrend.trend.length >= 2 && trendSeries.length > 0 ? (
              <MultiLineTrend
                title={`리소스 추세 (${trendDays}d)`}
                right={
                  <SegmentedControl
                    options={[{ value: '14', label: '14d' }, { value: '30', label: '30d' }, { value: '90', label: '90d' }]}
                    value={String(trendDays)}
                    onChange={(v) => setTrendDays(Number(v))}
                  />
                }
                data={resTrend.trend}
                xKey="date"
                series={trendSeries}
                key={trendTypes.join(',')} // period toggle re-ranks types → remount resets hidden state
                interactiveLegend
                legendGroups={[
                  { label: tt('Core Resources'), keys: coreTypes },
                  ...(otherTypes.length ? [{ label: tt('Other Resources'), keys: otherTypes }] : []),
                ]}
                defaultHidden={otherTypes}
              />
            ) : (
              <Card title={`리소스 추세 (${trendDays}d)`}>
                <div className="text-[13px] text-ink-400">{tt('이력 수집 중 — sync 주기마다 축적됩니다')}</div>
              </Card>
            )}
            {sum ? (
              <DonutBreakdown title="카테고리별 리소스" data={sum.byCategory} nameKey="group" valueKey="count" />
            ) : (
              <Card title="카테고리별 리소스">
                <div className="text-[13px] text-ink-400">{sumErr || tt('로딩 중…')}</div>
              </Card>
            )}
          </div>
        )}

        {/* ---- Trend delta table (v1 parity): Current / 7d / 30d ±% per resource type ---- */}
        {deltaRows.length > 0 && (
          <Card title="리소스 수량 변화" padded={false}>
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-b border-ink-100 text-left text-[11px] uppercase tracking-[0.04em] text-ink-400">
                    <th className="px-4 py-2 font-semibold">Type</th>
                    <th className="px-4 py-2 text-right font-semibold">Current</th>
                    <th className="px-4 py-2 text-right font-semibold">7d Ago</th>
                    <th className="px-4 py-2 text-right font-semibold">7d Δ</th>
                    <th className="px-4 py-2 text-right font-semibold">30d Ago</th>
                    <th className="px-4 py-2 text-right font-semibold">30d Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {deltaRows.map((r) => {
                    const pctCell = (pct: number | null) =>
                      pct == null ? (
                        <span className="text-ink-300">—</span>
                      ) : (
                        <span className={pct > 0 ? 'text-brand-700' : pct < 0 ? 'text-positive-text' : 'text-ink-400'}>
                          {pct > 0 ? '+' : ''}{pct.toFixed(1)}%
                        </span>
                      );
                    return (
                      <tr key={r.type} className="border-b border-ink-50 last:border-0">
                        <td className="px-4 py-1.5 text-ink-700">{r.label}</td>
                        <td className="tabular px-4 py-1.5 text-right font-semibold text-ink-800">{r.cur == null ? '—' : r.cur.toLocaleString()}</td>
                        <td className="tabular px-4 py-1.5 text-right text-ink-500">{r.w == null ? '—' : r.w.toLocaleString()}</td>
                        <td className="tabular px-4 py-1.5 text-right">{pctCell(r.wPct)}</td>
                        <td className="tabular px-4 py-1.5 text-right text-ink-500">{r.m == null ? '—' : r.m.toLocaleString()}</td>
                        <td className="tabular px-4 py-1.5 text-right">{pctCell(r.mPct)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {/* ---- Cost Impact Estimation (gap L225): 30d delta x static monthly weight ---- */}
        {impactRows.length > 0 && (
          <Card
            title="월 비용 영향 추정"
            subtitle="30일 수량 변화 × 타입별 정적 단가 근사 — 실제 청구액이 아닙니다 (실측은 Cost 페이지)"
          >
            <ul className="flex flex-col gap-1.5">
              {impactRows.map((r) => (
                <li key={r.type} className="flex items-center justify-between gap-3 text-[13px]">
                  <span className="min-w-0 truncate text-ink-700">{INV_LABEL(r.type)}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="tabular text-[11.5px] text-ink-400">
                      {r.delta > 0 ? '+' : ''}{r.delta.toLocaleString()}
                    </span>
                    <span className={'tabular font-semibold ' + (r.monthly > 0 ? 'text-brand-700' : 'text-positive-text')}>
                      {r.monthly > 0 ? '+' : '-'}${Math.abs(r.monthly).toLocaleString()}/mo est.
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {/* ---- Charts row 1: distribution bar (full-width) ---- */}
        {sumErr ? (
          <div className="text-[13px] text-ink-400">
            {tt('리소스 분포 데이터를 불러오지 못했습니다:')} {sumErr}
          </div>
        ) : sum ? (
          <>
            <BarDistribution title="리소스 분포" data={barData} xKey="label" yKey="count" />

            {/* ---- Charts row 2: resource-distribution donuts (EC2 type · K8s pods) ---- */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {ec2Types.length > 0 ? (
                <DonutBreakdown title="EC2 인스턴스 유형" data={ec2Types} nameKey="name" valueKey="count" />
              ) : (
                <Card title="EC2 인스턴스 유형">
                  <div className="text-[13px] text-ink-400">{tt('EC2 데이터 없음')}</div>
                </Card>
              )}
              {podStatusDonut.length > 0 ? (
                <DonutBreakdown title="K8s 파드 상태" data={podStatusDonut} nameKey="name" valueKey="value" />
              ) : (
                <Card title="K8s 파드 상태">
                  <div className="text-[13px] text-ink-400">{tt(hasFleet ? '파드 없음' : 'EKS 데이터 없음')}</div>
                </Card>
              )}
            </div>

            {/* ---- Charts row 3: cost trend (wide) + recent K8s events ---- */}
            <div className="grid grid-cols-1 lg:grid-cols-[1.6fr_1fr] gap-6">
              {trend.length > 0 ? (
                <AreaTrend
                  title="일별 비용 추이"
                  data={trend}
                  xKey="date"
                  yKey="amount"
                  valuePrefix="$"
                />
              ) : (
                <Card title="일별 비용 추이">
                  <div className="text-[13px] text-ink-400">{tt('비용 데이터 없음')}</div>
                </Card>
              )}
              <Card title="최근 K8s 이벤트">
                {recentEvents.length > 0 ? (
                  <ul className="flex flex-col divide-y divide-ink-100">
                    {recentEvents.map((e, i) => (
                      <li key={i} className="py-2 first:pt-0 last:pb-0">
                        <div className="flex items-center gap-2">
                          <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                            {String(e.reason ?? 'Event')}
                          </span>
                          <span className="truncate font-mono text-[11px] text-ink-500">{String(e.object ?? '')}</span>
                          {Number(e.count) > 1 && <span className="text-[10px] text-ink-400">×{Number(e.count)}</span>}
                          <span className="ml-auto shrink-0 text-[10px] text-ink-300">{String(e.cluster ?? '')}</span>
                        </div>
                        <p className="mt-0.5 line-clamp-2 break-words text-[12px] text-ink-700">{String(e.message ?? '')}</p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="text-[13px] text-ink-400">{tt(hasFleet ? '최근 이벤트 없음' : 'EKS 데이터 없음')}</div>
                )}
              </Card>
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}
