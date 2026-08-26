// Live hybrid accuracy gate — runs ONLY with LIVE_ROUTING=1 (real Bedrock calls, needs AWS creds).
import { describe, it, expect } from 'vitest';
import { classifyRoute, pickGateway } from './route';
import { classifyPrompt } from './classifier';
import golden from './fixtures/golden-routing.json';

describe.skipIf(!process.env.LIVE_ROUTING)('hybrid routing live accuracy (ADR-038 gate)', () => {
  it(`hybrid >= ${golden.sloAccuracy * 100}% AND >= regex baseline + ${golden.minDeltaPp}pp`, async () => {
    let regexCorrect = 0, hybridCorrect = 0;
    for (const c of golden.cases) {
      if (c.expect.includes(pickGateway(c.q))) regexCorrect++;
      const r = await classifyRoute(c.q, undefined, { llmEnabled: true, classify: classifyPrompt });
      if (c.expect.includes(r.primary)) hybridCorrect++;
    }
    const n = golden.cases.length;
    const baseline = regexCorrect / n, hybrid = hybridCorrect / n;
    // eslint-disable-next-line no-console
    console.log(`[golden-live] regex ${(baseline * 100).toFixed(1)}% → hybrid ${(hybrid * 100).toFixed(1)}%`);
    expect(hybrid).toBeGreaterThanOrEqual(golden.sloAccuracy);
    expect((hybrid - baseline) * 100).toBeGreaterThanOrEqual(golden.minDeltaPp);
  }, 420_000); // 65 cases × up to ~3.5s abort ceiling + backoffs
});
