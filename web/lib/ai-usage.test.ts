import { describe, it, expect } from 'vitest';
import { priceUsage, type UsageRow } from './ai-usage';

describe('priceUsage', () => {
  it('prices a known model via bedrock.ts rates (1M input → $3 for Sonnet)', () => {
    const rows: UsageRow[] = [
      { model: 'global.anthropic.claude-sonnet-4-6', input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
    ];
    const { models, totalCost } = priceUsage(rows);
    expect(models).toHaveLength(1);
    expect(models[0].model).toBe('global.anthropic.claude-sonnet-4-6');
    expect(models[0].label).toBe('Claude Sonnet 4.6'); // cross-region prefix stripped
    expect(models[0].cost.total).toBeCloseTo(3, 6);
    expect(totalCost).toBeCloseTo(3, 6);
  });

  it('sums output + cache costs and aggregates across models', () => {
    const rows: UsageRow[] = [
      // Opus: 1M output = $75; 1M cacheRead = $1.50
      { model: 'global.anthropic.claude-opus-4-8', input_tokens: 0, output_tokens: 1_000_000, cache_read_tokens: 1_000_000, cache_write_tokens: 0 },
      // Haiku: 1M input = $1
      { model: 'global.anthropic.claude-haiku-4-5', input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
    ];
    const { models, totalCost } = priceUsage(rows);
    expect(models).toHaveLength(2);
    expect(totalCost).toBeCloseTo(75 + 1.5 + 1, 5);
  });

  it('falls back to default pricing for an unknown model id', () => {
    const rows: UsageRow[] = [
      { model: 'global.anthropic.claude-newmodel-9-9', input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
    ];
    const { totalCost } = priceUsage(rows);
    // unknown non-haiku/opus → default sonnet-class input rate $3
    expect(totalCost).toBeCloseTo(3, 6);
  });

  it('handles node-pg bigint-as-string token values (SUM(...)::bigint returns strings)', () => {
    const rows = [
      { model: 'global.anthropic.claude-sonnet-4-6', input_tokens: '1000000', output_tokens: '0', cache_read_tokens: '0', cache_write_tokens: '0' } as unknown as UsageRow,
    ];
    const { models, totalCost } = priceUsage(rows);
    expect(models[0].inputTokens).toBe(1_000_000);
    expect(totalCost).toBeCloseTo(3, 6);
  });

  it('empty input → zero', () => {
    expect(priceUsage([])).toEqual({ models: [], totalCost: 0 });
  });

  it('collapses ARN-key + bare-key rows for the same model (no double-count, order-independent)', () => {
    const rows: UsageRow[] = [
      // legacy full-ARN row (worker) + bare-id row (AgentCore) for the SAME model + day-range
      { model: 'arn:aws:bedrock:ap-northeast-2:1:inference-profile/global.anthropic.claude-opus-4-8', input_tokens: 0, output_tokens: 1_000_000, cache_read_tokens: 0, cache_write_tokens: 0 },
      { model: 'global.anthropic.claude-opus-4-8', input_tokens: 0, output_tokens: 1_000_000, cache_read_tokens: 0, cache_write_tokens: 0 },
    ];
    const { models, totalCost } = priceUsage(rows);
    expect(models).toHaveLength(1); // merged into one canonical model
    expect(models[0].outputTokens).toBe(2_000_000);
    expect(totalCost).toBeCloseTo(150, 5); // 2M output × $75/M — counted once, not 4× double-counted
  });
});
