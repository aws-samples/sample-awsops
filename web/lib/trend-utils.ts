// Home-dashboard trend helpers (gap L127) — pure, unit-tested. Extracted from app/page.tsx
// (Next.js pages may not export extra symbols).

export interface TrendPointLike { date: string; total?: number | string; [k: string]: unknown }

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
 *    presented as a fleet change. Parity mismatch → null ('—'). */
export function netChange(pts: TrendPointLike[], daysAgo: number): number | null {
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
  const typeKeys = (p: TrendPointLike) =>
    Object.keys(p).filter((k) => k !== 'date' && k !== 'total' && typeof p[k] === 'number').sort();
  const lastKeys = typeKeys(last);
  const baseKeys = typeKeys(base);
  if (!lastKeys.length || lastKeys.join(',') !== baseKeys.join(',')) return null;
  const sumOf = (p: TrendPointLike) => lastKeys.reduce((s, k) => s + Number(p[k] ?? 0), 0);
  return sumOf(last) - sumOf(base);
}
