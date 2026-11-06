import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EC2Client } from '@aws-sdk/client-ec2';
import { EKSClient } from '@aws-sdk/client-eks';

// Real SDK client classes (paginators require instanceof) with send() intercepted:
// no AWS call leaves this test.
const ec2Send = vi.fn();
const eksSend = vi.fn();
const assumed = vi.fn();
vi.mock('./aws-assume', () => ({
  assumedClient: async (accountId: string, Ctor: new (cfg: Record<string, unknown>) => unknown, cfg: Record<string, unknown>) => {
    assumed(accountId, Ctor, cfg);
    const client = new Ctor({ ...cfg, credentials: { accessKeyId: 'k', secretAccessKey: 's' } }) as { send: unknown };
    client.send = Ctor === EC2Client ? ec2Send : eksSend;
    return client;
  },
}));

const CONTEXT = { id: 'arn:aws:eks:us-east-1:222222222222:cluster/shared', name: 'shared', accountId: '222222222222', region: 'us-east-1' };
const launched = new Date(Date.now() - 3 * 86_400_000);

beforeEach(() => {
  ec2Send.mockReset(); eksSend.mockReset(); assumed.mockReset();
  ec2Send.mockImplementation(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    if (command.constructor.name === 'DescribeInstanceTypesCommand') {
      return { InstanceTypes: [{ InstanceType: 'm5.large', VCpuInfo: { DefaultVCpus: 2 }, MemoryInfo: { SizeInMiB: 8192 } }] };
    }
    const filters = command.input.Filters as { Name: string; Values: string[] }[];
    const managed = filters.some((f) => f.Name === 'tag:eks:cluster-name');
    const instance = (id: string, tags: { Key: string; Value: string }[]) => ({
      InstanceId: id, InstanceType: 'm5.large', PrivateDnsName: `ip-${id}.ec2.internal`,
      Placement: { AvailabilityZone: 'us-east-1a' }, LaunchTime: launched, State: { Name: 'running' }, Tags: tags,
    });
    return { Reservations: [{ Instances: managed
      ? [instance('i-1', [{ Key: 'eks:nodegroup-name', Value: 'ng-a' }])]
      // the managed instance also carries the cluster tag-key: dedupe by instance id
      : [instance('i-1', [{ Key: 'eks:nodegroup-name', Value: 'ng-a' }]), instance('i-2', [{ Key: 'karpenter.sh/nodepool', Value: 'default' }])] }] };
  });
  eksSend.mockImplementation(async (command: { constructor: { name: string } }) => (
    command.constructor.name === 'ListNodegroupsCommand' ? { nodegroups: ['ng-a'] } : { nodegroup: { version: '1.31' } }
  ));
});

describe('listAwsApiNodes', () => {
  it('builds an EC2/node-group view with the member role, deduped across both cluster tags', async () => {
    const { listAwsApiNodes } = await import('./eks-aws-nodes');
    const rows = await listAwsApiNodes(CONTEXT);
    expect(assumed.mock.calls.every(([account, , cfg]) => account === '222222222222' && cfg.region === 'us-east-1')).toBe(true);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      name: 'ip-i-1.ec2.internal', status: 'EC2 running', roles: 'nodegroup:ng-a', version: '1.31',
      instanceType: 'm5.large', zone: 'us-east-1a', age: '3d', cpuCapacity: 2, cpuAllocatable: 2,
      memCapacity: 8192, memAllocatable: 8192, source: 'aws-api', instanceId: 'i-1',
    });
    expect(rows[1]).toMatchObject({ roles: 'karpenter:default', version: '', source: 'aws-api' });
    expect(rows[0]).not.toHaveProperty('conditions');
    const filters = ec2Send.mock.calls
      .filter(([c]) => c.constructor.name === 'DescribeInstancesCommand')
      .map(([c]) => c.input.Filters);
    expect(filters).toEqual([
      [{ Name: 'tag:eks:cluster-name', Values: ['shared'] }, expect.objectContaining({ Name: 'instance-state-name' })],
      [{ Name: 'tag-key', Values: ['kubernetes.io/cluster/shared'] }, expect.objectContaining({ Name: 'instance-state-name' })],
    ]);
  });

  it('only issues read-only Describe/List operations', async () => {
    const { listAwsApiNodes } = await import('./eks-aws-nodes');
    await listAwsApiNodes(CONTEXT);
    const names = [...ec2Send.mock.calls, ...eksSend.mock.calls].map(([c]) => c.constructor.name);
    expect(names.every((n) => /^(Describe|List)/.test(n))).toBe(true);
  });

  it('keeps instance rows when node-group or instance-type detail reads fail', async () => {
    eksSend.mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    const base = ec2Send.getMockImplementation()!;
    ec2Send.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'DescribeInstanceTypesCommand') throw new Error('denied');
      return base(command);
    });
    const { listAwsApiNodes } = await import('./eks-aws-nodes');
    const rows = await listAwsApiNodes(CONTEXT);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ version: '', cpuCapacity: 0, memCapacity: 0 });
  });

  it('propagates an instance read failure (caller degrades only the node fields)', async () => {
    ec2Send.mockRejectedValue(Object.assign(new Error('denied'), { name: 'UnauthorizedOperation' }));
    const { listAwsApiNodes } = await import('./eks-aws-nodes');
    await expect(listAwsApiNodes(CONTEXT)).rejects.toMatchObject({ name: 'UnauthorizedOperation' });
  });
});

void EKSClient;
