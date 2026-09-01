import { CloudWatchClient, GetMetricDataCommand, ListMetricsCommand } from '@aws-sdk/client-cloudwatch';
import { KafkaClient, GetBootstrapBrokersCommand, ListNodesCommand } from '@aws-sdk/client-kafka';
import { PricingClient, GetProductsCommand } from '@aws-sdk/client-pricing';
import { getModelLabel, getModelPricing, computeCost, RANGE_CONFIGS, type ModelPricing, type CostBreakdown } from './bedrock';
import { assumedClient } from './aws-assume';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';

let cw: CloudWatchClient | null = null;
const cwClient = () => (cw ??= new CloudWatchClient({ region: REGION }));

export interface Ec2CpuStats {
  avg: number | null;                 // fleet average across instances reporting a datapoint
  byInstance: Record<string, number>; // latest CPU % per instance id (gap L138 Top-N ranking)
}

const EC2_CPU_METRIC = [{ key: 'cpu', name: 'CPUUtilization', stat: 'Average' }] as const;

/**
 * Fleet-wide per-instance latest CPU + the fleet average. Instances are grouped by their
 * inventory region (CloudWatch metrics live in the resource's region) and each region's ids
 * are batched through fleetLatest's chunked GetMetricData — no arbitrary 100-instance sample.
 * The average is computed from RAW datapoints; byInstance values are display-rounded to 0.1.
 */
export async function ec2CpuStats(idsByRegion: Record<string, string[]>): Promise<Ec2CpuStats> {
  const regions = Object.entries(idsByRegion).filter(([, ids]) => ids.length > 0);
  if (!regions.length) return { avg: null, byInstance: {} };
  const byInstance: Record<string, number> = {};
  const raw: number[] = [];
  await Promise.all(regions.map(async ([region, ids]) => {
    const fleet = await fleetLatest('AWS/EC2', ids, (id) => [{ Name: 'InstanceId', Value: id }], EC2_CPU_METRIC, region, 3 * 3600_000, 3600);
    for (const [id, m] of Object.entries(fleet)) {
      if (typeof m.cpu === 'number') {
        raw.push(m.cpu);
        byInstance[id] = Math.round(m.cpu * 10) / 10;
      }
    }
  }));
  const avg = raw.length ? Math.round((raw.reduce((a, b) => a + b, 0) / raw.length) * 10) / 10 : null;
  return { avg, byInstance };
}

// ── RDS per-instance CloudWatch metrics (v1 parity) ─────────────────────────
export interface RdsInstanceMetrics {
  cpu: number | null;            // CPUUtilization (%)
  freeableMemory: number | null; // bytes
  connections: number | null;    // DatabaseConnections (count)
  readIops: number | null;       // ReadIOPS (ops/s)
  writeIops: number | null;      // WriteIOPS (ops/s)
  freeStorage: number | null;    // FreeStorageSpace (bytes)
  netIn: number | null;          // NetworkReceiveThroughput (bytes/s)
  netOut: number | null;         // NetworkTransmitThroughput (bytes/s)
}
export interface RdsMetrics {
  byInstance: Record<string, RdsInstanceMetrics>;
  avgCpu: number | null; // fleet average CPU across instances reporting a datapoint
}

const RDS_METRICS = [
  { key: 'cpu', field: 'cpu', name: 'CPUUtilization' },
  { key: 'mem', field: 'freeableMemory', name: 'FreeableMemory' },
  { key: 'conn', field: 'connections', name: 'DatabaseConnections' },
  { key: 'rio', field: 'readIops', name: 'ReadIOPS' },
  { key: 'wio', field: 'writeIops', name: 'WriteIOPS' },
  { key: 'storage', field: 'freeStorage', name: 'FreeStorageSpace' },
  { key: 'netin', field: 'netIn', name: 'NetworkReceiveThroughput' },
  { key: 'netout', field: 'netOut', name: 'NetworkTransmitThroughput' },
] as const;

const emptyRds = (): RdsInstanceMetrics => ({
  cpu: null, freeableMemory: null, connections: null, readIops: null,
  writeIops: null, freeStorage: null, netIn: null, netOut: null,
});

/**
 * Per-instance RDS CloudWatch metrics — the 8 series v1 rendered (latest 1h Average over a ~3h window).
 * Read-only, live-fetch (not persisted), multi-account via `assumedClient` (host/self → task-role creds).
 * Batches ≤62 instances per GetMetricData call (8 metrics × 62 = 496 < the 500 query/call cap — no silent
 * truncation). Degrades to an empty result on any CloudWatch error (never throws).
 */
export async function rdsMetrics(instanceIds: string[], accountId?: string): Promise<RdsMetrics> {
  const ids = instanceIds; // no silent cap — the 62/call chunk loop below covers any fleet size
  if (!ids.length) return { byInstance: {}, avgCpu: null };
  const byInstance: Record<string, RdsInstanceMetrics> = {};
  try {
    const client = await assumedClient(accountId, CloudWatchClient, { region: REGION });
    const CHUNK = 62; // 8 metrics × 62 = 496 ≤ 500 GetMetricData queries/call
    for (let c = 0; c < ids.length; c += CHUNK) {
      const chunk = ids.slice(c, c + CHUNK);
      for (const id of chunk) byInstance[id] ??= emptyRds();
      const queries = chunk.flatMap((id, i) =>
        RDS_METRICS.map((m) => ({
          Id: `${m.key}_i${i}`, ReturnData: true,
          MetricStat: { Metric: { Namespace: 'AWS/RDS', MetricName: m.name, Dimensions: [{ Name: 'DBInstanceIdentifier', Value: id }] }, Period: 3600, Stat: 'Average' },
        })),
      );
      const r = await client.send(new GetMetricDataCommand({
        StartTime: new Date(Date.now() - 3 * 3600_000), EndTime: new Date(),
        MetricDataQueries: queries,
      }));
      for (const res of r.MetricDataResults ?? []) {
        const mm = (res.Id ?? '').match(/^(\w+?)_i(\d+)$/);
        if (!mm) continue;
        const def = RDS_METRICS.find((m) => m.key === mm[1]);
        const id = chunk[Number(mm[2])];
        const v = res.Values?.[0];
        if (def && id && typeof v === 'number') {
          (byInstance[id] as unknown as Record<string, number | null>)[def.field] = Math.round(v * 100) / 100;
        }
      }
    }
  } catch {
    return { byInstance: {}, avgCpu: null };
  }
  const cpus = Object.values(byInstance).map((m) => m.cpu).filter((v): v is number => typeof v === 'number');
  const avgCpu = cpus.length ? Math.round((cpus.reduce((a, b) => a + b, 0) / cpus.length) * 10) / 10 : null;
  return { byInstance, avgCpu };
}

// ── RDS per-instance metric TRENDS (gap L141/L142/L155, v1 parity) ──────────
export interface TrendSample { t: string; v: number }
export type RdsSparkField = 'cpu' | 'freeableMemory' | 'connections' | 'readIops' | 'writeIops' | 'freeStorage';
export interface RdsInstanceTrends {
  /** 1h sparklines at 5-min resolution, keyed by RdsInstanceMetrics field name (6 metrics). */
  spark: Record<RdsSparkField, TrendSample[] | null>;
  /** FreeableMemory, 24h at 1h resolution (bytes). */
  mem24h: TrendSample[] | null;
  /** CPUUtilization, 14d at daily resolution (%). */
  cpu14d: TrendSample[] | null;
}

const SPARK_METRICS = [
  { field: 'cpu', name: 'CPUUtilization' },
  { field: 'freeableMemory', name: 'FreeableMemory' },
  { field: 'connections', name: 'DatabaseConnections' },
  { field: 'readIops', name: 'ReadIOPS' },
  { field: 'writeIops', name: 'WriteIOPS' },
  { field: 'freeStorage', name: 'FreeStorageSpace' },
] as const;

/**
 * Per-instance RDS metric time-series for the detail panel — TWO parallel GetMetricData
 * calls: sparks (6 queries, Period 300, ~65-min window → ≤13 points each) and long trends
 * (FreeableMemory Period 3600 + CPUUtilization Period 86400 over 14d → ≤24 + ≤14 points).
 * Read-only live fetch; degrades to null series on any CloudWatch error (the rdsMetrics
 * contract) — the UI renders '데이터 불가', never a dead panel.
 */
export async function rdsInstanceTrends(instanceId: string, accountId?: string): Promise<RdsInstanceTrends> {
  const empty: RdsInstanceTrends = {
    spark: Object.fromEntries(SPARK_METRICS.map((m) => [m.field, null])) as RdsInstanceTrends['spark'],
    mem24h: null, cpu14d: null,
  };
  try {
    const client = await assumedClient(accountId, CloudWatchClient, { region: REGION });
    const dim = [{ Name: 'DBInstanceIdentifier', Value: instanceId }];
    const stat = (name: string, period: number) => ({
      Metric: { Namespace: 'AWS/RDS', MetricName: name, Dimensions: dim }, Period: period, Stat: 'Average',
    });
    // TWO bounded calls — `Period` sets aggregation RESOLUTION, not a per-query window, so a
    // single 14-day StartTime would make each 5-min spark query return ~4,000 datapoints
    // (~24k per panel open) only to be trimmed client-side. Sparks get their own ~65-minute
    // window (≤13 points each); the two long trends share the 14-day window (≤14 + ≤24 points).
    const [sparkRes, longRes] = await Promise.all([
      client.send(new GetMetricDataCommand({
        StartTime: new Date(Date.now() - 65 * 60_000), EndTime: new Date(),
        MetricDataQueries: SPARK_METRICS.map((m, i) => ({ Id: `spark_${i}`, ReturnData: true, MetricStat: stat(m.name, 300) })),
        ScanBy: 'TimestampAscending',
      })),
      client.send(new GetMetricDataCommand({
        StartTime: new Date(Date.now() - 14 * 86_400_000), EndTime: new Date(),
        MetricDataQueries: [
          { Id: 'mem24h', ReturnData: true, MetricStat: stat('FreeableMemory', 3600) },
          { Id: 'cpu14d', ReturnData: true, MetricStat: stat('CPUUtilization', 86_400) },
        ],
        ScanBy: 'TimestampAscending',
      })),
    ]);
    const series = (from: typeof sparkRes, id: string, sinceMs: number): TrendSample[] | null => {
      const res = (from.MetricDataResults ?? []).find((x) => x.Id === id);
      if (!res?.Timestamps?.length || !res.Values?.length) return null;
      const out: TrendSample[] = [];
      for (let i = 0; i < res.Timestamps.length; i++) {
        const ts = res.Timestamps[i] instanceof Date ? (res.Timestamps[i] as Date) : new Date(String(res.Timestamps[i]));
        const v = res.Values[i];
        if (typeof v === 'number' && ts.getTime() >= sinceMs) {
          out.push({ t: ts.toISOString(), v: Math.round(v * 100) / 100 });
        }
      }
      return out.length ? out : null;
    };
    return {
      spark: Object.fromEntries(
        SPARK_METRICS.map((m, i) => [m.field, series(sparkRes, `spark_${i}`, Date.now() - 3600_000)]),
      ) as RdsInstanceTrends['spark'],
      mem24h: series(longRes, 'mem24h', Date.now() - 24 * 3600_000),
      cpu14d: series(longRes, 'cpu14d', Date.now() - 14 * 86_400_000),
    };
  } catch {
    return empty;
  }
}

let pricing: PricingClient | null = null;
// Pricing API is reached via us-east-1 only.
const priceClient = () => (pricing ??= new PricingClient({ region: 'us-east-1' }));
const priceCache = new Map<string, number | null>();

async function onDemandHourly(instanceType: string): Promise<number | null> {
  if (priceCache.has(instanceType)) return priceCache.get(instanceType)!;
  let price: number | null = null;
  try {
    const r = await priceClient().send(new GetProductsCommand({
      ServiceCode: 'AmazonEC2', MaxResults: 1,
      Filters: [
        { Type: 'TERM_MATCH', Field: 'instanceType', Value: instanceType },
        { Type: 'TERM_MATCH', Field: 'location', Value: 'Asia Pacific (Seoul)' },
        { Type: 'TERM_MATCH', Field: 'operatingSystem', Value: 'Linux' },
        { Type: 'TERM_MATCH', Field: 'tenancy', Value: 'Shared' },
        { Type: 'TERM_MATCH', Field: 'preInstalledSw', Value: 'NA' },
        { Type: 'TERM_MATCH', Field: 'capacitystatus', Value: 'Used' },
      ],
    }));
    const item = r.PriceList?.[0];
    if (item) {
      const p = JSON.parse(item as string);
      const od = p.terms?.OnDemand ?? {};
      const dim = Object.values(od)[0] as any;
      const pd = dim && Object.values(dim.priceDimensions ?? {})[0] as any;
      const usd = pd?.pricePerUnit?.USD;
      if (usd) price = Number(usd);
    }
  } catch { price = null; }
  priceCache.set(instanceType, price);
  return price;
}

/** Sum of on-demand hourly $/hr × count across instance types. null when no type priced. */
export async function ec2HourlyCost(typeCounts: Record<string, number>): Promise<number | null> {
  let total = 0, any = false;
  for (const [t, n] of Object.entries(typeCounts)) {
    const p = await onDemandHourly(t);
    if (p != null) { total += p * n; any = true; }
  }
  return any ? Math.round(total * 100) / 100 : null;
}

// ── Bedrock model usage metrics (AWS/Bedrock CloudWatch) ────────────────────
export interface BedrockModelMetric {
  modelId: string; label: string; pricing: ModelPricing;
  invocations: number; inputTokens: number; outputTokens: number;
  avgLatencyMs: number; clientErrors: number; serverErrors: number;
  cacheReadTokens: number; cacheWriteTokens: number;
  cost: CostBreakdown;
}
export interface BedrockMetrics {
  models: BedrockModelMetric[];
  totalCost: number;
  series: { t: string; tokens: number }[]; // combined input+output tokens over time
}

const BEDROCK_METRICS = [
  { id: 'inv', name: 'Invocations', stat: 'Sum' },
  { id: 'in', name: 'InputTokenCount', stat: 'Sum' },
  { id: 'out', name: 'OutputTokenCount', stat: 'Sum' },
  { id: 'lat', name: 'InvocationLatency', stat: 'Average' },
  { id: 'e4', name: 'InvocationClientErrors', stat: 'Sum' },
  { id: 'e5', name: 'InvocationServerErrors', stat: 'Sum' },
  { id: 'cr', name: 'CacheReadInputTokenCount', stat: 'Sum' },
  { id: 'cw', name: 'CacheWriteInputTokenCount', stat: 'Sum' },
] as const;

const sum = (v?: number[]) => (v ?? []).reduce((s, x) => s + x, 0);
const avg = (v?: number[]) => (v && v.length ? sum(v) / v.length : 0);

/**
 * Per-model Bedrock usage over the given range.
 * Step 1: ListMetrics(AWS/Bedrock, Invocations) → enumerate the ModelId dimension values
 *         (GetMetricData alone can't enumerate dimension values).
 * Step 2: GetMetricData for the 8 metrics × each model; aggregate + price.
 */
export async function bedrockModelMetrics(range = '24h', accountId?: string): Promise<BedrockMetrics> {
  const cfg = RANGE_CONFIGS[range] ?? RANGE_CONFIGS['24h'];
  // account-scoped CloudWatch client: host (null/self) → task-role creds; target → assumed read-only role.
  const cw = await assumedClient(accountId, CloudWatchClient, { region: REGION });
  const lm = await cw.send(new ListMetricsCommand({ Namespace: 'AWS/Bedrock', MetricName: 'Invocations' }));
  const ids = new Set<string>();
  for (const m of lm.Metrics ?? []) {
    for (const d of m.Dimensions ?? []) if (d.Name === 'ModelId' && d.Value) ids.add(d.Value);
  }
  const models = [...ids];
  if (!models.length) return { models: [], totalCost: 0, series: [] };

  const queries = models.flatMap((id, mi) =>
    BEDROCK_METRICS.map((d) => ({
      Id: `${d.id}_m${mi}`, ReturnData: true,
      MetricStat: { Metric: { Namespace: 'AWS/Bedrock', MetricName: d.name, Dimensions: [{ Name: 'ModelId', Value: id }] }, Period: cfg.period, Stat: d.stat },
    })),
  );
  // CloudWatch caps GetMetricData at 500 queries/call. Warn rather than silently truncate
  // (would only bite at >62 active models — well beyond reality, but no silent caps).
  if (queries.length > 500) {
    console.warn(`[bedrock] ${models.length} models × ${BEDROCK_METRICS.length} metrics = ${queries.length} queries > 500 cap; metrics truncated`);
  }
  const r = await cw.send(new GetMetricDataCommand({
    StartTime: new Date(Date.now() - cfg.hours * 3600_000), EndTime: new Date(),
    MetricDataQueries: queries.slice(0, 500),
  }));

  const acc: Record<number, { inv: number[]; in: number[]; out: number[]; lat: number[]; e4: number[]; e5: number[]; cr: number[]; cw: number[] }> = {};
  const seriesByTs = new Map<string, number>();
  for (const res of r.MetricDataResults ?? []) {
    const m = (res.Id ?? '').match(/^(\w+?)_m(\d+)$/);
    if (!m) continue;
    const key = m[1] as keyof (typeof acc)[number];
    const mi = Number(m[2]);
    if (mi >= models.length) continue;
    (acc[mi] ??= { inv: [], in: [], out: [], lat: [], e4: [], e5: [], cr: [], cw: [] })[key] = (res.Values ?? []) as number[];
    // combined token time series (input + output) keyed by timestamp
    if (key === 'in' || key === 'out') {
      const ts = res.Timestamps ?? [];
      const vals = res.Values ?? [];
      ts.forEach((t, i) => {
        const iso = t instanceof Date ? t.toISOString() : String(t);
        seriesByTs.set(iso, (seriesByTs.get(iso) ?? 0) + (vals[i] ?? 0));
      });
    }
  }

  const out: BedrockModelMetric[] = models.map((modelId, mi) => {
    const a = acc[mi] ?? { inv: [], in: [], out: [], lat: [], e4: [], e5: [], cr: [], cw: [] };
    const pricing = getModelPricing(modelId);
    const usage = { inputTokens: sum(a.in), outputTokens: sum(a.out), cacheReadTokens: sum(a.cr), cacheWriteTokens: sum(a.cw) };
    return {
      modelId, label: getModelLabel(modelId), pricing,
      invocations: sum(a.inv), ...usage,
      avgLatencyMs: Math.round(avg(a.lat)),
      clientErrors: sum(a.e4), serverErrors: sum(a.e5),
      cost: computeCost(usage, pricing),
    };
  });
  out.sort((x, y) => y.cost.total - x.cost.total);
  const totalCost = out.reduce((s, m) => s + m.cost.total, 0);
  const series = [...seriesByTs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([t, tokens]) => ({ t, tokens }));
  return { models: out, totalCost, series };
}

// ── Generic per-resource live CloudWatch metrics (v1 parity for ElastiCache/OpenSearch/MSK) ──
// One GetMetricData call per resource; every failure degrades to [] (never blanks the panel).
export interface LiveMetric { label: string; value: string }

export type LiveFmt = 'pct' | 'ratioPct' | 'gb' | 'mb' | 'mbRaw' | 'count' | 'ms' | 'bps';
interface LiveMetricDef { name: string; label: string; stat: 'Average' | 'Sum' | 'Maximum'; fmt: LiveFmt }
interface LiveMetricSpec { namespace: string; dims: (id: string, accountId?: string) => { Name: string; Value: string }[]; metrics: LiveMetricDef[] }

const LIVE_SPECS: Record<string, LiveMetricSpec> = {
  // resource_id = CacheClusterId
  elasticache: {
    namespace: 'AWS/ElastiCache',
    dims: (id) => [{ Name: 'CacheClusterId', Value: id }],
    metrics: [
      { name: 'CPUUtilization', label: 'CPU', stat: 'Average', fmt: 'pct' },
      { name: 'EngineCPUUtilization', label: 'Engine CPU', stat: 'Average', fmt: 'pct' },
      { name: 'FreeableMemory', label: 'Freeable Memory', stat: 'Average', fmt: 'gb' },
      { name: 'NetworkBytesIn', label: 'Network In', stat: 'Average', fmt: 'mb' },
      { name: 'NetworkBytesOut', label: 'Network Out', stat: 'Average', fmt: 'mb' },
      { name: 'CurrConnections', label: 'Connections', stat: 'Average', fmt: 'count' },
      // CacheHitRate arrives as a 0–1 RATIO (see ElasticacheNodeMetrics.hitPctOf) — plain 'pct'
      // would render 0.92 as '0.9%'.
      { name: 'CacheHitRate', label: 'Cache Hit Rate', stat: 'Average', fmt: 'ratioPct' },
    ],
  },
  // resource_id = DomainName. AWS/ES requires the ClientId (account) dimension.
  opensearch: {
    namespace: 'AWS/ES',
    // ClientId must be the OWNING account — pinning the host id made every member-account
    // domain query return empty series ('데이터 불가') while claiming cross-account support.
    dims: (id, accountId) => [
      { Name: 'DomainName', Value: id },
      { Name: 'ClientId', Value: accountId && accountId !== 'self' ? accountId : process.env.AWS_ACCOUNT_ID ?? '' },
    ],
    metrics: [
      { name: 'CPUUtilization', label: 'CPU', stat: 'Average', fmt: 'pct' },
      { name: 'JVMMemoryPressure', label: 'JVM Memory', stat: 'Average', fmt: 'pct' },
      // AWS/ES reports FreeStorageSpace in MEGABYTES already — 'mb' (bytes÷1e6) understated it ~1e6×.
      { name: 'FreeStorageSpace', label: 'Free Storage', stat: 'Average', fmt: 'mbRaw' },
      { name: 'SearchableDocuments', label: 'Documents', stat: 'Average', fmt: 'count' },
      { name: 'SearchLatency', label: 'Search Latency', stat: 'Average', fmt: 'ms' },
      { name: 'IndexingLatency', label: 'Indexing Latency', stat: 'Average', fmt: 'ms' },
      { name: 'ClusterStatus.yellow', label: 'Status Yellow', stat: 'Maximum', fmt: 'count' },
      { name: 'ClusterStatus.red', label: 'Status Red', stat: 'Maximum', fmt: 'count' },
    ],
  },
  // resource_id = cluster name (sync primary key). Cluster-level dimensions only.
  msk: {
    namespace: 'AWS/Kafka',
    dims: (id) => [{ Name: 'Cluster Name', Value: id }],
    metrics: [
      { name: 'ActiveControllerCount', label: 'Active Controllers', stat: 'Maximum', fmt: 'count' },
      { name: 'OfflinePartitionsCount', label: 'Offline Partitions', stat: 'Maximum', fmt: 'count' },
      { name: 'GlobalTopicCount', label: 'Topics', stat: 'Maximum', fmt: 'count' },
      { name: 'GlobalPartitionCount', label: 'Partitions', stat: 'Maximum', fmt: 'count' },
    ],
  },
};

function fmtLive(v: number, fmt: LiveFmt): string {
  switch (fmt) {
    case 'pct': return `${Math.round(v * 10) / 10}%`;
    // 0–1 ratio → percent (values >1 pass through — some engines report percent directly)
    case 'ratioPct': return `${Math.round((v <= 1 ? v * 100 : v) * 10) / 10}%`;
    case 'gb': return `${(v / 1e9).toFixed(1)} GB`;
    case 'mb': return `${(v / 1e6).toFixed(1)} MB`;
    case 'mbRaw': return `${v.toFixed(1)} MB`; // source metric already in megabytes (AWS/ES)
    case 'ms': return `${Math.round(v * 1000) / 1000} ms`;
    case 'bps': return `${(v / 1e6).toFixed(1)} MB/s`;
    default: return Math.round(v).toLocaleString();
  }
}

export function hasLiveMetrics(type: string): boolean { return type in LIVE_SPECS; }

/** Latest-hour metrics for ONE resource of a LIVE_SPECS type. [] on error/no data. */
export async function liveResourceMetrics(type: string, id: string, accountId?: string, region?: string): Promise<LiveMetric[]> {
  const spec = LIVE_SPECS[type];
  if (!spec) return [];
  try {
    const client = await assumedClient(accountId, CloudWatchClient, { region: region ?? REGION });
    const r = await client.send(new GetMetricDataCommand({
      StartTime: new Date(Date.now() - 3 * 3600_000), EndTime: new Date(),
      MetricDataQueries: spec.metrics.map((m, i) => ({
        Id: `lm${i}`, ReturnData: true,
        MetricStat: { Metric: { Namespace: spec.namespace, MetricName: m.name, Dimensions: spec.dims(id, accountId) }, Period: 3600, Stat: m.stat },
      })),
    }));
    const out: LiveMetric[] = [];
    for (const res of r.MetricDataResults ?? []) {
      const i = Number((res.Id ?? '').replace('lm', ''));
      const def = spec.metrics[i];
      const v = res.Values?.[0];
      if (def) out.push({ label: def.label, value: typeof v === 'number' ? fmtLive(v, def.fmt) : '—' });
    }
    return out;
  } catch {
    return [];
  }
}

export interface LiveTrendMetric { label: string; fmt: LiveFmt; samples: TrendSample[] | null }

/** 1-hour 5-min sparkline series for ONE resource of a LIVE_SPECS type (gap L118 — v1's
 *  elasticache detail sparklines, generalized to opensearch/msk which share the spec table).
 *  Bounded window (~65min → ≤13 points/metric); [] on error (never throws). */
export async function liveResourceTrends(type: string, id: string, accountId?: string, region?: string): Promise<LiveTrendMetric[]> {
  const spec = LIVE_SPECS[type];
  if (!spec) return [];
  try {
    // Opening the account dimension without the region would half-open the scope: a member
    // account's cluster outside the deployment region would silently read '데이터 불가' (or a
    // same-named default-region cluster would chart the WRONG resource).
    const client = await assumedClient(accountId, CloudWatchClient, { region: region ?? REGION });
    const r = await client.send(new GetMetricDataCommand({
      StartTime: new Date(Date.now() - 65 * 60_000), EndTime: new Date(),
      MetricDataQueries: spec.metrics.map((m, i) => ({
        Id: `lt${i}`, ReturnData: true,
        MetricStat: { Metric: { Namespace: spec.namespace, MetricName: m.name, Dimensions: spec.dims(id, accountId) }, Period: 300, Stat: m.stat },
      })),
      ScanBy: 'TimestampAscending',
    }));
    return spec.metrics.map((def, i) => {
      const res = (r.MetricDataResults ?? []).find((x) => x.Id === `lt${i}`);
      const samples: TrendSample[] = [];
      for (let k = 0; k < (res?.Timestamps?.length ?? 0); k++) {
        const ts = res!.Timestamps![k] instanceof Date ? (res!.Timestamps![k] as Date) : new Date(String(res!.Timestamps![k]));
        const v = res!.Values?.[k];
        if (typeof v === 'number' && ts.getTime() >= Date.now() - 3600_000) {
          samples.push({ t: ts.toISOString(), v: Math.round(v * 100) / 100 });
        }
      }
      return { label: def.label, fmt: def.fmt, samples: samples.length ? samples : null };
    });
  } catch {
    return [];
  }
}

// ── EC2 per-instance 24h network trends (gap L139, v1 parity) ───────────────
export interface Ec2NetworkTrends {
  netIn: TrendSample[] | null;  // hourly NetworkIn Sum (bytes/hour); null = no data / error
  netOut: TrendSample[] | null; // hourly NetworkOut Sum (bytes/hour)
}

/** One bounded read-only GetMetricData — 24h hourly NetworkIn/Out for one instance.
 *  Account/region thread through assumedClient so member-account and off-region instances
 *  chart their OWN metrics; any CloudWatch error degrades both series to null (never throws). */
export async function ec2NetworkTrends(instanceId: string, accountId?: string, region?: string): Promise<Ec2NetworkTrends> {
  try {
    const client = await assumedClient(accountId, CloudWatchClient, { region: region ?? REGION });
    const metrics = ['NetworkIn', 'NetworkOut'] as const;
    const r = await client.send(new GetMetricDataCommand({
      StartTime: new Date(Date.now() - 24 * 3600_000), EndTime: new Date(),
      MetricDataQueries: metrics.map((name, i) => ({
        Id: `nt${i}`, ReturnData: true,
        MetricStat: { Metric: { Namespace: 'AWS/EC2', MetricName: name, Dimensions: [{ Name: 'InstanceId', Value: instanceId }] }, Period: 3600, Stat: 'Sum' },
      })),
      ScanBy: 'TimestampAscending',
    }));
    const series = (i: number): TrendSample[] | null => {
      const res = (r.MetricDataResults ?? []).find((x) => x.Id === `nt${i}`);
      const samples: TrendSample[] = [];
      for (let k = 0; k < (res?.Timestamps?.length ?? 0); k++) {
        const ts = res!.Timestamps![k] instanceof Date ? (res!.Timestamps![k] as Date) : new Date(String(res!.Timestamps![k]));
        const v = res!.Values?.[k];
        if (typeof v === 'number') samples.push({ t: ts.toISOString(), v });
      }
      return samples.length ? samples : null;
    };
    return { netIn: series(0), netOut: series(1) };
  } catch {
    return { netIn: null, netOut: null };
  }
}

/** MSK bootstrap broker connection strings (v1 parity) — [] on error/denied. */
export async function mskBootstrapBrokers(clusterArn: string): Promise<LiveMetric[]> {
  try {
    const client = new KafkaClient({ region: REGION });
    const r = await client.send(new GetBootstrapBrokersCommand({ ClusterArn: clusterArn }));
    const out: LiveMetric[] = [];
    if (r.BootstrapBrokerStringTls) out.push({ label: 'Bootstrap (TLS)', value: r.BootstrapBrokerStringTls });
    if (r.BootstrapBrokerString) out.push({ label: 'Bootstrap (Plaintext)', value: r.BootstrapBrokerString });
    if (r.BootstrapBrokerStringSaslIam) out.push({ label: 'Bootstrap (SASL/IAM)', value: r.BootstrapBrokerStringSaslIam });
    return out;
  } catch {
    return [];
  }
}

// ── Monitoring hub (v1 /monitoring parity): fleet live columns + per-resource time series ──
export interface FleetLiveRow { id: string; cpu: number | null; netIn: number | null; netOut: number | null }

/** Latest-hour CPU/NetIn/NetOut per EC2 instance (one GetMetricData per 160-instance chunk). */
export async function ec2FleetLive(ids: string[]): Promise<Record<string, FleetLiveRow>> {
  const out: Record<string, FleetLiveRow> = {};
  if (!ids.length) return out;
  const METRICS = [
    { key: 'cpu', name: 'CPUUtilization' },
    { key: 'netIn', name: 'NetworkIn' },
    { key: 'netOut', name: 'NetworkOut' },
  ] as const;
  try {
    const CHUNK = 160; // 3 metrics × 160 = 480 ≤ 500 queries/call
    for (let c = 0; c < ids.length; c += CHUNK) {
      const chunk = ids.slice(c, c + CHUNK);
      for (const id of chunk) out[id] ??= { id, cpu: null, netIn: null, netOut: null };
      const r = await cwClient().send(new GetMetricDataCommand({
        StartTime: new Date(Date.now() - 3 * 3600_000), EndTime: new Date(),
        MetricDataQueries: chunk.flatMap((id, i) =>
          METRICS.map((m) => ({
            Id: `${m.key}_i${i}`, ReturnData: true,
            MetricStat: { Metric: { Namespace: 'AWS/EC2', MetricName: m.name, Dimensions: [{ Name: 'InstanceId', Value: id }] }, Period: 3600, Stat: 'Average' },
          }))),
      }));
      for (const res of r.MetricDataResults ?? []) {
        const mm = (res.Id ?? '').match(/^(\w+?)_i(\d+)$/);
        if (!mm) continue;
        const id = chunk[Number(mm[2])];
        const v = res.Values?.[0];
        if (id && typeof v === 'number') (out[id] as unknown as Record<string, number>)[mm[1]] = Math.round(v * 100) / 100;
      }
    }
  } catch { /* rows keep nulls */ }
  return out;
}

const SERIES_RANGES: Record<string, { ms: number; period: number }> = {
  '1h': { ms: 3600_000, period: 300 },
  '6h': { ms: 6 * 3600_000, period: 300 },
  '24h': { ms: 24 * 3600_000, period: 900 },
  '7d': { ms: 7 * 24 * 3600_000, period: 3600 },
};
const SERIES_METRICS: Record<string, { namespace: string; dim: string; metrics: { key: string; name: string; scale?: number }[] }> = {
  ec2: {
    namespace: 'AWS/EC2', dim: 'InstanceId',
    metrics: [
      { key: 'CPU %', name: 'CPUUtilization' },
      { key: 'Net In MB', name: 'NetworkIn', scale: 1e-6 },
      { key: 'Net Out MB', name: 'NetworkOut', scale: 1e-6 },
    ],
  },
  rds: {
    namespace: 'AWS/RDS', dim: 'DBInstanceIdentifier',
    metrics: [
      { key: 'CPU %', name: 'CPUUtilization' },
      { key: 'Connections', name: 'DatabaseConnections' },
      { key: 'Free Mem GB', name: 'FreeableMemory', scale: 1e-9 },
    ],
  },
};

/** Multi-metric time series for one EC2 instance / RDS instance (v1 drill-down chart). */
export async function resourceSeries(kind: string, id: string, range: string): Promise<Array<Record<string, unknown>>> {
  const spec = SERIES_METRICS[kind];
  const rg = SERIES_RANGES[range] ?? SERIES_RANGES['6h'];
  if (!spec) return [];
  try {
    const r = await cwClient().send(new GetMetricDataCommand({
      StartTime: new Date(Date.now() - rg.ms), EndTime: new Date(),
      ScanBy: 'TimestampAscending',
      MetricDataQueries: spec.metrics.map((m, i) => ({
        Id: `s${i}`, ReturnData: true,
        MetricStat: { Metric: { Namespace: spec.namespace, MetricName: m.name, Dimensions: [{ Name: spec.dim, Value: id }] }, Period: rg.period, Stat: 'Average' },
      })),
    }));
    const byT = new Map<string, Record<string, unknown>>();
    for (const res of r.MetricDataResults ?? []) {
      const i = Number((res.Id ?? '').replace('s', ''));
      const m = spec.metrics[i];
      if (!m) continue;
      (res.Timestamps ?? []).forEach((ts, j) => {
        const t = new Date(ts as unknown as string).toISOString().slice(5, 16).replace('T', ' ');
        const p = byT.get(t) ?? { t };
        const v = res.Values?.[j];
        if (typeof v === 'number') p[m.key] = Math.round(v * (m.scale ?? 1) * 100) / 100;
        byT.set(t, p);
      });
    }
    return [...byT.values()].sort((a, b) => String(a.t).localeCompare(String(b.t)));
  } catch {
    return [];
  }
}

export const SERIES_KEYS: Record<string, string[]> = Object.fromEntries(
  Object.entries(SERIES_METRICS).map(([k, v]) => [k, v.metrics.map((m) => m.key)]),
);

// ── v1-parity per-entity live metric fleets (요청: ElastiCache 노드 / OpenSearch 도메인 / MSK 브로커) ──
// Same GetMetricData batching discipline as ec2FleetLive: Period 300, last-1h window, latest
// value only (Values[0]), one call per ≤480-query chunk, every failure degrades to nulls.

async function fleetLatest(
  namespace: string,
  entities: string[],
  dimsFor: (id: string) => { Name: string; Value: string }[],
  metrics: readonly { key: string; name: string; stat: string; dims?: readonly { Name: string; Value: string }[]; period?: number }[],
  region?: string,
  windowMs = 3600_000,
  periodSec = 300,
): Promise<Record<string, Record<string, number | null>>> {
  const out: Record<string, Record<string, number | null>> = {};
  if (!entities.length) return out;
  for (const id of entities) out[id] = Object.fromEntries(metrics.map((m) => [m.key, null]));
  try {
    // CloudWatch metrics live in the resource's region — an off-region cluster (e.g. a DR MSK
    // in us-west-2) needs its own regional client; default stays the deployment region.
    const client = region && region !== REGION ? new CloudWatchClient({ region }) : cwClient();
    const CHUNK = Math.max(1, Math.floor(480 / metrics.length));
    for (let c = 0; c < entities.length; c += CHUNK) {
      const chunk = entities.slice(c, c + CHUNK);
      const r = await client.send(new GetMetricDataCommand({
        StartTime: new Date(Date.now() - windowMs), EndTime: new Date(),
        MetricDataQueries: chunk.flatMap((id, i) =>
          metrics.map((m) => ({
            Id: `${m.key}_i${i}`, ReturnData: true,
            MetricStat: { Metric: { Namespace: namespace, MetricName: m.name, Dimensions: [...dimsFor(id), ...(m.dims ?? [])] }, Period: m.period ?? periodSec, Stat: m.stat },
          }))),
      }));
      for (const res of r.MetricDataResults ?? []) {
        const mm = (res.Id ?? '').match(/^(\w+?)_i(\d+)$/);
        if (!mm) continue;
        const id = chunk[Number(mm[2])];
        const v = res.Values?.[0];
        if (id && typeof v === 'number') out[id][mm[1]] = v;
      }
    }
  } catch { /* nulls */ }
  return out;
}

const EC_FLEET_METRICS = [
  { key: 'cpu', name: 'CPUUtilization', stat: 'Average' },
  { key: 'ecpu', name: 'EngineCPUUtilization', stat: 'Average' },
  { key: 'mem', name: 'FreeableMemory', stat: 'Average' },
  { key: 'conn', name: 'CurrConnections', stat: 'Average' },
  { key: 'netIn', name: 'NetworkBytesIn', stat: 'Sum' },
  { key: 'netOut', name: 'NetworkBytesOut', stat: 'Sum' },
  // 진단 계층 (owner 가이드): DatabaseMemoryUsagePercentage가 가장 중요한 경보 지표,
  // Evictions>0 지속=메모리 부족, Network*AllowanceExceeded=놓치기 쉬운 대역폭 상한 병목.
  { key: 'dbMemPct', name: 'DatabaseMemoryUsagePercentage', stat: 'Average' },
  { key: 'hitRate', name: 'CacheHitRate', stat: 'Average' },
  { key: 'evictions', name: 'Evictions', stat: 'Sum' },
  { key: 'reclaimed', name: 'Reclaimed', stat: 'Sum' },
  { key: 'swap', name: 'SwapUsage', stat: 'Average' },
  { key: 'currItems', name: 'CurrItems', stat: 'Average' },
  { key: 'newConn', name: 'NewConnections', stat: 'Sum' },
  { key: 'bwInEx', name: 'NetworkBandwidthInAllowanceExceeded', stat: 'Sum' },
  { key: 'bwOutEx', name: 'NetworkBandwidthOutAllowanceExceeded', stat: 'Sum' },
  { key: 'replLag', name: 'ReplicationLag', stat: 'Average' },
] as const;
/** Per-CacheClusterId latest metrics (v1 elasticache 노드 메트릭 — cluster-level, applied to each node). */
export function elasticacheFleetLive(ids: string[], rangeSec = 3600) {
  return fleetLatest('AWS/ElastiCache', ids, (id) => [{ Name: 'CacheClusterId', Value: id }], EC_FLEET_METRICS, undefined, rangeSec * 1000, rangeSec);
}

const OS_FLEET_METRICS = [
  { key: 'cpu', name: 'CPUUtilization', stat: 'Average' },
  { key: 'jvm', name: 'JVMMemoryPressure', stat: 'Average' },
  { key: 'freeStorage', name: 'FreeStorageSpace', stat: 'Average' },
  { key: 'green', name: 'ClusterStatus.green', stat: 'Maximum' },
  { key: 'yellow', name: 'ClusterStatus.yellow', stat: 'Maximum' },
  { key: 'red', name: 'ClusterStatus.red', stat: 'Maximum' },
  { key: 'nodes', name: 'Nodes', stat: 'Average' },
  { key: 'docs', name: 'SearchableDocuments', stat: 'Average' },
  { key: 'searchLatency', name: 'SearchLatency', stat: 'Average' },
  { key: 'indexLatency', name: 'IndexingLatency', stat: 'Average' },
  { key: 'searchRate', name: 'SearchRate', stat: 'Sum' },
  { key: 'indexRate', name: 'IndexingRate', stat: 'Sum' },
  // 진단 계층 (owner 가이드): 쓰기 차단·스레드풀 거부(포화 신호)·마스터 병목·스냅샷 실패.
  { key: 'writesBlocked', name: 'ClusterIndexWritesBlocked', stat: 'Maximum' },
  { key: 'masterCpu', name: 'MasterCPUUtilization', stat: 'Average' },
  { key: 'searchQueue', name: 'ThreadpoolSearchQueue', stat: 'Maximum' },
  { key: 'writeQueue', name: 'ThreadpoolWriteQueue', stat: 'Maximum' },
  { key: 'searchRejected', name: 'ThreadpoolSearchRejected', stat: 'Sum' },
  { key: 'writeRejected', name: 'ThreadpoolWriteRejected', stat: 'Sum' },
  { key: 'diskQueue', name: 'DiskQueueDepth', stat: 'Average' },
  { key: 'http5xx', name: '5xx', stat: 'Sum' },
  { key: 'snapshotFail', name: 'AutomatedSnapshotFailure', stat: 'Maximum' },
] as const;
/** Per-domain latest metrics (v1 opensearch 도메인 메트릭). AWS/ES requires the ClientId dimension. */
export function opensearchFleetLive(domains: string[], rangeSec = 3600) {
  return fleetLatest('AWS/ES', domains, (id) => [
    { Name: 'DomainName', Value: id },
    { Name: 'ClientId', Value: process.env.AWS_ACCOUNT_ID ?? '' },
  ], OS_FLEET_METRICS, undefined, rangeSec * 1000, rangeSec);
}

export interface MskNode {
  nodeType: string; brokerId: number | null; instanceType: string | null;
  clientVpcIp: string | null; eni: string | null; endpoints: string[];
}
/** Broker/controller nodes for an MSK cluster (kafka ListNodes — Steampipe has no node table). */
export async function mskListNodes(clusterArn: string): Promise<MskNode[]> {
  try {
    // kafka is regional — parse the cluster's region off the ARN (DR clusters live off-region).
    const region = clusterArn.split(':')[3] || REGION;
    const client = new KafkaClient({ region });
    const r = await client.send(new ListNodesCommand({ ClusterArn: clusterArn, MaxResults: 100 }));
    return (r.NodeInfoList ?? []).map((n) => ({
      nodeType: n.NodeType ?? 'BROKER',
      brokerId: n.BrokerNodeInfo?.BrokerId != null ? Math.round(n.BrokerNodeInfo.BrokerId) : null,
      instanceType: n.InstanceType ?? null,
      clientVpcIp: n.BrokerNodeInfo?.ClientVpcIpAddress ?? null,
      eni: n.BrokerNodeInfo?.AttachedENIId ?? null,
      endpoints: n.BrokerNodeInfo?.Endpoints ?? n.ControllerNodeInfo?.Endpoints ?? [],
    }));
  } catch {
    return [];
  }
}

const MSK_BROKER_METRICS = [
  { key: 'cpuUser', name: 'CpuUser', stat: 'Average' },
  { key: 'cpuSystem', name: 'CpuSystem', stat: 'Average' },
  { key: 'memUsed', name: 'MemoryUsed', stat: 'Average' },
  { key: 'memFree', name: 'MemoryFree', stat: 'Average' },
  { key: 'bytesIn', name: 'BytesInPerSec', stat: 'Average' },
  { key: 'bytesOut', name: 'BytesOutPerSec', stat: 'Average' },
  // 진단 계층 확장 (owner 가이드): 디스크 고갈이 가장 흔한 장애 원인 (85% 임계),
  // 복제 건강성(URP/MinISR)은 정상값 0, 스로틀은 쿼터/네트워크 병목 신호.
  { key: 'dataDisk', name: 'KafkaDataLogsDiskUsed', stat: 'Average' },
  { key: 'rootDisk', name: 'RootDiskUsed', stat: 'Average' },
  { key: 'msgsIn', name: 'MessagesInPerSec', stat: 'Average' },
  { key: 'produceThrottle', name: 'ProduceThrottleTime', stat: 'Average' },
  { key: 'fetchThrottle', name: 'FetchThrottleTime', stat: 'Average' },
  { key: 'urp', name: 'UnderReplicatedPartitions', stat: 'Maximum' },
  { key: 'underMinIsr', name: 'UnderMinIsrPartitionCount', stat: 'Maximum' },
] as const;
/** Per-broker latest metrics (v1 msk 브로커 메트릭 — dims 'Cluster Name' + 'Broker ID'). */
export function mskBrokerFleetLive(clusterName: string, brokerIds: number[], region?: string, rangeSec = 3600) {
  return fleetLatest('AWS/Kafka', brokerIds.map(String), (id) => [
    { Name: 'Cluster Name', Value: clusterName },
    { Name: 'Broker ID', Value: id },
  ], MSK_BROKER_METRICS, region, rangeSec * 1000, rangeSec);
}

const MSK_CLUSTER_HEALTH_METRICS = [
  { key: 'activeControllers', name: 'ActiveControllerCount', stat: 'Maximum' },
  { key: 'offlinePartitions', name: 'OfflinePartitionsCount', stat: 'Maximum' },
  { key: 'globalPartitions', name: 'GlobalPartitionCount', stat: 'Maximum' },
] as const;
/** Cluster-level health metrics (v1 gap — 진단 우선순위 표: 컨트롤러=1, 오프라인 파티션=0). */
export async function mskClusterHealth(clusterName: string, region?: string, rangeSec = 3600): Promise<Record<string, number | null>> {
  const r = await fleetLatest('AWS/Kafka', [clusterName], (id) => [{ Name: 'Cluster Name', Value: id }], MSK_CLUSTER_HEALTH_METRICS, region, rangeSec * 1000, rangeSec);
  return r[clusterName] ?? {};
}

export interface MskOffsetLagRow { consumerGroup: string; topic: string; maxOffsetLag: number | null }
/** Consumer-group MaxOffsetLag rows for a cluster — series discovered via ListMetrics (the
 *  Consumer Group/Topic dimension values aren't known upfront), then one GetMetricData batch.
 *  실무 최우선 지표 (owner 가이드): lag이 계속 증가하면 컨슈머가 프로듀서를 못 따라가는 중. */
export async function mskOffsetLags(clusterName: string, region?: string, cap = 20, rangeSec = 3600): Promise<MskOffsetLagRow[]> {
  try {
    const client = region && region !== REGION ? new CloudWatchClient({ region }) : cwClient();
    const lm = await client.send(new ListMetricsCommand({
      Namespace: 'AWS/Kafka', MetricName: 'MaxOffsetLag',
      Dimensions: [{ Name: 'Cluster Name', Value: clusterName }],
    }));
    const series = (lm.Metrics ?? []).slice(0, cap).map((m) => {
      const dim = (n: string) => m.Dimensions?.find((d) => d.Name === n)?.Value ?? '';
      return { consumerGroup: dim('Consumer Group'), topic: dim('Topic'), dims: m.Dimensions ?? [] };
    }).filter((x) => x.consumerGroup || x.topic);
    if (!series.length) return [];
    const r = await client.send(new GetMetricDataCommand({
      StartTime: new Date(Date.now() - rangeSec * 1000), EndTime: new Date(),
      MetricDataQueries: series.map((x, i) => ({
        Id: `lag_i${i}`, ReturnData: true,
        MetricStat: { Metric: { Namespace: 'AWS/Kafka', MetricName: 'MaxOffsetLag', Dimensions: x.dims }, Period: rangeSec, Stat: 'Maximum' },
      })),
    }));
    const byIdx = new Map<number, number>();
    for (const res of r.MetricDataResults ?? []) {
      const mm = (res.Id ?? '').match(/^lag_i(\d+)$/);
      const v = res.Values?.[0];
      if (mm && typeof v === 'number') byIdx.set(Number(mm[1]), v);
    }
    return series
      .map((x, i) => ({ consumerGroup: x.consumerGroup, topic: x.topic, maxOffsetLag: byIdx.get(i) ?? null }))
      .sort((a, b) => (b.maxOffsetLag ?? -1) - (a.maxOffsetLag ?? -1));
  } catch {
    return [];
  }
}

const RDS_FLEET_METRICS = [
  { key: 'cpu', name: 'CPUUtilization', stat: 'Average' },
  { key: 'freeStorage', name: 'FreeStorageSpace', stat: 'Average' },
  { key: 'freeMem', name: 'FreeableMemory', stat: 'Average' },
  { key: 'swap', name: 'SwapUsage', stat: 'Average' },
  { key: 'conn', name: 'DatabaseConnections', stat: 'Average' },
  { key: 'readLat', name: 'ReadLatency', stat: 'Average' },
  { key: 'writeLat', name: 'WriteLatency', stat: 'Average' },
  { key: 'readIops', name: 'ReadIOPS', stat: 'Average' },
  { key: 'writeIops', name: 'WriteIOPS', stat: 'Average' },
  { key: 'diskQueue', name: 'DiskQueueDepth', stat: 'Average' },
  // 크레딧 계열 (owner 가이드: 프로덕션에서 자주 놓치는 함정) — gp2/T계열만 값이 존재.
  { key: 'burst', name: 'BurstBalance', stat: 'Average' },
  { key: 'cpuCredit', name: 'CPUCreditBalance', stat: 'Average' },
  { key: 'replicaLag', name: 'ReplicaLag', stat: 'Average' },
] as const;
/** Per-DBInstance latest metrics (owner 가이드: RDS 진단 계층 — 인스턴스 레벨 CloudWatch). */
export function rdsFleetLive(ids: string[], rangeSec = 3600) {
  return fleetLatest('AWS/RDS', ids, (id) => [{ Name: 'DBInstanceIdentifier', Value: id }], RDS_FLEET_METRICS, undefined, rangeSec * 1000, rangeSec);
}

// DynamoDB per-table diagnostics (owner 가이드: 스로틀링이 진단의 최우선 — 용량 부족 vs 핫 파티션).
// 스로틀/에러 계열은 Sum(5분 누적 건수), 소비 용량은 Sum/300 = 초당 소비율로 환산해 프로비저닝과 비교,
// SuccessfulRequestLatency는 Operation 차원 필수 → 대표 4개 오퍼레이션으로 분해.
const DDB_TABLE_METRICS = [
  { key: 'rThrottle', name: 'ReadThrottleEvents', stat: 'Sum' },
  { key: 'wThrottle', name: 'WriteThrottleEvents', stat: 'Sum' },
  { key: 'consumedR', name: 'ConsumedReadCapacityUnits', stat: 'Sum' },
  { key: 'consumedW', name: 'ConsumedWriteCapacityUnits', stat: 'Sum' },
  { key: 'provR', name: 'ProvisionedReadCapacityUnits', stat: 'Average' },
  { key: 'provW', name: 'ProvisionedWriteCapacityUnits', stat: 'Average' },
  { key: 'condFail', name: 'ConditionalCheckFailedRequests', stat: 'Sum' },
  { key: 'txnConflict', name: 'TransactionConflict', stat: 'Sum' },
  { key: 'latGet', name: 'SuccessfulRequestLatency', stat: 'Average', dims: [{ Name: 'Operation', Value: 'GetItem' }] },
  { key: 'latQuery', name: 'SuccessfulRequestLatency', stat: 'Average', dims: [{ Name: 'Operation', Value: 'Query' }] },
  { key: 'latPut', name: 'SuccessfulRequestLatency', stat: 'Average', dims: [{ Name: 'Operation', Value: 'PutItem' }] },
  { key: 'latScan', name: 'SuccessfulRequestLatency', stat: 'Average', dims: [{ Name: 'Operation', Value: 'Scan' }] },
] as const;
export function ddbFleetLive(tables: string[], rangeSec = 3600) {
  return fleetLatest('AWS/DynamoDB', tables, (id) => [{ Name: 'TableName', Value: id }], DDB_TABLE_METRICS, undefined, rangeSec * 1000, rangeSec);
}

export interface DdbReplicationRow { table: string; region: string; latencyMs: number | null }
/** Global Tables 리전 간 복제 지연 — ReceivingRegion 차원을 모르므로 ListMetrics로 발견. */
export async function ddbReplicationLags(cap = 30, rangeSec = 3600): Promise<DdbReplicationRow[]> {
  try {
    const lm = await cwClient().send(new ListMetricsCommand({
      Namespace: 'AWS/DynamoDB', MetricName: 'ReplicationLatency',
    }));
    const series = (lm.Metrics ?? []).slice(0, cap).map((m) => {
      const dim = (n: string) => m.Dimensions?.find((d) => d.Name === n)?.Value ?? '';
      return { table: dim('TableName'), region: dim('ReceivingRegion'), dims: m.Dimensions ?? [] };
    }).filter((x) => x.table);
    if (!series.length) return [];
    const r = await cwClient().send(new GetMetricDataCommand({
      StartTime: new Date(Date.now() - rangeSec * 1000), EndTime: new Date(),
      MetricDataQueries: series.map((x, i) => ({
        Id: `rep_i${i}`, ReturnData: true,
        MetricStat: { Metric: { Namespace: 'AWS/DynamoDB', MetricName: 'ReplicationLatency', Dimensions: x.dims }, Period: rangeSec, Stat: 'Average' },
      })),
    }));
    const byIdx = new Map<number, number>();
    for (const res of r.MetricDataResults ?? []) {
      const mm = (res.Id ?? '').match(/^rep_i(\d+)$/);
      const v = res.Values?.[0];
      if (mm && typeof v === 'number') byIdx.set(Number(mm[1]), v);
    }
    return series
      .map((x, i) => ({ table: x.table, region: x.region, latencyMs: byIdx.get(i) ?? null }))
      .sort((a, b) => (b.latencyMs ?? -1) - (a.latencyMs ?? -1));
  } catch {
    return [];
  }
}

// ALB per-LB diagnostics (owner 가이드: LB가 낸 에러 vs 타깃이 낸 에러 구분이 진단의 출발점).
// entities = CloudWatch LoadBalancer 차원 값("app/<name>/<id>", ARN 접미사) — 라우트가
// 인벤토리 ARN에서 도출해 resource_id로 되돌려 매핑한다. p50/p99는 확장 통계.
const ALB_FLEET_METRICS = [
  { key: 'elb5xx', name: 'HTTPCode_ELB_5XX_Count', stat: 'Sum' },
  { key: 'elb502', name: 'HTTPCode_ELB_502_Count', stat: 'Sum' },
  { key: 'elb503', name: 'HTTPCode_ELB_503_Count', stat: 'Sum' },
  { key: 'elb504', name: 'HTTPCode_ELB_504_Count', stat: 'Sum' },
  { key: 'tgt5xx', name: 'HTTPCode_Target_5XX_Count', stat: 'Sum' },
  { key: 'tgt4xx', name: 'HTTPCode_Target_4XX_Count', stat: 'Sum' },
  { key: 'tgt2xx', name: 'HTTPCode_Target_2XX_Count', stat: 'Sum' },
  { key: 'respP50', name: 'TargetResponseTime', stat: 'p50' },
  { key: 'respP99', name: 'TargetResponseTime', stat: 'p99' },
  { key: 'requests', name: 'RequestCount', stat: 'Sum' },
  { key: 'active', name: 'ActiveConnectionCount', stat: 'Sum' },
  { key: 'newConn', name: 'NewConnectionCount', stat: 'Sum' },
  { key: 'rejected', name: 'RejectedConnectionCount', stat: 'Sum' },
  { key: 'tgtConnErr', name: 'TargetConnectionErrorCount', stat: 'Sum' },
  { key: 'clientTlsErr', name: 'ClientTLSNegotiationErrorCount', stat: 'Sum' },
  { key: 'lcu', name: 'ConsumedLCUs', stat: 'Sum' },
] as const;
export function albFleetLive(lbDims: string[], rangeSec = 3600) {
  return fleetLatest('AWS/ApplicationELB', lbDims, (id) => [{ Name: 'LoadBalancer', Value: id }], ALB_FLEET_METRICS, undefined, rangeSec * 1000, rangeSec);
}

export interface AlbTgHealthRow { tg: string; tgName: string; lbDim: string; healthy: number | null; unhealthy: number | null }
/** Per-TargetGroup 헬스 (Healthy/UnHealthyHostCount는 TG 차원이어야 의미) — (tgDim, lbDim) 쌍으로 조회.
 *  namespace: AWS/ApplicationELB(기본) 또는 AWS/NetworkELB — ALB/NLB 공용. */
export async function albTargetHealth(pairs: { tgDim: string; tgName: string; lbDim: string }[], namespace = 'AWS/ApplicationELB', rangeSec = 3600): Promise<AlbTgHealthRow[]> {
  if (!pairs.length) return [];
  try {
    const capped = pairs.slice(0, 100);
    const r = await cwClient().send(new GetMetricDataCommand({
      StartTime: new Date(Date.now() - rangeSec * 1000), EndTime: new Date(),
      MetricDataQueries: capped.flatMap((p, i) => [
        { Id: `h_i${i}`, ReturnData: true, MetricStat: { Metric: { Namespace: namespace, MetricName: 'HealthyHostCount', Dimensions: [{ Name: 'TargetGroup', Value: p.tgDim }, { Name: 'LoadBalancer', Value: p.lbDim }] }, Period: rangeSec, Stat: 'Minimum' } },
        { Id: `u_i${i}`, ReturnData: true, MetricStat: { Metric: { Namespace: namespace, MetricName: 'UnHealthyHostCount', Dimensions: [{ Name: 'TargetGroup', Value: p.tgDim }, { Name: 'LoadBalancer', Value: p.lbDim }] }, Period: rangeSec, Stat: 'Maximum' } },
      ]),
    }));
    const vals = new Map<string, number>();
    for (const res of r.MetricDataResults ?? []) {
      const v = res.Values?.[0];
      if (res.Id && typeof v === 'number') vals.set(res.Id, v);
    }
    return capped.map((p, i) => ({
      tg: p.tgDim, tgName: p.tgName, lbDim: p.lbDim,
      healthy: vals.get(`h_i${i}`) ?? null, unhealthy: vals.get(`u_i${i}`) ?? null,
    }));
  } catch {
    return [];
  }
}

// NLB per-LB diagnostics (owner 가이드: L4 — HTTP 코드가 없어 RST 카운트와 타깃 헬스가 진단의 핵심).
const NLB_FLEET_METRICS = [
  { key: 'activeFlow', name: 'ActiveFlowCount', stat: 'Average' },
  { key: 'newFlow', name: 'NewFlowCount', stat: 'Sum' },
  { key: 'tgtRst', name: 'TCP_Target_Reset_Count', stat: 'Sum' },
  { key: 'elbRst', name: 'TCP_ELB_Reset_Count', stat: 'Sum' },
  { key: 'clientRst', name: 'TCP_Client_Reset_Count', stat: 'Sum' },
  { key: 'processedBytes', name: 'ProcessedBytes', stat: 'Sum' },
  { key: 'clientTlsErr', name: 'ClientTLSNegotiationErrorCount', stat: 'Sum' },
  { key: 'targetTlsErr', name: 'TargetTLSNegotiationErrorCount', stat: 'Sum' },
  { key: 'portAllocErr', name: 'PortAllocationErrorCount', stat: 'Sum' },
  { key: 'unhealthyRouting', name: 'UnhealthyRoutingFlowCount', stat: 'Sum' },
  { key: 'lcu', name: 'ConsumedLCUs', stat: 'Sum' },
] as const;
export function nlbFleetLive(lbDims: string[], rangeSec = 3600) {
  return fleetLatest('AWS/NetworkELB', lbDims, (id) => [{ Name: 'LoadBalancer', Value: id }], NLB_FLEET_METRICS, undefined, rangeSec * 1000, rangeSec);
}

// S3 per-bucket diagnostics (owner 가이드): 스토리지 메트릭(무료, 일 1회)과 요청 메트릭(유료,
// 1분 — 버킷에서 활성화해야 존재, FilterId='EntireBucket' 관례)을 함께. 윈도 2일(일별 집계 포착).
const S3_FLEET_METRICS = [
  { key: 'sizeStd', name: 'BucketSizeBytes', stat: 'Average', period: 86400, dims: [{ Name: 'StorageType', Value: 'StandardStorage' }] },
  { key: 'objects', name: 'NumberOfObjects', stat: 'Average', period: 86400, dims: [{ Name: 'StorageType', Value: 'AllStorageTypes' }] },
  { key: 'allReq', name: 'AllRequests', stat: 'Sum', dims: [{ Name: 'FilterId', Value: 'EntireBucket' }] },
  { key: 'req4xx', name: '4xxErrors', stat: 'Sum', dims: [{ Name: 'FilterId', Value: 'EntireBucket' }] },
  { key: 'req5xx', name: '5xxErrors', stat: 'Sum', dims: [{ Name: 'FilterId', Value: 'EntireBucket' }] },
  { key: 'firstByte', name: 'FirstByteLatency', stat: 'Average', dims: [{ Name: 'FilterId', Value: 'EntireBucket' }] },
  { key: 'bytesDown', name: 'BytesDownloaded', stat: 'Sum', dims: [{ Name: 'FilterId', Value: 'EntireBucket' }] },
  { key: 'bytesUp', name: 'BytesUploaded', stat: 'Sum', dims: [{ Name: 'FilterId', Value: 'EntireBucket' }] },
] as const;
/** Per-bucket S3 metrics — S3 CloudWatch metrics live in the BUCKET's region (caller groups by region). */
export function s3FleetLive(buckets: string[], region?: string, rangeSec = 3600) {
  // 스토리지 메트릭(일별, m.period=86400)이 잡히도록 윈도는 최소 2일 유지; 요청 메트릭은 range로 집계.
  return fleetLatest('AWS/S3', buckets, (id) => [{ Name: 'BucketName', Value: id }], S3_FLEET_METRICS, region, Math.max(rangeSec * 1000, 2 * 86400_000), rangeSec);
}

export interface S3ReplicationRow { source: string; dest: string; rule: string; latencySec: number | null; failed: number | null }
/** CRR/SRR 복제 상태 — Source/DestinationBucket/RuleId 차원을 ListMetrics로 발견 (배포 리전 한정). */
export async function s3ReplicationStatus(cap = 30, rangeSec = 3600): Promise<S3ReplicationRow[]> {
  try {
    const lm = await cwClient().send(new ListMetricsCommand({ Namespace: 'AWS/S3', MetricName: 'ReplicationLatency' }));
    const series = (lm.Metrics ?? []).slice(0, cap).map((m) => {
      const dim = (n: string) => m.Dimensions?.find((d) => d.Name === n)?.Value ?? '';
      return { source: dim('SourceBucket'), dest: dim('DestinationBucket'), rule: dim('RuleId'), dims: m.Dimensions ?? [] };
    }).filter((x) => x.source);
    if (!series.length) return [];
    const r = await cwClient().send(new GetMetricDataCommand({
      StartTime: new Date(Date.now() - rangeSec * 1000), EndTime: new Date(),
      MetricDataQueries: series.flatMap((x, i) => [
        { Id: `sl_i${i}`, ReturnData: true, MetricStat: { Metric: { Namespace: 'AWS/S3', MetricName: 'ReplicationLatency', Dimensions: x.dims }, Period: rangeSec, Stat: 'Maximum' } },
        { Id: `sf_i${i}`, ReturnData: true, MetricStat: { Metric: { Namespace: 'AWS/S3', MetricName: 'OperationsFailedReplication', Dimensions: x.dims }, Period: rangeSec, Stat: 'Sum' } },
      ]),
    }));
    const vals = new Map<string, number>();
    for (const res of r.MetricDataResults ?? []) {
      const v = res.Values?.[0];
      if (res.Id && typeof v === 'number') vals.set(res.Id, v);
    }
    return series.map((x, i) => ({
      source: x.source, dest: x.dest, rule: x.rule,
      latencySec: vals.get(`sl_i${i}`) ?? null, failed: vals.get(`sf_i${i}`) ?? null,
    })).sort((a, b) => (b.latencySec ?? -1) - (a.latencySec ?? -1));
  } catch {
    return [];
  }
}

// EBS per-volume diagnostics (owner 가이드: 볼륨 성능 한계 vs 인스턴스 EBS 대역폭 구분이 핵심).
// 원시값은 기간 합계 — IOPS/MBps/평균지연은 컴포넌트에서 /300, TotalTime/Ops로 환산한다.
const EBS_FLEET_METRICS = [
  { key: 'readOps', name: 'VolumeReadOps', stat: 'Sum' },
  { key: 'writeOps', name: 'VolumeWriteOps', stat: 'Sum' },
  { key: 'readBytes', name: 'VolumeReadBytes', stat: 'Sum' },
  { key: 'writeBytes', name: 'VolumeWriteBytes', stat: 'Sum' },
  { key: 'totalReadTime', name: 'VolumeTotalReadTime', stat: 'Sum' },
  { key: 'totalWriteTime', name: 'VolumeTotalWriteTime', stat: 'Sum' },
  { key: 'queueLength', name: 'VolumeQueueLength', stat: 'Average' },
  { key: 'burstBalance', name: 'BurstBalance', stat: 'Average' },
  { key: 'throughputPct', name: 'VolumeThroughputPercentage', stat: 'Average' },
  { key: 'idleTime', name: 'VolumeIdleTime', stat: 'Sum' },
] as const;
export function ebsFleetLive(volumeIds: string[], region?: string, rangeSec = 3600) {
  return fleetLatest('AWS/EBS', volumeIds, (id) => [{ Name: 'VolumeId', Value: id }], EBS_FLEET_METRICS, region, rangeSec * 1000, rangeSec);
}

// 인스턴스 레벨 EBS 대역폭 버스트 잔량 (소형 Nitro 인스턴스만 발행 — 0 근접 = 인스턴스가 병목).
const EC2_EBS_BALANCE_METRICS = [
  { key: 'ioBalance', name: 'EBSIOBalance%', stat: 'Average' },
  { key: 'byteBalance', name: 'EBSByteBalance%', stat: 'Average' },
] as const;
export function ec2EbsBalance(instanceIds: string[], region?: string, rangeSec = 3600) {
  return fleetLatest('AWS/EC2', instanceIds, (id) => [{ Name: 'InstanceId', Value: id }], EC2_EBS_BALANCE_METRICS, region, rangeSec * 1000, rangeSec);
}

// EC2 per-instance diagnostics (owner 가이드: 상태 점검의 System vs Instance 구분이 책임 소재를
// 즉시 가르는 핵심 — 메모리/디스크는 기본 메트릭에 없음(CloudWatch Agent 필요), 가이드가 설명).
const EC2_DIAG_METRICS = [
  { key: 'cpu', name: 'CPUUtilization', stat: 'Average' },
  { key: 'cpuCredit', name: 'CPUCreditBalance', stat: 'Average' },
  { key: 'statusSystem', name: 'StatusCheckFailed_System', stat: 'Maximum' },
  { key: 'statusInstance', name: 'StatusCheckFailed_Instance', stat: 'Maximum' },
  { key: 'statusEbs', name: 'StatusCheckFailed_AttachedEBS', stat: 'Maximum' },
  { key: 'netIn', name: 'NetworkIn', stat: 'Sum' },
  { key: 'netOut', name: 'NetworkOut', stat: 'Sum' },
  { key: 'pktIn', name: 'NetworkPacketsIn', stat: 'Sum' },
  { key: 'pktOut', name: 'NetworkPacketsOut', stat: 'Sum' },
  { key: 'ebsReadOps', name: 'EBSReadOps', stat: 'Sum' },
  { key: 'ebsWriteOps', name: 'EBSWriteOps', stat: 'Sum' },
  { key: 'ioBalance', name: 'EBSIOBalance%', stat: 'Average' },
  { key: 'byteBalance', name: 'EBSByteBalance%', stat: 'Average' },
] as const;
export function ec2DiagFleetLive(instanceIds: string[], region?: string, rangeSec = 3600) {
  return fleetLatest('AWS/EC2', instanceIds, (id) => [{ Name: 'InstanceId', Value: id }], EC2_DIAG_METRICS, region, rangeSec * 1000, rangeSec);
}

// Lambda per-function diagnostics (owner 가이드: 호출·에러(율)·스로틀·Duration p50/p99·동시성·
// 스트림 IteratorAge·PC 스필오버 — 서버리스라 인프라 메트릭 없음, 실행 단위에 집중).
const LAMBDA_FLEET_METRICS = [
  { key: 'invocations', name: 'Invocations', stat: 'Sum' },
  { key: 'errors', name: 'Errors', stat: 'Sum' },
  { key: 'throttles', name: 'Throttles', stat: 'Sum' },
  { key: 'durP50', name: 'Duration', stat: 'p50' },
  { key: 'durP99', name: 'Duration', stat: 'p99' },
  { key: 'concurrent', name: 'ConcurrentExecutions', stat: 'Maximum' },
  { key: 'iteratorAge', name: 'IteratorAge', stat: 'Maximum' },
  { key: 'deadLetterErrors', name: 'DeadLetterErrors', stat: 'Sum' },
  { key: 'pcSpillover', name: 'ProvisionedConcurrencySpilloverInvocations', stat: 'Sum' },
  { key: 'pcUtil', name: 'ProvisionedConcurrencyUtilization', stat: 'Maximum' },
] as const;
export function lambdaFleetLive(functionNames: string[], region?: string, rangeSec = 3600) {
  return fleetLatest('AWS/Lambda', functionNames, (id) => [{ Name: 'FunctionName', Value: id }], LAMBDA_FLEET_METRICS, region, rangeSec * 1000, rangeSec);
}


// ── EKS diagnosis tier (owner 가이드: 컨트롤 플레인/노드/워크로드/스케줄링 계층별) ──────────
// 소스 2곳: AWS/EKS(컨트롤 플레인 — EKS 관리형 발행) + ContainerInsights(노드/파드 — 에이전트 필요).
// CI 미설치 클러스터는 값이 null로 남아 '—' 정직 표시 (Aurora FreeStorageSpace 선례).

// AWS/EKS control-plane metrics: verb-suffixed P99s are pre-aggregated series (Average over
// the range reads the P99 level; Sum would be meaningless), counters are Sum, gauges Max.
const EKS_CONTROL_PLANE_METRICS = [
  { key: 'p99Get', name: 'apiserver_request_duration_seconds_GET_P99', stat: 'Average' },
  { key: 'p99List', name: 'apiserver_request_duration_seconds_LIST_P99', stat: 'Average' },
  { key: 'p99Post', name: 'apiserver_request_duration_seconds_POST_P99', stat: 'Average' },
  { key: 'p99Put', name: 'apiserver_request_duration_seconds_PUT_P99', stat: 'Average' },
  { key: 'p99Patch', name: 'apiserver_request_duration_seconds_PATCH_P99', stat: 'Average' },
  { key: 'p99Delete', name: 'apiserver_request_duration_seconds_DELETE_P99', stat: 'Average' },
  { key: 'reqTotal', name: 'apiserver_request_total', stat: 'Sum' },
  { key: 'err429', name: 'apiserver_request_total_429', stat: 'Sum' },
  { key: 'err4xx', name: 'apiserver_request_total_4XX', stat: 'Sum' },
  { key: 'err5xx', name: 'apiserver_request_total_5XX', stat: 'Sum' },
  { key: 'inflightMutating', name: 'apiserver_current_inflight_requests_MUTATING', stat: 'Maximum' },
  { key: 'inflightReadonly', name: 'apiserver_current_inflight_requests_READONLY', stat: 'Maximum' },
  { key: 'etcdDbBytes', name: 'etcd_mvcc_db_total_size_in_use_in_bytes', stat: 'Maximum' },
  { key: 'storageBytes', name: 'apiserver_storage_size_bytes', stat: 'Maximum' },
  { key: 'pendingPods', name: 'scheduler_pending_pods', stat: 'Maximum' },
  { key: 'pendingUnschedulable', name: 'scheduler_pending_pods_UNSCHEDULABLE', stat: 'Maximum' },
  { key: 'schedErrors', name: 'scheduler_schedule_attempts_ERROR', stat: 'Sum' },
  { key: 'schedUnschedulable', name: 'scheduler_schedule_attempts_UNSCHEDULABLE', stat: 'Sum' },
] as const;
export async function eksControlPlane(cluster: string, region?: string, rangeSec = 3600): Promise<Record<string, number | null>> {
  const out = await fleetLatest('AWS/EKS', [cluster], (id) => [{ Name: 'ClusterName', Value: id }], EKS_CONTROL_PLANE_METRICS, region, rangeSec * 1000, rangeSec);
  return out[cluster] ?? {};
}

// ContainerInsights cluster rollups (dims: ClusterName only) — pod_* rollups aggregate the
// whole cluster; restarts are a range Sum (재시작 급증 감지), status gauges are Max (지속/발생 여부).
const EKS_CLUSTER_CI_METRICS = [
  { key: 'nodeCount', name: 'cluster_node_count', stat: 'Average' },
  { key: 'failedNodes', name: 'cluster_failed_node_count', stat: 'Maximum' },
  { key: 'runningPods', name: 'cluster_number_of_running_pods', stat: 'Average' },
  { key: 'restarts', name: 'pod_number_of_container_restarts', stat: 'Sum' },
  { key: 'oomKilled', name: 'pod_container_status_terminated_reason_oom_killed', stat: 'Maximum' },
  { key: 'crashLoop', name: 'pod_container_status_waiting_reason_crash_loop_back_off', stat: 'Maximum' },
  { key: 'podPending', name: 'pod_status_pending', stat: 'Maximum' },
  { key: 'podFailed', name: 'pod_status_failed', stat: 'Maximum' },
  { key: 'cpuOverLimit', name: 'pod_cpu_utilization_over_pod_limit', stat: 'Average' },
  { key: 'memOverLimit', name: 'pod_memory_utilization_over_pod_limit', stat: 'Average' },
] as const;
export async function eksClusterCI(cluster: string, region?: string, rangeSec = 3600): Promise<Record<string, number | null>> {
  const out = await fleetLatest('ContainerInsights', [cluster], (id) => [{ Name: 'ClusterName', Value: id }], EKS_CLUSTER_CI_METRICS, region, rangeSec * 1000, rangeSec);
  return out[cluster] ?? {};
}

// CI per-node metrics need the (ClusterName, InstanceId, NodeName) dim tuple — InstanceId is
// not known from the in-cluster API, so discover live tuples via ListMetrics (MSK lag 패턴).
const EKS_NODE_CI_METRICS = [
  { key: 'cpu', name: 'node_cpu_utilization', stat: 'Average' },
  { key: 'mem', name: 'node_memory_utilization', stat: 'Average' },
  { key: 'fs', name: 'node_filesystem_utilization', stat: 'Maximum' },
  { key: 'cpuReserved', name: 'node_cpu_reserved_capacity', stat: 'Average' },
  { key: 'memReserved', name: 'node_memory_reserved_capacity', stat: 'Average' },
  { key: 'netBytes', name: 'node_network_total_bytes', stat: 'Average' },
  { key: 'rxDropped', name: 'node_interface_network_rx_dropped', stat: 'Sum' },
  { key: 'txDropped', name: 'node_interface_network_tx_dropped', stat: 'Sum' },
] as const;
export async function eksNodesCI(cluster: string, region?: string, rangeSec = 3600, cap = 100): Promise<Record<string, Record<string, number | null>>> {
  try {
    const client = region && region !== REGION ? new CloudWatchClient({ region }) : cwClient();
    const lm = await client.send(new ListMetricsCommand({
      Namespace: 'ContainerInsights', MetricName: 'node_cpu_utilization',
      Dimensions: [{ Name: 'ClusterName', Value: cluster }],
    }));
    const dimsByNode = new Map<string, { Name: string; Value: string }[]>();
    for (const m of lm.Metrics ?? []) {
      const node = m.Dimensions?.find((d) => d.Name === 'NodeName')?.Value;
      // Skip the ClusterName-only rollup series; keep one full tuple per node.
      if (node && (m.Dimensions?.length ?? 0) >= 3 && !dimsByNode.has(node)) {
        dimsByNode.set(node, (m.Dimensions ?? []).map((d) => ({ Name: d.Name ?? '', Value: d.Value ?? '' })));
      }
    }
    const nodes = [...dimsByNode.keys()].slice(0, cap);
    return await fleetLatest('ContainerInsights', nodes, (id) => dimsByNode.get(id) ?? [], EKS_NODE_CI_METRICS, region, rangeSec * 1000, rangeSec);
  } catch {
    return {};
  }
}

// ── Transit Gateway 진단 메트릭 (inventory transit_gateway 하단) ─────────────
// Blackhole/NoRoute 드롭 >0 = 라우팅 문제의 직접 신호 (블랙홀 라우트 매칭/라우트 부재).
const TGW_FLEET_METRICS = [
  { key: 'bytesIn', name: 'BytesIn', stat: 'Sum' },
  { key: 'bytesOut', name: 'BytesOut', stat: 'Sum' },
  { key: 'packetsIn', name: 'PacketsIn', stat: 'Sum' },
  { key: 'packetsOut', name: 'PacketsOut', stat: 'Sum' },
  { key: 'dropBlackhole', name: 'PacketDropCountBlackhole', stat: 'Sum' },
  { key: 'dropNoRoute', name: 'PacketDropCountNoRoute', stat: 'Sum' },
] as const;
export function tgwFleetLive(tgwIds: string[], region?: string, rangeSec = 3600) {
  return fleetLatest('AWS/TransitGateway', tgwIds, (id) => [{ Name: 'TransitGateway', Value: id }], TGW_FLEET_METRICS, region, rangeSec * 1000, rangeSec);
}
