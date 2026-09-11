import { verifyUser } from '@/lib/auth';
import { getPool } from '@/lib/db';
import { isDerivedTrendType } from '@/lib/trend-utils';

export const dynamic = 'force-dynamic';

const DEFAULT_DAYS = 14;
const MAX_DAYS = 90;

interface TrendPoint { date: string; total: number; ec2?: number }

/**
 * Daily resource-count trend (dashboard "리소스 추세" chart) from inventory_snapshots —
 * one row per (account, day, resource_type), written by sync_lambda per trusted account
 * (gap L124). `accounts` uses the same vocabulary as /api/inventory/summary: absent →
 * ['self'] (legacy behavior), '__all__', or a CSV validated to 'self'/12-digit ids.
 * Snapshots carry NO region dimension — `regions` is not accepted here (the page's
 * region-gated KPIs account for that). History only exists from whenever the sync Lambda
 * first wrote a snapshot for that account (non-self rows begin at the L124 deploy);
 * days before that simply have no row — honest absence, never a fabricated zero.
 * Derived security series (DERIVED_TREND_TYPES) are excluded from `total`: their
 * resources are already counted by their base series.
 */
export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const url = new URL(request.url);
  const days = Math.min(MAX_DAYS, Math.max(1, Number(url.searchParams.get('days')) || DEFAULT_DAYS));
  const accountsParam = url.searchParams.get('accounts');
  try {
    const pool = getPool();
    // Same accounts vocabulary as the security route's resolveAccounts: '__all__' resolves
    // SERVER-SIDE to 'self' + the currently enabled member accounts — never a lifted filter.
    // inventory_snapshots is append-only (no phase-1 prune), so an unfiltered read would also
    // sum the v1 backfill's cross-account 'aggregate' rows (double-counting backfilled days)
    // and offboarded accounts' history forever. Invalid CSV ids are dropped; an all-invalid
    // list falls back to 'self' rather than an unscoped read.
    let scopeDegraded = false;
    const accounts: string[] = await (async () => {
      if (accountsParam === null) return ['self'];
      if (accountsParam === '__all__') {
        try {
          // The IN-SCAN-SCOPE predicate, not bare `enabled`: mirrors the sync writer's own
          // scope condition (sync_lambda.py PHASE1/round-6 "phantom account" rule — an enabled
          // account with all_regions=false and zero enabled regions is never scanned, never
          // snapshots, and would make coverage-completeness fail for every steampipe type
          // forever). The resolved scope must be the writer's coverage universe.
          const r = await pool.query<{ account_id: string }>(
            `SELECT account_id FROM accounts a
             WHERE a.enabled AND NOT a.is_host
               AND (a.all_regions OR EXISTS (
                 SELECT 1 FROM account_regions r WHERE r.account_id = a.account_id AND r.enabled
               ))`,
          );
          return ['self', ...r.rows.map((x) => x.account_id)];
        } catch {
          scopeDegraded = true; // disclosed to the client — this narrowing is otherwise silent
          return ['self']; // accounts table unavailable → honest host-only scope
        }
      }
      // trim (the security route's resolveAccounts does — 'self, 2222…' must not silently
      // drop the member), dedupe, and bound the list (it drives two ANY() queries)
      const safe = [...new Set(
        accountsParam.split(',').map((a) => a.trim()).filter((a) => a === 'self' || /^[0-9]{12}$/.test(a)),
      )].slice(0, 50);
      return safe.length ? safe : ['self'];
    })();
    // resource_type charset guard: the v1 backfill wrote display-label series ('EC2
    // Instances', …) under member accounts — those legacy keys would render as split,
    // untranslatable series and their v1 derived-count labels dodge the DERIVED_TREND_TYPES
    // total-exclusion. v2 series are snake_case; legacy-label history is simply not read
    // (consistent with the 'per-account history accrues from this deploy' disclosure).
    const r = await pool.query<{ d: string; resource_type: string; n: number }>(
      `SELECT captured_at::date::text AS d, resource_type, SUM(resource_count)::int AS n
       FROM inventory_snapshots
       WHERE account_id = ANY($2::text[])
         AND resource_type ~ '^[a-z0-9_]+$'
         AND captured_at >= now() - ($1 || ' days')::interval
       GROUP BY 1, 2 ORDER BY 1`,
      [days, accounts],
    );
    // PER-TYPE per-day ACCOUNT coverage (which selected accounts wrote a row for that
    // (day, type)). Summing across accounts destroys the per-account half of the key-absence
    // signal — a fully unreachable account leaves every type key present via the others — and
    // the sync runs PER TYPE with its own trusted-account set, so a day-level set would still
    // mask an account that synced lambda but not ec2. The client guards (netChange, cost
    // impact, delta table) require SET-equal per-type coverage between compared days and
    // render '—' otherwise.
    const cov = await pool.query<{ d: string; resource_type: string; account_id: string }>(
      `SELECT DISTINCT captured_at::date::text AS d, resource_type, account_id
       FROM inventory_snapshots
       WHERE account_id = ANY($2::text[])
         AND resource_type ~ '^[a-z0-9_]+$'
         AND captured_at >= now() - ($1 || ' days')::interval
       ORDER BY 1, 2, 3`,
      [days, accounts],
    );
    // null-prototype accumulators: the snake_case charset still admits '__proto__'/
    // 'constructor' as resource_type values — a plain-object accumulator would walk or
    // pollute the prototype chain (the applyTerms hasOwnProperty precedent).
    const coverage: Record<string, Record<string, string[]>> = Object.create(null);
    for (const row of cov.rows) {
      const dayCov = (coverage[row.d] ??= Object.create(null));
      (dayCov[row.resource_type] ??= []).push(row.account_id);
    }
    const byDate = new Map<string, TrendPoint & Record<string, number | string>>();
    const latestByType = new Map<string, number>();
    for (const row of r.rows) {
      // NO per-type pre-seeding (the old `ec2: 0` seed made a failed EC2 sync day
      // indistinguishable from a genuine zero — key ABSENCE is the coverage signal the
      // client's coverage-parity diff and the ranking below both rely on).
      const p = byDate.get(row.d) ?? { date: row.d, total: 0 };
      // Derived security series don't add to the day's total — their resources are already
      // counted by the base series they were derived from (double-count guard).
      if (!isDerivedTrendType(row.resource_type)) p.total += Number(row.n);
      // v1 parity: every type is a column on the point (multi-line chart + delta table).
      p[row.resource_type] = Number(row.n);
      byDate.set(row.d, p);
      latestByType.set(row.resource_type, Number(row.n)); // rows are date-ordered → last write wins
    }
    const trend = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    // Types ranked by the latest day's counts. Mid-fan-out tolerance: the daily sync writes
    // one row per type progressively, so a type absent from the LATEST day but present on the
    // PREVIOUS day is treated as in-flight and keeps its last-seen rank (a transient slice
    // failure must not demote e.g. ec2 into the default-hidden group and churn chip state).
    // Only a type absent from BOTH of the last two days (dead/stopped syncing) ranks below
    // every recent type, its stale last-seen value serving only as the tie-break there.
    const lastPt = trend[trend.length - 1] as (Record<string, unknown> & { date: string }) | undefined;
    // "Recent" is CALENDAR-based (within 2 days of the latest point's date), not point-index
    // based — after a multi-day whole-sync gap, trend[len-2] can be weeks old and would let a
    // long-dead type count as in-flight.
    const lastMs = lastPt ? new Date(lastPt.date).getTime() : 0;
    // strictly < 2 days = the latest calendar day and the one before it
    const recentPts = trend.filter((pt) => lastMs - new Date(pt.date).getTime() < 2 * 86_400_000);
    const recent = (t: string) => recentPts.some((pt) => typeof (pt as Record<string, unknown>)[t] === 'number');
    const types = [...latestByType.keys()].sort((a, b) => {
      // Derived security series rank BELOW every real resource type: they must never claim a
      // Core top-5 chip slot from an actual resource (their counts overlap the base series).
      const da = isDerivedTrendType(a) ? 1 : 0;
      const db = isDerivedTrendType(b) ? 1 : 0;
      if (da !== db) return da - db;
      const ra = recent(a) ? 1 : 0;
      const rb = recent(b) ? 1 : 0;
      if (ra !== rb) return rb - ra;
      const d = (latestByType.get(b) ?? 0) - (latestByType.get(a) ?? 0);
      // deterministic name tie-break — unspecified SQL row order must not churn Core/Other
      // membership between requests (the chart key= would reset chip state on every churn)
      return d !== 0 ? d : a.localeCompare(b);
    });
    // `accounts` = the RESOLVED scope (the /api/security precedent) — the client can disclose
    // when it is narrower than the selector implied. `degraded` marks the __all__→self
    // fallback specifically: coverage is computed against the already-fallen-back scope, so
    // no coverage gap would ever disclose that narrowing on its own.
    return Response.json({ trend, types, coverage, accounts, ...(scopeDegraded ? { degraded: true } : {}) });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
