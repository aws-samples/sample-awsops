import { describe, it, expect } from 'vitest';
import {
  momChangePct, momChangePctDaily, daysInMonth, projectMonthEnd, trendPill,
  allServiceNames, filterServiceTotal, filterMonthlyTotals, filterDailyTotals,
  serviceChangeRows, mergeMonthlyByService, mergeDailyByService,
  type MonthlyServiceCostPoint, type DailyServiceCostPoint,
  looksLikeCeUnconfigured, momChangePctDailyUtc, serviceAlertChange,
} from './cost';

describe('momChangePct', () => {
  it('computes a positive change', () => {
    expect(momChangePct(120, 100)).toBeCloseTo(20);
  });
  it('computes a negative change', () => {
    expect(momChangePct(80, 100)).toBeCloseTo(-20);
  });
  it('returns 0 when last month is 0 or missing (no baseline)', () => {
    expect(momChangePct(100, 0)).toBe(0);
    expect(momChangePct(100, NaN)).toBe(0);
  });
});

describe('daysInMonth', () => {
  it('returns days in the previous calendar month', () => {
    expect(daysInMonth(new Date(2026, 5, 17), -1)).toBe(31);   // June → May = 31
    expect(daysInMonth(new Date(2024, 2, 1), -1)).toBe(29);    // March 2024 → Feb (leap) = 29
    expect(daysInMonth(new Date(2026, 2, 1), -1)).toBe(28);    // March 2026 → Feb = 28
  });
  it('returns days in the current month at offset 0', () => {
    expect(daysInMonth(new Date(2026, 5, 17), 0)).toBe(30);    // June = 30
  });
});

describe('momChangePctDaily (per-day run-rate — the MoM fix)', () => {
  // June 17 (day 17), previous month May has 31 days.
  it('equal daily run-rate ⇒ ~0 even though the month is partial (the bug fix)', () => {
    // MTD 170 over 17 days = $10/day; May 310 over 31 days = $10/day → 0%.
    expect(momChangePctDaily(170, 310, new Date(2026, 5, 17))).toBeCloseTo(0);
    // the OLD partial-vs-full math would have shown a bogus large negative:
    expect(momChangePct(170, 310)).toBeLessThan(-40);
  });
  it('higher daily run-rate ⇒ positive', () => {
    expect(momChangePctDaily(204, 310, new Date(2026, 5, 17))).toBeCloseTo(20);  // $12/day vs $10/day
  });
  it('lower daily run-rate ⇒ negative', () => {
    expect(momChangePctDaily(136, 310, new Date(2026, 5, 17))).toBeCloseTo(-20); // $8/day vs $10/day
  });
  it('returns 0 with no baseline (last month 0)', () => {
    expect(momChangePctDaily(100, 0, new Date(2026, 5, 17))).toBe(0);
  });
});

describe('projectMonthEnd', () => {
  it('extrapolates linearly mid-month', () => {
    // June 10: 30-day month, day 10, mtd 100 → 300
    expect(projectMonthEnd(100, new Date(2026, 5, 10))).toBeCloseTo(300);
  });
  it('equals mtd on the last day of the month', () => {
    expect(projectMonthEnd(300, new Date(2026, 5, 30))).toBeCloseTo(300); // June has 30 days
  });
  it('uses 29 days for a leap February', () => {
    // Feb 1, 2024 (leap), mtd 10 → (10/1)*29 = 290
    expect(projectMonthEnd(10, new Date(2024, 1, 1))).toBeCloseTo(290);
  });
  it('uses 28 days for a non-leap February', () => {
    expect(projectMonthEnd(10, new Date(2026, 1, 1))).toBeCloseTo(280);
  });
});

describe('trendPill', () => {
  it('renders up/down arrows and zero', () => {
    expect(trendPill(4.23)).toBe('↑4.2%');
    expect(trendPill(-2.3)).toBe('↓2.3%');
    expect(trendPill(0)).toBe('0.0%');
  });
});

// v1-parity cost filter menu (period + service) — pure aggregation helpers.
const MONTHLY: MonthlyServiceCostPoint[] = [
  { month: '2026-04', byService: [{ service: 'RDS', amount: 100 }, { service: 'EC2', amount: 50 }] },
  { month: '2026-05', byService: [{ service: 'RDS', amount: 120 }, { service: 'EC2', amount: 40 }, { service: 'S3', amount: 10 }] },
  { month: '2026-06', byService: [{ service: 'RDS', amount: 200 }, { service: 'EC2', amount: 60 }] },
];
const DAILY: DailyServiceCostPoint[] = [
  { date: '2026-06-01', byService: [{ service: 'RDS', amount: 5 }, { service: 'EC2', amount: 2 }] },
  { date: '2026-06-02', byService: [{ service: 'RDS', amount: 7 }] },
];

describe('allServiceNames', () => {
  it('collects distinct service names across every row, sorted', () => {
    expect(allServiceNames(MONTHLY)).toEqual(['EC2', 'RDS', 'S3']);
  });
  it('empty matrix → empty list', () => {
    expect(allServiceNames([])).toEqual([]);
  });
});

describe('filterServiceTotal', () => {
  const row = [{ service: 'RDS', amount: 200 }, { service: 'EC2', amount: 60 }];
  it('empty selection = no filter = sums everything', () => {
    expect(filterServiceTotal(row, new Set())).toBe(260);
  });
  it('sums only the selected services', () => {
    expect(filterServiceTotal(row, new Set(['RDS']))).toBe(200);
  });
  it('a selected service absent from this row contributes 0', () => {
    expect(filterServiceTotal(row, new Set(['S3']))).toBe(0);
  });
});

describe('filterMonthlyTotals / filterDailyTotals', () => {
  it('unfiltered totals match the full per-row sum', () => {
    expect(filterMonthlyTotals(MONTHLY, new Set())).toEqual([
      { month: '2026-04', total: 150 }, { month: '2026-05', total: 170 }, { month: '2026-06', total: 260 },
    ]);
    expect(filterDailyTotals(DAILY, new Set())).toEqual([
      { date: '2026-06-01', amount: 7 }, { date: '2026-06-02', amount: 7 },
    ]);
  });
  it('filtered totals only include the selected services', () => {
    expect(filterMonthlyTotals(MONTHLY, new Set(['EC2']))).toEqual([
      { month: '2026-04', total: 50 }, { month: '2026-05', total: 40 }, { month: '2026-06', total: 60 },
    ]);
    expect(filterDailyTotals(DAILY, new Set(['EC2']))).toEqual([
      { date: '2026-06-01', amount: 2 }, { date: '2026-06-02', amount: 0 },
    ]);
  });
});

describe('serviceChangeRows', () => {
  it('reads current/previous off the LAST two months, sorted desc by current, share sums to ~100%', () => {
    const rows = serviceChangeRows(MONTHLY, new Set());
    expect(rows.map((r) => r.service)).toEqual(['RDS', 'EC2']); // 200 > 60
    const rds = rows.find((r) => r.service === 'RDS')!;
    expect(rds.current).toBe(200);
    expect(rds.previous).toBe(120); // May's RDS
    expect(rds.change).toBeCloseTo(((200 - 120) / 120) * 100);
    const shareSum = rows.reduce((s, r) => s + r.share, 0);
    expect(shareSum).toBeCloseTo(100);
  });
  it('a service with no previous-month row gets previous=0, change=0 (no baseline)', () => {
    const rows = serviceChangeRows(MONTHLY, new Set());
    // S3 only appears in May, not June — should be ABSENT from June-based rows entirely.
    expect(rows.find((r) => r.service === 'S3')).toBeUndefined();
  });
  it('service filter restricts which current-month services are included', () => {
    const rows = serviceChangeRows(MONTHLY, new Set(['EC2']));
    expect(rows).toEqual([{ service: 'EC2', current: 60, previous: 40, change: 50, share: 100 }]);
  });
  it('fewer than 2 months → previous defaults to 0 for every service (no baseline)', () => {
    const rows = serviceChangeRows([MONTHLY[0]], new Set());
    expect(rows.every((r) => r.previous === 0 && r.change === 0)).toBe(true);
  });
  it('empty matrix → empty rows', () => {
    expect(serviceChangeRows([], new Set())).toEqual([]);
  });
});

describe('mergeMonthlyByService / mergeDailyByService (전체 계정 fan-out)', () => {
  it('sums matching month+service across accounts, sorted by month then desc by amount', () => {
    const a: MonthlyServiceCostPoint[] = [{ month: '2026-06', byService: [{ service: 'RDS', amount: 100 }] }];
    const b: MonthlyServiceCostPoint[] = [{ month: '2026-06', byService: [{ service: 'RDS', amount: 50 }, { service: 'EC2', amount: 200 }] }];
    expect(mergeMonthlyByService([a, b])).toEqual([
      { month: '2026-06', byService: [{ service: 'EC2', amount: 200 }, { service: 'RDS', amount: 150 }] },
    ]);
  });
  it('sums matching date+service across accounts', () => {
    const a: DailyServiceCostPoint[] = [{ date: '2026-06-01', byService: [{ service: 'RDS', amount: 5 }] }];
    const b: DailyServiceCostPoint[] = [{ date: '2026-06-01', byService: [{ service: 'RDS', amount: 3 }] }];
    expect(mergeDailyByService([a, b])).toEqual([{ date: '2026-06-01', byService: [{ service: 'RDS', amount: 8 }] }]);
  });
  it('empty parts → empty result', () => {
    expect(mergeMonthlyByService([])).toEqual([]);
    expect(mergeDailyByService([[], []])).toEqual([]);
  });
});


describe('momChangePctDailyUtc (alert-surface UTC math)', () => {
  it('completed-days contract: day 3 at an unchanged run-rate reads exactly ~0 (no -33% green bias)', () => {
    const now = new Date('2026-09-03T12:00:00Z'); // completed UTC days = 2
    // prev month (Aug, 31d) total 310 → 10/day; completed-days MTD (today already subtracted
    // by the caller) = 20 → 10/day → change 0.
    expect(Math.abs(momChangePctDailyUtc(20, 310, now))).toBeLessThan(0.5);
  });
  it('day 2: one completed day at the same rate reads ~0; a real 2x surge reads ~+100%', () => {
    const now = new Date('2026-09-02T12:00:00Z'); // completed = 1
    expect(Math.abs(momChangePctDailyUtc(10, 310, now))).toBeLessThan(0.5);
    expect(momChangePctDailyUtc(20, 310, now)).toBeGreaterThan(80);
  });
  it('uses UTC calendar days regardless of browser timezone (callers suppress UTC day 1)', () => {
    const now = new Date('2026-09-01T03:00:00Z'); // KST already Sep 1 local; UTC day 1 → clamp divisor 1
    // day-1 verdicts are suppressed by callers — the function itself just stays finite.
    expect(Number.isFinite(momChangePctDailyUtc(0, 310, now))).toBe(true);
  });
});

describe('looksLikeCeUnconfigured (gap L197)', () => {
  const zeroTrend = [{ date: '2026-08-30', amount: 0 }, { date: '2026-08-31', amount: 0 }] as { amount: number }[];
  const emptyMonths = [
    { month: '2026-08', byService: [] },
    { month: '2026-09', byService: [] },
  ] as never;
  const base = {
    busy: false, err: '', loaded: true, cached: false, filtered: false, failedLegs: 0,
    total: 0, changeRowCount: 0, trend: zeroTrend, monthlyByService: emptyMonths,
  };
  it('fires on a successful LIVE, unfiltered, failure-free load with zero spend anywhere', () => {
    expect(looksLikeCeUnconfigured(base)).toBe(true);
  });
  it('a zero-cost bucketed response with any nonzero value stays quiet', () => {
    expect(looksLikeCeUnconfigured({ ...base, total: 0.01 })).toBe(false);
    expect(looksLikeCeUnconfigured({ ...base, changeRowCount: 1 })).toBe(false);
    expect(looksLikeCeUnconfigured({ ...base, trend: [{ amount: 3 }] })).toBe(false);
  });
  it('HISTORICAL spend in an earlier month suppresses the banner (decommissioned workload)', () => {
    const months = [{ month: '2026-07', byService: [{ service: 'EC2', amount: 42 }] }, { month: '2026-09', byService: [] }] as never;
    expect(looksLikeCeUnconfigured({ ...base, monthlyByService: months })).toBe(false);
  });
  it('an EMPTY trend is a failed/degraded daily leg, not onboarding evidence (vacuous every())', () => {
    expect(looksLikeCeUnconfigured({ ...base, trend: [] })).toBe(false);
  });

  it('an EMPTY monthly matrix is a failed/degraded monthly leg — same vacuous-every() hole', () => {
    expect(looksLikeCeUnconfigured({ ...base, monthlyByService: [] as never })).toBe(false);
  });
  it('a cached-snapshot fallback (server-side degradation) fails closed', () => {
    expect(looksLikeCeUnconfigured({ ...base, cached: true })).toBe(false);
  });
  it('suppressed while busy / on error / before load / with a service filter active', () => {
    expect(looksLikeCeUnconfigured({ ...base, busy: true })).toBe(false);
    expect(looksLikeCeUnconfigured({ ...base, err: '500' })).toBe(false);
    expect(looksLikeCeUnconfigured({ ...base, loaded: false })).toBe(false);
    expect(looksLikeCeUnconfigured({ ...base, filtered: true })).toBe(false);
  });
  it('a failed fan-out leg is an access/error condition, NEVER an onboarding diagnosis', () => {
    expect(looksLikeCeUnconfigured({ ...base, failedLegs: 1 })).toBe(false);
  });
});


describe('serviceAlertChange (composed alert verdict)', () => {
  const now = new Date('2026-09-10T12:00:00Z'); // 9 completed days; Aug = 31d
  it('subtracts today and compares completed-day run rates (flat rate → ~0)', () => {
    // prev 310 → 10/day; completed MTD 90 + today partial 4 → current 94.
    expect(Math.abs(serviceAlertChange({ current: 94, previous: 310, todayAmount: 4, now })!)).toBeLessThan(0.5);
  });
  it('null verdicts: no baseline / UTC day 1 / degraded daily leg / cross-call clamp', () => {
    expect(serviceAlertChange({ current: 94, previous: 0, todayAmount: 4, now })).toBeNull();
    expect(serviceAlertChange({ current: 5, previous: 310, todayAmount: 5, now: new Date('2026-09-01T12:00:00Z') })).toBeNull();
    expect(serviceAlertChange({ current: 94, previous: 310, todayAmount: null, now })).toBeNull(); // degraded → never the biased basis
    expect(serviceAlertChange({ current: 3, previous: 310, todayAmount: 5, now })).toBeNull();     // clamp skew → never a confident -100%
  });
  it('a real surge still trips the threshold', () => {
    // completed MTD 270 over 9 days = 30/day vs prev 10/day → +200%.
    expect(serviceAlertChange({ current: 280, previous: 310, todayAmount: 10, now })!).toBeGreaterThan(100);
  });
});
