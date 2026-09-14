import { EKSClient, ListClustersCommand, DescribeClusterCommand } from '@aws-sdk/client-eks';
import { CostExplorerClient, GetCostAndUsageCommand, GetCostForecastCommand } from '@aws-sdk/client-cost-explorer';
import { assumedClient } from './aws-assume';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';

let eks: EKSClient | null = null;
function eksClient(): EKSClient { if (!eks) eks = new EKSClient({ region: REGION }); return eks; }
// Cost Explorer is a GLOBAL service → ALWAYS region us-east-1, regardless of the account's region.
// Account scoping comes from the assumed role (host/self → task-role creds), NOT the region.
function ceClient(accountId?: string): Promise<CostExplorerClient> {
  return assumedClient(accountId, CostExplorerClient, { region: 'us-east-1' });
}

export interface ClusterInfo {
  name: string; status: string; version: string; endpoint: string; createdAt: string;
  region: string; vpcId: string; platformVersion: string;
}

export async function listClusterInventory(accountId?: string): Promise<{ clusters: ClusterInfo[]; region: string; truncated: boolean }> {
  const c = accountId && accountId !== 'self' ? await assumedClient(accountId, EKSClient, { region: REGION }) : eksClient();
  const { clusters = [], nextToken } = await c.send(new ListClustersCommand({ maxResults: 25 }));
  const out: ClusterInfo[] = [];
  for (const name of clusters.slice(0, 25)) {
    const { cluster } = await c.send(new DescribeClusterCommand({ name }));
    out.push({
      name,
      status: cluster?.status ?? '?',
      version: cluster?.version ?? '?',
      endpoint: cluster?.endpoint ?? '',
      createdAt: cluster?.createdAt instanceof Date ? cluster.createdAt.toISOString() : '',
      region: REGION,
      vpcId: cluster?.resourcesVpcConfig?.vpcId ?? '',
      platformVersion: cluster?.platformVersion ?? '',
    });
  }
  return { clusters: out, region: REGION, truncated: !!nextToken || clusters.length > 25 };
}

export async function listClusters(accountId?: string): Promise<ClusterInfo[]> {
  return (await listClusterInventory(accountId)).clusters;
}

export interface CostBreakdown { total: number; currency: string; byService: { service: string; amount: number }[] }

// Cost Explorer has no cluster dimension — this relies on the AWS-generated tag
// `aws:ecs:clusterName` (activated as a cost-allocation tag; see terraform/foundation
// variable `ecs_cost_tag_active`). Untagged usage groups under the empty-value bucket
// (key `aws:ecs:clusterName$`, no `$name` suffix) — dropped, not a real cluster.
// Cluster names are only unique per-region, and inventory_resources keys ecs_cluster rows
// by name+region — so the REGION dimension is grouped too and the result keyed `region|name`,
// otherwise same-named clusters in different regions would collapse into one summed bucket.
export async function getEcsClusterCosts(accountId?: string): Promise<Record<string, number>> {
  const now = new Date();
  const start = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const end = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  const r = await (await ceClient(accountId)).send(new GetCostAndUsageCommand({
    TimePeriod: { Start: start, End: end },
    Granularity: 'MONTHLY',
    Metrics: ['UnblendedCost'],
    GroupBy: [
      { Type: 'DIMENSION', Key: 'REGION' },
      { Type: 'TAG', Key: 'aws:ecs:clusterName' },
    ],
  }));
  const groups = r.ResultsByTime?.[0]?.Groups ?? [];
  const out: Record<string, number> = {};
  for (const g of groups) {
    const region = g.Keys?.[0] ?? '';
    const name = g.Keys?.[1]?.split('$')[1];
    if (!name) continue;
    out[`${region}|${name}`] = Math.round(Number(g.Metrics?.UnblendedCost?.Amount ?? 0) * 100) / 100;
  }
  return out;
}

export async function getMtdCost(accountId?: string): Promise<CostBreakdown> {
  const now = new Date();
  const start = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const end = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10); // tomorrow → start<end always, MTD-to-date
  const r = await (await ceClient(accountId)).send(new GetCostAndUsageCommand({
    TimePeriod: { Start: start, End: end },
    Granularity: 'MONTHLY',
    Metrics: ['UnblendedCost'],
    GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
  }));
  const groups = r.ResultsByTime?.[0]?.Groups ?? [];
  const byService = groups
    .map((g) => ({ service: g.Keys?.[0] ?? '?', amount: Number(g.Metrics?.UnblendedCost?.Amount ?? 0) }))
    .filter((s) => s.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10);
  const currency = groups[0]?.Metrics?.UnblendedCost?.Unit ?? 'USD';
  const total = byService.reduce((s, x) => s + x.amount, 0);
  return { total, currency, byService };
}

export interface CostTrendPoint { date: string; amount: number }

/** Daily UnblendedCost for the trailing 30 days (no GroupBy) → [{ date, amount }] ascending. */
export async function getCostTrend(accountId?: string): Promise<CostTrendPoint[]> {
  const now = new Date();
  const end = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10); // tomorrow → end is exclusive
  const start = new Date(now.getTime() - 29 * 86_400_000).toISOString().slice(0, 10); // 30 days inclusive of today
  const r = await (await ceClient(accountId)).send(new GetCostAndUsageCommand({
    TimePeriod: { Start: start, End: end },
    Granularity: 'DAILY',
    Metrics: ['UnblendedCost'],
  }));
  return (r.ResultsByTime ?? []).map((t) => ({
    date: t.TimePeriod?.Start ?? '',
    amount: Number(t.Total?.UnblendedCost?.Amount ?? 0),
  }));
}

export interface MonthlyServiceCostPoint { month: string; byService: { service: string; amount: number }[] }

/**
 * v1-parity cost filter menu (period + service): monthly UnblendedCost broken down BY SERVICE for
 * the trailing `months` calendar months (incl. current MTD) → [{ month, byService: [{service,amount}] }]
 * ascending. One CE call (same date math as getMonthlyCost). The uncapped per-month service list is
 * what the client filters against — v1 filtered raw SQL rows the same way; this is its CE equivalent.
 */
export async function getMonthlyCostByService(months = 6, accountId?: string): Promise<MonthlyServiceCostPoint[]> {
  const now = new Date();
  const startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
  const start = startDate.toISOString().slice(0, 10);
  const end = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  const r = await (await ceClient(accountId)).send(new GetCostAndUsageCommand({
    TimePeriod: { Start: start, End: end },
    Granularity: 'MONTHLY',
    Metrics: ['UnblendedCost'],
    GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
  }));
  return (r.ResultsByTime ?? []).map((t) => ({
    month: (t.TimePeriod?.Start ?? '').slice(0, 7),
    byService: (t.Groups ?? [])
      .map((g) => ({ service: g.Keys?.[0] ?? '?', amount: Number(g.Metrics?.UnblendedCost?.Amount ?? 0) }))
      .filter((s) => s.amount > 0)
      .sort((a, b) => b.amount - a.amount),
  }));
}

export interface DailyServiceCostPoint { date: string; byService: { service: string; amount: number }[] }

/** Same 30-day window as getCostTrend, but GroupBy SERVICE — the daily-chart leg of the service filter.
 *  v1's daily line chart always showed a fixed trailing-30-day window regardless of the period filter
 *  (period only changed the monthly aggregates) — same fixed window here, no `months` param. */
export async function getDailyCostByService(accountId?: string): Promise<DailyServiceCostPoint[]> {
  const now = new Date();
  const end = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  const start = new Date(now.getTime() - 29 * 86_400_000).toISOString().slice(0, 10);
  const r = await (await ceClient(accountId)).send(new GetCostAndUsageCommand({
    TimePeriod: { Start: start, End: end },
    Granularity: 'DAILY',
    Metrics: ['UnblendedCost'],
    GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
  }));
  return (r.ResultsByTime ?? []).map((t) => ({
    date: t.TimePeriod?.Start ?? '',
    byService: (t.Groups ?? [])
      .map((g) => ({ service: g.Keys?.[0] ?? '?', amount: Number(g.Metrics?.UnblendedCost?.Amount ?? 0) }))
      .filter((s) => s.amount > 0),
  }));
}

export interface MonthlyCostPoint { month: string; total: number }

/** Monthly UnblendedCost for the trailing `months` calendar months (incl. current MTD) → [{ month: 'YYYY-MM', total }] ascending. */
export async function getMonthlyCost(months = 6, accountId?: string): Promise<MonthlyCostPoint[]> {
  const now = new Date();
  const startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
  const start = startDate.toISOString().slice(0, 10);
  const end = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10); // tomorrow → includes current partial month
  const r = await (await ceClient(accountId)).send(new GetCostAndUsageCommand({
    TimePeriod: { Start: start, End: end },
    Granularity: 'MONTHLY',
    Metrics: ['UnblendedCost'],
    GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
  }));
  return (r.ResultsByTime ?? []).map((t) => ({
    month: (t.TimePeriod?.Start ?? '').slice(0, 7),
    total: (t.Groups ?? []).reduce((s, g) => s + Number(g.Metrics?.UnblendedCost?.Amount ?? 0), 0),
  }));
}

export interface ServiceUsageType { usageType: string; amount: number }
export interface ServiceCostDetail {
  service: string;
  currency: string;
  trend: CostTrendPoint[] | null;          // null = the trend CE call failed (vs [] = genuinely empty)
  byUsageType: ServiceUsageType[] | null;  // null = the usage-type CE call failed (vs [] = genuinely empty)
  monthly: { month: string; amount: number }[] | null;
}

/** Sort rows desc, keep the top-n, and roll any remainder into a single '기타' row (omitted when the rest sums to 0). */
export function rollupUsageTypes(rows: ServiceUsageType[], n: number): ServiceUsageType[] {
  const sorted = [...rows].sort((a, b) => b.amount - a.amount);
  if (sorted.length <= n) return sorted;
  const head = sorted.slice(0, n);
  const rest = sorted.slice(n).reduce((s, x) => s + x.amount, 0);
  return rest > 0 ? [...head, { usageType: '기타', amount: rest }] : head;
}

/**
 * Per-service cost drill-down: daily trend (last 30d) + usage-type rollup (last 3 months, top-8 + 기타).
 * Both legs are filtered to a single SERVICE. Each leg degrades to null independently on CE failure
 * (null = call failed; [] = genuinely empty) so a half-broken pull still renders the other half.
 */
export async function getServiceCostDetail(service: string, account?: string): Promise<ServiceCostDetail> {
  const now = new Date();
  const filter = { Dimensions: { Key: 'SERVICE' as const, Values: [service] } };

  // ① DAILY UnblendedCost, trailing 30 days, no GroupBy → trend.
  const trendEnd = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10); // tomorrow, exclusive
  const trendStart = new Date(now.getTime() - 29 * 86_400_000).toISOString().slice(0, 10);
  const trend = await (await ceClient(account)).send(new GetCostAndUsageCommand({
    TimePeriod: { Start: trendStart, End: trendEnd },
    Granularity: 'DAILY',
    Metrics: ['UnblendedCost'],
    Filter: filter,
  })).then((r) => (r.ResultsByTime ?? []).map((t) => ({
    date: t.TimePeriod?.Start ?? '',
    amount: Number(t.Total?.UnblendedCost?.Amount ?? 0),
  }) as CostTrendPoint)).catch(() => null);

  // ② MONTHLY UnblendedCost, trailing 3 months, grouped by USAGE_TYPE → summed across months → rolled up.
  const utStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1)).toISOString().slice(0, 10);
  const utEnd = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  const byUsageType = await (await ceClient(account)).send(new GetCostAndUsageCommand({
    TimePeriod: { Start: utStart, End: utEnd },
    Granularity: 'MONTHLY',
    Metrics: ['UnblendedCost'],
    Filter: filter,
    GroupBy: [{ Type: 'DIMENSION', Key: 'USAGE_TYPE' }],
  })).then((r) => {
    const sums = new Map<string, number>();
    for (const t of r.ResultsByTime ?? []) {
      for (const g of t.Groups ?? []) {
        const key = g.Keys?.[0] ?? '?';
        sums.set(key, (sums.get(key) ?? 0) + Number(g.Metrics?.UnblendedCost?.Amount ?? 0));
      }
    }
    const rows = [...sums.entries()].map(([usageType, amount]) => ({ usageType, amount }));
    return rollupUsageTypes(rows, 8);
  }).catch(() => null);

  // ③ MONTHLY totals, trailing 6 months → monthly trend + this/last-month summary (v1 parity).
  const moStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1)).toISOString().slice(0, 10);
  const monthly = await (await ceClient(account)).send(new GetCostAndUsageCommand({
    TimePeriod: { Start: moStart, End: utEnd },
    Granularity: 'MONTHLY',
    Metrics: ['UnblendedCost'],
    Filter: filter,
  })).then((r) => (r.ResultsByTime ?? []).map((t) => ({
    month: (t.TimePeriod?.Start ?? '').slice(0, 7),
    amount: Number(t.Total?.UnblendedCost?.Amount ?? 0),
  }))).catch(() => null);

  return { service, currency: 'USD', trend, byUsageType, monthly };
}

/** AWS-forecasted remaining UnblendedCost from tomorrow to month-end. null when there is no future window (last day). */
export async function getCostForecast(accountId?: string): Promise<number | null> {
  const now = new Date();
  const start = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10); // forecast start must be in the future
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10); // 1st of next month (exclusive)
  if (start >= end) return null; // on/after the last day there is no remaining window to forecast
  const r = await (await ceClient(accountId)).send(new GetCostForecastCommand({
    TimePeriod: { Start: start, End: end },
    Metric: 'UNBLENDED_COST',
    Granularity: 'MONTHLY',
  }));
  return Number(r.Total?.Amount ?? 0);
}
