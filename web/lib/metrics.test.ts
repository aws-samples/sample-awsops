import { describe, it, expect, vi, beforeEach } from 'vitest';

const cwSend = vi.fn();
const priceSend = vi.fn();
vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class { send = cwSend; },
  GetMetricDataCommand: class { constructor(public input: unknown) {} },
  ListMetricsCommand: class { constructor(public input: unknown) {} },
}));
// assumedClient's member-account path hits a real STSClient — passthrough keeps the host path
// identical while letting member-account dims tests run against the mocked CloudWatch client.
vi.mock('./aws-assume', () => ({
  assumedClient: async (_a: unknown, Ctor: new (c: Record<string, unknown>) => unknown, cfg: Record<string, unknown> = {}) => new Ctor(cfg),
}));
vi.mock('@aws-sdk/client-pricing', () => ({
  PricingClient: class { send = priceSend; },
  GetProductsCommand: class { constructor(public input: unknown) {} },
}));

beforeEach(() => { cwSend.mockReset(); priceSend.mockReset(); });

// A realistic Pricing API PriceList entry (stringified JSON) → on-demand $/hr.
const priceList = (usd: string) => JSON.stringify({
  product: { attributes: { instanceType: 't3.micro' } },
  terms: {
    OnDemand: {
      'ABC.JRTCKXETXF': {
        priceDimensions: {
          'ABC.JRTCKXETXF.6YS6EN2CT7': {
            unit: 'Hrs',
            pricePerUnit: { USD: usd },
          },
        },
      },
    },
  },
});

describe('ec2CpuStats (gap L138 fleet-wide per-region)', () => {
  it('per-instance map + raw-value average, mapped by query Id (out-of-order safe)', async () => {
    cwSend.mockResolvedValueOnce({
      MetricDataResults: [
        { Id: 'cpu_i1', Values: [20.64] }, // out of order on purpose
        { Id: 'cpu_i0', Values: [10.24] },
      ],
    });
    const { ec2CpuStats } = await import('./metrics');
    const st = await ec2CpuStats({ 'ap-northeast-2': ['i-aaa', 'i-bbb'] });
    expect(st.byInstance).toEqual({ 'i-aaa': 10.2, 'i-bbb': 20.6 });
    // avg from RAW datapoints (10.24+20.64)/2 = 15.44 → 15.4, not from the rounded display values
    expect(st.avg).toBe(15.4);
  });

  it('merges regions — one GetMetricData batch per region, ids never cross-region sampled', async () => {
    cwSend
      .mockResolvedValueOnce({ MetricDataResults: [{ Id: 'cpu_i0', Values: [50] }] })
      .mockResolvedValueOnce({ MetricDataResults: [{ Id: 'cpu_i0', Values: [10] }] });
    const { ec2CpuStats } = await import('./metrics');
    const st = await ec2CpuStats({ 'ap-northeast-2': ['i-kr'], 'us-east-1': ['i-us'] });
    expect(cwSend).toHaveBeenCalledTimes(2);
    expect(Object.keys(st.byInstance).sort()).toEqual(['i-kr', 'i-us']);
    expect(st.avg).toBe(30);
  });

  it('empty input → {avg: null, byInstance: {}} without a CloudWatch call', async () => {
    const { ec2CpuStats } = await import('./metrics');
    expect(await ec2CpuStats({})).toEqual({ avg: null, byInstance: {} });
    expect(await ec2CpuStats({ 'ap-northeast-2': [] })).toEqual({ avg: null, byInstance: {} });
    expect(cwSend).not.toHaveBeenCalled();
  });

  it('no datapoints → avg null; a region-level CloudWatch deny degrades to the other regions', async () => {
    cwSend.mockResolvedValueOnce({ MetricDataResults: [{ Id: 'cpu_i0', Values: [] }] });
    const { ec2CpuStats } = await import('./metrics');
    expect((await ec2CpuStats({ 'ap-northeast-2': ['i-aaa'] })).avg).toBeNull();
    cwSend.mockRejectedValueOnce(new Error('AccessDenied'));
    cwSend.mockResolvedValueOnce({ MetricDataResults: [{ Id: 'cpu_i0', Values: [7] }] });
    const st = await ec2CpuStats({ 'us-east-1': ['i-denied'], 'ap-northeast-2': ['i-ok'] });
    expect(st.byInstance).toEqual({ 'i-ok': 7 });
  });
});
describe('ec2HourlyCost', () => {
  it('parses Pricing on-demand USD and sums price × count', async () => {
    priceSend
      .mockResolvedValueOnce({ PriceList: [priceList('0.0130')] }) // t3.micro
      .mockResolvedValueOnce({ PriceList: [priceList('0.0084')] }); // t4g.nano
    const { ec2HourlyCost } = await import('./metrics');
    // 0.0130*2 + 0.0084*1 = 0.0344 → round(*100)/100 = 0.03
    expect(await ec2HourlyCost({ 't3.micro': 2, 't4g.nano': 1 })).toBe(0.03);
    expect(priceSend).toHaveBeenCalledTimes(2);
  });

  it('caches per instance type (second call hits cache, no extra send)', async () => {
    priceSend.mockResolvedValueOnce({ PriceList: [priceList('1.00')] });
    const { ec2HourlyCost } = await import('./metrics');
    expect(await ec2HourlyCost({ 'cached.type': 3 })).toBe(3);
    expect(await ec2HourlyCost({ 'cached.type': 5 })).toBe(5);
    expect(priceSend).toHaveBeenCalledTimes(1); // cached on 2nd call
  });

  it('returns null when no type priced (empty PriceList / throw degrade)', async () => {
    priceSend.mockResolvedValueOnce({ PriceList: [] });
    const { ec2HourlyCost } = await import('./metrics');
    expect(await ec2HourlyCost({ 'unpriced.type': 4 })).toBeNull();
  });
});

describe('bedrockModelMetrics', () => {
  it('discovers models via ListMetrics then aggregates + prices GetMetricData', async () => {
    cwSend
      // Step 1: ListMetrics → one model dimension
      .mockResolvedValueOnce({ Metrics: [{ Dimensions: [{ Name: 'ModelId', Value: 'anthropic.claude-haiku-4-5' }] }] })
      // Step 2: GetMetricData → 8 metric results for m0
      .mockResolvedValueOnce({ MetricDataResults: [
        { Id: 'inv_m0', Values: [10, 5], Timestamps: ['2026-06-10T00:00:00Z', '2026-06-10T01:00:00Z'] },
        { Id: 'in_m0', Values: [600_000, 400_000], Timestamps: ['2026-06-10T00:00:00Z', '2026-06-10T01:00:00Z'] },
        { Id: 'out_m0', Values: [2_000_000], Timestamps: ['2026-06-10T00:00:00Z'] },
        { Id: 'lat_m0', Values: [120, 80] },
        { Id: 'e4_m0', Values: [1] },
        { Id: 'e5_m0', Values: [] },
        { Id: 'cr_m0', Values: [1_000_000] },
        { Id: 'cw_m0', Values: [0] },
      ] });
    const { bedrockModelMetrics } = await import('./metrics');
    const r = await bedrockModelMetrics('24h');
    expect(r.models).toHaveLength(1);
    const m = r.models[0];
    expect(m.label).toBe('Claude Haiku 4.5');
    expect(m.invocations).toBe(15);
    expect(m.inputTokens).toBe(1_000_000);
    expect(m.outputTokens).toBe(2_000_000);
    expect(m.avgLatencyMs).toBe(100); // (120+80)/2
    expect(m.cacheReadTokens).toBe(1_000_000);
    // haiku-4.5: input 1, output 5, cacheRead .1 → 1 + 10 + 0.1 = 11.1
    expect(m.cost.total).toBeCloseTo(11.1);
    expect(r.totalCost).toBeCloseTo(11.1);
    // combined token series sums input+output per timestamp
    expect(r.series.find((s) => s.t === '2026-06-10T00:00:00Z')?.tokens).toBe(2_600_000);
    // gap L184: per-model series preserved (invocations; in+out tokens merged per timestamp)
    expect(m.invSeries).toEqual([
      { t: '2026-06-10T00:00:00Z', v: 10 },
      { t: '2026-06-10T01:00:00Z', v: 5 },
    ]);
    expect(m.tokenSeries).toEqual([
      { t: '2026-06-10T00:00:00Z', v: 2_600_000 },
      { t: '2026-06-10T01:00:00Z', v: 400_000 },
    ]);
  });

  it('returns empty when ListMetrics finds no models (no GetMetricData call)', async () => {
    cwSend.mockResolvedValueOnce({ Metrics: [] });
    const { bedrockModelMetrics } = await import('./metrics');
    const r = await bedrockModelMetrics('1h');
    expect(r).toEqual({ models: [], totalCost: 0, series: [] });
    expect(cwSend).toHaveBeenCalledTimes(1); // only ListMetrics
  });
});

describe('rdsMetrics', () => {
  it('parses 8 AWS/RDS series per instance and averages CPU', async () => {
    cwSend.mockResolvedValueOnce({
      MetricDataResults: [
        { Id: 'cpu_i0', Values: [42] }, { Id: 'mem_i0', Values: [1_000_000] }, { Id: 'conn_i0', Values: [5] },
        { Id: 'rio_i0', Values: [10] }, { Id: 'wio_i0', Values: [3] }, { Id: 'storage_i0', Values: [5_000_000_000] },
        { Id: 'netin_i0', Values: [100] }, { Id: 'netout_i0', Values: [200] },
        { Id: 'cpu_i1', Values: [58] },
      ],
    });
    const { rdsMetrics } = await import('./metrics');
    const r = await rdsMetrics(['db-1', 'db-2']);
    expect(r.byInstance['db-1']).toMatchObject({
      cpu: 42, freeableMemory: 1_000_000, connections: 5, readIops: 10, writeIops: 3,
      freeStorage: 5_000_000_000, netIn: 100, netOut: 200,
    });
    // db-2 reported only CPU → the other 7 stay null (graceful partial).
    expect(r.byInstance['db-2'].cpu).toBe(58);
    expect(r.byInstance['db-2'].connections).toBeNull();
    expect(r.avgCpu).toBe(50); // (42 + 58) / 2
  });

  it('returns empty without a CloudWatch call for an empty instance list', async () => {
    const { rdsMetrics } = await import('./metrics');
    expect(await rdsMetrics([])).toEqual({ byInstance: {}, avgCpu: null });
    expect(cwSend).not.toHaveBeenCalled();
  });

  it('degrades to empty (never throws) when CloudWatch denies', async () => {
    cwSend.mockRejectedValueOnce(new Error('AccessDenied'));
    const { rdsMetrics } = await import('./metrics');
    expect(await rdsMetrics(['db-1'])).toEqual({ byInstance: {}, avgCpu: null });
  });

  it('batches >62 instances into multiple GetMetricData calls (no silent truncation)', async () => {
    cwSend.mockResolvedValue({ MetricDataResults: [{ Id: 'cpu_i0', Values: [10] }] });
    const { rdsMetrics } = await import('./metrics');
    const ids = Array.from({ length: 63 }, (_, i) => `db-${i}`);
    const r = await rdsMetrics(ids);
    expect(cwSend).toHaveBeenCalledTimes(2);       // 63 → chunk(62) + chunk(1)
    expect(Object.keys(r.byInstance)).toHaveLength(63); // every instance represented
  });
});

describe('rdsInstanceTrends (gap L141/L142/L155)', () => {
  const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60_000);
  type CwInput = { input: { StartTime: Date; MetricDataQueries: { Id: string; MetricStat: { Period: number } }[]; ScanBy?: string } };
  it('makes TWO bounded parallel calls — a ~65-min spark window and a 14-day long-trend window', async () => {
    cwSend.mockResolvedValue({ MetricDataResults: [] });
    const { rdsInstanceTrends } = await import('./metrics');
    await rdsInstanceTrends('db-1');
    expect(cwSend).toHaveBeenCalledTimes(2);
    const [a, b] = cwSend.mock.calls.map((c) => (c[0] as CwInput).input);
    const spark = a.MetricDataQueries[0].Id.startsWith('spark') ? a : b;
    const long = spark === a ? b : a;
    // Period sets RESOLUTION, not a window — the spark call must carry its own short StartTime
    // (one 14d window returned ~4,000 points per 5-min query only to be trimmed client-side).
    expect(Date.now() - spark.StartTime.getTime()).toBeLessThan(70 * 60_000);
    expect(spark.MetricDataQueries).toHaveLength(6);
    expect(spark.MetricDataQueries.every((q) => q.MetricStat.Period === 300)).toBe(true);
    expect(Date.now() - long.StartTime.getTime()).toBeGreaterThan(13 * 86_400_000);
    const periods = Object.fromEntries(long.MetricDataQueries.map((q) => [q.Id, q.MetricStat.Period]));
    expect(periods).toEqual({ mem24h: 3600, cpu14d: 86_400 });
    expect(spark.ScanBy).toBe('TimestampAscending');
    expect(long.ScanBy).toBe('TimestampAscending');
  });
  it('maps series into {t,v}[] and windows sparks to the last hour', async () => {
    cwSend.mockImplementation(async (cmd: { input: { MetricDataQueries: { Id: string }[] } }) => (
      cmd.input.MetricDataQueries[0].Id.startsWith('spark')
        ? { MetricDataResults: [{ Id: 'spark_0', Timestamps: [iso(120), iso(30), iso(5)], Values: [9, 41.234, 43.5] }] }
        : { MetricDataResults: [{ Id: 'mem24h', Timestamps: [iso(60)], Values: [2 * 1024 ** 3] }] }
    ));
    const { rdsInstanceTrends } = await import('./metrics');
    const t = await rdsInstanceTrends('db-1');
    // the 120-min-old point falls outside the 1h spark window
    expect(t.spark.cpu?.map((s) => s.v)).toEqual([41.23, 43.5]);
    expect(t.mem24h?.[0].v).toBe(2 * 1024 ** 3);
    expect(t.cpu14d).toBeNull(); // no datapoints → null, never []
  });
  it('degrades every series to null (never throws) when CloudWatch denies', async () => {
    cwSend.mockRejectedValueOnce(new Error('AccessDenied'));
    const { rdsInstanceTrends } = await import('./metrics');
    const t = await rdsInstanceTrends('db-1');
    expect(t.mem24h).toBeNull();
    expect(t.cpu14d).toBeNull();
    expect(Object.values(t.spark).every((v) => v === null)).toBe(true);
  });

});

describe('liveResourceTrends (gap L118)', () => {
  it('one bounded ~65-min call, Period 300, ascending; per-spec labels; empty series → null', async () => {
    cwSend.mockResolvedValueOnce({ MetricDataResults: [
      { Id: 'lt0', Timestamps: [new Date(Date.now() - 10 * 60_000)], Values: [42.123] },
    ] });
    const { liveResourceTrends } = await import('./metrics');
    const t = await liveResourceTrends('elasticache', 'cc-1');
    const input = (cwSend.mock.calls[0][0] as { input: { StartTime: Date; MetricDataQueries: { MetricStat: { Period: number; Metric: { MetricName: string } } }[]; ScanBy?: string } }).input;
    expect(Date.now() - input.StartTime.getTime()).toBeLessThan(70 * 60_000);
    expect(input.MetricDataQueries.every((q) => q.MetricStat.Period === 300)).toBe(true);
    expect(input.ScanBy).toBe('TimestampAscending');
    // the audit-required CacheHitRate is part of the elasticache spec
    expect(input.MetricDataQueries.map((q) => q.MetricStat.Metric.MetricName)).toContain('CacheHitRate');
    expect(t[0]).toMatchObject({ label: 'CPU', fmt: 'pct' });
    expect(t[0].samples?.[0].v).toBe(42.12);
    expect(t[1].samples).toBeNull(); // no datapoints → null, never []
  });
  it('unknown type → []; CloudWatch deny → [] (never throws)', async () => {
    const { liveResourceTrends } = await import('./metrics');
    expect(await liveResourceTrends('nope', 'x')).toEqual([]);
    cwSend.mockRejectedValueOnce(new Error('AccessDenied'));
    expect(await liveResourceTrends('elasticache', 'cc-1')).toEqual([]);
  });
  it('opensearch dims carry the OWNING account ClientId (member domains must not query with the host id)', async () => {
    process.env.AWS_ACCOUNT_ID = '123456789012';
    cwSend.mockResolvedValueOnce({ MetricDataResults: [] });
    const { liveResourceTrends } = await import('./metrics');
    await liveResourceTrends('opensearch', 'dom-1', '123456789012');
    const q = (cwSend.mock.calls[0][0] as { input: { MetricDataQueries: { MetricStat: { Metric: { Dimensions: { Name: string; Value: string }[] } } }[] } }).input.MetricDataQueries[0];
    const client = q.MetricStat.Metric.Dimensions.find((d) => d.Name === 'ClientId');
    expect(client?.Value).toBe('123456789012');
  });
});

describe('ebs_volume live spec (gap L233 — measured IOPS)', () => {
  it('latest grid: perSecond metrics query Period 300 and divide the newest COMPLETE 5-min bucket by 300 (fresh, never a partial underestimate)', async () => {
    cwSend.mockResolvedValueOnce({ MetricDataResults: [
      // newest-first (CloudWatch default): a 2-min-old PARTIAL bucket must be skipped —
      // dividing a still-filling Sum by the period systematically understates the headline.
      { Id: 'lm0',
        Timestamps: [new Date(Date.now() - 2 * 60_000), new Date(Date.now() - 7 * 60_000)],
        Values: [100, 600] }, // partial (skip) · complete 600/300 = 2 IOPS
    ] });
    const { liveResourceMetrics } = await import('./metrics');
    const rows = await liveResourceMetrics('ebs_volume', 'vol-0abc');
    expect(rows.find((r) => r.label === 'Read IOPS')?.value).toBe('2 IOPS');
    // the perSecond queries went out at Period 300 (an hourly bucket made the headline
    // 1–2h stale — round-3 gate); non-perSecond stay 3600
    const q = (cwSend.mock.calls[0][0] as { input: { MetricDataQueries: { MetricStat: { Period: number; Metric: { MetricName: string } } }[] } }).input.MetricDataQueries;
    expect(q.find((x) => x.MetricStat.Metric.MetricName === 'VolumeReadOps')?.MetricStat.Period).toBe(300);
    expect(q.find((x) => x.MetricStat.Metric.MetricName === 'BurstBalance')?.MetricStat.Period).toBe(3600);
  });
  it("latest grid: only-partial data renders '—' (never a partial-bucket underestimate)", async () => {
    cwSend.mockResolvedValueOnce({ MetricDataResults: [
      { Id: 'lm0', Timestamps: [new Date(Date.now() - 60_000)], Values: [600] },
    ] });
    const { liveResourceMetrics } = await import('./metrics');
    const rows = await liveResourceMetrics('ebs_volume', 'vol-0abc');
    expect(rows.find((r) => r.label === 'Read IOPS')?.value).toBe('—');
  });
  it('spark trends: complete period-300 buckets scale ÷300; the still-filling trailing bucket is dropped (no fake dip)', async () => {
    cwSend.mockResolvedValueOnce({ MetricDataResults: [
      { Id: 'lt0',
        Timestamps: [new Date(Date.now() - 10 * 60_000), new Date(Date.now() - 2 * 60_000)],
        Values: [1500, 100] }, // complete 1500/300=5 · partial (dropped)
    ] });
    const { liveResourceTrends } = await import('./metrics');
    const t = await liveResourceTrends('ebs_volume', 'vol-0abc');
    expect(t[0]).toMatchObject({ label: 'Read IOPS', fmt: 'iops' });
    expect(t[0].samples).toHaveLength(1);
    expect(t[0].samples?.[0].v).toBe(5);
  });
});

describe('live fmt (ratio/native units)', () => {
  it('CacheHitRate uses ratioPct — 0.92 renders 92%, never 0.9% (0–1 ratio source)', async () => {
    cwSend.mockResolvedValueOnce({ MetricDataResults: [
      { Id: 'lm6', Values: [0.92] }, // elasticache spec index 6 = CacheHitRate
    ] });
    const { liveResourceMetrics } = await import('./metrics');
    const rows = await liveResourceMetrics('elasticache', 'cc-1');
    const hit = rows.find((r) => r.label === 'Cache Hit Rate');
    expect(hit?.value).toBe('92%');
  });
  it('opensearch FreeStorageSpace (already megabytes) renders without the bytes÷1e6 division', async () => {
    cwSend.mockResolvedValueOnce({ MetricDataResults: [
      { Id: 'lm2', Values: [512.4] }, // opensearch spec index 2 = FreeStorageSpace (mbRaw)
    ] });
    const { liveResourceMetrics } = await import('./metrics');
    const rows = await liveResourceMetrics('opensearch', 'dom-1');
    const fs = rows.find((r) => r.label === 'Free Storage');
    expect(fs?.value).toBe('512.4 MB');
  });
});

describe('ec2NetworkTrends (gap L139)', () => {
  it('one bounded 24h hourly call — both metrics, ascending, account+region forwarded', async () => {
    cwSend.mockResolvedValueOnce({ MetricDataResults: [
      { Id: 'nt0', Timestamps: [new Date('2026-09-01T00:00:00Z'), new Date('2026-09-01T01:00:00Z')], Values: [1e6, 2e6] },
      { Id: 'nt1', Timestamps: [new Date('2026-09-01T00:00:00Z')], Values: [5e5] },
    ] });
    const { ec2NetworkTrends } = await import('./metrics');
    const t = await ec2NetworkTrends('i-abc12345', '123456789012', 'us-west-2');
    const input = (cwSend.mock.calls[0][0] as { input: { StartTime: Date; EndTime: Date; ScanBy?: string; MetricDataQueries: { MetricStat: { Metric: { MetricName?: string }; Period?: number } }[] } }).input;
    const windowMs = input.EndTime.getTime() - input.StartTime.getTime();
    expect(windowMs).toBeLessThanOrEqual(25 * 3600_000);
    expect(windowMs).toBeGreaterThanOrEqual(23 * 3600_000);
    expect(input.ScanBy).toBe('TimestampAscending');
    expect(input.MetricDataQueries.map((q) => q.MetricStat.Metric.MetricName)).toEqual(['NetworkIn', 'NetworkOut']);
    expect(input.MetricDataQueries.every((q) => q.MetricStat.Period === 3600)).toBe(true);
    expect(t.netIn).toHaveLength(2);
    expect(t.netIn![1]).toEqual({ t: '2026-09-01T01:00:00.000Z', v: 2e6 });
    expect(t.netOut).toHaveLength(1);
  });

  it('empty series → null; CloudWatch error → both null (never throws)', async () => {
    cwSend.mockResolvedValueOnce({ MetricDataResults: [{ Id: 'nt0', Timestamps: [], Values: [] }] });
    const { ec2NetworkTrends } = await import('./metrics');
    expect(await ec2NetworkTrends('i-abc12345')).toEqual({ netIn: null, netOut: null });
    cwSend.mockRejectedValueOnce(new Error('AccessDenied'));
    expect(await ec2NetworkTrends('i-abc12345')).toEqual({ netIn: null, netOut: null });
  });
});
