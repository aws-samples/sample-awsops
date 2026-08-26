import { describe, it, expect, vi, beforeEach } from 'vitest';

const eksSend = vi.fn();
const ceSend = vi.fn();
vi.mock('@aws-sdk/client-eks', () => ({
  EKSClient: class { send = eksSend; },
  ListClustersCommand: class { constructor(public input: unknown) {} },
  DescribeClusterCommand: class { constructor(public input: { name: string }) {} },
}));
vi.mock('@aws-sdk/client-cost-explorer', () => ({
  CostExplorerClient: class { send = ceSend; },
  GetCostAndUsageCommand: class { constructor(public input: unknown) {} },
  GetCostForecastCommand: class { constructor(public input: unknown) {} },
}));

beforeEach(() => { eksSend.mockReset(); ceSend.mockReset(); });

describe('listClusters', () => {
  it('lists names then describes each', async () => {
    eksSend
      .mockResolvedValueOnce({ clusters: ['fsi-demo-cluster'] })
      .mockResolvedValueOnce({ cluster: { status: 'ACTIVE', version: '1.30', endpoint: 'https://x', createdAt: new Date('2026-01-01T00:00:00Z') } });
    const { listClusters } = await import('./aws');
    const out = await listClusters();
    expect(out).toEqual([{ name: 'fsi-demo-cluster', status: 'ACTIVE', version: '1.30', endpoint: 'https://x', createdAt: '2026-01-01T00:00:00.000Z', region: 'ap-northeast-2', vpcId: '', platformVersion: '' }]);
  });
  it('returns [] when no clusters', async () => {
    eksSend.mockResolvedValueOnce({ clusters: [] });
    const { listClusters } = await import('./aws');
    expect(await listClusters()).toEqual([]);
  });
});

describe('getMtdCost', () => {
  it('aggregates + sorts by-service desc', async () => {
    ceSend.mockResolvedValue({ ResultsByTime: [{ Groups: [
      { Keys: ['Amazon RDS'], Metrics: { UnblendedCost: { Amount: '310.5', Unit: 'USD' } } },
      { Keys: ['Amazon EKS'], Metrics: { UnblendedCost: { Amount: '180.0', Unit: 'USD' } } },
      { Keys: ['Zero'], Metrics: { UnblendedCost: { Amount: '0', Unit: 'USD' } } },
    ] }] });
    const { getMtdCost } = await import('./aws');
    const c = await getMtdCost();
    expect(c.currency).toBe('USD');
    expect(c.byService[0]).toEqual({ service: 'Amazon RDS', amount: 310.5 });
    expect(c.byService.find((s) => s.service === 'Zero')).toBeUndefined();
    expect(c.total).toBeCloseTo(490.5);
  });
});

describe('getEcsClusterCosts', () => {
  it('keys by region|clusterName so same-named clusters in different regions don\'t double-count', async () => {
    ceSend.mockResolvedValue({ ResultsByTime: [{ Groups: [
      { Keys: ['ap-northeast-2', 'aws:ecs:clusterName$awsops-v2'], Metrics: { UnblendedCost: { Amount: '12.345', Unit: 'USD' } } },
      { Keys: ['us-east-1', 'aws:ecs:clusterName$awsops-v2'], Metrics: { UnblendedCost: { Amount: '7.0', Unit: 'USD' } } },
      { Keys: ['ap-northeast-2', 'aws:ecs:clusterName$'], Metrics: { UnblendedCost: { Amount: '3.0', Unit: 'USD' } } },
    ] }] });
    const { getEcsClusterCosts } = await import('./aws');
    const out = await getEcsClusterCosts();
    expect(out).toEqual({ 'ap-northeast-2|awsops-v2': 12.35, 'us-east-1|awsops-v2': 7 });
    const input = ceSend.mock.calls[0][0].input;
    expect(input.GroupBy).toEqual([
      { Type: 'DIMENSION', Key: 'REGION' },
      { Type: 'TAG', Key: 'aws:ecs:clusterName' },
    ]);
  });
});

describe('getMonthlyCost', () => {
  it('sums each month\'s service groups → [{month, total}] ascending', async () => {
    ceSend.mockResolvedValue({ ResultsByTime: [
      { TimePeriod: { Start: '2026-05-01' }, Groups: [
        { Keys: ['Amazon RDS'], Metrics: { UnblendedCost: { Amount: '100', Unit: 'USD' } } },
        { Keys: ['Amazon EKS'], Metrics: { UnblendedCost: { Amount: '50', Unit: 'USD' } } },
      ] },
      { TimePeriod: { Start: '2026-06-01' }, Groups: [
        { Keys: ['Amazon RDS'], Metrics: { UnblendedCost: { Amount: '120.25', Unit: 'USD' } } },
      ] },
    ] });
    const { getMonthlyCost } = await import('./aws');
    const out = await getMonthlyCost(2);
    expect(out).toEqual([
      { month: '2026-05', total: 150 },
      { month: '2026-06', total: 120.25 },
    ]);
  });
});

describe('getCostForecast', () => {
  it('returns the forecasted remaining amount', async () => {
    ceSend.mockResolvedValue({ Total: { Amount: '250.5', Unit: 'USD' } });
    const { getCostForecast } = await import('./aws');
    const v = await getCostForecast();
    // null only on the last day of the month (no future window); otherwise the mapped number
    if (v !== null) expect(v).toBeCloseTo(250.5);
  });
});

describe('rollupUsageTypes', () => {
  it('sorts descending', async () => {
    const { rollupUsageTypes } = await import('./aws');
    const out = rollupUsageTypes([
      { usageType: 'a', amount: 1 },
      { usageType: 'b', amount: 3 },
      { usageType: 'c', amount: 2 },
    ], 8);
    expect(out.map((x) => x.usageType)).toEqual(['b', 'c', 'a']);
  });
  it('keeps top-n and rolls the rest into 기타', async () => {
    const { rollupUsageTypes } = await import('./aws');
    const rows = [
      { usageType: 'a', amount: 10 },
      { usageType: 'b', amount: 8 },
      { usageType: 'c', amount: 5 },
      { usageType: 'd', amount: 3 },
    ];
    const out = rollupUsageTypes(rows, 2);
    expect(out).toEqual([
      { usageType: 'a', amount: 10 },
      { usageType: 'b', amount: 8 },
      { usageType: '기타', amount: 8 }, // 5 + 3
    ]);
  });
  it('passes through unchanged when length <= n', async () => {
    const { rollupUsageTypes } = await import('./aws');
    const rows = [{ usageType: 'a', amount: 2 }, { usageType: 'b', amount: 1 }];
    expect(rollupUsageTypes(rows, 8)).toEqual([
      { usageType: 'a', amount: 2 },
      { usageType: 'b', amount: 1 },
    ]);
  });
  it('omits 기타 when the rest sums to zero', async () => {
    const { rollupUsageTypes } = await import('./aws');
    const rows = [
      { usageType: 'a', amount: 5 },
      { usageType: 'b', amount: 0 },
      { usageType: 'c', amount: 0 },
    ];
    const out = rollupUsageTypes(rows, 1);
    expect(out).toEqual([{ usageType: 'a', amount: 5 }]);
  });
});

describe('getServiceCostDetail', () => {
  it('returns trend + rolled-up byUsageType, each filtered by SERVICE', async () => {
    ceSend
      // ① DAILY trend
      .mockResolvedValueOnce({
        ResultsByTime: [
          { TimePeriod: { Start: '2026-06-01' }, Total: { UnblendedCost: { Amount: '4', Unit: 'USD' } } },
          { TimePeriod: { Start: '2026-06-02' }, Total: { UnblendedCost: { Amount: '6', Unit: 'USD' } } },
        ],
      })
      // ② MONTHLY usage-type groups across months
      .mockResolvedValueOnce({
        ResultsByTime: [
          { Groups: [
            { Keys: ['DataTransfer'], Metrics: { UnblendedCost: { Amount: '3', Unit: 'USD' } } },
            { Keys: ['BoxUsage'], Metrics: { UnblendedCost: { Amount: '7', Unit: 'USD' } } },
          ] },
          { Groups: [
            { Keys: ['BoxUsage'], Metrics: { UnblendedCost: { Amount: '5', Unit: 'USD' } } },
          ] },
        ],
      });
    ceSend
      // ③ MONTHLY totals (6 months)
      .mockResolvedValueOnce({
        ResultsByTime: [
          { TimePeriod: { Start: '2026-06-01' }, Total: { UnblendedCost: { Amount: '10', Unit: 'USD' } } },
          { TimePeriod: { Start: '2026-07-01' }, Total: { UnblendedCost: { Amount: '12', Unit: 'USD' } } },
        ],
      });
    const { getServiceCostDetail } = await import('./aws');
    const d = await getServiceCostDetail('Amazon EC2');
    expect(d.service).toBe('Amazon EC2');
    expect(d.monthly).toEqual([
      { month: '2026-06', amount: 10 },
      { month: '2026-07', amount: 12 },
    ]);
    expect(d.trend).toEqual([
      { date: '2026-06-01', amount: 4 },
      { date: '2026-06-02', amount: 6 },
    ]);
    // BoxUsage = 7 + 5 = 12, DataTransfer = 3, sorted desc
    expect(d.byUsageType).toEqual([
      { usageType: 'BoxUsage', amount: 12 },
      { usageType: 'DataTransfer', amount: 3 },
    ]);
    // P4 gate (codex): assert the CE command INPUTS — both legs SERVICE-filtered,
    // correct granularity, and the usage-type leg grouped by USAGE_TYPE.
    const inputs = ceSend.mock.calls.map((c) => c[0].input);
    expect(inputs[0].Granularity).toBe('DAILY');
    expect(inputs[0].Filter).toEqual({ Dimensions: { Key: 'SERVICE', Values: ['Amazon EC2'] } });
    expect(inputs[0].GroupBy).toBeUndefined();
    expect(inputs[1].Granularity).toBe('MONTHLY');
    expect(inputs[1].Filter).toEqual({ Dimensions: { Key: 'SERVICE', Values: ['Amazon EC2'] } });
    expect(inputs[1].GroupBy).toEqual([{ Type: 'DIMENSION', Key: 'USAGE_TYPE' }]);
  });
  it('null on the leg that fails, [] semantics preserved per-leg', async () => {
    ceSend
      .mockRejectedValueOnce(new Error('no ce perms')) // trend fails
      .mockResolvedValueOnce({ ResultsByTime: [] })     // usage-type genuinely empty
      .mockRejectedValueOnce(new Error('no ce perms')); // monthly fails too
    const { getServiceCostDetail } = await import('./aws');
    const d = await getServiceCostDetail('Amazon S3');
    expect(d.trend).toBeNull();
    expect(d.monthly).toBeNull();
    expect(d.byUsageType).toEqual([]);
  });
});
