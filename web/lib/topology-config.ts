import { scopedTargetIp, type FlowInput } from './flow-topology';
import type { EndpointRow } from './eks-incluster';
import { isTerminalPodPhase, type PodRow } from './eks-resources';

type Resolution = NonNullable<FlowInput['ipResolved']>[string];
export interface EksIpResolution {
  map: NonNullable<FlowInput['ipResolved']>;
  blockedScopes: string[];
  coveredRegions: string[];
  globalUnknown: boolean;
  status: 'ok' | 'empty' | 'partial' | 'unavailable';
  reasons: ('cluster_unreadable' | 'cluster_limit_possible')[];
}
const unavailable = (reason: EksIpResolution['reasons'][number] = 'cluster_unreadable'): EksIpResolution =>
  ({ map: {}, blockedScopes: [], coveredRegions: [], globalUnknown: true, status: 'unavailable', reasons: [reason] });
type Cluster = { name: string; access?: string; region?: string; vpcId?: string };
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const optionalStrings = (row: Record<string, unknown>, keys: string[]) =>
  keys.every(key => row[key] == null || typeof row[key] === 'string');

// Endpoints describes Service membership, not cluster ownership. Only an independently listed,
// unique pod in a known active phase can establish ownership; conflicting references also
// disqualify the pod fallback. PodRow.status is the normalized Kubernetes status.phase.
export async function fetchEksIpMap(signal?: AbortSignal): Promise<EksIpResolution> {
  const candidates = new Map<string, Resolution | null>();
  const blockedScopes = new Set<string>();
  let coveredRegions: string[] = [];
  try {
    if (signal?.aborted) return unavailable();
    const response = await fetch('/api/eks', { signal });
    const list = response.ok ? await response.json() : null;
    if (signal?.aborted || list?.error || list?.status === 'error' || !Array.isArray(list?.clusters)) return unavailable();
    if (!list.clusters.every((c: unknown) => isRecord(c) && nonempty(c.name) && nonempty(c.access))) return unavailable();
    // The current API returns at most 25 descriptors and reports truncation.
    if (list.truncated === true || (list.truncated !== false && list.clusters.length >= 25)) return unavailable('cluster_limit_possible');
    const clusters = list.clusters as Cluster[];
    if (clusters.some(c => ![c.name, c.region, c.vpcId].every(nonempty))) return unavailable();
    coveredRegions = nonempty(list.region) ? [list.region] : [...new Set(clusters.map(c => c.region!))];
    if (!coveredRegions.length || clusters.some(c => !coveredRegions.includes(c.region!))) return unavailable();
    await Promise.all(clusters.map(async cluster => {
      const scope = scopedTargetIp(cluster.region!, cluster.vpcId!, '');
      if (cluster.access !== 'connected') { blockedScopes.add(scope); return; }
      const get = async (kind: string) => {
        try {
          if (signal?.aborted) return null;
          const r = await fetch(`/api/eks/${encodeURIComponent(cluster.name)}/incluster?kind=${kind}`, { signal });
          const d = r.ok ? await r.json() : null;
          return !signal?.aborted && !d?.error && d?.status !== 'error' && Array.isArray(d?.rows) ? d.rows : null;
        } catch { return null; }
      };
      const [endpoints, pods]: [EndpointRow[] | null, PodRow[] | null] = await Promise.all([get('endpoints'), get('pods')]);
      // Missing reads cannot enumerate addresses to veto another cluster. Empty arrays can.
      if (!endpoints || !pods
        || !pods.every(row => isRecord(row) && typeof row.name === 'string' && typeof row.namespace === 'string'
          && optionalStrings(row, ['podIP', 'workload', 'status']))
        || !endpoints.every(row => isRecord(row) && typeof row.name === 'string' && typeof row.namespace === 'string'
          && Array.isArray(row.ips) && row.ips.every(nonempty)
          && Array.isArray(row.targets) && row.targets.every(target =>
            isRecord(target) && nonempty(target.ip) && optionalStrings(target, ['pod'])))) {
        blockedScopes.add(scope); return;
      }
      const podsByIp = new Map<string, PodRow[]>();
      for (const pod of pods ?? []) {
        if (pod.podIP && !isTerminalPodPhase(pod.status)) podsByIp.set(pod.podIP, [...(podsByIp.get(pod.podIP) ?? []), pod]);
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
        const services = (servicesByIp.get(ip) ?? [])
          .filter(service => service.targets.some(t => t.ip === ip && t.pod));
        // A manual non-pod backend is service context, not a competing Kubernetes owner.
        if (!matches.length && !services.length) continue;
        const corroborated = pod?.name && pod.namespace && ['Pending', 'Running'].includes(pod.status) && services.every(service =>
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
    // Unknown scope or enumeration failure can hide an owner anywhere in the account.
    return unavailable();
  }
  if (signal?.aborted) return unavailable();
  const map = Object.fromEntries([...candidates].map(([key, value]) =>
    [key, blockedScopes.has(key.slice(0, key.lastIndexOf('|') + 1)) ? null : value]));
  return { map, blockedScopes: [...blockedScopes].sort(), coveredRegions, globalUnknown: false, status: blockedScopes.size ? Object.values(map).some(Boolean) ? 'partial' : 'unavailable'
    : candidates.size ? 'ok' : 'empty', reasons: blockedScopes.size ? ['cluster_unreadable'] : [] };
}
