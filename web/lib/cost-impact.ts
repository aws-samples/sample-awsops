// Cost Impact Estimation (gap L225, v1 parity): 30-day resource-count delta × a STATIC
// monthly-unit-cost heuristic per type → '±$N/mo est.' list, |impact| descending. This is
// v1's approach verbatim (static weights, client-only) with ap-northeast-2-flavored
// approximations for a typical small/medium footprint — deliberately NOT billing data (the
// Cost page shows actuals). Honest bounds: a type with no 30d baseline or no weight entry
// contributes NOTHING (never a fabricated $0), matching the delta table's '—' semantics.

/** Approximate monthly USD per ONE resource of the type (static heuristic — see header). */
export const COST_IMPACT_WEIGHTS: Record<string, number> = {
  ec2: 80,             // ~t3.large-ish on-demand month
  rds: 200,            // small Multi-AZ-ish instance
  nat_gateway: 45,     // hourly base, ex-traffic
  ebs_volume: 10,      // ~100GB gp3
  ebs_snapshot: 2,
  alb: 25,             // hourly base, ex-LCU
  nlb: 25,
  elasticache: 100,    // cache.r-class node-ish
  opensearch: 150,     // small domain
  msk: 300,            // 2-broker small cluster
  dynamodb: 20,        // light on-demand table
  cloudfront: 20,      // light distribution, ex-heavy egress
  lambda: 5,           // light invocation volume
  s3: 5,               // light bucket
};

export interface CostImpactRow {
  type: string;
  delta: number;      // 30d count change (cur - baseline)
  monthly: number;    // delta × weight (signed USD/month)
}

/**
 * Rows eligible for the impact list: both counts known (null = no snapshot for that type on
 * that day — excluded, never treated as 0) AND a weight entry exists AND the count moved.
 * Sorted by |monthly| descending, capped to `top`.
 */
export function estimateCostImpact(
  rows: { type: string; cur: number | null; m: number | null }[],
  top = 8,
): CostImpactRow[] {
  const out: CostImpactRow[] = [];
  for (const r of rows) {
    const w = COST_IMPACT_WEIGHTS[r.type];
    if (w == null || r.cur == null || r.m == null) continue;
    const delta = r.cur - r.m;
    if (delta === 0) continue;
    out.push({ type: r.type, delta, monthly: delta * w });
  }
  return out.sort((a, b) => Math.abs(b.monthly) - Math.abs(a.monthly)).slice(0, top);
}
