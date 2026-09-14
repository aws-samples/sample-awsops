import { scopedTargetIp, type FlowInput } from './flow-topology';
import type { EndpointRow } from './eks-incluster';
import { isTerminalPodPhase, type PodRow } from './eks-resources';

type Resolution = NonNullable<FlowInput['ipResolved']>[string];
type Cluster = { name: string; access?: string; region?: string; vpcId?: string };

export type AggregateRunStatus = 'succeeded' | 'running' | 'partial' | 'failed' | 'unknown';

export interface InventoryEvidence {
  capturedAt: string | null;
  capturedThrough: string | null;
  unknownCapture: boolean;
  aggregateStatus: AggregateRunStatus;
}

const validTime = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));

/** Row captures are scoped; the self-keyed run ledger describes an aggregate account sweep. */
export function inventoryEvidence(
  rows: { captured_at?: unknown }[],
  run: { status?: unknown; last_success_at?: unknown } | null | undefined,
  host: boolean,
): InventoryEvidence {
  const times = rows.map(row => row.captured_at).filter(validTime);
  const lastSuccess = host && validTime(run?.last_success_at) ? run.last_success_at : null;
  // Retained row captures take precedence over a newer success or failed attempt.
  // Missing captures may fall back to host last-success evidence, never finished_at.
  if (times.length < rows.length && lastSuccess) times.push(lastSuccess);
  if (rows.length === 0 && lastSuccess) times.push(lastSuccess);
  times.sort((a, b) => Date.parse(a) - Date.parse(b));
  return {
    capturedAt: times[0] ?? null,
    capturedThrough: times[times.length - 1] ?? null,
    unknownCapture: rows.some(row => !validTime(row.captured_at)) || times.length === 0,
    aggregateStatus: typeof run?.status === 'string'
      && ['succeeded', 'running', 'partial', 'failed'].includes(run.status) ? run.status as AggregateRunStatus : 'unknown',
  };
}

// Endpoints describes Service membership, not cluster ownership. Only an independently listed,
// unique pod can establish ownership; conflicting references also disqualify the pod fallback.
export interface EksIpEvidence {
  ipResolved: NonNullable<FlowInput['ipResolved']>;
  status: 'ok' | 'partial' | 'failed';
}

export async function fetchEksIpEvidence(signal?: AbortSignal): Promise<EksIpEvidence> {
  const candidates = new Map<string, Resolution | null>();
  let degraded = false;
  try {
    const response = await fetch('/api/eks', { signal });
    const list = response.ok ? await response.json() : null;
    if (signal?.aborted || list?.error || !Array.isArray(list?.clusters)) {
      return { ipResolved: {}, status: 'failed' };
    }
    degraded = list.truncated === true || (list.truncated !== undefined && typeof list.truncated !== 'boolean');
    await Promise.all((list.clusters as Cluster[]).filter(c => {
      const usable = c && c.access === 'connected' && typeof c.name === 'string' && c.name
        && typeof c.region === 'string' && c.region && typeof c.vpcId === 'string' && c.vpcId;
      if (!usable) degraded = true;
      return usable;
    }).map(async cluster => {
      const get = async (kind: string) => {
        try {
          const r = await fetch(`/api/eks/${encodeURIComponent(cluster.name)}/incluster?kind=${kind}`, { signal });
          const d = r.ok ? await r.json() : null;
          if (!d?.error && d?.status !== 'error' && Array.isArray(d?.rows)) return d.rows;
          degraded = true;
          return [];
        } catch { degraded = true; return []; }
      };
      const [endpoints, pods]: [EndpointRow[], PodRow[]] = await Promise.all([get('endpoints'), get('pods')]);
      const podsByIp = new Map<string, PodRow[]>();
      for (const pod of pods) {
        if (isTerminalPodPhase(pod.status)) continue;
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
        // Ambiguous/uncorroborated IPs are ordinary non-evidence, not failed collection.
        // An IP seen in two clusters in the same network scope is never last-wins, even if their
        // workload labels coincide. Unproven records block ownership rather than asserting it.
        candidates.set(key, candidates.has(key) ? null : resolution);
      }
    }));
  } catch { return { ipResolved: {}, status: 'failed' }; }
  return {
    ipResolved: Object.fromEntries([...candidates].filter((entry): entry is [string, Resolution] => entry[1] !== null)),
    status: degraded ? 'partial' : 'ok',
  };
}

/** Compatibility API for callers that only consume the corroborated map. */
export async function fetchEksIpMap(signal?: AbortSignal): Promise<NonNullable<FlowInput['ipResolved']>> {
  return (await fetchEksIpEvidence(signal)).ipResolved;
}
