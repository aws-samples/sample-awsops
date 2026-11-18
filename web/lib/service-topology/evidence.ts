import type { ScopeDomain, SourceEvidence, TimeWindow } from './types';

export const validWindow = (w: TimeWindow | null | undefined): w is TimeWindow =>
  !!w &&
  Number.isSafeInteger(w.start) &&
  Number.isSafeInteger(w.end) &&
  w.start >= 0 &&
  w.start <= w.end &&
  w.end <= 8640000000000000;
export const containsWindow = (outer: TimeWindow | null, inner: TimeWindow | null) =>
  validWindow(outer) && validWindow(inner) && outer.start <= inner.start && inner.end <= outer.end;

export function overlapsDomain(a: ScopeDomain, b: ScopeDomain) {
  return (['account', 'region', 'vpc'] as const).every((k) => !a[k] || !b[k] || a[k] === b[k]);
}

export function qualifyEvidence(e: SourceEvidence, scope: ScopeDomain, observed: TimeWindow | null) {
  if (!overlapsDomain(e, scope)) return 'disjoint';
  if (
    !scope.account ||
    !scope.region ||
    !scope.vpc ||
    e.account !== scope.account ||
    e.region !== scope.region ||
    e.vpc !== scope.vpc
  )
    return 'missing_scope';
  if (
    !e.id ||
    e.status !== 'ok' ||
    e.complete !== true ||
    e.stale !== false ||
    e.retained !== false ||
    e.capturedAt == null ||
    !Number.isSafeInteger(e.capturedAt) ||
    !validWindow(e.window) ||
    e.capturedAt > 8640000000000000 ||
    e.capturedAt < e.window.end
  )
    return 'unverified_source';
  return containsWindow(e.window, observed) ? 'qualified' : 'unverified_window';
}
