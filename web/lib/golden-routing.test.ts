import { describe, it, expect } from 'vitest';
import { pickGateway } from './route';
import { SECTIONS } from './sections';
import golden from './fixtures/golden-routing.json';

const VALID = new Set(SECTIONS.map((s) => s.key));

describe('golden-routing fixture (ADR-038 §5)', () => {
  it('every expect key is a valid v2 section key', () => {
    for (const c of golden.cases) {
      for (const k of c.expect) expect(VALID.has(k), `${c.q} → ${k}`).toBe(true);
    }
  });
  it('has the SLO gate parameters', () => {
    expect(golden.sloAccuracy).toBeGreaterThanOrEqual(0.85);
    expect(golden.minDeltaPp).toBe(15);
    expect(golden.cases.length).toBeGreaterThanOrEqual(45);
  });
  it('reports the deterministic regex-only baseline (informational, not a gate)', () => {
    let correct = 0;
    for (const c of golden.cases) {
      if (c.expect.includes(pickGateway(c.q))) correct++;
    }
    const baseline = correct / golden.cases.length;
    // eslint-disable-next-line no-console
    console.log(`[golden] regex-only baseline: ${(baseline * 100).toFixed(1)}% (${correct}/${golden.cases.length})`);
    // NOTE: sloAccuracy 0.85 over 65 discrete cases means the live gate's effective bar is
    // ceil(0.85*65)=56/65 ≈ 86.2%. Baseline here moves if fixture labels change — bounds only.
    // sanity bounds only: baseline must leave headroom for the +15pp hybrid delta gate
    expect(baseline).toBeGreaterThan(0.3);
    expect(baseline).toBeLessThan(0.85);
  });
});
