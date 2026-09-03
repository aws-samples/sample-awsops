import { describe, it, expect } from 'vitest';
import { mergeBedrock } from './bedrock-merge';

const model = (over: Record<string, unknown>) => ({
  modelId: 'm1', label: 'M1', invocations: 1, inputTokens: 0, outputTokens: 0,
  avgLatencyMs: 0, clientErrors: 0, serverErrors: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  cost: { inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheWriteCost: 0, total: 0, cacheSavings: 0 },
  ...over,
});

describe('mergeBedrock per-model series (gap L184 round-1)', () => {
  it('merges invSeries/tokenSeries by timestamp across accounts — the detail charts must sum ALL accounts like the scalars do', () => {
    const a = { range: '24h', totalCost: 0, series: [], models: [model({
      invSeries: [{ t: '2026-06-10T00:00:00Z', v: 10 }],
      tokenSeries: [{ t: '2026-06-10T00:00:00Z', v: 100 }],
    })] };
    const b = { range: '24h', totalCost: 0, series: [], models: [model({
      invSeries: [{ t: '2026-06-10T00:00:00Z', v: 5 }, { t: '2026-06-10T01:00:00Z', v: 3 }],
      tokenSeries: [{ t: '2026-06-10T01:00:00Z', v: 40 }],
    })] };
    const merged = mergeBedrock([a, b] as never);
    const m = merged.models[0];
    expect(m.invSeries).toEqual([
      { t: '2026-06-10T00:00:00Z', v: 15 },
      { t: '2026-06-10T01:00:00Z', v: 3 },
    ]);
    expect(m.tokenSeries).toEqual([
      { t: '2026-06-10T00:00:00Z', v: 100 },
      { t: '2026-06-10T01:00:00Z', v: 40 },
    ]);
  });
  it('a model with no series in any account merges to empty arrays (honest no-data, not a copy of nothing)', () => {
    const merged = mergeBedrock([{ range: '1h', totalCost: 0, series: [], models: [model({})] }] as never);
    expect(merged.models[0].invSeries).toEqual([]);
    expect(merged.models[0].tokenSeries).toEqual([]);
  });
});
