// Service Resources join (gap L229, v1 '/k8s chart' tab parity): per-Service CPU/Memory
// REQUEST footprint from its selector-matched RUNNING pods. Pure — unit-tested, consumed by
// FleetKindPage's services block.
import type { ServiceRow } from './eks-incluster';
import type { PodRow } from './eks-resources';

export interface ServiceResourceRow {
  /** cluster/namespace/name — same-name services in different namespaces/clusters must not merge. */
  key: string;
  name: string; namespace: string; cluster: string;
  pods: number;          // matched RUNNING pods
  cpuMillicores: number; // Σ cpuRequest (cores) × 1000, rounded
  memMiB: number;        // Σ memRequest (MiB), rounded
}

/** Every selector key/value must match the pod's labels (K8s equality-selector semantics). */
export function selectorMatches(selector: Record<string, string>, labels?: Record<string, string>): boolean {
  if (!labels) return false;
  return Object.entries(selector).every(
    ([k, v]) => Object.prototype.hasOwnProperty.call(labels, k) && labels[k] === v,
  );
}

/**
 * Join services to their running pods per (cluster, namespace). v1 semantics:
 * - only Running pods count (a Pending/Failed pod's requests are not a running footprint);
 * - a selectorless Service (ExternalName / manual Endpoints) joins nothing;
 * - services with ZERO matched running pods are EXCLUDED, not charted as 0 — absence of a
 *   footprint is not a zero-footprint claim (callers disclose the exclusion in a caption).
 * Values are REQUESTS (scheduler reservations), not live usage — v1 parity, disclosed by
 * the chart captions.
 */
export function serviceResources(
  services: (ServiceRow & { cluster: string })[],
  pods: (PodRow & { cluster: string })[],
): ServiceResourceRow[] {
  // index pods per (cluster, namespace) so the match loop is not services × all-pods
  const byNs = new Map<string, (PodRow & { cluster: string })[]>();
  for (const p of pods) {
    if (p.status !== 'Running') continue;
    const k = `${p.cluster}/${p.namespace}`;
    (byNs.get(k) ?? byNs.set(k, []).get(k)!).push(p);
  }
  const out: ServiceResourceRow[] = [];
  for (const s of services) {
    if (!s.selector) continue;
    const candidates = byNs.get(`${s.cluster}/${s.namespace}`) ?? [];
    const matched = candidates.filter((p) => selectorMatches(s.selector!, p.labels));
    if (matched.length === 0) continue;
    out.push({
      key: `${s.cluster}/${s.namespace}/${s.name}`,
      name: s.name, namespace: s.namespace, cluster: s.cluster,
      pods: matched.length,
      cpuMillicores: Math.round(matched.reduce((sum, p) => sum + p.cpuRequest, 0) * 1000),
      memMiB: Math.round(matched.reduce((sum, p) => sum + p.memRequest, 0)),
    });
  }
  return out;
}

/** Top-N by a numeric field, descending, deterministic key tie-break (chip/churn stability). */
export function topServiceResources(
  rows: ServiceResourceRow[],
  field: 'cpuMillicores' | 'memMiB',
  n = 15,
): ServiceResourceRow[] {
  return [...rows]
    .sort((a, b) => (b[field] - a[field]) || a.key.localeCompare(b.key))
    .slice(0, n);
}
