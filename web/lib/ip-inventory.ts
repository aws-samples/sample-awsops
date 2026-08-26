import { EC2Client, DescribeNetworkInterfacesCommand, DescribeAddressesCommand } from '@aws-sdk/client-ec2';
import { getAllowedClusters, getClusterAuth } from './eks-registry';
import { listInCluster, type PodRow } from './eks-incluster';

// IP 인벤토리 (Network 메뉴) — 계정의 모든 IP는 ENI에 귀속되므로 ENI가 원천이다:
// EC2/ALB/NLB/NAT/Lambda/RDS/ElastiCache/OpenSearch/MSK/VPCE/EFS/TGW/CloudFront/AgentCore…
// interfaceType + description 패턴으로 소유 리소스를 판별하고(실측 341 ENI 패턴 기준),
// EKS 파드 IP(VPC CNI 보조 IP, 실측 896개)는 인-클러스터 파드 목록과 조인한다.
// 미사용 신호 2종: 연결 안 된 EIP(과금 발생) + available 상태 ENI.

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
let ec2Client: EC2Client | null = null;
const ec2 = () => (ec2Client ??= new EC2Client({ region: REGION }));

const TTL_MS = 4 * 60_000;
const cache = new Map<string, { at: number; v: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v as T;
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = fn().then((v) => {
    cache.set(key, { at: Date.now(), v });
    return v;
  }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
export function _resetIpCacheForTests() { cache.clear(); inflight.clear(); ec2Client = null; }

export interface EniRow {
  id: string; status: string;
  /** 소유 리소스 종류 (facet) — interfaceType + description 판별. */
  kind: string;
  /** 소유 리소스 식별자 (instance-id, LB 이름, 클러스터명 등 — 판별 가능할 때). */
  resource: string | null;
  description: string;
  privateIps: string[]; publicIp: string | null;
  subnetId: string; vpcId: string; az: string;
  instanceId: string | null;
}
export interface EipRow {
  allocationId: string; publicIp: string; privateIp: string | null;
  eniId: string | null; instanceId: string | null;
  /** 연결 안 된 EIP — 유휴 과금 발생 (미사용 public IP). */
  unused: boolean;
}
export interface PodIpInfo { cluster: string; namespace: string; name: string }

// interfaceType → kind (실측 타입 10종).
const TYPE_KIND: Record<string, string> = {
  nat_gateway: 'NAT Gateway', network_load_balancer: 'NLB', vpc_endpoint: 'VPC Endpoint',
  lambda: 'Lambda', efs: 'EFS', transit_gateway: 'Transit Gateway',
  gateway_load_balancer_endpoint: 'GWLB Endpoint', cloudfront_managed: 'CloudFront',
  agentic_ai: 'AgentCore', branch: 'Branch ENI',
};

// type 'interface'의 description 패턴 → [kind, resource 추출] (실측 상위 패턴).
function classifyByDescription(desc: string): { kind: string; resource: string | null } | null {
  if (desc.startsWith('ELB app/')) return { kind: 'ALB', resource: desc.slice(4).split('/').slice(0, 2).join('/') };
  if (desc.startsWith('ELB net/')) return { kind: 'NLB', resource: desc.slice(4).split('/').slice(0, 2).join('/') };
  if (desc.startsWith('ELB ')) return { kind: 'ELB(classic)', resource: desc.slice(4) };
  if (desc.startsWith('arn:aws:ecs:')) return { kind: 'ECS Task', resource: desc.split('/').pop() ?? null };
  if (desc.startsWith('ElastiCache')) return { kind: 'ElastiCache', resource: desc.replace(/^ElastiCache[- ]?/, '') || null };
  if (desc.startsWith('RDSNetworkInterface')) return { kind: 'RDS', resource: null };
  if (desc.startsWith('ES ')) return { kind: 'OpenSearch', resource: desc.slice(3) || null };
  if (/^Amazon MSK/i.test(desc)) return { kind: 'MSK', resource: null };
  if (/Amazon EKS/i.test(desc)) return { kind: 'EKS Control Plane', resource: desc.replace(/^.*Amazon EKS /i, '') || null };
  if (desc.startsWith('AWS Lambda VPC ENI')) return { kind: 'Lambda', resource: null };
  if (desc.startsWith('Interface for NAT Gateway')) return { kind: 'NAT Gateway', resource: desc.split(' ').pop() ?? null };
  if (desc.startsWith('VPC Endpoint Interface')) return { kind: 'VPC Endpoint', resource: desc.split(' ').pop() ?? null };
  if (/aws K8S/i.test(desc)) return { kind: 'EKS Node (CNI)', resource: null };
  return null;
}

interface RawEni {
  NetworkInterfaceId?: string; Status?: string; InterfaceType?: string; Description?: string;
  SubnetId?: string; VpcId?: string; AvailabilityZone?: string;
  Association?: { PublicIp?: string };
  Attachment?: { InstanceId?: string };
  PrivateIpAddresses?: { PrivateIpAddress?: string; Primary?: boolean }[];
  PrivateIpAddress?: string;
}

/** ENI 소유 리소스 분류 — sg-analysis 등 다른 계층에서도 재사용 (toEniRow와 동일 로직). */
export function classifyEni(interfaceType: string, description: string, instanceId: string | null): { kind: string; resource: string | null } {
  let kind: string; let resource: string | null = null;
  const byDesc = classifyByDescription(description);
  if (interfaceType !== 'interface' && TYPE_KIND[interfaceType]) {
    kind = TYPE_KIND[interfaceType];
    resource = byDesc?.resource ?? null;
  } else if (byDesc) {
    kind = byDesc.kind; resource = byDesc.resource;
  } else if (instanceId) {
    kind = 'EC2'; resource = instanceId;
  } else {
    kind = 'Other'; resource = null;
  }
  if (!resource && instanceId) resource = instanceId;
  return { kind, resource };
}

function toEniRow(e: RawEni): EniRow {
  const desc = e.Description ?? '';
  const type = e.InterfaceType ?? 'interface';
  const instanceId = e.Attachment?.InstanceId ?? null;
  const { kind, resource } = classifyEni(type, desc, instanceId);
  const privateIps = (e.PrivateIpAddresses ?? [])
    .map((p) => p.PrivateIpAddress).filter((x): x is string => !!x);
  if (privateIps.length === 0 && e.PrivateIpAddress) privateIps.push(e.PrivateIpAddress);
  return {
    id: e.NetworkInterfaceId ?? '', status: e.Status ?? '', kind, resource, description: desc,
    privateIps, publicIp: e.Association?.PublicIp ?? null,
    subnetId: e.SubnetId ?? '', vpcId: e.VpcId ?? '', az: e.AvailabilityZone ?? '',
    instanceId,
  };
}

/** 전체 ENI (페이지네이션, 상한 2000). */
export async function listEnis(): Promise<EniRow[]> {
  return cached('enis', async () => {
    const out: EniRow[] = [];
    let token: string | undefined;
    do {
      const r = await ec2().send(new DescribeNetworkInterfacesCommand({ MaxResults: 500, NextToken: token }));
      for (const e of r.NetworkInterfaces ?? []) out.push(toEniRow(e as RawEni));
      token = r.NextToken;
    } while (token && out.length < 2000);
    return out;
  });
}

/** 전체 EIP — AssociationId 없는 것이 미사용(유휴 과금). */
export async function listEips(): Promise<EipRow[]> {
  return cached('eips', async () => {
    const r = await ec2().send(new DescribeAddressesCommand({}));
    return (r.Addresses ?? []).map((a) => ({
      allocationId: a.AllocationId ?? '', publicIp: a.PublicIp ?? '',
      privateIp: a.PrivateIpAddress ?? null,
      eniId: a.NetworkInterfaceId ?? null, instanceId: a.InstanceId ?? null,
      unused: !a.AssociationId,
    }));
  });
}

/** 연결된 EKS 클러스터들의 파드 IP → {cluster, ns, name} 맵 (best-effort — 실패 클러스터는 빠짐). */
export async function podIpMap(): Promise<Record<string, PodIpInfo>> {
  return cached('podips', async () => {
    const out: Record<string, PodIpInfo> = {};
    const clusters = [...(await getAllowedClusters().catch(() => new Set<string>()))];
    await Promise.all(clusters.map(async (cluster) => {
      try {
        if (!(await getClusterAuth(cluster))) return;
        const pods = (await listInCluster(cluster, 'pods')) as PodRow[];
        for (const p of pods) {
          // hostNetwork 파드는 노드 IP를 공유 — 먼저 잡힌 항목 유지(파드 고유 IP 우선 아님 주의).
          if (p.podIP && !out[p.podIP]) out[p.podIP] = { cluster, namespace: p.namespace, name: p.name };
        }
      } catch { /* per-cluster degrade */ }
    }));
    return out;
  });
}
