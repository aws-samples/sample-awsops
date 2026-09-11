// Home-dashboard trend helpers (gap L127) — pure, unit-tested. Extracted from app/page.tsx
// (Next.js pages may not export extra symbols).

export interface TrendPointLike { date: string; total?: number | string; [k: string]: unknown }

/** Per-day, PER-TYPE account coverage from the trend route: which selected accounts wrote a
 *  snapshot row for that (day, resource_type). Keyed per type because the sync runs per type
 *  with its own trusted-account set — an account can be reachable for one type's run and
 *  silent for another's on the same day, and a day-level set would mask exactly that gap. */
export type TrendCoverage = Record<string, Record<string, string[]>>;

/** SET-equality of one type's account coverage between two days. Fail-closed: a missing or
 *  empty set on either day is a mismatch, never a pass — absence cannot prove parity. */
// Coverage sets arrive via JSON; a prototype-chain hit for an Object.prototype-named type
// ('constructor') would be a non-array — treat anything that isn't an own array as absent.
function covSet(cov: TrendCoverage, d: string, type: string): string {
  const day = cov[d];
  const v = day && Object.prototype.hasOwnProperty.call(day, type) ? day[type] : undefined;
  return Array.isArray(v) ? [...v].sort().join(',') : '';
}

export function typeCovEqual(cov: TrendCoverage, d1: string, d2: string, type: string): boolean {
  const a = covSet(cov, d1, type);
  return a !== '' && a === covSet(cov, d2, type);
}

/** Whether one (day, type)'s coverage equals the RESOLVED account scope exactly. Stronger
 *  than endpoint-relative parity: an account silent on BOTH compared days passes typeCovEqual
 *  but silently narrows the presented scope — scope-relative completeness catches it. */
export function covComplete(cov: TrendCoverage, d: string, type: string, accounts: string[]): boolean {
  const have = covSet(cov, d, type);
  return have !== '' && have === [...accounts].sort().join(',');
}

/** Types whose snapshots are HOST-ONLY BY DESIGN: the sync lambda's SDK collectors run
 *  against the host account only (their `present` set is always ⊆ {'self'}), so their
 *  coverage can never include a member account. LOCKSTEP with sync_lambda.py's SDK_SYNCS
 *  keys (+ `public_s3_buckets`, the derived series riding the s3_public_access SDK sync) —
 *  pytest (test_sync_lambda_queries.py) pins this set against the Python dict. Without this
 *  exemption, covComplete against a multi-account scope would mark these types incomplete
 *  FOREVER (permanently blanking the KPI/chart/impact in exactly the multi-account scenario
 *  the scoping exists for) — the guard couldn't tell "silent this run" from "host-only". */
export const HOST_ONLY_TREND_TYPES: ReadonlySet<string> = new Set([
  's3',
  's3_public_access',
  'opensearch_serverless',
  'cloudfront_vpc_origin',
  'alb_listener_rule',
  'public_s3_buckets',
]);

/** The account set a type's snapshot coverage can EVER reach under the resolved scope:
 *  host-only types are checked against `resolved ∩ {'self'}`; everything else against the
 *  full resolved scope. An empty result fails covComplete (fail-closed) — such a type
 *  shouldn't have rows under that scope at all. */
export function expectedAccounts(type: string, resolved: string[]): string[] {
  return HOST_ONLY_TREND_TYPES.has(type) ? resolved.filter((a) => a === 'self') : resolved;
}

/** covComplete against the type's EXPECTED scope (see expectedAccounts). */
export function covCompleteForScope(cov: TrendCoverage, d: string, type: string, resolved: string[]): boolean {
  return covComplete(cov, d, type, expectedAccounts(type, resolved));
}

/** Order-insensitive account-set equality — for cross-checking two fetches' RESOLVED scopes
 *  (e.g. the chart's and the cost-impact's independent trend responses): each request resolves
 *  `__all__` on its own, so one can fall back to self while the other doesn't. */
export function sameAccountSet(a: string[], b: string[]): boolean {
  return [...a].sort().join(',') === [...b].sort().join(',');
}

/** Own-property check for the derived-series map: resource_type values pass a snake_case
 *  charset guard, which still admits Object.prototype keys ('constructor') and '__proto__' —
 *  an `in` lookup would misclassify them (the applyTerms hasOwnProperty precedent). */
export function isDerivedTrendType(k: string): boolean {
  return Object.prototype.hasOwnProperty.call(DERIVED_TREND_TYPES, k);
}

/** Derived security-count trend series (gap L129), written by the sync lambda's
 *  DERIVED_SNAPSHOTS (scripts/v2/steampipe/sync_lambda.py — LOCKSTEP: keys must match) from
 *  the /security predicates in security-findings.ts. Excluded from the trend `total` (the
 *  underlying resources are already counted by their base series); labels are the v1-parity
 *  series names (these keys are not inventory types, so INV_LABEL would show raw keys). */
export const DERIVED_TREND_TYPES: Record<string, string> = {
  public_s3_buckets: 'Public S3 Buckets',
  open_security_groups: 'Open Security Groups',
  unencrypted_ebs: 'Unencrypted EBS Volumes',
};

/** Nearest snapshot to `daysAgo` within ±2 CALENDAR days (v1 tolerance): the target is
 *  date-normalized so gaps are integral — comparing against a time-of-day-bearing now() made
 *  the window asymmetric and wall-clock-dependent. Shared by the delta table and the KPI bar. */
export function nearestSnapshot<T extends TrendPointLike>(pts: T[], daysAgo: number): T | null {
  const target = new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
  let best: T | null = null;
  let bestGap = 3;
  // Ties resolve toward the NEWER candidate (<= over date-ascending input): with −8d and −6d
  // both at gap 2, preferring −8d would label a 9-day span "7d" — asymmetric with the
  // stale-latest guard below.
  for (const p of [...pts].sort((a, b) => a.date.localeCompare(b.date))) {
    const gap = Math.abs((new Date(p.date).getTime() - new Date(target).getTime()) / 86_400_000);
    if (gap <= bestGap && gap < 3) { best = p; bestGap = gap; }
  }
  return best;
}

/** 7d(-ish) net change of the fleet total, honest-degrade to null (rendered '—') when the data
 *  cannot support the claim:
 *  - fewer than 2 snapshots, or no baseline within the ±2-calendar-day tolerance;
 *  - the qualifying baseline IS the latest snapshot (a stale-sync self-diff fabricates 0);
 *  - the LATEST snapshot itself is >2 days old, or the ACTUAL endpoint span falls outside
 *    daysAgo±2 (each endpoint tolerance alone still admitted a 3-day diff labeled "7d");
 *  - STRICT TYPE-SET PARITY: both days must snapshot the SAME type set — the writer emits one
 *    row per type on its own success path, so a mid-fan-out or partially failed day carries a
 *    different type set, and any diff over it (raw OR intersection) is a sync artifact
 *    presented as a fleet change. Parity mismatch → null ('—');
 *  - STRICT PER-TYPE ACCOUNT-SET PARITY (`coverage`, gap L124): points are summed ACROSS the
 *    selected accounts, so type-set parity alone is blind to a whole account going silent
 *    (its type keys survive via the other accounts — that silence would read as a genuine
 *    fleet decrease, and the deploy boundary, where baseline days carry only 'self' rows, as
 *    growth). Parity is checked PER TYPE, not per day: the sync runs per type with its own
 *    trusted-account set, so an account reachable for lambda but silent for ec2 on the same
 *    day differs only at the (day, type) grain. EVERY summed type must cover the same
 *    account set on both endpoint days, else null ('—'). When the RESOLVED scope
 *    (`accounts`) is also given, both endpoint days must cover exactly that set — an
 *    account silent on BOTH days passes day-to-day parity but would silently present a
 *    narrower fleet than the selector implies.
 *  Derived security series (DERIVED_TREND_TYPES) are excluded from the sum — their resources
 *  are already counted by their base series (the route excludes them from `total` for the
 *  same reason). */
export function netChange(
  pts: TrendPointLike[],
  daysAgo: number,
  coverage?: TrendCoverage,
  accounts?: string[],
): number | null {
  if (pts.length < 2) return null;
  const sorted = [...pts].sort((a, b) => a.date.localeCompare(b.date)); // input order not assumed
  const last = sorted[sorted.length - 1];
  if (nearestSnapshot(sorted, 0) !== last) return null; // latest point itself is stale
  const base = nearestSnapshot(sorted, daysAgo);
  if (!base || base === last) return null;
  // The two guards above anchor each endpoint to TODAY independently, which still admits a
  // short span (latest 2d old + baseline 5d old = a 3-day diff labeled "7d"). Validate the
  // ACTUAL span between the endpoints — outside daysAgo±2 → null ('—').
  const spanDays = Math.abs(
    (new Date(last.date).getTime() - new Date(base.date).getTime()) / 86_400_000,
  );
  if (Math.abs(spanDays - daysAgo) > 2) return null;
  // STRICT type-set parity: the two days must snapshot the SAME type set, else null ('—').
  // An intersection diff was still a confident partial number for a mid-fan-out day (the
  // latest day builds progressively — one snapshot row per type on its own success path);
  // parity also nulls the window where a genuinely new type has no 7d-old baseline yet.
  // Derived series are excluded from BOTH the parity set and the sum: excluding them from the
  // sum alone would let a derived-only fan-out difference null a perfectly comparable pair,
  // and including them in the sum double-counts (ebs_volume + unencrypted_ebs move together).
  const typeKeys = (p: TrendPointLike) =>
    Object.keys(p)
      .filter((k) => k !== 'date' && k !== 'total' && !isDerivedTrendType(k) && typeof p[k] === 'number')
      .sort();
  const lastKeys = typeKeys(last);
  const baseKeys = typeKeys(base);
  if (!lastKeys.length || lastKeys.join(',') !== baseKeys.join(',')) return null;
  // STRICT per-type account-set parity (see doc above). A provided-but-empty coverage for a
  // summed type on either endpoint day is a mismatch, not a pass — absence can't prove parity.
  // With the resolved scope, parity upgrades to scope-relative completeness on BOTH days.
  if (coverage) {
    for (const k of lastKeys) {
      const ok = accounts
        ? covCompleteForScope(coverage, last.date, k, accounts)
          && covCompleteForScope(coverage, base.date, k, accounts)
        : typeCovEqual(coverage, last.date, base.date, k);
      if (!ok) return null;
    }
  }
  const sumOf = (p: TrendPointLike) => lastKeys.reduce((s, k) => s + Number(p[k] ?? 0), 0);
  return sumOf(last) - sumOf(base);
}
