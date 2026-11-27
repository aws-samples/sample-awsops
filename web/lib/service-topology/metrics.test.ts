import { expect, it } from 'vitest';
import { spanMeasurements, edgeCounts } from './metrics';

it('uses the known-status denominator and preserves the published duration sum only once', () => {
  const m = spanMeasurements({ spanCount: 10, unknownStatusSpanCount: 2, errorSpanCount: 2, sampledDurationMs: 240 });
  expect(m).toEqual({ spanCount: 10, knownStatus: 8, errors: 2, errorFraction: 0.25, durationSumMs: 240 });
});
it('keeps missing, contradictory and metric-only observations unknown', () => {
  expect(spanMeasurements({ spanCount: 5, errorSpanCount: 5, unknownStatusSpanCount: 2 }).errorFraction).toBeNull();
  expect(spanMeasurements({ spanCount: 0, sampledDurationMs: 0 }).durationSumMs).toBeNull();
  expect(spanMeasurements({ spanCount: 4, errorSpanCount: 6 }).errors).toBeNull();
  expect(edgeCounts({ metricCount: 7.5 })).toEqual({ metricCount: 7.5 });
  expect(edgeCounts({ spanCount: -1, metricCount: Infinity, private: 'omitted' })).toEqual({});
});
