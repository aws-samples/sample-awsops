// Client-side merge of per-account BedrockData (thin-BFF fan-out) — extracted from the
// bedrock page so the per-model series merge is unit-testable (a Next.js page may not export
// helpers). gap L184 round-1: per-model invSeries/tokenSeries MUST merge across accounts by
// timestamp — otherwise the detail charts silently show one account while the scalars sum all.
import type { CostBreakdown } from '@/lib/bedrock';

export interface ModelMetric {
  modelId: string; label: string; invocations: number; inputTokens: number; outputTokens: number;
  avgLatencyMs: number; clientErrors: number; serverErrors: number; cacheReadTokens: number; cacheWriteTokens: number; cost: CostBreakdown;
  // gap L184: per-model series (optional — an older cached API response may omit them).
  invSeries?: { t: string; v: number }[];
  tokenSeries?: { t: string; v: number }[];
}
export interface BedrockData { range: string; models: ModelMetric[]; totalCost: number; series: { t: string; tokens: number }[] }

/** Merge per-account BedrockData: sum per modelId (tokens/invocations/cost), invocation-weighted latency. */
export function mergeBedrock(parts: BedrockData[]): BedrockData {
  const byModel = new Map<string, ModelMetric>();
  const lat = new Map<string, { lat: number; inv: number }>();
  let totalCost = 0;
  const seriesByT = new Map<string, number>();
  // gap L184 (review round-1): per-model series must merge across accounts too — otherwise
  // the detail charts silently show ONE account while the surrounding scalars sum all.
  const invByModel = new Map<string, Map<string, number>>();
  const tokByModel = new Map<string, Map<string, number>>();
  const addSeries = (store: Map<string, Map<string, number>>, id: string, pts?: { t: string; v: number }[]) => {
    if (!pts?.length) return;
    const m = store.get(id) ?? new Map<string, number>();
    for (const pt of pts) m.set(pt.t, (m.get(pt.t) ?? 0) + pt.v);
    store.set(id, m);
  };
  for (const p of parts) {
    totalCost += p.totalCost ?? 0;
    for (const m of p.models ?? []) {
      const la = lat.get(m.modelId) ?? { lat: 0, inv: 0 };
      la.lat += (m.avgLatencyMs || 0) * (m.invocations || 0); la.inv += m.invocations || 0;
      lat.set(m.modelId, la);
      addSeries(invByModel, m.modelId, m.invSeries);
      addSeries(tokByModel, m.modelId, m.tokenSeries);
      const e = byModel.get(m.modelId);
      if (!e) { byModel.set(m.modelId, { ...m, cost: { ...m.cost } }); continue; }
      e.invocations += m.invocations; e.inputTokens += m.inputTokens; e.outputTokens += m.outputTokens;
      e.cacheReadTokens += m.cacheReadTokens; e.cacheWriteTokens += m.cacheWriteTokens;
      e.clientErrors += m.clientErrors; e.serverErrors += m.serverErrors;
      e.cost = {
        inputCost: e.cost.inputCost + m.cost.inputCost, outputCost: e.cost.outputCost + m.cost.outputCost,
        cacheReadCost: e.cost.cacheReadCost + m.cost.cacheReadCost, cacheWriteCost: e.cost.cacheWriteCost + m.cost.cacheWriteCost,
        total: e.cost.total + m.cost.total, cacheSavings: e.cost.cacheSavings + m.cost.cacheSavings,
      };
    }
    for (const s of p.series ?? []) seriesByT.set(s.t, (seriesByT.get(s.t) ?? 0) + s.tokens);
  }
  for (const [id, e] of byModel) {
    const la = lat.get(id)!; e.avgLatencyMs = la.inv ? la.lat / la.inv : 0;
    const toSeries = (m?: Map<string, number>) =>
      [...(m ?? new Map<string, number>()).entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([t, v]) => ({ t, v }));
    e.invSeries = toSeries(invByModel.get(id));
    e.tokenSeries = toSeries(tokByModel.get(id));
  }
  const series = [...seriesByT.entries()].map(([t, tokens]) => ({ t, tokens })).sort((a, b) => (a.t < b.t ? -1 : 1));
  return { range: parts[0]?.range ?? '', models: [...byModel.values()], totalCost, series };
}
