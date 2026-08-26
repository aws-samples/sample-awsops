// Scheduled auto-diagnosis — read/upsert the per-user row in the existing `report_schedules` table
// (singleton per (user_sub, schedule_type); tier/model live in the `config` JSONB; `next_run_at` is NOT NULL
// so it is always set — the `enabled` flag, not a null next-run, gates firing). v1 parity for
// src/lib/report-scheduler.ts. The worker-side dispatcher (EventBridge) scans this table; this module is the
// BFF read/write seam only. Stored times are UTC (TIMESTAMPTZ); KST is a display concern in the UI.
import { getPool } from '@/lib/db';

export type ScheduleFreq = 'weekly' | 'biweekly' | 'monthly';
export const SCHEDULE_FREQS: ScheduleFreq[] = ['weekly', 'biweekly', 'monthly'];

export interface DiagnosisSchedule {
  scheduleType: ScheduleFreq;
  enabled: boolean;
  tier: string;
  model: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

/** Next run = `from` + one interval, returned as a UTC ISO string. weekly=+7d, biweekly=+14d, monthly=+1 month. */
export function computeNextRun(type: ScheduleFreq, fromISO: string): string {
  const d = new Date(fromISO);
  if (type === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else if (type === 'biweekly') d.setUTCDate(d.getUTCDate() + 14);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
}

interface Row {
  schedule_type: string;
  enabled: boolean;
  next_run_at: string | Date | null;
  last_run_at: string | Date | null;
  config: { tier?: string; model?: string | null } | null;
}

const iso = (v: string | Date | null): string | null => (v == null ? null : new Date(v).toISOString());

function mapRow(r: Row): DiagnosisSchedule {
  const cfg = r.config ?? {};
  return {
    scheduleType: r.schedule_type as ScheduleFreq,
    enabled: r.enabled,
    tier: cfg.tier ?? 'mid',
    model: cfg.model ?? null,
    nextRunAt: iso(r.next_run_at),
    lastRunAt: iso(r.last_run_at),
  };
}

/** The caller's current schedule, or null if they have none yet. Scoped by user_sub (no cross-user read). */
export async function readSchedule(userSub: string): Promise<DiagnosisSchedule | null> {
  const { rows } = await getPool().query<Row>(
    `SELECT schedule_type, enabled, next_run_at, last_run_at, config
       FROM report_schedules WHERE user_sub = $1 ORDER BY enabled DESC, updated_at DESC LIMIT 1`,
    [userSub],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

/** Create/replace the caller's schedule. next_run_at is always recomputed (NOT NULL); `enabled` gates firing. */
export async function upsertSchedule(
  userSub: string,
  input: { scheduleType: ScheduleFreq; enabled: boolean; tier?: string; model?: string | null; nowISO?: string },
): Promise<DiagnosisSchedule> {
  const nextRunAt = computeNextRun(input.scheduleType, input.nowISO ?? new Date().toISOString());
  const config = { tier: input.tier ?? 'mid', model: input.model ?? null };
  // One active schedule per user. The table's conflict key is (user_sub, schedule_type), so changing
  // frequency (e.g. weekly→monthly) would INSERT a new row and leave the previous one enabled — the
  // dispatcher (WHERE enabled) would then fire BOTH, and readSchedule (LIMIT 1) would hide the leak.
  // Disable every other-frequency row for this user before upserting the chosen one.
  await getPool().query(
    `UPDATE report_schedules SET enabled = false WHERE user_sub = $1 AND schedule_type <> $2`,
    [userSub, input.scheduleType],
  );
  const { rows } = await getPool().query<Row>(
    `INSERT INTO report_schedules (user_sub, schedule_type, enabled, next_run_at, config)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (user_sub, schedule_type)
     DO UPDATE SET enabled = EXCLUDED.enabled, next_run_at = EXCLUDED.next_run_at, config = EXCLUDED.config
     RETURNING schedule_type, enabled, next_run_at, last_run_at, config`,
    [userSub, input.scheduleType, input.enabled, nextRunAt, JSON.stringify(config)],
  );
  return mapRow(rows[0]);
}
