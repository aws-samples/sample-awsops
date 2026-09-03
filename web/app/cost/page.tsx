'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, Filter, Calendar, DollarSign, TrendingUp, CalendarDays, Layers, BarChart3 } from 'lucide-react';
import { useResizablePanel, usePublishDockedWidth, RESIZE_GRIP_CLASS, RESIZE_GRIP_BAR_CLASS } from '@/lib/useResizablePanel';
import StatTile from '@/components/ui/StatTile';
import PageHeader from '@/components/ui/PageHeader';
import RefreshButton from '@/components/ui/RefreshButton';
import Card from '@/components/ui/Card';
import MetricTable, { type MetricCol } from '@/components/inventory/metrics/MetricTable';
import AreaTrend from '@/components/charts/AreaTrend';
import HBarList from '@/components/charts/HBarList';
import DonutBreakdown from '@/components/charts/DonutBreakdown';
import { useI18n } from '@/components/shell/LanguageProvider';
import { localeOf } from '@/lib/i18n';
import {
  momChangePctDaily, projectMonthEnd, trendPill,
  PERIOD_MONTHS, PERIOD_OPTIONS, allServiceNames, filterMonthlyTotals, filterDailyTotals,
  serviceChangeRows, mergeMonthlyByService, mergeDailyByService, looksLikeCeUnconfigured, serviceAlertChange,
  type MonthlyServiceCostPoint, type DailyServiceCostPoint,
} from '@/lib/cost';
import { useActiveAccount, accountParam, ALL_ACCOUNTS } from '@/lib/account-context';
import FinopsBaselineCard from '@/components/finops/FinopsBaselineCard';

interface TrendPoint { date: string; amount: number; [k: string]: unknown }
// Client model: only `forecast` is read directly off the API response — the monthly/daily TOTALS
// the page renders are always DERIVED from monthlyByService/dailyByService via lib/cost.ts's
// filter*Totals (so period + service filtering apply uniformly, incl. the "전체 계정" merge below).
// The API also returns flat `byService`/`trend`/`monthly` fields (older-client back-compat) —
// intentionally unused here.
interface Cost {
  currency: string; forecast?: number | null;
  monthlyByService: MonthlyServiceCostPoint[]; dailyByService: DailyServiceCostPoint[];
  cached?: boolean; cachedAt?: string; dailyDegraded?: boolean;
}
interface UsageType { usageType: string; amount: number; [k: string]: unknown }
interface ServiceDetail { service: string; currency: string; trend: TrendPoint[] | null; byUsageType: UsageType[] | null; monthly: { month: string; amount: number }[] | null }

const DASH = '—';
const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const DEFAULT_PERIOD = '3m'; // v1 default

const FANOUT = 6;
async function fetchCost(accountId: string, months: number): Promise<Cost> {
  const p = accountParam(accountId);
  const qs = new URLSearchParams({ months: String(months) });
  const r = await fetch(`/api/cost?${p ? `${p}&` : ''}${qs}`);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
/** Merge per-account Cost: sum forecast + the raw month×service / date×service matrices (every
 *  rendered total is derived from these via lib/cost.ts, so period + service filtering apply
 *  uniformly whether one account or "전체 계정" is selected). */
function mergeCost(parts: Cost[]): Cost {
  const monthlyByService = mergeMonthlyByService(parts.map((p) => p.monthlyByService ?? []));
  const dailyByService = mergeDailyByService(parts.map((p) => p.dailyByService ?? []));
  return {
    currency: parts[0]?.currency ?? 'USD',
    forecast: parts.some((p) => typeof p.forecast === 'number')
      ? parts.reduce((s, p) => s + (p.forecast ?? 0), 0) : null,
    monthlyByService, dailyByService,
    // ANY cached leg taints the merge — the onboarding banner must fail closed on stale data.
    cached: parts.some((p) => p.cached === true),
    // OLDEST cached timestamp — the honest staleness bound for a mixed merge.
    cachedAt: parts.map((p) => p.cachedAt).filter(Boolean).sort()[0],
    // ANY leg's degraded daily leg taints the merge — the alert verdict needs every account's
    // today-bucket to subtract honestly.
    dailyDegraded: parts.some((p) => p.dailyDegraded === true),
  };
}
async function loadAllAccountsCost(months: number): Promise<{ cost: Cost; failedLegs: number }> {
  const ar = await fetch('/api/accounts').catch(() => null);
  const body = ar?.ok ? await ar.json().catch(() => null) : null;
  // A 200 with {} / accounts:null is malformed discovery too — not "no accounts registered".
  const accountsValid = Array.isArray(body?.accounts);
  const accts: Array<{ accountId: string; isHost: boolean; enabled: boolean }> = accountsValid ? body.accounts : [];
  // A FAILED discovery (accounts API down/malformed) is not the same as "no accounts
  // registered": the self-only fallback still renders, but it counts as a failed leg so the
  // onboarding banner can never diagnose an accounts-API outage as "CE not enabled".
  const discoveryFailed = !accountsValid;
  const ids = accts.filter((a) => a.enabled).map((a) => (a.isHost ? 'self' : a.accountId));
  if (!ids.length) return { cost: await fetchCost('self', months), failedLegs: discoveryFailed ? 1 : 0 };
  const parts: Cost[] = [];
  // Failed legs are swallowed into empty stubs (one broken account must not blank the page) —
  // but the count is TRACKED: an all-empty merge caused by failures must never be diagnosed
  // as "Cost Explorer not enabled" (gap L197 review round 1).
  let failedLegs = 0;
  for (let i = 0; i < ids.length; i += FANOUT) {
    const chunk = await Promise.all(ids.slice(i, i + FANOUT).map((id) =>
      fetchCost(id, months).catch(() => {
        failedLegs += 1;
        return { currency: 'USD', forecast: null, monthlyByService: [], dailyByService: [] } as Cost;
      })));
    parts.push(...chunk);
  }
  return { cost: mergeCost(parts), failedLegs };
}

export default function CostPage() {
  const { tt, lang } = useI18n();
  const [d, setD] = useState<Cost | null>(null);
  const [failedLegs, setFailedLegs] = useState(0);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [capturedAt, setCapturedAt] = useState<string | null>(null);
  const [active] = useActiveAccount();
  const [avail, setAvail] = useState<{ available: boolean; reason: string; message?: string } | null>(null);
  const [rechecking, setRechecking] = useState(false);

  // v1-parity filter menu: period (트레일링 개월 수) + multi-select service filter. Empty selection
  // = no filter = all services (matches v1's Set-based semantics exactly).
  const [period, setPeriod] = useState(DEFAULT_PERIOD);
  const [selectedServices, setSelectedServices] = useState<Set<string>>(new Set());
  const [showServiceFilter, setShowServiceFilter] = useState(false);

  // Service drill-down panel: name selected (open) + lazily-fetched detail + its loading state.
  const [picked, setPicked] = useState<string | null>(null);
  const [detail, setDetail] = useState<ServiceDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);

  // Monotonic sequence — a slower detail response for service A must not land
  // under service B's panel title (P4 gate: codex; same class as the EKS guards).
  const detailSeqRef = useRef(0);
  // 차트가 들어가는 패널 — 기본 폭을 넉넉히(640), 좌측 엣지 드래그로 조절·영속.
  const { width: detailWidth, startResize: startDetailResize } = useResizablePanel('awsops_cost_detail_width', 640);
  // Coordinate the drill-down panel with the global chat so they don't overlap.
  usePublishDockedWidth(!!picked, detailWidth);

  const openDetail = useCallback(async (service: string) => {
    const seq = ++detailSeqRef.current;
    setPicked(service);
    setDetail(null);
    setDetailBusy(true);
    try {
      // Scope the drill-down to the selected account (v1 parity). '전체 계정' keeps host scope —
      // per-account fan-out+merge for the detail panel is not worth the 3× CE calls per click.
      const acct = active !== ALL_ACCOUNTS ? accountParam(active) : '';
      const r = await fetch(`/api/cost/detail?service=${encodeURIComponent(service)}${acct ? `&${acct}` : ''}`);
      if (seq !== detailSeqRef.current) return; // superseded by a newer click
      if (!r.ok) throw new Error(String(r.status));
      const body = await r.json();
      if (seq === detailSeqRef.current) setDetail(body);
    } catch {
      if (seq === detailSeqRef.current) setDetail(null);
    } finally {
      if (seq === detailSeqRef.current) setDetailBusy(false);
    }
  }, [active]);

  const closeDetail = useCallback(() => { setPicked(null); setDetail(null); }, []);

  useEffect(() => {
    if (!picked) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeDetail(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [picked, closeDetail]);

  const load = useCallback(async () => {
    setBusy(true);
    probeSeqRef.current += 1;
    setEmptyProbe(null);
    const months = PERIOD_MONTHS[period] ?? 6;
    try {
      if (active === ALL_ACCOUNTS) {
        const { cost, failedLegs: legs } = await loadAllAccountsCost(months);
        setD(cost);
        setFailedLegs(legs);
      } else {
        setD(await fetchCost(active, months));
        setFailedLegs(0);
      }
      setErr('');
      setCapturedAt(new Date().toISOString());
    } catch (e) {
      setErr(String(e));
      // v1 cost-check parity: classify WHY CE is unavailable (권한/미활성/오류) for the notice.
      fetch('/api/cost/availability').then((r) => (r.ok ? r.json() : null)).then((a) => a && setAvail(a)).catch(() => {});
    } finally {
      setBusy(false);
    }
  }, [active, period]);

  const recheck = useCallback(async () => {
    setRechecking(true);
    try {
      const r = await fetch('/api/cost/availability?force=1');
      const a = r.ok ? await r.json() : null;
      if (a) setAvail(a);
      if (a?.available) { setErr(''); await load(); }
    } finally { setRechecking(false); }
  }, [load]);

  useEffect(() => { load(); }, [load]);

  // A period/account switch can leave a selected service that no longer exists in the new window —
  // silently drop it rather than filtering everything down to zero with a stale, invisible selection.
  const allServices = useMemo(() => allServiceNames(d?.monthlyByService ?? []), [d]);
  useEffect(() => {
    setSelectedServices((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set([...prev].filter((s) => allServices.includes(s)));
      return next.size === prev.size ? prev : next;
    });
  }, [allServices]);

  const toggleService = (svc: string) => {
    setSelectedServices((prev) => {
      const next = new Set(prev);
      if (next.has(svc)) next.delete(svc); else next.add(svc);
      return next;
    });
  };

  // ---- Filtered views (period scoped server-side via `months`; service filter applied here) ----
  const monthlyByService = d?.monthlyByService ?? [];
  const dailyByService = d?.dailyByService ?? [];
  const monthly = useMemo(() => filterMonthlyTotals(monthlyByService, selectedServices), [monthlyByService, selectedServices]);
  const trend = useMemo(() => filterDailyTotals(dailyByService, selectedServices), [dailyByService, selectedServices]);
  const changeRows = useMemo(() => serviceChangeRows(monthlyByService, selectedServices), [monthlyByService, selectedServices]);

  const total = changeRows.reduce((s, r) => s + r.current, 0);
  const top = changeRows[0];
  const currency = d?.currency ?? 'USD';

  // Donut: top 6 filtered services + "기타" rollup of the remainder.
  const donutData = (() => {
    if (changeRows.length <= 6) return changeRows.map((s) => ({ service: s.service, amount: s.current }));
    const head = changeRows.slice(0, 6).map((s) => ({ service: s.service, amount: s.current }));
    const rest = changeRows.slice(6).reduce((acc, s) => acc + s.current, 0);
    return rest > 0 ? [...head, { service: tt('기타'), amount: rest }] : head;
  })();
  const hbarData = changeRows.map((s) => ({ service: s.service, amount: s.current }));

  // Day-normalized change (the same momChangePctDaily primitive the MoM tile uses): the raw
  // partial-MTD-vs-full-month ratio reads ≈-50% mid-month for an unchanged run-rate — turning
  // that skew into a red/green verdict and an alert count would invert for most of the month.
  // Declared BEFORE costRows — .map() executes during render (const is not hoisted).
  const now = new Date();
  // Completed-days basis on BOTH sides (rounds 8–11): today's partial/lagging per-service
  // amount is subtracted from the numerator (dailyByService is already on the client), and
  // the divisor counts completed UTC days. serviceAlertChange returns null — no verdict —
  // on UTC day 1, on a DEGRADED daily leg (today's bucket unsubtractable → the math would
  // silently revert to the biased basis), and on cross-call clamp skew.
  const todayIso = now.toISOString().slice(0, 10);
  // cached snapshot → NO verdict either: a snapshot from a previous day has no live-todayIso
  // bucket to subtract, and at month rollover its full-month total divided by 1-2 completed
  // days would paint every row red (~10-30x run-rate). Same fail-closed rule as the banner.
  const dailyLegDegraded = d?.dailyDegraded === true || d?.cached === true || dailyByService.length === 0;
  const todayBucket = dailyByService.find((p) => p.date === todayIso);
  const todayByService = new Map((todayBucket?.byService ?? []).map((b) => [b.service, b.amount]));
  const alertChange = (r: { current: number; previous: number; service: string }) =>
    serviceAlertChange({
      current: r.current, previous: r.previous,
      todayAmount: dailyLegDegraded ? null : (todayByService.get(r.service) ?? 0),
      now,
    });
  // Gap L198: raw numbers feed MetricTable (real numeric sort + threshold-colored cells),
  // not pre-formatted strings.
  type CostRow = { service: string; current: number; previous: number; change: number | null; share: number };
  const costRows: CostRow[] = changeRows.map((s) => ({
    service: s.service, current: s.current, previous: s.previous,
    change: alertChange(s), // null = no honest verdict (baseline/day-1/degraded/clamped)
    share: s.share,
  }));
  const changeTone = (c: number) =>
    c > 20 ? 'text-rose-600 font-semibold' : c > 0 ? 'text-amber-600' : c < 0 ? 'text-emerald-600' : 'text-ink-500';
  const costCols: MetricCol<CostRow>[] = [
    { key: 'service', label: '서비스', value: (r) => r.service },
    { key: 'current', label: `이번 달 (${currency})`, type: 'num', value: (r) => r.current, render: (r) => usd(r.current) },
    { key: 'previous', label: '전월', type: 'num', value: (r) => r.previous, render: (r) => usd(r.previous) },
    {
      // null = no baseline (previous 0) — MetricTable's missing contract sorts these LAST
      // instead of interleaving them with genuinely-flat services.
      key: 'change', label: '변화율 (일평균)', type: 'num',
      title: tt('전월 일평균 대비 이번 달 완결일(UTC) 일평균 — 오늘의 부분 집계 제외. 기준월 없음/매월 1일(UTC)/일별 데이터 저하 시 판정을 표시하지 않습니다'),
      value: (r) => r.change,
      render: (r) => (
        <span className={r.change == null ? 'text-ink-500' : changeTone(r.change)}>
          {r.change == null ? '—' : `${r.change > 0 ? '+' : ''}${r.change.toFixed(1)}%`}
        </span>
      ),
      danger: (r) => r.change != null && r.change > 20,
    },
    {
      key: 'share', label: '점유율', type: 'num', value: (r) => r.share,
      render: (r) => (
        <span className="flex items-center gap-2">
          <span className="h-1.5 w-16 overflow-hidden rounded-full bg-ink-100">
            <span className="block h-full bg-brand-400" style={{ width: `${Math.min(100, r.share)}%` }} />
          </span>
          <span className="tabular text-[12px]">{r.share.toFixed(1)}%</span>
        </span>
      ),
    },
  ];

  // MoM (from the FILTERED monthly series) + month-end forecast. AWS's CE forecast is inherently
  // account/service-unscoped (whole-account), so it only applies when NO service filter is active —
  // with a filter on, fall back to the linear projection of the filtered total (honest > precise-looking).
  const thisMonth = monthly.length > 0 ? monthly[monthly.length - 1].total : total;
  const lastMonth = monthly.length > 1 ? monthly[monthly.length - 2].total : 0;
  const mom = momChangePctDaily(thisMonth, lastMonth, new Date());
  // Gap L196: Daily Average over the FILTERED trailing-30d series; surge count for the
  // Services subtext (previous>0 keeps new services out — serviceChangeRows pins their
  // change to 0, so >20 alone is already safe, but the guard states the intent).
  // Exclude today's still-accumulating CE bucket from the mean (the same partial-day caveat
  // momChangePctDaily documents); fall back to the full series when it is all we have.
  const completedDays = trend.filter((t) => t.date !== todayIso);
  // No completed day yet (only today's partial bucket) → '—', never an average of exactly
  // the bucket the exclusion was written for.
  const dailyAvg = completedDays.length > 0 ? completedDays.reduce((a, t) => a + t.amount, 0) / completedDays.length : null;
  const surging = changeRows.filter((r) => (alertChange(r) ?? 0) > 20).length;
  // Gap L197: load SUCCEEDED but every DERIVED value is empty → a NEUTRAL empty-data banner
  // that never asserts a cause on its own (a narrow window can be all-empty for an enabled
  // CE, and a genuinely disabled CE takes the error path with its classified notice). The
  // banner offers the existing force-probe; the not_enabled onboarding sentence renders only
  // after a probe result AND only in host scope — /api/cost/availability probes with the
  // host task role, so its verdict must never be presented as a member account's.
  const ceLooksEmpty = looksLikeCeUnconfigured({
    busy, err, loaded: d != null, cached: d?.cached === true, filtered: selectedServices.size > 0, failedLegs,
    total, changeRowCount: changeRows.length, trend, monthlyByService,
  });
  // The onboarding hint must come from a FRESH, user-initiated probe (the global `avail` is
  // set on old error paths / rechecks and never invalidated on account/period switches). This
  // local result is set only by the banner's own button and cleared on every load.
  const [emptyProbe, setEmptyProbe] = useState<{ reason: string } | null>(null);
  const probeSeqRef = useRef(0);
  const probeFromBanner = useCallback(async () => {
    const seq = ++probeSeqRef.current;
    setRechecking(true);
    try {
      // No force=1: the 1h-cached verdict is adequate for an onboarding hint, and the banner
      // button must not be an unthrottled billable CE entry point.
      const r = await fetch('/api/cost/availability');
      const a = r.ok ? await r.json().catch(() => null) : null;
      // A stale in-flight probe must not land after an account/period switch cleared it.
      if (seq !== probeSeqRef.current) return;
      setEmptyProbe({ reason: String(a?.reason ?? 'error') }); // non-OK → explicit 'error', never a dead button
    } catch {
      // transport-level rejection (offline/abort) — same explicit feedback, never a dead button
      if (seq === probeSeqRef.current) setEmptyProbe({ reason: 'error' });
    } finally { setRechecking(false); } // unconditional — a bumped seq guards the RESULT, not the busy flag (a skipped clear strands both recheck buttons)
  }, []);
  // Both hints are HOST-scope only — the availability classifier probes with the host task
  // role and must never speak for a member account (either direction).
  const showNotEnabledHint = active === 'self' && emptyProbe?.reason === 'not_enabled';
  const showAvailableHint = active === 'self' && emptyProbe?.reason === 'ok';
  const useAwsForecast = selectedServices.size === 0 && d?.forecast != null;
  const monthEndEstimate = useAwsForecast ? total + (d!.forecast as number) : projectMonthEnd(total, new Date());

  return (
    <>
      <PageHeader
        title="Cost Explorer"
        subtitle="Cost Explorer 기반 누적 비용 · 기간/서비스 필터 · 서비스별 분포"
        right={<RefreshButton busy={busy} onClick={load} capturedAt={capturedAt} />}
      />
      <div className="px-4 lg:px-8 py-8 flex flex-col gap-6">
        {err && (
          <div className="rounded-lg border border-rose-200 bg-negative-surface px-4 py-3">
            <p className="text-[13px] font-semibold text-negative-text">{tt('비용 데이터를 불러올 수 없습니다')}</p>
            <p className="mt-1 text-[12px] text-ink-600">
              {avail?.reason === 'access_denied' && tt('Cost Explorer 접근 권한이 없습니다 (ce:GetCostAndUsage) — MSP/멤버 계정에서 흔한 구성입니다.')}
              {avail?.reason === 'not_enabled' && tt('Cost Explorer가 아직 활성화되지 않았습니다 (콘솔에서 최초 활성화 후 최대 24시간 소요).')}
              {(!avail || avail.reason === 'error' || avail.reason === 'ok') && tt(`일시적 오류일 수 있습니다: ${err}`)}
            </p>
            <div className="mt-2 flex items-center gap-3 text-[12px]">
              <button onClick={recheck} disabled={rechecking} className="rounded-md border border-ink-200 bg-card px-2.5 py-1 font-medium text-ink-700 hover:bg-ink-50 disabled:opacity-50">
                {tt(rechecking ? '확인 중…' : '가용성 재확인')}
              </button>
              <a href="/inventory/ec2" className="text-brand-600 hover:underline">{tt('리소스 인벤토리로 이동 →')}</a>
            </div>
          </div>
        )}
        {d?.cached && (
          <div className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-[12px] text-amber-700">
            <span>{tt(`캐시된 데이터 표시 중 — Cost Explorer 호출 실패로 마지막 성공 응답(${d.cachedAt ? new Date(d.cachedAt).toLocaleString(localeOf(lang)) : ''})을 보여줍니다.`)}</span>
            <button onClick={load} className="rounded-md border border-amber-300 bg-card px-2 py-0.5 font-medium hover:bg-amber-100">{tt('라이브 재시도')}</button>
          </div>
        )}
        <FinopsBaselineCard />

        {!d && !err && <div className="text-ink-400">{tt('로딩 중…')}</div>}

        {d && (
          <>
            {/* ---- Period + Service filter (v1 parity) ---- */}
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-1">
                <Calendar size={14} className="text-ink-400" />
                {PERIOD_OPTIONS.map((p) => (
                  <button
                    key={p.value}
                    onClick={() => setPeriod(p.value)}
                    className={
                      'rounded-md px-3 py-1.5 text-[12px] font-mono transition-colors ' +
                      (period === p.value
                        ? 'border border-brand-200 bg-brand-50 text-brand-700'
                        : 'border border-ink-100 bg-card text-ink-500 hover:text-ink-800')
                    }
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setShowServiceFilter((v) => !v)}
                className={
                  'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] transition-colors ' +
                  (showServiceFilter || selectedServices.size > 0
                    ? 'border border-brand-200 bg-brand-50 text-brand-700'
                    : 'border border-ink-100 bg-card text-ink-500 hover:text-ink-800')
                }
              >
                <Filter size={12} />
                {tt('서비스 필터')}
                {selectedServices.size > 0 && (
                  <span className="rounded-full bg-brand-100 px-1.5 py-0.5 text-[10px] font-semibold text-brand-700">{selectedServices.size}</span>
                )}
              </button>
              {selectedServices.size > 0 && (
                <button onClick={() => setSelectedServices(new Set())} className="text-[12px] text-ink-400 hover:text-ink-800">
                  {tt('초기화')}
                </button>
              )}
            </div>

            {showServiceFilter && (
              <div className="rounded-lg border border-ink-100 bg-card p-4">
                <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-400">{tt(`서비스로 필터링 (${allServices.length})`)}</p>
                {allServices.length === 0 ? (
                  <div className="text-[12px] text-ink-400">{tt('선택된 기간에 서비스 데이터가 없습니다.')}</div>
                ) : (
                  <div className="flex max-h-48 flex-wrap gap-2 overflow-y-auto">
                    {allServices.map((svc) => (
                      <button
                        key={svc}
                        onClick={() => toggleService(svc)}
                        className={
                          'rounded px-2.5 py-1 text-[11px] font-mono transition-colors ' +
                          (selectedServices.has(svc)
                            ? 'border border-brand-200 bg-brand-50 text-brand-700'
                            : 'border border-ink-100 bg-paper-muted text-ink-500 hover:text-ink-800')
                        }
                      >
                        {svc}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {failedLegs > 0 && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-700">
                {tt(`일부 계정 조회 실패 (${failedLegs}건) — 아래 합계는 불완전합니다.`)}
              </div>
            )}
            {ceLooksEmpty && (
              <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2.5 text-[12.5px] text-sky-800">
                <span>{tt('선택한 기간에 비용 데이터가 없습니다.')}</span>
                {showNotEnabledHint && (
                  <span className="ml-1">{tt('Cost Explorer가 아직 활성화되지 않았습니다 — AWS Billing 콘솔에서 활성화하세요 (표시까지 최대 24시간).')}</span>
                )}
                {showAvailableHint && (
                  <span className="ml-1">{tt('가용성 확인 결과: Cost Explorer는 사용 가능합니다 — 선택한 기간에 비용이 없었을 가능성이 큽니다.')}</span>
                )}
                {emptyProbe != null && !showNotEnabledHint && !showAvailableHint && (
                  <span className="ml-1">{tt('가용성을 확정하지 못했습니다 — 상세 원인은 새로고침 시 오류 배너를 참고하세요.')}</span>
                )}
                {active === 'self' && (
                  <button onClick={probeFromBanner} disabled={rechecking} className="ml-2 rounded-md border border-sky-300 bg-card px-2 py-0.5 text-[11.5px] font-medium text-sky-700 hover:bg-sky-100 disabled:opacity-50">
                    {tt(rechecking ? '확인 중…' : '가용성 확인')}
                  </button>
                )}
              </div>
            )}
            {/* ---- KPI tiles (gap L196: Daily Average + Last Month + surge subtext) ---- */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatTile
                label={`이번 달 누적 (${currency})`}
                value={usd(total)}
                variant="accent"
                icon={<DollarSign size={16} />}
              />
              <StatTile
                label="전월 대비 (MoM · 일평균)"
                value={lastMonth > 0 ? `${mom >= 0 ? '+' : ''}${mom.toFixed(1)}%` : DASH}
                trend={lastMonth > 0 ? trendPill(mom) : undefined}
                icon={<TrendingUp size={16} />}
                hint={lastMonth > 0 ? `일평균 기준 · 전월 ${usd(lastMonth)}` : '기준월 부족'}
              />
              <StatTile
                label="예상 월말 비용"
                value={usd(monthEndEstimate)}
                hint={useAwsForecast ? 'AWS 예측' : selectedServices.size > 0 ? '선형 추정 · 서비스 필터 적용 중' : '선형 추정'}
                variant="warn"
                icon={<CalendarDays size={16} />}
              />
              <StatTile
                label={tt(`일평균 (${currency})`)}
                value={dailyAvg == null ? DASH : usd(dailyAvg)}
                hint={dailyAvg == null ? undefined : tt('최근 30일 중 완결일 평균 · 필터 적용')}
                icon={<CalendarDays size={16} />}
              />
              <StatTile
                label={tt(`전월 총액 (${currency})`)}
                value={monthly.length > 1 ? usd(lastMonth) : DASH}
                icon={<DollarSign size={16} />}
              />
              <StatTile
                label="서비스 수"
                value={changeRows.length}
                trend={surging > 0 ? tt(`${surging}개 >20% 증가`) : undefined}
                variant={surging > 0 ? 'warn' : 'default'}
                icon={<Layers size={16} />}
              />
              <StatTile
                label="최대 서비스"
                value={top ? usd(top.current) : DASH}
                hint={top ? top.service : undefined}
                variant="warn"
                icon={<BarChart3 size={16} />}
              />
            </div>

            {/* ---- Monthly trend area (MoM context) ---- */}
            {monthly.length > 1 && (
              <AreaTrend title="월별 비용 추이" data={monthly} xKey="month" yKey="total" valuePrefix="$" />
            )}

            {/* ---- Daily trend area (full-width, trailing 30 days) ---- */}
            {trend.length > 0 ? (
              <AreaTrend title="일별 비용 추이 (최근 30일)" data={trend} xKey="date" yKey="amount" valuePrefix="$" />
            ) : (
              <Card title="일별 비용 추이 (최근 30일)">
                <div className="text-[13px] text-ink-400">{tt('비용 추이 데이터 없음')}</div>
              </Card>
            )}

            {/* ---- Row: service HBar (wide) + composition donut ---- */}
            {changeRows.length > 0 ? (
              <div className="grid grid-cols-1 lg:grid-cols-[1.5fr_1fr] gap-6">
                <HBarList
                  title="서비스별 비용"
                  data={hbarData}
                  labelKey="service"
                  valueKey="amount"
                  valuePrefix="$"
                />
                <DonutBreakdown
                  title="비용 구성"
                  data={donutData}
                  nameKey="service"
                  valueKey="amount"
                  valuePrefix="$"
                />
              </div>
            ) : null}

            {/* ---- Detail table: service / 이번 달 / 전월 / 변화율 / 점유율 ---- */}
            <section className="flex flex-col gap-3">
              <h2 className="text-[13px] font-semibold text-ink-800">{tt('서비스 상세')}</h2>
              {/* Gap L198: MetricTable — numeric sort + threshold-colored Change + Share mini bar */}
              <MetricTable
                columns={costCols}
                items={costRows}
                rowKey={(r) => r.service}
                defaultSortKey="current"
                onRowClick={(r) => openDetail(r.service)}
              />
              <p className="text-[12px] text-ink-400">{tt('행을 클릭하면 서비스별 일별 추이·사용 유형 분해를 볼 수 있습니다.')}</p>
            </section>
          </>
        )}
      </div>

      {/* ---- Service drill-down panel (lazy: daily trend + usage-type rollup) ---- */}
      {picked && (
        <>
          <div aria-hidden onClick={closeDetail} className="fixed inset-0 z-40 bg-ink-900/20" />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label={tt(`${picked} 비용 상세`)}
            className="fixed right-0 top-0 z-50 flex h-full max-w-full flex-col border-l border-ink-100 bg-card shadow-pop"
            style={{ width: detailWidth }}
          >
            <div onMouseDown={startDetailResize} title={tt('드래그하여 폭 조절')} aria-label={tt('패널 폭 조절')} role="separator" className={RESIZE_GRIP_CLASS}>
              <div className={RESIZE_GRIP_BAR_CLASS} />
            </div>
            <header className="flex items-start justify-between gap-2 border-b border-ink-100 px-4 py-3">
              <h2 className="min-w-0 break-words text-[13px] font-semibold text-ink-800">{picked}</h2>
              <button
                type="button"
                onClick={closeDetail}
                aria-label={tt('닫기')}
                className="-mr-1 shrink-0 rounded p-1 text-ink-400 hover:bg-ink-50 hover:text-ink-700"
              >
                <X size={16} />
              </button>
            </header>
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
              {detailBusy && <div className="text-[13px] text-ink-400">{tt('로딩 중…')}</div>}
              {!detailBusy && (
                <>
                  {detail?.trend == null ? (
                    <Card title="일별 비용 추이 (30일)">
                      <div className="text-[13px] text-ink-400">{tt('추이 호출 실패 — 잠시 후 재시도')}</div>
                    </Card>
                  ) : detail.trend.length > 0 ? (
                    <AreaTrend title="일별 비용 추이 (30일)" data={detail.trend} xKey="date" yKey="amount" valuePrefix="$" />
                  ) : (
                    <Card title="일별 비용 추이 (30일)">
                      <div className="text-[13px] text-ink-400">{tt('데이터 없음')}</div>
                    </Card>
                  )}

                  {detail?.monthly == null ? (
                    <Card title="월별 비용 추이 (6개월)">
                      <div className="text-[13px] text-ink-400">{tt('월별 호출 실패 — 잠시 후 재시도')}</div>
                    </Card>
                  ) : detail.monthly.length > 0 ? (
                    <>
                      <AreaTrend title="월별 비용 추이 (6개월)" data={detail.monthly} xKey="month" yKey="amount" valuePrefix="$" />
                      {/* v1 parity: Cost Summary — this vs last month + change */}
                      {detail.monthly.length >= 2 && (() => {
                        const cur = detail.monthly[detail.monthly.length - 1].amount;
                        const prev = detail.monthly[detail.monthly.length - 2].amount;
                        const pct = prev > 0 ? ((cur - prev) / prev) * 100 : null;
                        return (
                          <Card title="Cost Summary">
                            <dl className="grid grid-cols-3 gap-3">
                              <div><dt className="text-[11px] uppercase text-ink-400">{tt('이번 달')}</dt>
                                <dd className="tabular mt-0.5 text-[16px] font-semibold text-ink-800">{usd(cur)}</dd></div>
                              <div><dt className="text-[11px] uppercase text-ink-400">{tt('지난 달')}</dt>
                                <dd className="tabular mt-0.5 text-[16px] text-ink-700">{usd(prev)}</dd></div>
                              <div><dt className="text-[11px] uppercase text-ink-400">{tt('변화')}</dt>
                                <dd className={`tabular mt-0.5 text-[16px] font-semibold ${pct != null && pct > 0 ? 'text-brand-700' : 'text-positive-text'}`}>
                                  {pct == null ? DASH : `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`}
                                </dd></div>
                            </dl>
                            <ul className="mt-3 flex flex-col gap-1 border-t border-ink-100 pt-2">
                              {[...detail.monthly].reverse().map((mo) => (
                                <li key={mo.month} className="flex items-center justify-between text-[12px]">
                                  <span className="text-ink-500">{mo.month}</span>
                                  <span className="tabular text-ink-700">{usd(mo.amount)}</span>
                                </li>
                              ))}
                            </ul>
                          </Card>
                        );
                      })()}
                    </>
                  ) : null}

                  {detail?.byUsageType == null ? (
                    <Card title="사용 유형별 비용 (최근 3개월)">
                      <div className="text-[13px] text-ink-400">{tt('사용 유형 호출 실패 — 잠시 후 재시도')}</div>
                    </Card>
                  ) : detail.byUsageType.length > 0 ? (
                    <HBarList
                      title="사용 유형별 비용 (최근 3개월)"
                      data={detail.byUsageType}
                      labelKey="usageType"
                      valueKey="amount"
                      valuePrefix="$"
                    />
                  ) : (
                    <Card title="사용 유형별 비용 (최근 3개월)">
                      <div className="text-[13px] text-ink-400">{tt('데이터 없음')}</div>
                    </Card>
                  )}
                </>
              )}
            </div>
          </aside>
        </>
      )}
    </>
  );
}
