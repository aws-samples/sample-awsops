import { scopedTargetIp, type FlowInput } from './flow-topology';
import type { EndpointRow } from './eks-incluster';
import type { PodRow } from './eks-resources';

type Resolution = NonNullable<FlowInput['ipResolved']>[string];
type Cluster = { name: string; access?: string; region?: string; vpcId?: string };

// Endpoints describes Service membership, not cluster ownership. Only an independently listed,
// unique pod can establish ownership; conflicting references also disqualify the pod fallback.
export async function fetchEksIpMap(): Promise<NonNullable<FlowInput['ipResolved']>> {
  const candidates = new Map<string, Resolution | null>();
  try {
    const response = await fetch('/api/eks');
    const list = response.ok ? await response.json() : null;
    if (list?.error || !Array.isArray(list?.clusters)) return {};
    await Promise.all((list.clusters as Cluster[]).filter(c =>
      c.access === 'connected' && c.name && c.region && c.vpcId,
    ).map(async cluster => {
      const get = async (kind: string) => {
        try {
          const r = await fetch(`/api/eks/${encodeURIComponent(cluster.name)}/incluster?kind=${kind}`);
          const d = r.ok ? await r.json() : null;
          return !d?.error && Array.isArray(d?.rows) ? d.rows : [];
        } catch { return []; }
      };
      const [endpoints, pods]: [EndpointRow[], PodRow[]] = await Promise.all([get('endpoints'), get('pods')]);
      const podsByIp = new Map<string, PodRow[]>();
      for (const pod of pods) {
        if (pod.podIP) podsByIp.set(pod.podIP, [...(podsByIp.get(pod.podIP) ?? []), pod]);
      }
      const servicesByIp = new Map<string, EndpointRow[]>();
      for (const endpoint of endpoints) {
        for (const ip of new Set(endpoint.ips ?? [])) {
          servicesByIp.set(ip, [...(servicesByIp.get(ip) ?? []), endpoint]);
        }
      }
      for (const ip of new Set([...podsByIp.keys(), ...servicesByIp.keys()])) {
        const matches = podsByIp.get(ip) ?? [];
        const pod = matches.length === 1 ? matches[0] : undefined;
        const services = servicesByIp.get(ip) ?? [];
        const corroborated = pod?.name && pod.namespace && services.every(service =>
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
  } catch { /* no EKS ownership evidence */ }
  return Object.fromEntries([...candidates].filter((entry): entry is [string, Resolution] => entry[1] !== null));
}
