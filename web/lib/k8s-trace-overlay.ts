// Trace overlay for the K8s service graph (client-safe: same-origin fetch, no AWS/DB imports).
// Reads the published service snapshot (`GET /api/topology?lens=service`) and reduces it to
// workload-level calls for ONE selected cluster. Never-misattribute rules:
//  - `k8s.cluster.name` (entity `cluster`) is a telemetry claim, not authority: the join runs only
//    when the selected cluster's name occurs exactly once among the FLEET-WIDE cluster listing (all
//    registered accounts and regions, as K8sMapView fetches it), and only when that listing is
//    complete — `listingIncomplete` must be set when it was truncated, errored or failed, since an
//    incomplete listing cannot prove that no same-named cluster exists. Callers must not pass a
//    scope-filtered listing: a narrowed scope hides same-named clusters without any truncation or
//    error flag.
//  - The trace snapshot is host-only (`account=self`); member clusters are refused without a fetch.
//  - A trace service maps to a K8s workload ONLY through its `runs_on` relation, and only when it
//    runs on exactly one `ns/deployment` in the selected cluster. Never by service-name similarity.
//  - An incomplete read (anything omitted by the route's page/edge caps) cannot prove that a service
//    runs on only one workload, so it yields no calls — only the omitted count is disclosed.
//  - A partial publication (a gap other than the two baseline gaps, or a stale/retained/capped source,
//    one without a generation, or one whose status is not 'ok'/'empty'; missing `gaps`/`sources` count
//    as partial) may have dropped a second `runs_on` relation, so it also yields no calls
//    (`partial_snapshot`). The top-level `status` is NOT used: every healthy publication reads 'partial'
//    because the baseline gaps are always present.
//
// Snapshot contract (verified against the producers, not assumed):
// | Snapshot element           | Shape                                                        | Producer                                          |
// |----------------------------|--------------------------------------------------------------|---------------------------------------------------|
// | entity kind `service`      | label = service.name; cluster/namespace = k8s.cluster.name / | trace-graph.ts serviceNode → read-published.ts    |
// |                            | k8s.namespace.name claims                                    | (meta->>'cluster', meta->>'namespace')            |
// | entity kind `workload`     | label = `ns/deployment`; namespace = ns; cluster claim       | trace-graph.ts (k8sNamespace + k8sDeployment)     |
// | entity kind `db`           | label = `${system}:${host ?? 'unknown'}/${dbName}`;          | trace-graph.ts db node; published.ts drops hosts  |
// |                            | cluster/namespace null, no host field in the projection      | from Entity, so the host is parsed from the label |
// | relation `runs_on`         | service → workload (the join)                                | trace-graph.ts edge(sid, workload, 'runs_on')     |
// | relation `calls`           | service → service (also → runtime/model, ignored here)       | trace-graph.ts parent/child spans + metric calls  |
// | relation `queries`         | service → db                                                 | trace-graph.ts edge(sid, db, 'queries')           |
// | relation `hosts`/`linked`  | runtime → service / span links — not calls, ignored          | trace-graph.ts                                    |
// | relation `spanCount`       | optional per relation; no per-relation error count exists    | metrics.ts edgeCounts                             |
// | page                       | entities/relations visible on this page only (relations only | migration service_topology_read: 200 entities,    |
// |                            | between same-page entities), `omitted` {entities,relations}, | 400 relations per page; cursor > 0 requires the   |
// |                            | `nextCursor`, `snapshotId`                                   | pinned `snapshot` id (route.ts)                   |
import type { Entity, Relation } from './service-topology/snapshot';
import type { WorkloadRef } from './eks-db-refs';
import { eksClusterName, parseEksClusterId } from './eks-cluster-id';
import { extractManagedDbHosts } from './db-endpoint';

export type TraceOverlayReason =
  | 'disabled' | 'unsupported_scope' | 'unavailable' | 'ambiguous_cluster' | 'member_cluster' | 'incomplete_listing'
  | 'partial_snapshot';
export interface TraceWorkloadCall {
  fromWorkload: WorkloadRef;
  to: { workload: WorkloadRef } | { datastoreHost: string };
  spanCount?: number;
  errors?: number;
}
export interface TraceOverlay {
  available: boolean;
  reason?: TraceOverlayReason;
  workloadCalls: TraceWorkloadCall[];
  /** Snapshot entities + relations the overlay could not inspect (page/edge caps). */
  omitted: number;
  /** In-cluster trace calls that could not be mapped to exactly one workload / managed datastore host. */
  skipped?: number;
}
/** One `/api/topology?lens=service` response page (only the fields the overlay reads). */
export interface ServiceTopologyView {
  status?: string;
  snapshotId: string | null;
  entities: Entity[];
  relations: Relation[];
  nextCursor?: number | null;
  omitted?: { entities: number; relations: number };
  /** Publication read gaps; anything beyond BASELINE_SNAPSHOT_GAPS makes the snapshot partial. */
  gaps?: string[];
  /** Per-source publication state (see `partialSource`). */
  sources?: { sourceId?: string; generation?: string | null; status?: string; stale?: boolean; retained?: boolean; capped?: boolean }[];
}

/**
 * Gaps every healthy publication carries (seeded by service-topology/published.ts), so they do not make a
 * snapshot partial. Mirrors `partialInputs` in web/lib/service-topology/read-published.ts.
 */
export const BASELINE_SNAPSHOT_GAPS: readonly string[] = ['nfm:not_collected', 'kubernetes:live_ownership_unavailable'];
export interface TraceCluster {
  id: string;
  /** Names (or ids) of every cluster in the FLEET-WIDE listing (all registered accounts and regions, as
   *  K8sMapView fetches it); the selected name must occur exactly once. Never a scope-filtered listing:
   *  a narrowed scope hides same-named clusters without any truncation or error flag. */
  registeredNames: string[];
  /** The fleet listing was truncated, errored or failed: uniqueness is unprovable, so no join. */
  listingIncomplete?: boolean;
  /** Host account id. An ARN id is a host cluster only when its account equals this; otherwise member. */
  hostAccountId?: string;
}

const MAX_PAGES = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const K8S_NAME = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;

const unavailable = (reason: TraceOverlayReason): TraceOverlay => ({ available: false, reason, workloadCalls: [], omitted: 0 });
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Scope gate shared by build and fetch: the selected cluster name, or the refusal. */
function clusterGate(cluster: TraceCluster): { name: string } | { refuse: TraceOverlay } {
  const parsed = typeof cluster?.id === 'string' ? parseEksClusterId(cluster.id) : null;
  if (!parsed) return { refuse: unavailable('unavailable') };
  if (parsed.accountId && !(/^\d{12}$/.test(cluster.hostAccountId ?? '') && parsed.accountId === cluster.hostAccountId))
    return { refuse: unavailable('member_cluster') };
  if (cluster.listingIncomplete) return { refuse: unavailable('incomplete_listing') };
  const names = Array.isArray(cluster.registeredNames) ? cluster.registeredNames : [];
  if (names.filter((n) => typeof n === 'string' && eksClusterName(n) === parsed.name).length !== 1)
    return { refuse: unavailable('ambiguous_cluster') };
  return { name: parsed.name };
}

/** `system:host[:port]/dbName` → the managed datastore host, or null (self-hosted, unknown, malformed). */
function dbLabelHost(label: string): string | null {
  const colon = label.indexOf(':');
  if (colon < 0) return null;
  const rest = label.slice(colon + 1);
  const slash = rest.indexOf('/');
  const segment = (slash < 0 ? rest : rest.slice(0, slash)).toLowerCase();
  const found = extractManagedDbHosts(segment);
  if (found.length !== 1) return null;
  const host = found[0].host;
  const port = segment.startsWith(`${host}:`) ? segment.slice(host.length + 1) : null;
  return segment === host || (port !== null && /^\d{1,5}$/.test(port)) ? host : null;
}

/** `ns/deployment` label that agrees with the entity namespace → WorkloadRef. */
function workloadRef(e: Entity): WorkloadRef | null {
  const parts = e.label.split('/');
  if (parts.length !== 2 || parts[0] !== e.namespace || !K8S_NAME.test(parts[0]) || !K8S_NAME.test(parts[1])) return null;
  return { namespace: parts[0], name: parts[1] };
}

export function buildTraceOverlay(pages: ServiceTopologyView[], cluster: TraceCluster): TraceOverlay {
  const gate = clusterGate(cluster);
  if ('refuse' in gate) return gate.refuse;
  if (!Array.isArray(pages) || pages.length === 0) return unavailable('unavailable');
  const snapshotId = pages[0].snapshotId;
  if (pages.some((p) => p.snapshotId !== snapshotId)) return unavailable('unavailable');
  // A partial publication cannot prove the "exactly one workload" join (a capped source may have dropped
  // a second runs_on relation), so it yields no calls. Same rule as read-published.ts `partialInputs`;
  // missing gaps/sources fail closed.
  const partialSource = (s: NonNullable<ServiceTopologyView['sources']>[number]) =>
    !!s.stale || !!s.retained || !!s.capped || !s.generation || !['ok', 'empty'].includes(s.status ?? '');
  const partialPage = (p: ServiceTopologyView) =>
    !Array.isArray(p.gaps) || !Array.isArray(p.sources)
    || p.gaps.some((g) => !BASELINE_SNAPSHOT_GAPS.includes(g)) || p.sources.some(partialSource);
  if (pages.some(partialPage)) return unavailable('partial_snapshot');

  const entities = new Map<string, Entity>();
  const relations = new Map<string, Relation>();
  for (const p of pages) {
    for (const e of p.entities) entities.set(e.id, e);
    for (const r of p.relations) relations.set(r.id, r);
  }
  // `omitted` on a page counts eligible records not visible on THAT page, so the last page
  // gives the snapshot totals; anything not seen on any fetched page is omitted.
  const last = pages[pages.length - 1];
  const totalEntities = last.entities.length + (last.omitted?.entities ?? 0);
  const totalRelations = last.relations.length + (last.omitted?.relations ?? 0);
  const omitted = Math.max(0, totalEntities - entities.size) + Math.max(0, totalRelations - relations.size);
  if (omitted > 0) return { available: true, workloadCalls: [], omitted, skipped: 0 };

  const name = gate.name;
  const isTrace = (e: Entity | undefined) => !!e && e.layers.includes('trace');
  const inCluster = (e: Entity | undefined): e is Entity => isTrace(e) && e!.kind === 'service' && e!.cluster === name;

  // service entity id → distinct workload keys it runs on (any cluster; only an in-cluster one is usable).
  const runsOn = new Map<string, Map<string, WorkloadRef | null>>();
  for (const r of relations.values()) {
    if (r.kind !== 'runs_on' || r.layer !== 'trace') continue;
    const w = entities.get(r.target);
    if (!isTrace(w) || w!.kind !== 'workload') continue;
    const ref = w!.cluster === name ? workloadRef(w!) : null;
    const key = ref ? `${ref.namespace}/${ref.name}` : `invalid:${w!.id}`;
    const m = runsOn.get(r.source) ?? new Map<string, WorkloadRef | null>();
    m.set(key, ref);
    runsOn.set(r.source, m);
  }
  const workloadOf = (serviceId: string): WorkloadRef | null => {
    if (!inCluster(entities.get(serviceId))) return null;
    const m = runsOn.get(serviceId);
    return m && m.size === 1 ? [...m.values()][0] : null;
  };

  const calls = new Map<string, TraceWorkloadCall>();
  let skipped = 0;
  const add = (from: WorkloadRef, to: TraceWorkloadCall['to'], toKey: string, spanCount: number | undefined) => {
    const key = JSON.stringify([from.namespace, from.name, toKey]);
    const c = calls.get(key);
    if (!c) calls.set(key, { fromWorkload: from, to, ...(spanCount !== undefined ? { spanCount } : {}) });
    else if (spanCount !== undefined) c.spanCount = (c.spanCount ?? 0) + spanCount;
  };
  for (const r of relations.values()) {
    if (r.layer !== 'trace' || (r.kind !== 'calls' && r.kind !== 'queries')) continue;
    const src = entities.get(r.source), tgt = entities.get(r.target);
    const span = typeof r.spanCount === 'number' && Number.isSafeInteger(r.spanCount) && r.spanCount >= 0 ? r.spanCount : undefined;
    if (r.kind === 'calls') {
      if (!isTrace(src) || src!.kind !== 'service' || !isTrace(tgt) || tgt!.kind !== 'service') continue;
      if (!inCluster(src) && !inCluster(tgt)) continue;
      const from = workloadOf(r.source), to = workloadOf(r.target);
      if (!from || !to) { skipped++; continue; }
      add(from, { workload: to }, `w:${to.namespace}/${to.name}`, span);
    } else {
      if (!inCluster(src) || !isTrace(tgt) || tgt!.kind !== 'db') continue;
      const from = workloadOf(r.source), host = dbLabelHost(tgt!.label);
      if (!from || !host) { skipped++; continue; }
      add(from, { datastoreHost: host }, `d:${host}`, span);
    }
  }
  const workloadCalls = [...calls.entries()].sort(([a], [b]) => cmp(a, b)).map(([, c]) => c);
  return { available: true, workloadCalls, omitted: 0, skipped };
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
function validPage(body: unknown): ServiceTopologyView | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const o = b.omitted as Record<string, unknown> | undefined;
  if (typeof b.snapshotId !== 'string' || !UUID.test(b.snapshotId) || b.status === 'unavailable') return null;
  if (!Array.isArray(b.entities) || !Array.isArray(b.relations)) return null;
  if (!o || typeof o !== 'object' || !isCount(o.entities) || !isCount(o.relations)) return null;
  const okEntity = (e: unknown) => !!e && typeof e === 'object' && typeof (e as Entity).id === 'string'
    && typeof (e as Entity).kind === 'string' && typeof (e as Entity).label === 'string' && Array.isArray((e as Entity).layers);
  const okRelation = (r: unknown) => !!r && typeof r === 'object' && ['id', 'source', 'target', 'kind', 'layer']
    .every((k) => typeof (r as Record<string, unknown>)[k] === 'string');
  if (!b.entities.every(okEntity) || !b.relations.every(okRelation)) return null;
  if (b.nextCursor != null && !(isCount(b.nextCursor) && b.nextCursor > 0 && b.nextCursor <= 20000)) return null;
  if (b.gaps !== undefined && !(Array.isArray(b.gaps) && b.gaps.every((g) => typeof g === 'string'))) return null;
  const okSource = (s: unknown) => !!s && typeof s === 'object' && !Array.isArray(s)
    && ((s as { generation?: unknown }).generation === undefined || (s as { generation?: unknown }).generation === null
      || typeof (s as { generation?: unknown }).generation === 'string');
  if (b.sources !== undefined && !(Array.isArray(b.sources) && b.sources.every(okSource))) return null;
  return body as ServiceTopologyView;
}

/** Fetch up to 5 pages of the pinned service snapshot. Never throws; refusals never fetch. */
export async function fetchTraceOverlay(cluster: TraceCluster, signal?: AbortSignal): Promise<TraceOverlay> {
  try {
    const gate = clusterGate(cluster);
    if ('refuse' in gate) return gate.refuse;
    const pages: ServiceTopologyView[] = [];
    let url = '/api/topology?lens=service';
    for (let i = 0; i < MAX_PAGES; i++) {
      // Same-origin fetch: the browser attaches the session cookie; no headers are set here.
      const res = await fetch(url, signal ? { signal } : {});
      if (res.status === 404) return unavailable('disabled');
      if (res.status === 422) return unavailable('unsupported_scope');
      if (!res.ok) return unavailable('unavailable');
      const p = validPage(await res.json());
      if (!p || (pages.length > 0 && p.snapshotId !== pages[0].snapshotId)) return unavailable('unavailable');
      pages.push(p);
      if (p.nextCursor == null) break;
      url = `/api/topology?lens=service&snapshot=${encodeURIComponent(p.snapshotId!)}&cursor=${p.nextCursor}`;
    }
    return buildTraceOverlay(pages, cluster);
  } catch {
    return unavailable('unavailable');
  }
}
