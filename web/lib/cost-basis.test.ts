import { describe, it, expect } from 'vitest';
import { ESTIMATE_UNIT_PRICES, estimateDailyCost, estimateDailyParts } from './cost-basis';
import { estimatePodCost } from './opencost-allocation';

describe('cost-basis (gap L217 single price source)', () => {
  it('pins the documented unit prices — the panel and the estimator share these', () => {
    expect(ESTIMATE_UNIT_PRICES.vcpuHour).toBe(0.04656);
    expect(ESTIMATE_UNIT_PRICES.gbHour).toBe(0.00511);
  });
  it('worked example: 0.5 vCPU + 1 GB ≈ $0.68/day', () => {
    const daily = estimateDailyCost(0.5, 1);
    expect(daily).toBeCloseTo(0.5 * 0.04656 * 24 + 1 * 0.00511 * 24, 10);
    expect(daily).toBeGreaterThan(0.67);
    expect(daily).toBeLessThan(0.69);
  });

  it('the ESTIMATOR consumes the same formula: a MiB-valued PodRow yields a NONZERO RAM cost', () => {
    // 1 GiB request arrives as memRequest = 1024 (MiB). The old /1e9-as-bytes bug zeroed RAM.
    const pod = estimatePodCost({ name: 'p', namespace: 'ns', node: 'n', cpuRequest: 0.5, memRequest: 1024 });
    const expected = estimateDailyParts(0.5, 1);
    expect(pod.ramCost).toBeCloseTo(Math.round(expected.ram * 100) / 100, 10);
    expect(pod.ramCost).toBeGreaterThan(0.1); // 1 GiB × $0.00511 × 24 ≈ $0.123 — never $0.00
    expect(pod.totalCost).toBeCloseTo(Math.round(expected.total * 100) / 100, 10);
  });
});
