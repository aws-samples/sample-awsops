import { describe, it, expect } from 'vitest';
import { estimateCostImpact, COST_IMPACT_WEIGHTS } from './cost-impact';

describe('estimateCostImpact (gap L225 — static-weight heuristic)', () => {
  it('multiplies the 30d delta by the static weight, sorted by |impact| desc', () => {
    const out = estimateCostImpact([
      { type: 'ec2', cur: 12, m: 10 },       // +2 × 80 = +160
      { type: 'rds', cur: 1, m: 2 },         // −1 × 200 = −200
      { type: 'nat_gateway', cur: 3, m: 3 }, // no change → excluded
    ]);
    expect(out).toEqual([
      { type: 'rds', delta: -1, monthly: -200 },
      { type: 'ec2', delta: 2, monthly: 160 },
    ]);
  });
  it('excludes null baselines/currents (no snapshot ≠ zero) and unweighted types', () => {
    const out = estimateCostImpact([
      { type: 'ec2', cur: 5, m: null },        // no 30d baseline → excluded, not −100%
      { type: 'ec2', cur: null, m: 5 },        // no current → excluded
      { type: 'iam_role', cur: 40, m: 10 },    // no weight entry → excluded
    ]);
    expect(out).toEqual([]);
  });
  it('caps to top N by |impact|', () => {
    const rows = Object.keys(COST_IMPACT_WEIGHTS).map((type, i) => ({ type, cur: i + 2, m: 1 }));
    expect(estimateCostImpact(rows, 3)).toHaveLength(3);
  });
  it('weights are static constants (v1 parity — heuristic, not live pricing)', () => {
    expect(COST_IMPACT_WEIGHTS.rds).toBe(200);
    expect(COST_IMPACT_WEIGHTS.nat_gateway).toBe(45);
    expect(COST_IMPACT_WEIGHTS.ec2).toBe(80);
  });
});
