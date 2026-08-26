// OpenCost allocation read (v1 eks-container-cost parity) — queries the in-cluster OpenCost
// service via the K8s service proxy (no ingress/port-forward needed). READ-ONLY.
import { k8sGetPath, listInCluster } from './eks-incluster';
import type { PodRow } from './eks-resources';

export interface PodCost {
  namespace: string; pod: string; node: string;
  cpuCost: number; ramCost: number; networkCost: number; pvCost: number; gpuCost: number; totalCost: number;
}
export interface AllocationResult {
  available: boolean;
  /** 'opencost' = measured 1d allocation; 'request-estimate' = requests × unit prices fallback. */
  source?: 'opencost' | 'request-estimate';
  message?: string;
  nodes?: { node: string; cpuCost: number; ramCost: number; totalCost: number }[];
  pods: PodCost[];
  namespaces: { name: string; value: number }[];
  kpi: { dailyTotal: number; monthly: number; podCount: number; topNamespace: { name: string; cost: number } | null };
  hasNetwork: boolean; hasPv: boolean; hasGpu: boolean;
}

// OpenCost helm chart defaults: namespace `opencost`, service `opencost`, API port 9003.
const PROXY_PATH =
  '/api/v1/namespaces/opencost/services/opencost:9003/proxy/allocation/compute?window=1d&aggregate=namespace,pod';

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (n: number): number => Math.round(n * 100) / 100;

export async function getAllocation(cluster: string): Promise<AllocationResult> {
  const empty: AllocationResult = {
    available: false, pods: [], namespaces: [],
    kpi: { dailyTotal: 0, monthly: 0, podCount: 0, topNamespace: null },
    hasNetwork: false, hasPv: false, hasGpu: false,
  };
  let body: string;
  try {
    body = await k8sGetPath(cluster, PROXY_PATH);
  } catch (e) {
    // v1 parity: OpenCost unavailable → request-based estimate (pods' requests × unit prices).
    const est = await requestEstimate(cluster).catch(() => null);
    if (est) return est;
    return { ...empty, message: e instanceof Error ? e.message : String(e) };
  }
  try {
    const parsed = JSON.parse(body) as { data?: Array<Record<string, Record<string, unknown>>> };
    const alloc = parsed.data?.[0] ?? {};
    const pods: PodCost[] = [];
    for (const [key, a] of Object.entries(alloc)) {
      if (key === '__idle__' || key === '__unallocated__') continue;
      const props = (a.properties ?? {}) as Record<string, unknown>;
      const [nsFromKey, podFromKey] = key.includes('/') ? key.split('/', 2) : ['', key];
      pods.push({
        namespace: String(props.namespace ?? nsFromKey ?? ''),
        pod: String(props.pod ?? podFromKey ?? key),
        node: String(props.node ?? ''),
        cpuCost: r2(num(a.cpuCost)),
        ramCost: r2(num(a.ramCost)),
        networkCost: r2(num(a.networkCost)),
        pvCost: r2(num(a.pvCost)),
        gpuCost: r2(num(a.gpuCost)),
        totalCost: r2(num(a.totalCost)),
      });
    }
    pods.sort((a, b) => b.totalCost - a.totalCost);
    const byNs = new Map<string, number>();
    for (const p of pods) byNs.set(p.namespace, (byNs.get(p.namespace) ?? 0) + p.totalCost);
    const namespaces = [...byNs.entries()].map(([name, value]) => ({ name, value: r2(value) })).sort((a, b) => b.value - a.value);
    const dailyTotal = r2(pods.reduce((s, p) => s + p.totalCost, 0));
    // node-level rollup (best-effort second call; measured mode only)
    let nodes: AllocationResult['nodes'];
    try {
      const nb = JSON.parse(await k8sGetPath(cluster, PROXY_PATH.replace('aggregate=namespace,pod', 'aggregate=node'))) as { data?: Array<Record<string, Record<string, unknown>>> };
      nodes = Object.entries(nb.data?.[0] ?? {})
        .filter(([k]) => k !== '__idle__' && k !== '__unallocated__')
        .map(([k, a]) => ({ node: k, cpuCost: r2(num(a.cpuCost)), ramCost: r2(num(a.ramCost)), totalCost: r2(num(a.totalCost)) }))
        .sort((a, b) => b.totalCost - a.totalCost);
    } catch { /* nodes omitted */ }
    return {
      available: true,
      source: 'opencost',
      nodes,
      pods,
      namespaces,
      kpi: {
        dailyTotal,
        monthly: r2(dailyTotal * 30),
        podCount: pods.length,
        topNamespace: namespaces[0] ? { name: namespaces[0].name, cost: namespaces[0].value } : null,
      },
      hasNetwork: pods.some((p) => p.networkCost > 0),
      hasPv: pods.some((p) => p.pvCost > 0),
      hasGpu: pods.some((p) => p.gpuCost > 0),
    };
  } catch {
    return { ...empty, message: 'OpenCost 응답 파싱 실패' };
  }
}

// Fargate-style unit prices (ap-northeast-2 on-demand) — the request-estimate fallback's basis.
const VCPU_H = 0.04656;
const GB_H = 0.00511;

/** OpenCost-unavailable fallback: per-pod daily cost from resource REQUESTS × unit prices. */
async function requestEstimate(cluster: string): Promise<AllocationResult | null> {
  const rows = (await listInCluster(cluster, 'pods')) as PodRow[];
  if (!rows.length) return null;
  const pods = rows
    .filter((p) => (p as { status?: string }).status !== 'Succeeded')
    .map((p) => {
      const cores = Number((p as { cpuRequest?: number }).cpuRequest) || 0;
      const memGb = (Number((p as { memRequest?: number }).memRequest) || 0) / 1e9;
      const daily = cores * VCPU_H * 24 + memGb * GB_H * 24;
      return {
        namespace: (p as { namespace?: string }).namespace ?? '',
        pod: (p as { name?: string }).name ?? '',
        node: (p as { node?: string }).node ?? '',
        cpuCost: r2(cores * VCPU_H * 24),
        ramCost: r2(memGb * GB_H * 24),
        networkCost: 0, pvCost: 0, gpuCost: 0,
        totalCost: r2(daily),
      };
    })
    .sort((a, b) => b.totalCost - a.totalCost);
  const byNs = new Map<string, number>();
  for (const p of pods) byNs.set(p.namespace, (byNs.get(p.namespace) ?? 0) + p.totalCost);
  const namespaces = [...byNs.entries()].map(([name, value]) => ({ name, value: r2(value) })).sort((a, b) => b.value - a.value);
  const dailyTotal = r2(pods.reduce((s, p) => s + p.totalCost, 0));
  return {
    available: true,
    source: 'request-estimate',
    pods, namespaces,
    kpi: {
      dailyTotal, monthly: r2(dailyTotal * 30), podCount: pods.length,
      topNamespace: namespaces[0] ? { name: namespaces[0].name, cost: namespaces[0].value } : null,
    },
    hasNetwork: false, hasPv: false, hasGpu: false,
  };
}
