import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock, releaseMock } = vi.hoisted(() => ({ queryMock: vi.fn(), releaseMock: vi.fn() }));
// upsertSchedule takes a CLIENT now (the disable + upsert pair has to be one transaction), so the mock
// pool hands back a client backed by the same query mock: BEGIN/COMMIT show up in the call log.
vi.mock('@/lib/db', () => ({
  getPool: () => ({
    query: queryMock,
    connect: async () => ({ query: queryMock, release: releaseMock }),
  }),
}));

import { computeNextRun, readSchedule, upsertSchedule } from './diagnosis-schedule';

beforeEach(() => { queryMock.mockReset(); releaseMock.mockReset(); });

describe('computeNextRun', () => {
  const from = '2026-06-18T00:00:00.000Z';
  it('weekly adds 7 days', () => expect(computeNextRun('weekly', from)).toBe('2026-06-25T00:00:00.000Z'));
  it('biweekly adds 14 days', () => expect(computeNextRun('biweekly', from)).toBe('2026-07-02T00:00:00.000Z'));
  it('monthly adds 1 calendar month', () => expect(computeNextRun('monthly', from)).toBe('2026-07-18T00:00:00.000Z'));

  // Detail fields (gap L51): KST occurrences, strictly in the future. `from` above is
  // 2026-06-18T00:00:00Z = 2026-06-18 09:00 KST, a Thursday (JS getDay 4).
  it('weekly + dayOfWeek/hour lands on the next KST occurrence (future-strict)', () => {
    // Thursday 10:00 KST is later today → today 10:00 KST = 01:00 UTC.
    expect(computeNextRun('weekly', from, { dayOfWeek: 4, hour: 10 })).toBe('2026-06-18T01:00:00.000Z');
    // Thursday 09:00 KST equals "now" → pushed a full week out.
    expect(computeNextRun('weekly', from, { dayOfWeek: 4, hour: 9 })).toBe('2026-06-25T00:00:00.000Z');
    // Sunday (0) 06:00 KST → 2026-06-21 06:00 KST = 2026-06-20T21:00:00Z.
    expect(computeNextRun('weekly', from, { dayOfWeek: 0, hour: 6 })).toBe('2026-06-20T21:00:00.000Z');
  });
  it('biweekly adds one extra week past the next occurrence', () => {
    expect(computeNextRun('biweekly', from, { dayOfWeek: 0, hour: 6 })).toBe('2026-06-27T21:00:00.000Z');
  });
  it('monthly + dayOfMonth/hour picks this month if future, else next month (KST)', () => {
    // 25th 09:00 KST = 2026-06-25T00:00:00Z (still ahead of Jun 18).
    expect(computeNextRun('monthly', from, { dayOfMonth: 25, hour: 9 })).toBe('2026-06-25T00:00:00.000Z');
    // 5th already passed in June → July 5th 09:00 KST.
    expect(computeNextRun('monthly', from, { dayOfMonth: 5, hour: 9 })).toBe('2026-07-05T00:00:00.000Z');
  });
  it('empty detail object keeps the pure-interval behavior', () => {
    expect(computeNextRun('weekly', from, {})).toBe('2026-06-25T00:00:00.000Z');
  });
  it('hour-only keeps the interval date and pins the KST hour (never invents a run date)', () => {
    // weekly interval lands on 2026-06-25 09:00 KST; hour 10 pins the wall clock → 01:00 UTC.
    expect(computeNextRun('weekly', from, { hour: 10 })).toBe('2026-06-25T01:00:00.000Z');
    // monthly interval lands on 2026-07-18 09:00 KST; hour 9 is a no-op pin.
    expect(computeNextRun('monthly', from, { hour: 9 })).toBe('2026-07-18T00:00:00.000Z');
    // a monthly hour-only must NOT jump to the 1st of the month.
    expect(computeNextRun('monthly', from, { hour: 9 })).not.toContain('-07-01');
  });
  it('monthly interval clamps month-ends instead of overflowing (Jan 31 → Feb 28, not Mar 3)', () => {
    expect(computeNextRun('monthly', '2026-01-31T00:00:00.000Z')).toBe('2026-02-28T00:00:00.000Z');
    // hour pin composes with the clamp (2026-01-31T00:00Z = Jan 31 09:00 KST → Feb 28 10:00 KST).
    expect(computeNextRun('monthly', '2026-01-31T00:00:00.000Z', { hour: 10 })).toBe('2026-02-28T01:00:00.000Z');
  });
});

describe('readSchedule', () => {
  it('returns null when the user has no schedule', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    expect(await readSchedule('u1')).toBeNull();
    expect(queryMock.mock.calls[0][1]).toEqual(['u1']); // scoped by user_sub
  });

  it('maps a row (tier/model from config) when present', async () => {
    queryMock.mockResolvedValue({
      rows: [{ schedule_type: 'weekly', enabled: true, next_run_at: '2026-06-25T00:00:00.000Z', last_run_at: null, config: { tier: 'deep', model: 'opus' } }],
    });
    const s = await readSchedule('u1');
    expect(s).toMatchObject({ scheduleType: 'weekly', enabled: true, tier: 'deep', model: 'opus', nextRunAt: '2026-06-25T00:00:00.000Z', lastRunAt: null });
  });

});

describe('upsertSchedule', () => {
  it('upserts with a recomputed next_run_at and config, returns the mapped row', async () => {
    queryMock.mockResolvedValue({
      rows: [{ schedule_type: 'weekly', enabled: true, next_run_at: '2026-06-25T00:00:00.000Z', last_run_at: null, config: { tier: 'mid', model: null } }],
    });
    const s = await upsertSchedule('u1', { scheduleType: 'weekly', enabled: true, tier: 'mid', nowISO: '2026-06-18T00:00:00.000Z' });
    // disable-others UPDATE runs first (no cross-frequency double-fire)
    const disable = queryMock.mock.calls.find((c) => /UPDATE report_schedules SET enabled = false/.test(c[0] as string));
    expect(disable).toBeTruthy();
    expect(disable![1]).toEqual(['u1', 'weekly']);
    // then the upsert
    const insert = queryMock.mock.calls.find((c) => /INSERT INTO report_schedules/.test(c[0] as string))!;
    expect(insert[0]).toMatch(/ON CONFLICT \(user_sub, schedule_type\)/);
    const params = insert[1] as unknown[];
    expect(params[0]).toBe('u1');
    expect(params[1]).toBe('weekly');
    expect(params[2]).toBe(true);
    expect(params[3]).toBe('2026-06-25T00:00:00.000Z'); // recomputed next_run_at
    expect(JSON.parse(params[4] as string)).toEqual({ tier: 'mid', model: null });
    expect(s.scheduleType).toBe('weekly');
  });

  it('still sets next_run_at when disabled (NOT NULL column); enabled flag gates firing', async () => {
    queryMock.mockResolvedValue({
      rows: [{ schedule_type: 'monthly', enabled: false, next_run_at: '2026-07-18T00:00:00.000Z', last_run_at: null, config: { tier: 'mid', model: null } }],
    });
    await upsertSchedule('u1', { scheduleType: 'monthly', enabled: false, nowISO: '2026-06-18T00:00:00.000Z' });
    const insert = (queryMock.mock.calls.find((c) => /INSERT INTO report_schedules/.test(c[0] as string))!)[1] as unknown[];
    expect(insert[2]).toBe(false);
    expect(insert[3]).toBe('2026-07-18T00:00:00.000Z'); // next_run_at present even when disabled
  });

  it('runs the disable + upsert as ONE transaction on ONE client', async () => {
    // Two pool queries meant two autocommit transactions: between them the user has no enabled
    // schedule at all (a dispatcher tick in that gap skips them), and two concurrent saves could
    // interleave disable/disable/insert/insert — which uq_schedule_one_active turns into a hard 23505
    // (PR #203 review MAJOR).
    queryMock.mockResolvedValue({ rows: [{ schedule_type: 'weekly', enabled: true,
      next_run_at: '2026-06-25T00:00:00.000Z', last_run_at: null, config: {} }] });
    await upsertSchedule('u1', { scheduleType: 'weekly', enabled: true, nowISO: '2026-06-18T00:00:00.000Z' });
    const sqls = queryMock.mock.calls.map((c) => String(c[0]).trim());
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[1]).toContain('SET enabled = false');
    expect(sqls[2]).toContain('INSERT INTO report_schedules');
    expect(sqls[3]).toBe('COMMIT');
    expect(releaseMock).toHaveBeenCalled();
  });

  it('disables other-frequency rows even when the target is the only one (idempotent)', async () => {
    queryMock.mockResolvedValue({ rows: [{ schedule_type: 'weekly', enabled: true, next_run_at: '2026-06-25T00:00:00.000Z', last_run_at: null, config: {} }] });
    await upsertSchedule('u1', { scheduleType: 'weekly', enabled: true });
    expect(queryMock.mock.calls.some((c) => /UPDATE report_schedules SET enabled = false/.test(c[0] as string) && (c[1] as unknown[])[1] === 'weekly')).toBe(true);
  });

});
