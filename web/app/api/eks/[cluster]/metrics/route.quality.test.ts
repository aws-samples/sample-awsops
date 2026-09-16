import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetricDataResult } from '@aws-sdk/client-cloudwatch';

const { cwSend, hostSend, stsSend, configs } = vi.hoisted(() => ({
  cwSend: vi.fn(), hostSend: vi.fn(), stsSend: vi.fn(), configs: [] as Record<string, unknown>[],
}));
vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class {
    constructor(private config: Record<string, any>) { configs.push(config); }
    send(command: unknown) {
      return this.config.credentials?.accessKeyId === 'member-test-key' ? cwSend(command) : hostSend(command);
    }
  },
  GetMetricDataCommand: class { constructor(public input: any) {} },
  ListMetricsCommand: class { constructor(public input: any) {} },
}));
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class { send = stsSend; },
  AssumeRoleCommand: class { constructor(public input: unknown) {} },
}));
vi.mock('@/lib/accounts', () => ({
  getAccount: async () => ({ accountId: '222222222222', roleName: 'AWSopsReadOnlyRole', isHost: false, enabled: true }),
}));
vi.mock('@/lib/auth', () => ({ verifyUser: async () => ({ sub: 'u' }) }));
vi.mock('@/lib/eks-registry', () => ({ isAllowed: async () => true }));
vi.mock('@/lib/eks-context', () => ({
  resolveEksCluster: async () => ({
    id: 'arn:aws:eks:us-west-2:222222222222:cluster/shared',
    name: 'shared', accountId: '222222222222', region: 'us-west-2',
  }),
  EksScopeError: class extends Error { constructor(message: string, public status: number) { super(message); } },
}));

type Command = { constructor: { name: string }; input: any };
const complete = (cmd: Command, value?: number): { MetricDataResults: MetricDataResult[] } => ({
  MetricDataResults: cmd.input.MetricDataQueries.map((q: { Id: string }) => ({
    Id: q.Id, StatusCode: 'Complete', Values: value === undefined ? [] : [value],
  })),
});
const nodeMetric = (i = 0) => ({ Dimensions: [
  { Name: 'ClusterName', Value: 'shared' },
  { Name: 'NodeName', Value: `node-${i}` },
  { Name: 'InstanceId', Value: `i-member-${i}` },
] });
const empty = (cmd: Command) => cmd.constructor.name === 'ListMetricsCommand' ? { Metrics: [] } : complete(cmd);
const deny = () => Object.assign(new Error('Denied arn:aws:iam::222222222222:role/private-role SECRET_SESSION_TOKEN'), {
  name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 },
});
async function read() {
  const { GET } = await import('./route');
  const response = await GET(new Request('http://local/?account=222222222222&region=us-west-2'), { params: { cluster: 'shared' } });
  expect(response.status).toBe(200);
  return response.json();
}
const forbiddenLeak = (value: unknown) => {
  expect(JSON.stringify(value)).not.toMatch(/private-role|SECRET_SESSION_TOKEN|member-test-key|member-secret|member-token/);
};

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('HOST_ACCOUNT_ID', '111111111111');
  vi.stubEnv('AWS_REGION', 'ap-northeast-2');
  configs.length = 0;
  hostSend.mockReset().mockRejectedValue(new Error('unexpected host CloudWatch request'));
  cwSend.mockReset().mockImplementation(empty);
  stsSend.mockReset().mockResolvedValue({ Credentials: {
    AccessKeyId: 'member-test-key', SecretAccessKey: 'member-secret', SessionToken: 'member-token',
  } });
});
afterEach(() => vi.unstubAllEnvs());

describe('EKS metrics quality through the service boundary', () => {
  it('distinguishes member CloudWatch denial from successful no-data and echoes scope', async () => {
    cwSend.mockRejectedValue(deny());
    const denied = await read();
    expect(denied).toMatchObject({
      accountId: '222222222222', region: 'us-west-2',
      sources: { controlPlane: { status: 'denied' }, cluster: { status: 'denied' }, nodes: { status: 'denied' } },
    });
    expect(denied.sources.cluster.reason).toMatch(/access|permission/i);
    forbiddenLeak(denied);
    cwSend.mockImplementation(empty);
    const clean = await read();
    expect(clean.sources).toEqual({
      controlPlane: { status: 'no-data' }, cluster: { status: 'no-data' }, nodes: { status: 'no-data' },
    });
    expect(hostSend).not.toHaveBeenCalled();
    expect(configs.every(c => c.region === 'us-west-2')).toBe(true);
  });

  it('reports AssumeRole denial without constructing or calling host CloudWatch', async () => {
    stsSend.mockRejectedValue(deny());
    const body = await read();
    expect(body.sources).toMatchObject({
      controlPlane: { status: 'denied' }, cluster: { status: 'denied' }, nodes: { status: 'denied' },
    });
    expect(cwSend).not.toHaveBeenCalled(); expect(hostSend).not.toHaveBeenCalled();
    forbiddenLeak(body);
  });

  it('keeps successful sources when cluster metrics fail and uses member credentials for node discovery and reads', async () => {
    cwSend.mockImplementation(async (cmd: Command) => {
      if (cmd.constructor.name === 'ListMetricsCommand') return { Metrics: [nodeMetric()] };
      const metric = cmd.input.MetricDataQueries[0].MetricStat.Metric;
      if (metric.Namespace === 'AWS/EKS') return complete(cmd, 0.42);
      if (metric.Dimensions.length === 1) throw new Error('transport failed SECRET_SESSION_TOKEN');
      return complete(cmd, 17);
    });
    const body = await read();
    expect(body.sources).toMatchObject({
      controlPlane: { status: 'ok' }, cluster: { status: 'unavailable' }, nodes: { status: 'ok' },
    });
    expect(body.controlPlane.p99Get).toBe(0.42);
    expect(body.nodes['node-0'].cpu).toBe(17);
    expect(Object.values(body.cluster).every(v => v === null)).toBe(true);
    expect(cwSend.mock.calls.some(([cmd]) => cmd.constructor.name === 'ListMetricsCommand')).toBe(true);
    expect(hostSend).not.toHaveBeenCalled();
    forbiddenLeak(body);
  });

  it.each([
    ['PartialData', 'partial', 4],
    ['Forbidden', 'denied', null],
    ['InternalError', 'unavailable', null],
  ])('preserves query status %s even when the HTTP request succeeds', async (status, expected, value) => {
    cwSend.mockImplementation((cmd: Command) => cmd.constructor.name === 'ListMetricsCommand'
      ? { Metrics: [] }
      : { MetricDataResults: complete(cmd, 4).MetricDataResults.map((r: object) => ({
        ...r, StatusCode: status, Messages: [{ Code: status, Value: 'SECRET_SESSION_TOKEN private-role' }],
      })) });
    const body = await read();
    expect(body.sources.cluster.status).toBe(expected);
    expect(body.cluster.nodeCount).toBe(value);
    forbiddenLeak(body);
  });

  it('handles per-query denial messages and retains other successful metrics as partial', async () => {
    cwSend.mockImplementation((cmd: Command) => {
      if (cmd.constructor.name === 'ListMetricsCommand') return { Metrics: [] };
      const output = complete(cmd, 8);
      output.MetricDataResults[0].Messages = [{ Code: 'Forbidden', Value: 'arn:aws:iam::222222222222:role/private-role' }];
      return output;
    });
    const body = await read();
    expect(body.sources.cluster.status).toBe('partial');
    expect(body.cluster.nodeCount).toBeNull();
    expect(body.cluster.failedNodes).toBe(8);
    forbiddenLeak(body);
  });

  it('handles global error messages even with an empty result array', async () => {
    cwSend.mockImplementation((cmd: Command) => cmd.constructor.name === 'ListMetricsCommand'
      ? { Metrics: [] }
      : { MetricDataResults: [], Messages: [{ Code: 'Forbidden', Value: 'private-role SECRET_SESSION_TOKEN' }] });
    const body = await read();
    expect(body.sources.controlPlane.status).toBe('denied');
    expect(body.sources.cluster.status).toBe('denied');
    forbiddenLeak(body);
  });

  it('treats successful empty arrays as no-data but missing query result envelopes as unavailable', async () => {
    cwSend.mockImplementation((cmd: Command) => cmd.constructor.name === 'ListMetricsCommand' ? { Metrics: [] } : { MetricDataResults: [] });
    expect((await read()).sources.cluster.status).toBe('no-data');
    cwSend.mockResolvedValue({});
    const body = await read();
    expect(body.sources).toMatchObject({
      controlPlane: { status: 'unavailable' }, cluster: { status: 'unavailable' }, nodes: { status: 'unavailable' },
    });
  });

  it.each(['list-next-token', 'node-cap', 'data-next-token'])('reports %s as partial rather than complete/absent', async kind => {
    cwSend.mockImplementation((cmd: Command) => {
      if (cmd.constructor.name === 'ListMetricsCommand') return {
        Metrics: Array.from({ length: kind === 'node-cap' ? 101 : 1 }, (_, i) => nodeMetric(i)),
        ...(kind === 'list-next-token' ? { NextToken: 'more-nodes' } : {}),
      };
      return { ...complete(cmd, 1), ...(kind === 'data-next-token' ? { NextToken: 'more-data' } : {}) };
    });
    const body = await read();
    expect(body.sources.nodes.status).toBe('partial');
    expect(body.sources.nodes.reason).toMatch(/incomplete|limit|partial/i);
    expect(Object.keys(body.nodes)).toHaveLength(kind === 'node-cap' ? 100 : 1);
    expect(cwSend.mock.calls.every(([cmd]) => !cmd.input.NextToken)).toBe(true);
    expect(hostSend).not.toHaveBeenCalled();
  });

  it('does not reuse failed-null legacy results or cache away quality on subsequent reads', async () => {
    cwSend.mockRejectedValue(deny());
    const { eksClusterCI } = await import('@/lib/metrics');
    await eksClusterCI('shared', 'us-west-2', 3600, '222222222222');
    expect((await read()).sources.cluster.status).toBe('denied');
    const deniedCallCount = cwSend.mock.calls.length;
    cwSend.mockImplementation((cmd: Command) => cmd.constructor.name === 'ListMetricsCommand' ? { Metrics: [] } : complete(cmd, 5));
    const fresh = await read();
    expect(fresh.sources.cluster.status).toBe('ok');
    expect(fresh.cluster.nodeCount).toBe(5);
    expect(cwSend.mock.calls.length).toBeGreaterThan(deniedCallCount);
    expect(hostSend).not.toHaveBeenCalled();
  });

  it('retains node values from successful chunks when a later chunk fails', async () => {
    cwSend.mockImplementation((cmd: Command) => {
      if (cmd.constructor.name === 'ListMetricsCommand') return { Metrics: Array.from({ length: 70 }, (_, i) => nodeMetric(i)) };
      const first = cmd.input.MetricDataQueries[0].MetricStat.Metric;
      if (first.Dimensions.find((d: { Name: string; Value: string }) => d.Name === 'NodeName')?.Value === 'node-60') throw deny();
      return complete(cmd, 19);
    });
    const body = await read();
    expect(body.sources.nodes.status).toBe('partial');
    expect(body.nodes['node-0'].cpu).toBe(19);
    expect(body.nodes['node-60'].cpu).toBeNull();
    expect(body.sources.cluster.status).toBe('ok');
    expect(hostSend).not.toHaveBeenCalled();
  });

  it('does not turn missing statuses or missing query results into successful no-data', async () => {
    cwSend.mockImplementation((cmd: Command) => cmd.constructor.name === 'ListMetricsCommand'
      ? { Metrics: [] }
      : { MetricDataResults: [{ Id: cmd.input.MetricDataQueries[0].Id, Values: [] }] });
    const body = await read();
    expect(body.sources.controlPlane.status).toBe('partial');
    expect(body.sources.cluster.status).toBe('partial');
  });

  it('preserves metric values when node discovery is denied without suggesting node absence', async () => {
    cwSend.mockImplementation((cmd: Command) => {
      if (cmd.constructor.name === 'ListMetricsCommand') throw deny();
      return complete(cmd, 2);
    });
    const body = await read();
    expect(body.sources.nodes.status).toBe('denied');
    expect(body.sources.cluster.status).toBe('ok');
    expect(body.cluster.nodeCount).toBe(2);
    expect(body.nodes).toEqual({});
    forbiddenLeak(body);
  });

  it.each([true, false])('withholds conflicting instance tuples sharing a node name (other node: %s)', async includeUnique => {
    const conflict = nodeMetric();
    conflict.Dimensions = conflict.Dimensions.map(d => d.Name === 'InstanceId' ? { ...d, Value: 'i-replaced' } : d);
    cwSend.mockImplementation((cmd: Command) => cmd.constructor.name === 'ListMetricsCommand'
      ? { Metrics: [nodeMetric(), conflict, ...(includeUnique ? [nodeMetric(1)] : [])] }
      : complete(cmd, 17));
    const body = await read();
    expect(body.sources.nodes.status).toBe('partial');
    expect(body.nodes).not.toHaveProperty('node-0');
    if (includeUnique) expect(body.nodes['node-1'].cpu).toBe(17);
    else expect(body.nodes).toEqual({});
    const queriedNodes = cwSend.mock.calls.flatMap(([cmd]) => (cmd.input.MetricDataQueries ?? [])
      .flatMap((q: any) => q.MetricStat.Metric.Dimensions.filter((d: any) => d.Name === 'NodeName').map((d: any) => d.Value)));
    expect(queriedNodes).not.toContain('node-0');
  });

  it('deduplicates identical node tuples regardless of dimension ordering without inventing ambiguity', async () => {
    const duplicate = { Dimensions: [...nodeMetric().Dimensions].reverse() };
    cwSend.mockImplementation((cmd: Command) => cmd.constructor.name === 'ListMetricsCommand'
      ? { Metrics: [nodeMetric(), duplicate] } : complete(cmd, 17));
    const body = await read();
    expect(body.sources.nodes.status).toBe('ok');
    expect(body.nodes['node-0'].cpu).toBe(17);
  });
});
