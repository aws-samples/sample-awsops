import { EC2Client, DescribeVpcEndpointsCommand } from '@aws-sdk/client-ec2';
import { CloudWatchClient, ListMetricsCommand, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { getPool } from './db';

// VPC Endpoint 리스트 + 분석 (Network 메뉴): DescribeVpcEndpoints를 인벤토리 VPC 리전들로
// fan-out하고, Interface 엔드포인트는 AWS/PrivateLinkEndpoints 메트릭(BytesProcessed 등)으로
// **미사용(유휴 과금) 감지** — IF 엔드포인트는 AZ(ENI)당 시간 과금이라 미사용 = 실돈 낭비.
// 추가 분석: full-access 정책, private DNS off, S3/DynamoDB gateway 커버리지 갭(VPC 조인).

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const clients = new Map<string, EC2Client>();
const ec2 = (r: string) => {
  let c = clients.get(r);
  if (!c) { c = new EC2Client({ region: r }); clients.set(r, c); }
  return c;
};
const cwClients = new Map<string, CloudWatchClient>();
const cw = (r: string) => {
  let c = cwClients.get(r);
  if (!c) { c = new CloudWatchClient({ region: r }); cwClients.set(r, c); }
  return c;
};

const TTL_MS = 4 * 60_000;
const cache = new Map<string, { at: number; v: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v as T;
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = fn().then((v) => { cache.set(key, { at: Date.now(), v }); return v; }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
export function _resetVpceCacheForTests() { cache.clear(); inflight.clear(); clients.clear(); cwClients.clear(); }

export interface VpceRow {
  id: string; region: string; vpcId: string;
  /** 서비스 짧은 이름 (com.amazonaws.<region>. 접두사 제거). */
  service: string; serviceName: string;
  type: string; state: string;
  subnetCount: number; eniCount: number;
  privateDnsEnabled: boolean | null;
  /** 정책이 Action:* + Principal:* 전면 허용인지 (Gateway/IF 공통 보안 신호). */
  policyOpen: boolean;
  createdAt: string | null;
  /** PrivateLink 메트릭 (Interface만, 선택 기간 집계 — null=데이터 없음). */
  bytesProcessed: number | null; activeConnections: number | null;
  newConnections: number | null; packetsDropped: number | null;
  /** Interface + 기간 내 트래픽 0/없음 → 유휴 과금 의심. */
  unused: boolean;
}
export interface VpceAnalysis {
  rows: VpceRow[];
  /** S3/DynamoDB gateway 엔드포인트가 없는 VPC (NAT 경유 비용/경로 최적화 후보). */
  coverageGaps: { vpcId: string; region: string; missing: string[] }[];
  totals: {
    total: number; interface: number; gateway: number; gwlb: number;
    unused: number; policyOpen: number; privateDnsOff: number;
    /** Interface ENI(AZ) 수 × $0.0126/h 기준 월 추정 (추정치 명시용). */
    estMonthlyUsd: number;
  };
  rangeSec: number;
}

const IF_HOURLY_PER_AZ = 0.0126; // ap-northeast-2 Interface endpoint per-AZ 시간당 (추정 기준 명시)

function policyIsOpen(doc?: string): boolean {
  if (!doc) return false;
  try {
    const p = JSON.parse(doc) as { Statement?: { Effect?: string; Action?: unknown; Principal?: unknown }[] };
    return (p.Statement ?? []).some((st) =>
      st.Effect === 'Allow' &&
      (st.Action === '*' || (Array.isArray(st.Action) && st.Action.includes('*'))) &&
      (st.Principal === '*' || JSON.stringify(st.Principal) === '{"AWS":"*"}' || JSON.stringify(st.Principal) === '"*"'));
  } catch { return false; }
}

async function regionsFromInventory(): Promise<string[]> {
  try {
    const r = await getPool().query<{ region: string }>(
      `SELECT DISTINCT region FROM inventory_resources WHERE resource_type = 'vpc' AND region IS NOT NULL`);
    const set = new Set(r.rows.map((x) => x.region));
    set.add(REGION);
    return [...set];
  } catch { return [REGION]; }
}

interface RawEp {
  VpcEndpointId?: string; VpcId?: string; ServiceName?: string; VpcEndpointType?: string; State?: string;
  SubnetIds?: string[]; NetworkInterfaceIds?: string[]; PrivateDnsEnabled?: boolean;
  PolicyDocument?: string; CreationTimestamp?: string | Date;
}

const PL_METRICS = [
  { key: 'bytesProcessed', name: 'BytesProcessed', stat: 'Sum' },
  { key: 'activeConnections', name: 'ActiveConnections', stat: 'Maximum' },
  { key: 'newConnections', name: 'NewConnections', stat: 'Sum' },
  { key: 'packetsDropped', name: 'PacketsDropped', stat: 'Sum' },
] as const;

/** Interface 엔드포인트별 PrivateLink 메트릭 — dims 5종 튜플을 ListMetrics로 발견 (eksNodesCI 패턴). */
async function plMetrics(region: string, rangeSec: number): Promise<Record<string, Record<string, number | null>>> {
  const out: Record<string, Record<string, number | null>> = {};
  try {
    const lm = await cw(region).send(new ListMetricsCommand({
      Namespace: 'AWS/PrivateLinkEndpoints', MetricName: 'BytesProcessed',
    }));
    const dimsById = new Map<string, { Name: string; Value: string }[]>();
    for (const m of lm.Metrics ?? []) {
      const id = m.Dimensions?.find((d) => d.Name === 'VPC Endpoint Id')?.Value;
      if (id && !dimsById.has(id)) dimsById.set(id, (m.Dimensions ?? []).map((d) => ({ Name: d.Name ?? '', Value: d.Value ?? '' })));
    }
    const ids = [...dimsById.keys()].slice(0, 100);
    if (ids.length === 0) return out;
    const r = await cw(region).send(new GetMetricDataCommand({
      StartTime: new Date(Date.now() - rangeSec * 1000), EndTime: new Date(),
      MetricDataQueries: ids.flatMap((id, i) => PL_METRICS.map((m) => ({
        Id: `${m.key}_i${i}`, ReturnData: true,
        MetricStat: { Metric: { Namespace: 'AWS/PrivateLinkEndpoints', MetricName: m.name, Dimensions: dimsById.get(id) }, Period: rangeSec, Stat: m.stat },
      }))),
    }));
    for (const id of ids) out[id] = Object.fromEntries(PL_METRICS.map((m) => [m.key, null]));
    for (const res of r.MetricDataResults ?? []) {
      const mm = (res.Id ?? '').match(/^(\w+?)_i(\d+)$/);
      const v = res.Values?.[0];
      if (mm && typeof v === 'number' && ids[Number(mm[2])]) out[ids[Number(mm[2])]][mm[1]] = v;
    }
  } catch { /* region degrade */ }
  return out;
}

/** 전 리전 VPC 엔드포인트 + 분석 (미사용/정책/커버리지 갭). */
export async function vpceAnalysis(rangeSec: number): Promise<VpceAnalysis> {
  return cached(`a|${rangeSec}`, async () => {
    const regions = await regionsFromInventory();
    const perRegion = await Promise.all(regions.map(async (region) => {
      try {
        const [r, metrics] = await Promise.all([
          ec2(region).send(new DescribeVpcEndpointsCommand({ MaxResults: 400 })),
          plMetrics(region, rangeSec),
        ]);
        return ((r.VpcEndpoints ?? []) as RawEp[]).map((e): VpceRow => {
          const id = e.VpcEndpointId ?? '';
          const m = metrics[id] ?? {};
          const isIf = e.VpcEndpointType === 'Interface';
          const bytes = m.bytesProcessed ?? null;
          const conns = m.activeConnections ?? null;
          return {
            id, region, vpcId: e.VpcId ?? '',
            service: (e.ServiceName ?? '').replace(/^com\.amazonaws\.[^.]+\./, ''),
            serviceName: e.ServiceName ?? '',
            type: e.VpcEndpointType ?? '?', state: e.State ?? '?',
            subnetCount: e.SubnetIds?.length ?? 0, eniCount: e.NetworkInterfaceIds?.length ?? 0,
            privateDnsEnabled: isIf ? (e.PrivateDnsEnabled ?? null) : null,
            policyOpen: policyIsOpen(e.PolicyDocument),
            createdAt: e.CreationTimestamp ? new Date(e.CreationTimestamp).toISOString() : null,
            bytesProcessed: bytes, activeConnections: conns,
            newConnections: m.newConnections ?? null, packetsDropped: m.packetsDropped ?? null,
            // 미사용: Interface인데 기간 내 처리 바이트가 0(또는 시리즈 부재) — 유휴 과금 의심.
            unused: isIf && (bytes ?? 0) === 0,
          };
        });
      } catch { return [] as VpceRow[]; }
    }));
    const rows = perRegion.flat();

    // 커버리지 갭: 인벤토리 VPC 중 S3/DynamoDB gateway 엔드포인트가 없는 VPC.
    let coverageGaps: VpceAnalysis['coverageGaps'] = [];
    try {
      const vr = await getPool().query<{ resource_id: string; region: string | null }>(
        `SELECT resource_id, region FROM inventory_resources WHERE resource_type = 'vpc'`);
      const gwByVpc = new Map<string, Set<string>>();
      for (const e of rows) {
        if (e.type !== 'Gateway') continue;
        const svc = e.service === 's3' ? 's3' : e.service === 'dynamodb' ? 'dynamodb' : null;
        if (!svc) continue;
        gwByVpc.set(e.vpcId, new Set([...(gwByVpc.get(e.vpcId) ?? []), svc]));
      }
      coverageGaps = vr.rows.map((v) => {
        const have = gwByVpc.get(v.resource_id) ?? new Set<string>();
        const missing = ['s3', 'dynamodb'].filter((s) => !have.has(s));
        return { vpcId: v.resource_id, region: v.region ?? REGION, missing };
      }).filter((g) => g.missing.length > 0);
    } catch { /* Aurora 미가용 시 갭 분석만 생략 */ }

    const ifRows = rows.filter((r) => r.type === 'Interface');
    const totals = {
      total: rows.length,
      interface: ifRows.length,
      gateway: rows.filter((r) => r.type === 'Gateway').length,
      gwlb: rows.filter((r) => r.type === 'GatewayLoadBalancer').length,
      unused: rows.filter((r) => r.unused).length,
      policyOpen: rows.filter((r) => r.policyOpen).length,
      privateDnsOff: ifRows.filter((r) => r.privateDnsEnabled === false).length,
      estMonthlyUsd: Math.round(ifRows.reduce((s, r) => s + r.eniCount, 0) * IF_HOURLY_PER_AZ * 24 * 30 * 100) / 100,
    };
    return { rows, coverageGaps, totals, rangeSec };
  });
}
