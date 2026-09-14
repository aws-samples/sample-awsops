import { scopedTargetIp, type FlowInput } from './flow-topology';
import type { EndpointRow } from './eks-incluster';
import type { PodRow } from './eks-resources';

type Resolution = NonNullable<FlowInput['ipResolved']>[string];
export interface EksIpResolution {
  map: NonNullable<FlowInput['ipResolved']>;
  status: 'ok' | 'empty' | 'unavailable';
  reasons: ('cluster_unreadable' | 'cluster_limit_possible')[];
}
const unavailable = (reason: EksIpResolution['reasons'][number] = 'cluster_unreadable'): EksIpResolution =>
  ({ map: {}, status: 'unavailable', reasons: [reason] });
type Cluster = { name: string; access?: string; region?: string; vpcId?: string };
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const optionalStrings = (row: Record<string, unknown>, keys: string[]) =>
  keys.every(key => row[key] == null || typeof row[key] === 'string');

// Endpoints describes Service membership, not cluster ownership. Only an independently listed,
// unique pod can establish ownership; conflicting references also disqualify the pod fallback.
export async function fetchEksIpMap(): Promise<EksIpResolution> {
  const candidates = new Map<string, Resolution | null>();
  try {
    const response = await fetch('/api/eks');
    const list = response.ok ? await response.json() : null;
    if (list?.error || list?.status === 'error' || !Array.isArray(list?.clusters)) return unavailable();
    if (!list.clusters.every((c: unknown) => isRecord(c) && nonempty(c.name) && nonempty(c.access))) return unavailable();
    // The current API returns at most 25 descriptors without a continuation token.
    if (list.clusters.length >= 25) return unavailable('cluster_limit_possible');
    const clusters = list.clusters as Cluster[];
    if (clusters.some(c => c.access !== 'connected')) return unavailable();
    if (clusters.some(c => ![c.name, c.region, c.vpcId].every(nonempty))) return unavailable();
    await Promise.all(clusters.map(async cluster => {
      const get = async (kind: string) => {
        try {
          const r = await fetch(`/api/eks/${encodeURIComponent(cluster.name)}/incluster?kind=${kind}`);
          const d = r.ok ? await r.json() : null;
          return !d?.error && d?.status !== 'error' && Array.isArray(d?.rows) ? d.rows : null;
        } catch { return null; }
      };
      const [endpoints, pods]: [EndpointRow[] | null, PodRow[] | null] = await Promise.all([get('endpoints'), get('pods')]);
      // Missing reads cannot enumerate addresses to veto another cluster. Empty arrays can.
      if (!endpoints || !pods
        || !pods.every(row => isRecord(row) && typeof row.name === 'string' && typeof row.namespace === 'string'
          && optionalStrings(row, ['podIP', 'workload']))
        || !endpoints.every(row => isRecord(row) && typeof row.name === 'string' && typeof row.namespace === 'string'
          && Array.isArray(row.ips) && row.ips.every(nonempty)
          && Array.isArray(row.targets) && row.targets.every(target =>
            isRecord(target) && nonempty(target.ip) && optionalStrings(target, ['pod'])))) {
        throw new Error('Unavailable or malformed EKS identity inventory');
      }
      const podsByIp = new Map<string, PodRow[]>();
      for (const pod of pods ?? []) {
        if (pod.podIP) podsByIp.set(pod.podIP, [...(podsByIp.get(pod.podIP) ?? []), pod]);
      }
      const servicesByIp = new Map<string, EndpointRow[]>();
      for (const endpoint of endpoints ?? []) {
        for (const ip of new Set(endpoint.ips ?? [])) {
          servicesByIp.set(ip, [...(servicesByIp.get(ip) ?? []), endpoint]);
        }
      }
      for (const ip of new Set([...podsByIp.keys(), ...servicesByIp.keys()])) {
        const matches = podsByIp.get(ip) ?? [];
        const pod = matches.length === 1 ? matches[0] : undefined;
        const services = servicesByIp.get(ip) ?? [];
        const corroborated = endpoints !== null && pod?.name && pod.namespace && services.every(service =>
          service.namespace === pod.namespace && (service.targets ?? []).filter(t => t.ip === ip)
            .every(t => !t.pod || t.pod === pod.name),
        );
        let resolution: Resolution | null = null;
        if (corroborated && pod) {
          // Multiple Services can legitimately select one pod; use its workload label in that case.
          const service = services.length === 1 ? services[0].name : undefined;
          resolution = {
            label: `${pod.namespace}/${service || pod.workload || pod.name}`, resolved: 'eks',
            meta: {
              cluster: cluster.name, namespace: pod.namespace, pod: pod.name, workload: pod.workload,
              ...(service ? { service } : {}), region: cluster.region, vpcId: cluster.vpcId,
            },
          };
        }
        const key = scopedTargetIp(cluster.region!, cluster.vpcId!, ip);
        // An IP seen in two clusters in the same network scope is never last-wins, even if their
        // workload labels coincide. Unproven records block ownership rather than asserting it.
        candidates.set(key, candidates.has(key) ? null : resolution);
      }
    }));
  } catch {
    // A failed cluster may hide a competing owner; never publish a partial candidate map.
    return unavailable();
  }
  const map = Object.fromEntries([...candidates].filter((entry): entry is [string, Resolution] => entry[1] !== null));
  return { map, status: candidates.size ? 'ok' : 'empty', reasons: [] };
}
