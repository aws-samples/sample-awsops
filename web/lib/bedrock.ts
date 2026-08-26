// Pure Bedrock pricing + cost math (no SDK). Ported from v1 src/app/api/bedrock-metrics/route.ts.
// Pricing = USD per 1M tokens (ap-northeast-2 cross-region inference).

export interface ModelPricing { input: number; output: number; cacheRead: number; cacheWrite: number }

interface PriceEntry { input: number; output: number; cacheRead?: number; cacheWrite?: number; label: string }

export const MODEL_PRICING: Record<string, PriceEntry> = {
  'anthropic.claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75, label: 'Claude Sonnet 5' },
  'anthropic.claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75, label: 'Claude Sonnet 4.6' },
  'anthropic.claude-sonnet-4-6-v1': { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75, label: 'Claude Sonnet 4.6' },
  'anthropic.claude-opus-4-8': { input: 15, output: 75, cacheRead: 1.50, cacheWrite: 18.75, label: 'Claude Opus 4.8' },
  'anthropic.claude-opus-4-7': { input: 15, output: 75, cacheRead: 1.50, cacheWrite: 18.75, label: 'Claude Opus 4.7' },
  'anthropic.claude-opus-4-6-v1': { input: 15, output: 75, cacheRead: 1.50, cacheWrite: 18.75, label: 'Claude Opus 4.6' },
  'anthropic.claude-opus-4-6': { input: 15, output: 75, cacheRead: 1.50, cacheWrite: 18.75, label: 'Claude Opus 4.6' },
  'anthropic.claude-haiku-4-5-20251001-v1:0': { input: 1, output: 5, cacheRead: 0.10, cacheWrite: 1.25, label: 'Claude Haiku 4.5' },
  'anthropic.claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.10, cacheWrite: 1.25, label: 'Claude Haiku 4.5' },
  'anthropic.claude-sonnet-4-5-20250514-v1:0': { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75, label: 'Claude Sonnet 4.5' },
  'anthropic.claude-opus-4-0-20250514-v1:0': { input: 15, output: 75, cacheRead: 1.50, cacheWrite: 18.75, label: 'Claude Opus 4' },
  'anthropic.claude-3-5-sonnet-20241022-v2:0': { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75, label: 'Claude 3.5 Sonnet v2' },
  'anthropic.claude-3-5-sonnet-20240620-v1:0': { input: 3, output: 15, label: 'Claude 3.5 Sonnet' },
  'anthropic.claude-3-5-haiku-20241022-v1:0': { input: 0.80, output: 4, cacheRead: 0.08, cacheWrite: 1, label: 'Claude 3.5 Haiku' },
  'anthropic.claude-3-haiku-20240307-v1:0': { input: 0.25, output: 1.25, label: 'Claude 3 Haiku' },
  'anthropic.claude-3-sonnet-20240229-v1:0': { input: 3, output: 15, label: 'Claude 3 Sonnet' },
  'anthropic.claude-3-opus-20240229-v1:0': { input: 15, output: 75, label: 'Claude 3 Opus' },
  'amazon.nova-pro-v1:0': { input: 0.80, output: 3.20, label: 'Nova Pro' },
  'amazon.nova-lite-v1:0': { input: 0.06, output: 0.24, label: 'Nova Lite' },
  'amazon.nova-micro-v1:0': { input: 0.035, output: 0.14, label: 'Nova Micro' },
  'amazon.titan-text-express-v1': { input: 0.20, output: 0.60, label: 'Titan Text Express' },
};

const CROSS_REGION = /^(us\.|eu\.|ap\.|global\.)/;

/** Friendly model label; strips cross-region prefixes and falls back to a readable id. */
export function getModelLabel(modelId: string): string {
  if (MODEL_PRICING[modelId]) return MODEL_PRICING[modelId].label;
  const base = modelId.replace(CROSS_REGION, '');
  if (MODEL_PRICING[base]) return MODEL_PRICING[base].label;
  const parts = modelId.split('.');
  return parts.length > 1 ? parts.slice(1).join('.').replace(/-v\d.*$/, '') : modelId;
}

/** Pricing for a model id, normalizing cross-region prefixes; family fallback when unknown. */
export function getModelPricing(modelId: string): ModelPricing {
  const base = modelId.replace(CROSS_REGION, '');
  const p = MODEL_PRICING[base] || MODEL_PRICING[modelId];
  if (p) return { input: p.input, output: p.output, cacheRead: p.cacheRead ?? 0, cacheWrite: p.cacheWrite ?? 0 };
  if (modelId.includes('haiku')) return { input: 0.25, output: 1.25, cacheRead: 0, cacheWrite: 0 };
  if (modelId.includes('opus')) return { input: 15, output: 75, cacheRead: 1.50, cacheWrite: 18.75 };
  return { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 };
}

export const RANGE_CONFIGS: Record<string, { hours: number; period: number }> = {
  '1h': { hours: 1, period: 300 },
  '6h': { hours: 6, period: 300 },
  '24h': { hours: 24, period: 3600 },
  '7d': { hours: 168, period: 86400 },
  '30d': { hours: 720, period: 86400 },
};

export interface TokenUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
export interface CostBreakdown { inputCost: number; outputCost: number; cacheReadCost: number; cacheWriteCost: number; total: number; cacheSavings: number }

/** Compute USD cost from token usage + pricing (per-1M-token rates). cacheSavings = what cache reads saved vs full input price. */
export function computeCost(u: TokenUsage, p: ModelPricing): CostBreakdown {
  const inputCost = (u.inputTokens / 1e6) * p.input;
  const outputCost = (u.outputTokens / 1e6) * p.output;
  const cacheReadCost = (u.cacheReadTokens / 1e6) * p.cacheRead;
  const cacheWriteCost = (u.cacheWriteTokens / 1e6) * p.cacheWrite;
  const total = inputCost + outputCost + cacheReadCost + cacheWriteCost;
  const cacheSavings = (u.cacheReadTokens * Math.max(0, p.input - p.cacheRead)) / 1e6;
  return { inputCost, outputCost, cacheReadCost, cacheWriteCost, total, cacheSavings };
}
