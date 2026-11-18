// Legacy publications retain sums but do not attest the duration denominator or histogram.
const count = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
const nonnegative = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

export function spanMeasurements(meta: Record<string, unknown> = {}) {
  const spanCount = count(meta.spanCount),
    unknown = count(meta.unknownStatusSpanCount),
    reportedErrors = count(meta.errorSpanCount);
  const knownStatus = spanCount !== null && unknown !== null && unknown <= spanCount ? spanCount - unknown : null;
  const errors =
    reportedErrors !== null &&
    spanCount !== null &&
    reportedErrors <= (knownStatus ?? spanCount) &&
    (unknown === null || unknown <= spanCount)
      ? reportedErrors
      : null;
  const errorFraction =
    knownStatus !== null && knownStatus > 0 && errors !== null && errors <= knownStatus ? errors / knownStatus : null;
  return {
    spanCount,
    knownStatus,
    errors,
    errorFraction,
    durationSumMs: spanCount !== null && spanCount > 0 ? nonnegative(meta.sampledDurationMs) : null,
  };
}

export function edgeCounts(v: unknown): { spanCount?: number; metricCount?: number } {
  const m = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const spans = count(m.spanCount),
    metrics = nonnegative(m.metricCount);
  return { ...(spans !== null ? { spanCount: spans } : {}), ...(metrics !== null ? { metricCount: metrics } : {}) };
}
