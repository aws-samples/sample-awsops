// Pure cost math — no SDK, deterministic (inject `now`). Ported from v1 src/app/cost/page.tsx.

/** Month-over-month change %, signed. Returns 0 when last month is 0/missing (no baseline). */
export function momChangePct(thisMonth: number, lastMonth: number): number {
  if (!lastMonth || lastMonth <= 0) return 0;
  return ((thisMonth - lastMonth) / lastMonth) * 100;
}

/** Days in the month `monthOffset` away from `now` (0 = current, -1 = previous). `now` local. */
export function daysInMonth(now: Date, monthOffset = 0): number {
  return new Date(now.getFullYear(), now.getMonth() + monthOffset + 1, 0).getDate();
}

/**
 * Month-over-month change on a PER-DAY (run-rate) basis, signed.
 * Compares this month's average daily spend (MTD ÷ days elapsed) against last month's average
 * daily spend (full total ÷ days in that month). This fixes the bug where a PARTIAL current month
 * (month-to-date) was compared against a FULL previous month, producing a bogus large drop
 * (e.g. on the 17th, ~17/31 of the month read as ≈-45%). At equal daily run-rates this returns ~0.
 * `now` injected for determinism. Returns 0 when there is no baseline.
 * NB: the current day is still accumulating in AWS Cost Explorer, so the latest day's spend is
 * partial — a small downward bias in this-month's daily average (far smaller than the partial-vs-full
 * bug this replaces). A same-day-range MTD comparison would remove it but needs a prev-month query.
 */
export function momChangePctDaily(thisMtd: number, lastMonthTotal: number, now: Date): number {
  const elapsed = now.getDate();          // days elapsed in the current month (MTD)
  const lastDays = daysInMonth(now, -1);  // full days in the previous calendar month
  if (elapsed <= 0 || lastDays <= 0) return 0;
  return momChangePct(thisMtd / elapsed, lastMonthTotal / lastDays);
}

/** UTC variant of momChangePctDaily for the ALERT surface (red cells / surge count): CE
 *  buckets are UTC calendar months, so a local-time day count inverts the verdict in the
 *  ~9h window after a UTC month rollover (KST) and skews elapsed by one day daily. The MoM
 *  tile keeps the original local-time behavior (pre-existing, non-alerting). */
/** CONTRACT: `thisMtdCompleted` must be the MTD with TODAY'S (UTC) partial bucket already
 *  subtracted by the caller (the cost page derives it from dailyByService — no extra CE
 *  call). Both sides then cover completed UTC days only: numerator = completed-day spend,
 *  divisor = completed days. Any mixed window systematically biases the thresholded verdict
 *  (rounds 8–10: +100% on day 2 with a completed divisor and an including numerator; −33%
 *  on day 3 the other way). Callers suppress the verdict entirely on UTC day 1 (zero
 *  completed days). */
export function momChangePctDailyUtc(thisMtdCompleted: number, lastMonthTotal: number, now: Date): number {
  const elapsed = Math.max(1, now.getUTCDate() - 1);
  const lastDays = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).getUTCDate();
  if (lastDays <= 0) return 0;
  return momChangePct(thisMtdCompleted / elapsed, lastMonthTotal / lastDays);
}

/** Linear projection of month-end spend from month-to-date. `now` injected for determinism. */
export function projectMonthEnd(mtd: number, now: Date): number {
  const dayOfMonth = now.getDate();
  if (dayOfMonth <= 0) return 0;
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return (mtd / dayOfMonth) * daysInMonth;
}

/** Format a signed percentage as an arrow trend pill, e.g. 4.2 → "↑4.2%", -2.3 → "↓2.3%". */
export function trendPill(pct: number): string {
  const a = Math.abs(pct).toFixed(1);
  if (pct > 0) return `↑${a}%`;
  if (pct < 0) return `↓${a}%`;
  return `0.0%`;
}

// ---------------------------------------------------------------------------
// v1-parity cost filter menu (period + service) — pure aggregation over the
// month×service / date×service matrices from lib/aws.ts getMonthlyCostByService
// / getDailyCostByService. v1 filtered raw SQL rows by period cutoff + a
// selected-services Set; these do the CE-backed equivalent client-side so the
// same matrix serves every derived view (KPIs, trend charts, donut/hbar, table).
// ---------------------------------------------------------------------------

export interface ServiceAmount { service: string; amount: number }
export interface MonthlyServiceCostPoint { month: string; byService: ServiceAmount[] }
export interface DailyServiceCostPoint { date: string; byService: ServiceAmount[] }

/** Period filter keys → trailing calendar months to fetch/show (v1's PERIODS, '1m' default→'3m' page default). */
export const PERIOD_MONTHS: Record<string, number> = { '1m': 1, '3m': 3, '6m': 6, '12m': 12 };
export const PERIOD_OPTIONS: { value: string; label: string }[] = [
  { value: '1m', label: '1개월' },
  { value: '3m', label: '3개월' },
  { value: '6m', label: '6개월' },
  { value: '12m', label: '1년' },
];

/** All distinct service names across a month×service or date×service matrix, sorted — the
 *  service-filter panel's option list (unfiltered, so filtering never shrinks its own options). */
export function allServiceNames(matrix: { byService: ServiceAmount[] }[]): string[] {
  const set = new Set<string>();
  for (const row of matrix) for (const s of row.byService) set.add(s.service);
  return [...set].sort();
}

/** Sum one row's byService, applying the service filter (empty set = no filter = all services). */
export function filterServiceTotal(byService: ServiceAmount[], selected: ReadonlySet<string>): number {
  return byService.reduce((sum, s) => sum + (selected.size === 0 || selected.has(s.service) ? s.amount : 0), 0);
}

export function filterMonthlyTotals(matrix: MonthlyServiceCostPoint[], selected: ReadonlySet<string>): { month: string; total: number }[] {
  return matrix.map((m) => ({ month: m.month, total: filterServiceTotal(m.byService, selected) }));
}

export function filterDailyTotals(matrix: DailyServiceCostPoint[], selected: ReadonlySet<string>): { date: string; amount: number }[] {
  return matrix.map((d) => ({ date: d.date, amount: filterServiceTotal(d.byService, selected) }));
}

export interface ServiceChangeRow { service: string; current: number; previous: number; change: number; share: number }

/**
 * Per-service current-vs-previous-month breakdown (v1's serviceTableRows), filtered, sorted desc
 * by current. `current`/`previous` = the LAST two months of `matrix` (the selected period's tail —
 * matches v1 reading currentMonth/previousMonth off the filtered-period row set). `share` is each
 * service's % of the FILTERED current-month total (not the grand total), so it always sums to ~100%.
 */
export function serviceChangeRows(matrix: MonthlyServiceCostPoint[], selected: ReadonlySet<string>): ServiceChangeRow[] {
  const cur = matrix[matrix.length - 1]?.byService ?? [];
  const prevMap = new Map((matrix[matrix.length - 2]?.byService ?? []).map((s) => [s.service, s.amount]));
  const rows = cur
    .filter((s) => selected.size === 0 || selected.has(s.service))
    .map((s) => {
      const previous = prevMap.get(s.service) ?? 0;
      const change = previous > 0 ? ((s.amount - previous) / previous) * 100 : 0;
      return { service: s.service, current: s.amount, previous, change, share: 0 };
    });
  const total = rows.reduce((sum, r) => sum + r.current, 0);
  return rows
    .map((r) => ({ ...r, share: total > 0 ? (r.current / total) * 100 : 0 }))
    .sort((a, b) => b.current - a.current);
}

/** Merge per-account month×service matrices (sum matching month+service) — the "전체 계정" fan-out leg. */
export function mergeMonthlyByService(parts: MonthlyServiceCostPoint[][]): MonthlyServiceCostPoint[] {
  const byMonth = new Map<string, Map<string, number>>();
  for (const part of parts) {
    for (const row of part) {
      const svc = byMonth.get(row.month) ?? new Map<string, number>();
      for (const s of row.byService) svc.set(s.service, (svc.get(s.service) ?? 0) + s.amount);
      byMonth.set(row.month, svc);
    }
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([month, svc]) => ({
      month,
      byService: [...svc.entries()].map(([service, amount]) => ({ service, amount })).sort((a, b) => b.amount - a.amount),
    }));
}

/** Merge per-account date×service matrices (sum matching date+service) — the "전체 계정" fan-out leg. */
export function mergeDailyByService(parts: DailyServiceCostPoint[][]): DailyServiceCostPoint[] {
  const byDate = new Map<string, Map<string, number>>();
  for (const part of parts) {
    for (const row of part) {
      const svc = byDate.get(row.date) ?? new Map<string, number>();
      for (const s of row.byService) svc.set(s.service, (svc.get(s.service) ?? 0) + s.amount);
      byDate.set(row.date, svc);
    }
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, svc]) => ({
      date,
      byService: [...svc.entries()].map(([service, amount]) => ({ service, amount })).sort((a, b) => b.amount - a.amount),
    }));
}


/** Gap L197: "Cost Explorer probably isn't enabled" ONLY when the load succeeded LIVE (not a
 *  cached fallback), nothing is filtered, no fan-out leg failed, the daily leg actually
 *  returned buckets (a swallowed daily-leg failure yields [], and [].every() is vacuously
 *  true), and there is no spend ANYWHERE — including the earlier monthly buckets, so an
 *  account whose spend stopped >30 days ago never reads an onboarding banner above a chart
 *  showing real historical bars. A successful zero-spend CE response still returns ~30 zero
 *  daily buckets and one (empty-byService) bucket per month, so the intended case still
 *  fires; a genuinely-disabled CE throws and takes the error path instead. */
export function looksLikeCeUnconfigured(p: {
  busy: boolean; err: string; loaded: boolean; cached: boolean; filtered: boolean; failedLegs: number;
  total: number; changeRowCount: number; trend: { amount: number }[];
  monthlyByService: MonthlyServiceCostPoint[];
}): boolean {
  if (p.busy || p.err !== '' || !p.loaded || p.cached || p.filtered || p.failedLegs > 0) return false;
  if (p.trend.length === 0) return false; // daily leg failed/empty — not evidence of anything
  if (p.monthlyByService.length === 0) return false; // same vacuous-every() hole on the monthly axis
  const noHistoricalSpend = p.monthlyByService.every((m) => m.byService.length === 0);
  return p.total === 0 && p.changeRowCount === 0 && noHistoricalSpend && p.trend.every((t) => t.amount === 0);
}


/** The composed per-service ALERT change (table color / danger / surge count). Returns null
 *  ("no verdict") whenever an honest verdict is impossible: no baseline, UTC day 1 (zero
 *  completed days), a degraded/absent daily leg (today's bucket can't be subtracted — the
 *  math would silently revert to the biased includes-today basis), or a clamped numerator
 *  (today's bucket exceeding the monthly MTD — cross-call skew, not a real -100%). */
export function serviceAlertChange(p: {
  current: number; previous: number; todayAmount: number | null; // null = daily leg degraded
  now: Date;
}): number | null {
  if (p.previous <= 0) return null;
  if (p.now.getUTCDate() <= 1) return null;
  if (p.todayAmount == null) return null;
  const completed = p.current - p.todayAmount;
  if (completed < 0) return null; // cross-call skew — never a confident -100%
  return momChangePctDailyUtc(completed, p.previous, p.now);
}
