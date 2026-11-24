import { podBindings } from './service-topology/adapters';
import type { Binding } from './service-topology/types';
import { scopedTargetIp, type FlowInput } from './flow-topology';
import type { EndpointRow } from './eks-incluster';
import { isTerminalPodPhase, type PodRow } from './eks-resources';

type Resolution = NonNullable<FlowInput['ipResolved']>[string];
export interface EksIpResolution {
  bindings?: Binding[];
  /** `partial`: bindings in blocked region|vpc scopes were dropped (`binding_scope_blocked`, `blockedClusters` = listed ids). */
  bindingRead?: { status: 'ok' | 'empty' | 'partial' | 'withheld'; reasons: string[]; blockedClusters?: string[] };
  map: NonNullable<FlowInput['ipResolved']>;
  blockedScopes: string[];
  coveredRegions: string[];
  /** Scoped listings only: `account|region` pairs proven enumerated. Host rows also key as `self`. */
  coveredAccountRegions?: string[];
  globalUnknown: boolean;
  notConnected?: number;
  status: 'ok' | 'empty' | 'partial' | 'unavailable';
  reasons: ('cluster_unreadable' | 'cluster_limit_possible' | 'cluster_not_connected')[];
}
const unavailable = (reason: EksIpResolution['reasons'][number] = 'cluster_unreadable'): EksIpResolution =>
  ({ map: {}, blockedScopes: [], coveredRegions: [], globalUnknown: true, status: 'unavailable', reasons: [reason] });
type Cluster = { id?: string; name: string; arn?: string; accountId?: string; access?: string; region?: string; vpcId?: string };
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const validRegion = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9-]{1,64}$/.test(value);
const SCOPE_KEYS = ['accounts', 'regions', 'includeGlobal'] as const;
/** Only the listing scope keys reach /api/eks; anything else in the page scope is dropped. */
function eksListUrl(scopeQuery: string): string {
  const source = new URLSearchParams(scopeQuery), query = new URLSearchParams();
  for (const key of SCOPE_KEYS) { const value = source.get(key); if (value !== null) query.set(key, value); }
  return query.size ? `/api/eks?${query}` : '/api/eks';
}
// A multi-target listing answers 200 with surviving clusters plus per-target `errors` that carry
// a `reason`. Survivors cannot certify their regions, so only the reason-less all-region
// discovery note (getEksScope) is tolerated, and it still withholds bindings.
const discoveryNote = (entry: unknown) => isRecord(entry) && entry.reason === undefined && entry.region === '__all__';
const optionalStrings = (row: Record<string, unknown>, keys: string[]) =>
  keys.every(key => row[key] == null || typeof row[key] === 'string');

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
// unique pod in a known active phase can establish ownership; conflicting references also
// disqualify the pod fallback. PodRow.status is the normalized Kubernetes status.phase.
//
// `scopeQuery` (the page inventory scope) widens the listing to the selected member accounts and
// regions; without it the server lists host clusters in the deployment region only. An array issues one
// scoped listing per entry: the site view (deriveEksScope in components/topology/useSiteFlowData.ts) passes
// one entry per account with only that account's regions, for explicit page regions and all-region pages
// alike, so a region one account lacks never 403s another and each request stays under the server's
// 12-target cap. Every sub-listing is validated on its own and computes its own coverage with its own
// `accounts`; any failed, errored or truncated sub-listing fails the whole read. The cluster lists are concatenated (deduped by ARN) BEFORE
// the candidate loop, so duplicate-IP vetoes and blocked scopes apply across accounts.
//
// Blocked scopes (a not-connected or unreadable cluster's region|vpc) null that scope's map entries. In scoped
// mode they drop only the bindings observed in that scope: `bindingRead` is then `partial` with
// `binding_scope_blocked` and the blocked cluster ids. The unscoped default path withholds every binding
// (`binding_read_incomplete`), as before. Every other binding gap withholds all bindings in both modes.
type ListedCluster = Cluster & { ref: string };
type Listing = { clusters: ListedCluster[]; regions: string[]; keys: string[] | null; hasErrors: boolean; partial: boolean };
async function readListing(scopeQuery: string, signal: AbortSignal | undefined): Promise<Listing | { fail: EksIpResolution['reasons'][number] | undefined }> {
  const listUrl = eksListUrl(scopeQuery), scoped = listUrl !== '/api/eks';
  const response = await fetch(listUrl, { signal });
  const list = response.ok ? await response.json() : null;
  if (signal?.aborted || list?.error || list?.status === 'error' || !Array.isArray(list?.clusters)) return { fail: undefined };
  if (!list.clusters.every((c: unknown) => isRecord(c) && nonempty(c.name) && nonempty(c.access))) return { fail: undefined };
  // The current API returns at most 25 descriptors and reports truncation.
  if (list.truncated === true || (list.truncated !== undefined && typeof list.truncated !== 'boolean')
    || (list.truncated !== false && list.clusters.length >= 25)) return { fail: 'cluster_limit_possible' };
  const clusters = list.clusters as Cluster[];
  let hasErrors = false, partial = false;
  if (scoped) {
    if (list.errors !== undefined && (!Array.isArray(list.errors) || !list.errors.every(discoveryNote))) return { fail: undefined };
    if (list.status === 'partial') hasErrors = true;
    if (Array.isArray(list.errors) && list.errors.length) partial = true;
    // Member and non-default-region rows are addressed by their listed id (full ARN); a bare
    // name would be read as a host deployment-region cluster, so scoped rows require it. The
    // account keys per-account coverage below.
    if (!clusters.every(c => nonempty(c.id) && typeof c.accountId === 'string' && /^(?:self|\d{12})$/.test(c.accountId))) return { fail: undefined };
  } else {
    hasErrors = list.status === 'partial' || (list.errors !== undefined && (!Array.isArray(list.errors) || list.errors.length > 0));
  }
  if (clusters.some(c => ![c.name, c.region, c.vpcId].every(nonempty))) return { fail: undefined };
  if ((list.region !== undefined && !validRegion(list.region)) || clusters.some(c => !validRegion(c.region))) return { fail: undefined };
  const regions: string[] = nonempty(list.region) ? [list.region] : [...new Set(clusters.map(c => c.region!))];
  if (!regions.length || clusters.some(c => !regions.includes(c.region!))) return { fail: undefined };
  let keys: string[] | null = null;
  if (scoped) {
    // A region is enumerated per account: one account's clusters prove nothing about another
    // account's listing there. Without an error or truncation, a returned row proves its
    // account|region target was listed; a single-target listing also proves its own target
    // when empty. Host inventory rows are keyed `self`; the listing reports the host's numeric
    // id, recognizable only on bare-id (host deployment-region) rows or a self-only scope.
    // Host clusters elsewhere then stay unproven for `self` rows (fail closed).
    const accounts = new URLSearchParams(scopeQuery).get('accounts') ?? 'self';
    const hostIds = new Set(['self', ...clusters.filter(c => accounts === 'self' || !c.id!.startsWith('arn:'))
      .map(c => c.accountId!)]);
    const set = new Set(clusters.flatMap(c => [`${c.accountId}|${c.region}`,
      ...(hostIds.has(c.accountId!) ? [`self|${c.region}`] : [])]));
    if (nonempty(list.region) && accounts !== '__all__' && !accounts.includes(',')) set.add(`${accounts}|${list.region}`);
    keys = [...set];
  }
  return { clusters: clusters.map(c => ({ ...c, ref: scoped ? c.id! : c.name })), regions, keys, hasErrors, partial };
}

export async function fetchEksIpMap(signal?: AbortSignal, includeBindings = false, scopeQuery: string | string[] = ''): Promise<EksIpResolution> {
  const fail = (reason?: EksIpResolution['reasons'][number]): EksIpResolution => ({
    ...unavailable(reason), ...(includeBindings ? {bindingRead:{status:'withheld' as const,reasons:[reason ?? 'cluster_unreadable']}} : {}),
  });
  const candidates = new Map<string, Resolution | null>();
  const blockedScopes = new Set<string>();
  const blockedClusters = new Set<string>();
  const reasons = new Set<EksIpResolution['reasons'][number]>();
  let coveredRegions: string[] = [];
  let coveredAccountRegions: string[] = [];
  let notConnected = 0;
  const bindings: Binding[] = [];
  const bindingGaps = new Set<string>();
  let listHasErrors = false, scopePartial = false, scoped = false;
  const queries = Array.isArray(scopeQuery) ? scopeQuery : [scopeQuery];
  try {
    if (signal?.aborted || !queries.length) return fail();
    const listings = await Promise.all(queries.map(q => readListing(q, signal)));
    const clusters: ListedCluster[] = [];
    const seenClusters = new Set<string>();
    const keys = new Set<string>();
    for (const listing of listings) {
      if ('fail' in listing) return fail(listing.fail);
      listHasErrors ||= listing.hasErrors;
      scopePartial ||= listing.partial;
      if (listing.keys) { scoped = true; listing.keys.forEach(k => keys.add(k)); }
      for (const region of listing.regions) if (!coveredRegions.includes(region)) coveredRegions.push(region);
      for (const c of listing.clusters) {
        const identity = c.arn ?? `${c.accountId ?? ''}|${c.region}|${c.name}`;
        if (!seenClusters.has(identity)) { seenClusters.add(identity); clusters.push(c); }
      }
    }
    if (signal?.aborted) return fail();
    coveredAccountRegions = [...keys].sort();
    await Promise.all(clusters.map(async cluster => {
      const scope = scopedTargetIp(cluster.region!, cluster.vpcId!, '');
      if (cluster.access !== 'connected') {
        if (cluster.access === 'entry-only' || cluster.access === 'no-entry') {
          notConnected++; reasons.add('cluster_not_connected');
        } else reasons.add('cluster_unreadable');
        blockedScopes.add(scope); blockedClusters.add(cluster.ref); return;
      }
      let podReadAt: number | null = null;
      const get = async (kind: string) => {
        try {
          if (signal?.aborted) return null;
          const r = await fetch(`/api/eks/${encodeURIComponent(cluster.ref)}/incluster?kind=${kind}`, { signal });
          const d = r.ok ? await r.json() : null;
          if (kind === 'pods' && typeof d?.generatedAt === 'string' && Number.isFinite(Date.parse(d.generatedAt))) podReadAt = Date.parse(d.generatedAt);
          if (includeBindings && (d?.status === 'partial' || d?.truncated === true)) bindingGaps.add('binding_read_incomplete');
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
        blockedScopes.add(scope); blockedClusters.add(cluster.ref); reasons.add('cluster_unreadable'); return;
      }
      const capturedAt: number | null = podReadAt;
      if (includeBindings && capturedAt === null) bindingGaps.add('binding_clock_unknown');
      const validBindingRows = !includeBindings || pods.every(row => nonempty(row.uid) &&
        (row.hostNetwork == null || typeof row.hostNetwork === 'boolean') &&
        (row.podIPs == null || (Array.isArray(row.podIPs) && row.podIPs.every(nonempty))));
      if (!validBindingRows) bindingGaps.add('binding_rows_invalid');
      const clusterRef = cluster.arn && /^arn:aws(?:-[a-z0-9-]+)?:eks:([a-z0-9-]+):(\d{12}):cluster\/([\w-]+)$/.exec(cluster.arn);
      if (includeBindings && cluster.arn && cluster.accountId && clusterRef && clusterRef[1] === cluster.region &&
          clusterRef[2] === cluster.accountId && clusterRef[3] === cluster.name) {
        if (capturedAt !== null && validBindingRows) {
          const records = podBindings(pods, cluster.arn, {
          account: cluster.accountId, region: cluster.region!, vpc: cluster.vpcId!, id: cluster.arn,
          // Point-in-time server read. Earlier flow windows can only use this as context.
          status: 'ok', complete: true, stale: false, retained: false, capturedAt, window: {start: capturedAt,end: capturedAt},
        });
        if (records.length + bindings.length > 10000) bindingGaps.add('binding_limit');
        else bindings.push(...records);
        }
      } else if (includeBindings) bindingGaps.add('binding_authority_unverified');
      const podsByIp = new Map<string, PodRow[]>();
      for (const pod of pods ?? []) {
        if (pod.podIP && !isTerminalPodPhase(pod.status)) {
          const seen = podsByIp.get(pod.podIP);
          if (seen) seen.push(pod); else podsByIp.set(pod.podIP, [pod]);
        }
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
    return fail();
  }
  if (signal?.aborted) return fail();
  const map = Object.fromEntries([...candidates].map(([key, value]) =>
    [key, blockedScopes.has(key.slice(0, key.lastIndexOf('|') + 1)) ? null : value]));
  // The unscoped default path keeps its contract: any blocked scope withholds every binding.
  if (listHasErrors || (!scoped && blockedScopes.size)) bindingGaps.add('binding_read_incomplete');
  // Reason-less all-region discovery note: listed targets are sound, unlisted regions unknown.
  if (scopePartial) bindingGaps.add('binding_scope_partial');
  // A blocked region|vpc (not-connected or unreadable cluster) cannot veto its IPs: drop only the bindings
  // observed there; the map already nulls that scope, so its targets stay unresolved (eksScopes).
  const blockedBinding = (b: Binding) => !b.region || !b.vpc || blockedScopes.has(scopedTargetIp(b.region, b.vpc, ''));
  const usableBindings = includeBindings && !bindingGaps.size ? bindings.filter(b => !blockedBinding(b)).map(b => {
    const proof = b.region && b.vpc ? map[scopedTargetIp(b.region, b.vpc, b.ip)] : null;
    const namespace = proof?.meta?.namespace, name = proof?.meta?.pod;
    return nonempty(namespace) && nonempty(name) && b.label === namespace + '/' + name
      ? b : { ...b, confidence: 'context' as const };
  }) : [];
  const blocked = !bindingGaps.size && blockedScopes.size > 0;
  return { map, ...(includeBindings ? {
    ...(!bindingGaps.size ? { bindings: usableBindings } : {}),
    bindingRead: bindingGaps.size ? { status: 'withheld' as const, reasons: [...bindingGaps].sort() }
      : blocked ? { status: 'partial' as const, reasons: ['binding_scope_blocked'], blockedClusters: [...blockedClusters].sort() }
      : { status: usableBindings.length ? 'ok' as const : 'empty' as const, reasons: [] },
  } : {}), ...(notConnected ? { notConnected } : {}), blockedScopes: [...blockedScopes].sort(), coveredRegions,
    ...(scoped ? { coveredAccountRegions } : {}), globalUnknown: false, status: blockedScopes.size ? Object.values(map).some(Boolean) ? 'partial' : 'unavailable'
    : candidates.size ? 'ok' : 'empty', reasons: [...reasons].sort() };
}

/** Compatibility evidence view; the typed resolution remains the source of ownership guards. */
export interface EksIpEvidence {
  ipResolved: NonNullable<FlowInput['ipResolved']>;
  status: 'ok' | 'partial' | 'failed';
  region: string | null;
  notConnected: number;
}
export async function fetchEksIpEvidence(signal?: AbortSignal): Promise<EksIpEvidence> {
  const result = await fetchEksIpMap(signal);
  return { ipResolved: result.map, status: result.globalUnknown ? 'failed' : result.blockedScopes.length ? 'partial' : 'ok',
    region: result.coveredRegions[0] ?? null, notConnected: result.notConnected ?? 0 };
}
