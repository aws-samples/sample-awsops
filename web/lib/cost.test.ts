import { describe, it, expect } from 'vitest';
import {
  momChangePct, momChangePctDaily, daysInMonth, projectMonthEnd, trendPill,
  allServiceNames, filterServiceTotal, filterMonthlyTotals, filterDailyTotals,
  serviceChangeRows, mergeMonthlyByService, mergeDailyByService,
  type MonthlyServiceCostPoint, type DailyServiceCostPoint,
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
