import {
  EC2Client, paginateDescribeInstances, DescribeInstanceTypesCommand,
  type Instance, type InstanceTypeInfo, type _InstanceType,
} from '@aws-sdk/client-ec2';
import { EKSClient, paginateListNodegroups, DescribeNodegroupCommand } from '@aws-sdk/client-eks';
import { assumedClient } from './aws-assume';
import type { EksClusterContext } from './eks-context';
import type { NodeRow } from './eks-resources';

// Member clusters onboard with AmazonEKSViewPolicy only, which has no cluster-scoped
// `nodes` read. Their node view is therefore built from AWS control-plane reads made
// with the registered member read role (AWSopsReadOnlyRole / ReadOnlyAccess):
// eks:ListNodegroups + eks:DescribeNodegroup, ec2:DescribeInstances (cluster tags) and
// ec2:DescribeInstanceTypes. READ-ONLY: no Describe/List call here mutates anything.
// The rows are an EC2/node-group view: no kubelet conditions, labels, taints or
// allocatable. Fargate pods have no EC2 instance and do not appear.

const MAX_INSTANCES = 2000;
const MAX_NODEGROUPS = 100;
const INSTANCE_TYPES_PER_CALL = 100;
const LIVE_STATES = ['pending', 'running', 'stopping', 'shutting-down'];

function age(ts?: Date): string {
  if (!ts) return '';
  const ms = Date.now() - ts.getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function tag(instance: Instance, key: string): string | undefined {
  return instance.Tags?.find((t) => t.Key === key)?.Value;
}

async function clusterInstances(ec2: EC2Client, cluster: string): Promise<Instance[]> {
  // Managed node groups tag `eks:cluster-name`; self-managed and Karpenter nodes carry
  // `kubernetes.io/cluster/<name>`. Filters within one call are AND-ed, so query both.
  const filterSets = [
    [{ Name: 'tag:eks:cluster-name', Values: [cluster] }],
    [{ Name: 'tag-key', Values: [`kubernetes.io/cluster/${cluster}`] }],
  ];
  const byId = new Map<string, Instance>();
  for (const filters of filterSets) {
    const pages = paginateDescribeInstances({ client: ec2, pageSize: 1000 }, {
      Filters: [...filters, { Name: 'instance-state-name', Values: LIVE_STATES }],
    });
    for await (const page of pages) {
      for (const r of page.Reservations ?? []) {
        for (const i of r.Instances ?? []) if (i.InstanceId) byId.set(i.InstanceId, i);
      }
      if (byId.size >= MAX_INSTANCES) break;
    }
  }
  return [...byId.values()].slice(0, MAX_INSTANCES);
}

async function nodegroupVersions(eks: EKSClient, cluster: string): Promise<Map<string, string>> {
  const names: string[] = [];
  for await (const page of paginateListNodegroups({ client: eks }, { clusterName: cluster })) {
    names.push(...(page.nodegroups ?? []));
    if (names.length >= MAX_NODEGROUPS) break;
  }
  const out = new Map<string, string>();
  await Promise.all(names.slice(0, MAX_NODEGROUPS).map(async (nodegroupName) => {
    try {
      const { nodegroup } = await eks.send(new DescribeNodegroupCommand({ clusterName: cluster, nodegroupName }));
      if (nodegroup?.version) out.set(nodegroupName, nodegroup.version);
    } catch { /* version is optional detail; the instance row still renders */ }
  }));
  return out;
}

async function instanceTypeInfo(ec2: EC2Client, types: string[]): Promise<Map<string, InstanceTypeInfo>> {
  const out = new Map<string, InstanceTypeInfo>();
  for (let i = 0; i < types.length; i += INSTANCE_TYPES_PER_CALL) {
    const batch = types.slice(i, i + INSTANCE_TYPES_PER_CALL) as _InstanceType[];
    // One invalid/unsupported type rejects a whole batch, so a failed batch is retried per type;
    // a type still missing leaves its rows' capacity unknown (capacityUnknown), never 0 as fact.
    for (const attempt of [batch, ...batch.map((t) => [t])]) {
      if (attempt.every((t) => out.has(t))) continue;
      try {
        const r = await ec2.send(new DescribeInstanceTypesCommand({ InstanceTypes: attempt }));
        for (const t of r.InstanceTypes ?? []) if (t.InstanceType) out.set(t.InstanceType, t);
        if (attempt === batch) break;
      } catch { /* retried per type below; unresolved types stay unknown */ }
    }
  }
  return out;
}

function roles(instance: Instance): string {
  const ng = tag(instance, 'eks:nodegroup-name');
  if (ng) return `nodegroup:${ng}`;
  const pool = tag(instance, 'karpenter.sh/nodepool') ?? tag(instance, 'karpenter.sh/provisioner-name');
  if (pool) return `karpenter:${pool}`;
  return 'ec2';
}

/** EC2/node-group view of a member cluster's worker nodes, via the registered member role. */
export async function listAwsApiNodes(context: EksClusterContext): Promise<NodeRow[]> {
  const cfg = { region: context.region };
  const [ec2, eks] = await Promise.all([
    assumedClient(context.accountId, EC2Client, cfg),
    assumedClient(context.accountId, EKSClient, cfg),
  ]);
  const [instances, versions] = await Promise.all([
    clusterInstances(ec2, context.name),
    nodegroupVersions(eks, context.name).catch(() => new Map<string, string>()),
  ]);
  const types = [...new Set(instances.flatMap((i) => (i.InstanceType ? [String(i.InstanceType)] : [])))];
  const typeInfo = await instanceTypeInfo(ec2, types);
  return instances.map((i) => {
    const info = i.InstanceType ? typeInfo.get(i.InstanceType) : undefined;
    const cpu = info?.VCpuInfo?.DefaultVCpus ?? 0;
    const mem = info?.MemoryInfo?.SizeInMiB ?? 0;
    const capacityUnknown = !(cpu > 0 && mem > 0);
    const ng = tag(i, 'eks:nodegroup-name');
    const state = i.State?.Name ?? 'unknown';
    return {
      // Default EKS node names are the EC2 private DNS name — the pods' spec.nodeName join key.
      name: i.PrivateDnsName || i.InstanceId || '',
      status: `EC2 ${state}`,
      roles: roles(i),
      version: ng ? versions.get(ng) ?? '' : '',
      instanceType: i.InstanceType ?? '',
      zone: i.Placement?.AvailabilityZone ?? '',
      age: age(i.LaunchTime),
      // Instance-type capacity; kubelet allocatable is unavailable without the nodes API,
      // so allocatable mirrors capacity (an upper bound) and the UI labels it as such.
      cpuCapacity: cpu, cpuAllocatable: cpu, memCapacity: mem, memAllocatable: mem,
      diskCapacity: 0, diskAllocatable: 0,
      createdAt: i.LaunchTime?.toISOString(),
      source: 'aws-api',
      ...(capacityUnknown ? { capacityUnknown: true } : {}),
      ...(i.InstanceId ? { instanceId: i.InstanceId } : {}),
    } satisfies NodeRow;
  });
}
