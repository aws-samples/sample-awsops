// web/lib/diff.ts
// Plan-2 report-vs-parent regression diff. PURE — no IO. Operates over the `summary` JSONB of two
// diagnosis reports (the verdict-only `drift` array + an optional `posture` severity-count map).
//
// A REGRESSION is either:
//   - an invariant `id` present in current.drift but NOT in parent.drift (a newly-failing drift), or
//   - a posture severity count that INCREASED vs the parent.
// An IMPROVEMENT is the converse: a drift `id` that failed in the parent but no longer does, or a
// posture severity count that decreased. This mirrors the worker's `_diff_summary` in report.py and
// extends it with the posture-count comparison the plan requires.

export interface Verdict {
  id?: number | string;
  kind?: string;
  target?: string | null;
  severity?: string;
  passed?: boolean | null;
  observed?: string;
}

export interface ReportSummary {
  drift?: Verdict[];
  posture?: Record<string, number>;
  [k: string]: unknown;
}

export interface ReportDiff {
  regressions: Verdict[];
  improvements: (number | string)[];
  unchanged: boolean;
}

function driftIds(s: ReportSummary | null | undefined): Set<number | string> {
  return new Set((s?.drift ?? []).map((v) => v.id).filter((id): id is number | string => id != null));
}

export function diffReports(
  current: ReportSummary | null | undefined,
  parent: ReportSummary | null | undefined,
): ReportDiff {
  const curDrift = current?.drift ?? [];
  const parentIds = driftIds(parent);
  const curIds = driftIds(current);

  const regressions: Verdict[] = [];
  const improvements: (number | string)[] = [];

  // No parent to diff against → first report; surface nothing as a regression/improvement.
  if (!parent) {
    return { regressions: [], improvements: [], unchanged: false };
  }

  // 1) Drift-level diff (invariant ids).
  for (const v of curDrift) {
    if (v.id != null && !parentIds.has(v.id)) regressions.push(v);
  }
  for (const id of parentIds) {
    if (!curIds.has(id)) improvements.push(id);
  }

  // 2) Posture severity-count diff (a count increase is a regression; a decrease an improvement).
  const curPosture = current?.posture ?? {};
  const parentPosture = parent?.posture ?? {};
  const severities = new Set([...Object.keys(curPosture), ...Object.keys(parentPosture)]);
  for (const sev of severities) {
    const cur = curPosture[sev] ?? 0;
    const prev = parentPosture[sev] ?? 0;
    if (cur > prev) {
      regressions.push({ kind: 'posture', severity: sev, observed: `${sev}: ${prev} → ${cur}` });
    } else if (cur < prev) {
      improvements.push(`posture:${sev}`);
    }
  }

  return {
    regressions,
    improvements,
    unchanged: regressions.length === 0 && improvements.length === 0,
  };
}
