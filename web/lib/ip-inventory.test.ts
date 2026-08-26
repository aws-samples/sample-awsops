import { describe, it, expect, vi, beforeEach } from 'vitest';

const ec2Send = vi.fn();
vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: class { send = ec2Send; },
  DescribeNetworkInterfacesCommand: class { constructor(public input: unknown) {} },
  DescribeAddressesCommand: class { constructor(public input: unknown) {} },
}));

const mockGetAllowedClusters = vi.fn();
const mockGetClusterAuth = vi.fn();
vi.mock('./eks-registry', () => ({
  getAllowedClusters: mockGetAllowedClusters,
  getClusterAuth: mockGetClusterAuth,
}));

const mockListInCluster = vi.fn();
vi.mock('./eks-incluster', () => ({
  listInCluster: mockListInCluster,
}));

beforeEach(async () => {
  ec2Send.mockReset();
  mockGetAllowedClusters.mockReset();
  mockGetClusterAuth.mockReset();
  mockListInCluster.mockReset();
  const { _resetIpCacheForTests } = await import('./ip-inventory');
  _resetIpCacheForTests();
});

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

const eniPage = (enis: unknown[], nextToken?: string) => ({ NetworkInterfaces: enis, NextToken: nextToken });

describe('toEniRow classification (via listEnis)', () => {
  it('interfaceType wins: nat_gateway / vpc_endpoint / agentic_ai map by type (resource still from description)', async () => {
    ec2Send.mockResolvedValueOnce(eniPage([
      { NetworkInterfaceId: 'eni-nat', Status: 'in-use', InterfaceType: 'nat_gateway', Description: 'Interface for NAT Gateway nat-0abc' },
      { NetworkInterfaceId: 'eni-vpce', Status: 'in-use', InterfaceType: 'vpc_endpoint', Description: 'VPC Endpoint Interface vpce-0def' },
      { NetworkInterfaceId: 'eni-ai', Status: 'in-use', InterfaceType: 'agentic_ai', Description: '' },
    ]));
    const { listEnis } = await import('./ip-inventory');
    const rows = await listEnis();
    expect(rows.map((r) => [r.id, r.kind, r.resource])).toEqual([
      ['eni-nat', 'NAT Gateway', 'nat-0abc'],
      ['eni-vpce', 'VPC Endpoint', 'vpce-0def'],
      ['eni-ai', 'AgentCore', null],
    ]);
  });

  it("type 'interface': description patterns → ALB / ECS Task / RDS / ElastiCache / EKS Control Plane", async () => {
    ec2Send.mockResolvedValueOnce(eniPage([
      { NetworkInterfaceId: 'eni-alb', InterfaceType: 'interface', Description: 'ELB app/my-alb/50dc6c495c0c9188' },
      { NetworkInterfaceId: 'eni-ecs', InterfaceType: 'interface', Description: 'arn:aws:ecs:ap-northeast-2:111122223333:attachment/0a1b2c3d-task-id' },
      { NetworkInterfaceId: 'eni-rds', InterfaceType: 'interface', Description: 'RDSNetworkInterface' },
      { NetworkInterfaceId: 'eni-ec', InterfaceType: 'interface', Description: 'ElastiCache my-redis-001' },
      { NetworkInterfaceId: 'eni-eks', InterfaceType: 'interface', Description: 'Amazon EKS prod-cluster' },
    ]));
    const { listEnis } = await import('./ip-inventory');
    const rows = await listEnis();
    expect(rows.map((r) => [r.kind, r.resource])).toEqual([
      ['ALB', 'app/my-alb'],
      ['ECS Task', '0a1b2c3d-task-id'],
      ['RDS', null],
      ['ElastiCache', 'my-redis-001'],
      ['EKS Control Plane', 'prod-cluster'],
    ]);
  });

  it('no description match + Attachment.InstanceId → EC2; nothing at all → Other', async () => {
    ec2Send.mockResolvedValueOnce(eniPage([
      { NetworkInterfaceId: 'eni-ec2', InterfaceType: 'interface', Description: 'Primary network interface', Attachment: { InstanceId: 'i-0123456789abcdef0' } },
      { NetworkInterfaceId: 'eni-other', InterfaceType: 'interface', Description: 'something unrecognized' },
    ]));
    const { listEnis } = await import('./ip-inventory');
    const rows = await listEnis();
    expect(rows[0]).toMatchObject({ kind: 'EC2', resource: 'i-0123456789abcdef0', instanceId: 'i-0123456789abcdef0' });
    expect(rows[1]).toMatchObject({ kind: 'Other', resource: null, instanceId: null });
  });

  it('privateIps prefers the PrivateIpAddresses array; falls back to PrivateIpAddress when empty', async () => {
    ec2Send.mockResolvedValueOnce(eniPage([
      {
        NetworkInterfaceId: 'eni-multi', InterfaceType: 'interface', Description: '',
        PrivateIpAddresses: [
          { PrivateIpAddress: '10.0.1.10', Primary: true },
          { PrivateIpAddress: '10.0.1.11' },
          { Primary: false }, // no IP → dropped
        ],
        PrivateIpAddress: '10.0.9.99', // ignored when array has entries
      },
      { NetworkInterfaceId: 'eni-fallback', InterfaceType: 'interface', Description: '', PrivateIpAddress: '10.0.2.20' },
      { NetworkInterfaceId: 'eni-empty-arr', InterfaceType: 'interface', Description: '', PrivateIpAddresses: [], PrivateIpAddress: '10.0.3.30' },
    ]));
    const { listEnis } = await import('./ip-inventory');
    const rows = await listEnis();
    expect(rows[0].privateIps).toEqual(['10.0.1.10', '10.0.1.11']);
    expect(rows[1].privateIps).toEqual(['10.0.2.20']);
    expect(rows[2].privateIps).toEqual(['10.0.3.30']);
  });
});

describe('listEnis pagination + cache', () => {
  it('follows NextToken across 2 pages and merges rows', async () => {
    ec2Send.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name !== 'DescribeNetworkInterfacesCommand') throw new Error(`unexpected ${cmd.constructor.name}`);
      return cmd.input.NextToken === undefined
        ? eniPage([{ NetworkInterfaceId: 'eni-1', InterfaceType: 'interface', Description: '' }], 'token-2')
        : eniPage([{ NetworkInterfaceId: 'eni-2', InterfaceType: 'interface', Description: '' }]);
    });
    const { listEnis } = await import('./ip-inventory');
    const rows = await listEnis();
    expect(rows.map((r) => r.id)).toEqual(['eni-1', 'eni-2']);
    expect(ec2Send).toHaveBeenCalledTimes(2);
    expect((ec2Send.mock.calls[1][0] as Cmd).input.NextToken).toBe('token-2');
  });

  it('caches: second call sends no additional commands', async () => {
    ec2Send.mockResolvedValue(eniPage([{ NetworkInterfaceId: 'eni-1', InterfaceType: 'interface', Description: '' }]));
    const { listEnis } = await import('./ip-inventory');
    await listEnis();
    expect(ec2Send).toHaveBeenCalledTimes(1);
    await listEnis();
    expect(ec2Send).toHaveBeenCalledTimes(1); // cache hit — no extra send
  });
});

describe('listEips', () => {
  it('marks addresses without AssociationId as unused', async () => {
    ec2Send.mockResolvedValueOnce({
      Addresses: [
        { AllocationId: 'eipalloc-used', PublicIp: '3.3.3.3', PrivateIpAddress: '10.0.1.10', NetworkInterfaceId: 'eni-1', InstanceId: 'i-1', AssociationId: 'eipassoc-1' },
        { AllocationId: 'eipalloc-idle', PublicIp: '4.4.4.4' },
      ],
    });
    const { listEips } = await import('./ip-inventory');
    const rows = await listEips();
    expect(rows).toEqual([
      { allocationId: 'eipalloc-used', publicIp: '3.3.3.3', privateIp: '10.0.1.10', eniId: 'eni-1', instanceId: 'i-1', unused: false },
      { allocationId: 'eipalloc-idle', publicIp: '4.4.4.4', privateIp: null, eniId: null, instanceId: null, unused: true },
    ]);
  });
});

describe('podIpMap', () => {
  const pod = (name: string, namespace: string, podIP?: string) => ({
    name, namespace, status: 'Running', node: 'node-1', restarts: 0, age: '1d',
    cpuRequest: 0, memRequest: 0, diskRequest: 0, podIP,
  });

  it('skips clusters without auth, keeps the first entry per IP, and degrades failing clusters', async () => {
    mockGetAllowedClusters.mockResolvedValue(new Set(['with-auth', 'no-auth', 'broken']));
    mockGetClusterAuth.mockImplementation(async (cluster: string) =>
      cluster === 'no-auth' ? null : { mode: 'sa-token', token: 't' });
    mockListInCluster.mockImplementation(async (cluster: string) => {
      if (cluster === 'broken') throw new Error('kube API unreachable');
      return [
        pod('pod-a', 'default', '10.0.5.1'),
        pod('pod-dup', 'kube-system', '10.0.5.1'), // duplicate IP — must NOT overwrite pod-a
        pod('pod-b', 'default', '10.0.5.2'),
        pod('pod-no-ip', 'default'), // no podIP — skipped
      ];
    });
    const { podIpMap } = await import('./ip-inventory');
    const map = await podIpMap();
    expect(map).toEqual({
      '10.0.5.1': { cluster: 'with-auth', namespace: 'default', name: 'pod-a' },
      '10.0.5.2': { cluster: 'with-auth', namespace: 'default', name: 'pod-b' },
    });
    // no-auth cluster skipped before listing; broken cluster attempted but degraded
    expect(mockListInCluster.mock.calls.map(([c]) => c).sort()).toEqual(['broken', 'with-auth']);
  });

  it('returns an empty map when getAllowedClusters itself fails', async () => {
    mockGetAllowedClusters.mockRejectedValue(new Error('DB down'));
    const { podIpMap } = await import('./ip-inventory');
    expect(await podIpMap()).toEqual({});
    expect(mockGetClusterAuth).not.toHaveBeenCalled();
  });
});
