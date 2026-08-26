import { describe, it, expect } from 'vitest';
import { getModelLabel, getModelPricing, computeCost, RANGE_CONFIGS, MODEL_PRICING } from './bedrock';

describe('getModelPricing', () => {
  it('exact-matches a known id', () => {
    expect(getModelPricing('anthropic.claude-opus-4-8')).toEqual({ input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 });
  });
  it('normalizes cross-region prefixes (us./ap./eu./global.)', () => {
    for (const pfx of ['us.', 'ap.', 'eu.', 'global.']) {
      expect(getModelPricing(`${pfx}anthropic.claude-haiku-4-5`).input).toBe(1);
    }
  });
  it('family fallback for unknown ids', () => {
    expect(getModelPricing('anthropic.claude-haiku-99').input).toBe(0.25);
    expect(getModelPricing('anthropic.claude-opus-99').input).toBe(15);
    expect(getModelPricing('something.else').input).toBe(3); // default sonnet-ish
  });
});

describe('getModelLabel', () => {
  it('returns the friendly label, normalizing cross-region prefixes', () => {
    expect(getModelLabel('anthropic.claude-opus-4-8')).toBe('Claude Opus 4.8');
    expect(getModelLabel('ap.anthropic.claude-haiku-4-5')).toBe('Claude Haiku 4.5');
  });
  it('derives a readable name for unknown ids', () => {
    expect(getModelLabel('amazon.titan-foo-v2:0')).toBe('titan-foo');
  });
});

describe('RANGE_CONFIGS', () => {
  it('has the expected ranges with hours/period', () => {
    expect(Object.keys(RANGE_CONFIGS)).toEqual(['1h', '6h', '24h', '7d', '30d']);
    expect(RANGE_CONFIGS['24h']).toEqual({ hours: 24, period: 3600 });
  });
});

describe('computeCost', () => {
  it('computes per-component USD from per-1M-token pricing', () => {
    const p = MODEL_PRICING['anthropic.claude-haiku-4-5']; // input 1, output 5, cacheRead .1, cacheWrite 1.25
    const c = computeCost({ inputTokens: 1_000_000, outputTokens: 2_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 },
      { input: p.input, output: p.output, cacheRead: p.cacheRead!, cacheWrite: p.cacheWrite! });
    expect(c.inputCost).toBeCloseTo(1);
    expect(c.outputCost).toBeCloseTo(10);
    expect(c.cacheReadCost).toBeCloseTo(0.1);
    expect(c.total).toBeCloseTo(11.1);
    // cacheSavings = 1M * (input 1 - cacheRead 0.1) / 1e6 = 0.9
    expect(c.cacheSavings).toBeCloseTo(0.9);
  });
  it('zero usage → zero cost', () => {
    const c = computeCost({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
    expect(c.total).toBe(0);
    expect(c.cacheSavings).toBe(0);
  });
});
