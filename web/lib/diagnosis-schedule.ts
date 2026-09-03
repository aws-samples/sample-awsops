// Scheduled auto-diagnosis — read/upsert the per-user row in the existing `report_schedules` table
// (singleton per (user_sub, schedule_type); tier/model live in the `config` JSONB; `next_run_at` is NOT NULL
// so it is always set — the `enabled` flag, not a null next-run, gates firing). v1 parity for
// src/lib/report-scheduler.ts. The worker-side dispatcher (EventBridge) scans this table; this module is the
// BFF read/write seam only. Stored times are UTC (TIMESTAMPTZ); KST is a display concern in the UI.
import { getPool } from '@/lib/db';

export type ScheduleFreq = 'weekly' | 'biweekly' | 'monthly';
export const SCHEDULE_FREQS: ScheduleFreq[] = ['weekly', 'biweekly', 'monthly'];

// Detail fields (gap L51, all optional — absent keeps the pure-interval behavior):
// dayOfWeek 0-6 (JS getDay convention, 0=Sun, KST) for weekly/biweekly; dayOfMonth 1-28 (KST)
// for monthly; hour 0-23 (KST) for all. KST is a fixed +9 offset (no DST).
export interface ScheduleDetail {
  dayOfWeek?: number;
  dayOfMonth?: number;
  hour?: number;
}

export interface DiagnosisSchedule extends ScheduleDetail {
  scheduleType: ScheduleFreq;
  enabled: boolean;
  tier: string;
  model: string | null;
  lang?: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

const KST_OFFSET_MS = 9 * 3600_000;
const kstParts = (utcMs: number) => new Date(utcMs + KST_OFFSET_MS); // read its getUTC* as KST fields

/** Next run as a UTC ISO string. Without detail fields: `from` + one interval (weekly=+7d,
 *  biweekly=+14d, monthly=+1 month — today's behavior). The precise weekday/date branch runs
 *  only when the cadence's PARTNER field is present (`dayOfWeek` for weekly/biweekly,
 *  `dayOfMonth` for monthly) — an `hour` alone keeps the interval behavior with the run hour
 *  pinned in KST, never inventing a run date. Mirrors the dispatcher's `_precise_next_run` so
 *  the BFF-computed first run and the worker-computed subsequent runs agree. */
export function computeNextRun(type: ScheduleFreq, fromISO: string, detail?: ScheduleDetail): string {
  const h = typeof detail?.hour === 'number' && detail.hour >= 0 && detail.hour <= 23 ? detail.hour : null;
  const hasPartner = type === 'monthly'
    ? typeof detail?.dayOfMonth === 'number' && detail.dayOfMonth >= 1 && detail.dayOfMonth <= 28
    : typeof detail?.dayOfWeek === 'number' && detail.dayOfWeek >= 0 && detail.dayOfWeek <= 6;
  if (!hasPartner) {
    const d = new Date(fromISO);
    if (type === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
    else if (type === 'biweekly') d.setUTCDate(d.getUTCDate() + 14);
    else {
      // Overflow-safe month add — raw setUTCMonth turns Jan 31 into Mar 3 (skipping February).
      // Clamp to the target month's last day instead (matches Postgres `+ interval '1 month'`,
      // which the dispatcher's claim SQL uses for subsequent runs).
      const day = d.getUTCDate();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + 1);
      const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(day, lastDay));
    }
    if (h === null) return d.toISOString();
    // hour-only: pin the KST wall-clock hour on the interval date.
    const k = kstParts(d.getTime());
    const pinned = Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate(), h, 0, 0);
    return new Date(pinned - KST_OFFSET_MS).toISOString();
  }
  const nowMs = new Date(fromISO).getTime();
  const now = kstParts(nowMs);
  const hh = h ?? 0;
  let cand: Date;
  if (type === 'weekly' || type === 'biweekly') {
    const target = detail!.dayOfWeek as number;
    cand = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(),
      now.getUTCDate() + ((target - now.getUTCDay()) + 7) % 7, hh, 0, 0));
    if (cand.getTime() - KST_OFFSET_MS <= nowMs) cand = new Date(cand.getTime() + 7 * 86400_000);
    if (type === 'biweekly') cand = new Date(cand.getTime() + 7 * 86400_000);
  } else {
    const d = detail!.dayOfMonth as number;
    cand = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), d, hh, 0, 0));
    if (cand.getTime() - KST_OFFSET_MS <= nowMs) {
      cand = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, d, hh, 0, 0));
    }
  }
  // cand's getUTC* fields carry KST wall-clock values → shift back to real UTC.
  return new Date(cand.getTime() - KST_OFFSET_MS).toISOString();
}

interface Row {
  schedule_type: string;
  enabled: boolean;
  next_run_at: string | Date | null;
  last_run_at: string | Date | null;
  config: { tier?: string; model?: string | null; lang?: string;
    dayOfWeek?: number; dayOfMonth?: number; hour?: number } | null;
}

const iso = (v: string | Date | null): string | null => (v == null ? null : new Date(v).toISOString());

function mapRow(r: Row): DiagnosisSchedule {
  const cfg = r.config ?? {};
  return {
    scheduleType: r.schedule_type as ScheduleFreq,
    enabled: r.enabled,
    tier: cfg.tier ?? 'mid',
    model: cfg.model ?? null,
    ...(cfg.lang !== undefined ? { lang: cfg.lang } : {}),
    ...(cfg.dayOfWeek !== undefined ? { dayOfWeek: cfg.dayOfWeek } : {}),
    ...(cfg.dayOfMonth !== undefined ? { dayOfMonth: cfg.dayOfMonth } : {}),
    ...(cfg.hour !== undefined ? { hour: cfg.hour } : {}),
    nextRunAt: iso(r.next_run_at),
    lastRunAt: iso(r.last_run_at),
  };
}

const SELECT_SQL = `SELECT schedule_type, enabled, next_run_at, last_run_at, config
     FROM report_schedules WHERE user_sub = $1 ORDER BY enabled DESC, updated_at DESC LIMIT 1`;

/** The caller's current schedule, or null if they have none yet. Scoped by immutable Cognito sub. */
export async function readSchedule(userSub: string): Promise<DiagnosisSchedule | null> {
  const { rows } = await getPool().query<Row>(SELECT_SQL, [userSub]);
  return rows.length ? mapRow(rows[0]) : null;
}

/** Another writer holds this user's single active-schedule slot (see uq_schedule_one_active). */
export class ScheduleSlotTakenError extends Error {
  constructor() {
    super('another write is holding this user\'s active schedule slot; retry in a moment');
    this.name = 'ScheduleSlotTakenError';
  }
}

/** Create/replace the caller's schedule. next_run_at is always recomputed (NOT NULL); `enabled` gates firing. */
export async function upsertSchedule(
  userSub: string,
  input: { scheduleType: ScheduleFreq; enabled: boolean; tier?: string; model?: string | null;
    lang?: string; nowISO?: string } & ScheduleDetail,
): Promise<DiagnosisSchedule> {
  const detail: ScheduleDetail = {
    ...(typeof input.dayOfWeek === 'number' ? { dayOfWeek: input.dayOfWeek } : {}),
    ...(typeof input.dayOfMonth === 'number' ? { dayOfMonth: input.dayOfMonth } : {}),
    ...(typeof input.hour === 'number' ? { hour: input.hour } : {}),
  };
  const nextRunAt = computeNextRun(input.scheduleType, input.nowISO ?? new Date().toISOString(), detail);
  const config = { tier: input.tier ?? 'mid', model: input.model ?? null,
    ...(input.lang ? { lang: input.lang } : {}), ...detail };
  // One active schedule per user. The table's conflict key is (user_sub, schedule_type), so changing
  // frequency (e.g. weekly→monthly) would INSERT a new row and leave the previous one enabled — the
  // dispatcher (WHERE enabled) would then fire BOTH, and readSchedule (LIMIT 1) would hide the leak.
  // Disable every other-frequency row for this user, then upsert the chosen one.
  //
  // ONE TRANSACTION on ONE connection. These were two separate pool queries, which means two separate
  // autocommit transactions on possibly different connections: between them the user has NO enabled
  // schedule (a dispatcher tick in that gap silently skips them), and two concurrent saves can
  // interleave as disable/disable/insert/insert — which uq_schedule_one_active now turns into a hard
  // 23505 for the second, where before it merely left the table wrong (PR #203 review MAJOR). Inside
  // one transaction the pair is atomic and the second saver waits on the first's row locks.
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE report_schedules SET enabled = false WHERE user_sub = $1 AND schedule_type <> $2`,
      [userSub, input.scheduleType],
    );
    const { rows } = await client.query<Row>(
      `INSERT INTO report_schedules (user_sub, schedule_type, enabled, next_run_at, config)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (user_sub, schedule_type)
       DO UPDATE SET enabled = EXCLUDED.enabled, next_run_at = EXCLUDED.next_run_at, config = EXCLUDED.config
       RETURNING schedule_type, enabled, next_run_at, last_run_at, config`,
      [userSub, input.scheduleType, input.enabled, nextRunAt, JSON.stringify(config)],
    );
    await client.query('COMMIT');
    return mapRow(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    // uq_schedule_one_active (migration 01KZ3C7Q…) now enforces one enabled row per user at the DB.
    // The disable above means this insert cannot collide with the caller's own rows, so reaching here
    // means something else claimed the slot concurrently — in practice the owner-sub backfill moving a
    // legacy email-keyed row onto this sub. Say so with a 409 rather than letting a raw 23505 surface
    // as a 500.
    const code = (e as { code?: string }).code;
    // 23505 = the index refused a second active row. 40P01/40001 = two concurrent saves for the same
    // user deadlocked or failed to serialize (opposing frequency changes lock the same rows in opposite
    // order). All three mean "someone else was writing this user's schedule" and all three are
    // retryable, so none of them should surface as a 500 (codex stop-gate).
    if ((code === '23505'
          && String((e as { constraint?: string }).constraint || '').includes('one_active'))
        || code === '40P01' || code === '40001') {
      throw new ScheduleSlotTakenError();
    }
    throw e;
  } finally {
    client.release();
  }
}
