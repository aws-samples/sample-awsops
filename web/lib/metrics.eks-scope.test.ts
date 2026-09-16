import { beforeEach, describe, expect, it, vi } from 'vitest';

const { hostSend, memberSend, assume } = vi.hoisted(() => ({
  hostSend: vi.fn(), memberSend: vi.fn(), assume: vi.fn(),
}));
vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class { send = hostSend; },
  GetMetricDataCommand: class { constructor(public input: unknown) {} },
  ListMetricsCommand: class { constructor(public input: unknown) {} },
}));
vi.mock('./aws-assume', () => ({ assumedClient: assume }));

const ACCOUNT = '222222222222';
const REGION = 'us-west-2';

beforeEach(() => {
  vi.clearAllMocks();
  assume.mockReset().mockResolvedValue({ send: memberSend });
  memberSend.mockReset().mockResolvedValue({});
  hostSend.mockReset().mockResolvedValue({});
});

describe('EKS CloudWatch account isolation', () => {
  it.each(['eksControlPlane', 'eksClusterCI'] as const)('%s uses target credentials/region and the raw cluster dimension', async key => {
    const metrics = await import('./metrics');
    await metrics[key]('shared', REGION, 3600, ACCOUNT);
    expect(assume).toHaveBeenCalledWith(ACCOUNT, expect.any(Function), { region: REGION });
    expect(hostSend).not.toHaveBeenCalled();
    expect(memberSend).toHaveBeenCalledOnce();
    const queries = memberSend.mock.calls[0][0].input.MetricDataQueries;
    expect(queries.length).toBeGreaterThan(0);
    for (const query of queries) {
      expect(query.MetricStat.Metric.Dimensions).toEqual([{ Name: 'ClusterName', Value: 'shared' }]);
    }
  });

  it('scopes both node metric discovery and datapoints to the member', async () => {
    const dims = [
      { Name: 'ClusterName', Value: 'shared' },
      { Name: 'NodeName', Value: 'same.internal' },
      { Name: 'InstanceId', Value: 'i-member' },
    ];
    memberSend.mockResolvedValueOnce({ Metrics: [{ Dimensions: dims }] })
      .mockResolvedValueOnce({ MetricDataResults: [{ Id: 'cpu_i0', Values: [23] }] });
    const { eksNodesCI } = await import('./metrics');
    expect(await eksNodesCI('shared', REGION, 3600, 100, ACCOUNT)).toMatchObject({ 'same.internal': { cpu: 23 } });
    expect(assume).toHaveBeenCalledTimes(2);
    for (const call of assume.mock.calls) expect(call).toEqual([ACCOUNT, expect.any(Function), { region: REGION }]);
    expect(hostSend).not.toHaveBeenCalled();
    expect(memberSend.mock.calls[0][0].input.Dimensions).toEqual([{ Name: 'ClusterName', Value: 'shared' }]);
    expect(memberSend.mock.calls[1][0].input.MetricDataQueries[0].MetricStat.Metric.Dimensions).toEqual(dims);
  });

  it('scopes node ENI traffic to the target account', async () => {
    const { ec2DiagFleetLive } = await import('./metrics');
    await ec2DiagFleetLive(['i-member'], REGION, 3600, true, ACCOUNT);
    expect(assume).toHaveBeenCalledWith(ACCOUNT, expect.any(Function), { region: REGION });
    expect(hostSend).not.toHaveBeenCalled();
    expect(memberSend).toHaveBeenCalledOnce();
  });

  it('returns missing data after AssumeRole failure without host fallback', async () => {
    assume.mockRejectedValue(new Error('target role denied'));
    const { eksControlPlane, eksClusterCI, eksNodesCI, ec2DiagFleetLive } = await import('./metrics');
    const cp = await eksControlPlane('shared', REGION, 3600, ACCOUNT);
    const ci = await eksClusterCI('shared', REGION, 3600, ACCOUNT);
    const nodes = await eksNodesCI('shared', REGION, 3600, 100, ACCOUNT);
    const ec2 = await ec2DiagFleetLive(['i-member'], REGION, 3600, true, ACCOUNT);
    expect(Object.values(cp).every(value => value === null)).toBe(true);
    expect(Object.values(ci).every(value => value === null)).toBe(true);
    expect(nodes).toEqual({});
    expect(Object.values(ec2['i-member']).every(value => value === null)).toBe(true);
    expect(hostSend).not.toHaveBeenCalled();
    expect(memberSend).not.toHaveBeenCalled();
  });
});
