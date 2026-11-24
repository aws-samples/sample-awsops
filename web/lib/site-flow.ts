// Pure per-host site-flow composer (client-safe: no fetch, React, clock or server imports).
// Joins the front-door flow graph (flow-topology.ts), CloudFront cache behaviors, EKS pod bindings,
// trace workload calls and env/ConfigMap DB references into one SiteFlow for a single host:
//   DNS → CloudFront → behavior → origin → LB → TG → targets/workloads → traced services → datastores.
// Never-misattribute rules:
//  - A TG target becomes a workload only when EVERY member IP has exactly one observed pod binding
//    (region|VPC|IP) from qualified evidence (ok, complete, not stale or retained, window covering the
//    binding) naming that member's pod, all under one cluster ARN whose name matches the
//    flow's EKS resolution. Anything else stays a target and adds `pods_unresolved`.
//  - Trace/DB-ref inputs join by exact cluster ARN (Binding.authority), never by bare name. Two bound
//    ARNs sharing a cluster name refuse every trace join for both (`ambiguous_cluster`); the trace
//    snapshot's `k8s.cluster.name` claim cannot tell them apart.
//  - Trace calls attach only from workloads already in the flow (closure to a fixpoint), so no
//    orphan nodes appear. Partial/unavailable evidence yields a gap, never a silent empty result.
//  - Page→API inference is expressed only through `highlight.inferred`; edges keep their own evidence.
// Determinism: every output array is sorted by id (gaps by value); identical input → identical output.
import { filterFromEntry, type FlowEdge, type FlowGraph, type FlowKind, type FlowNode } from './flow-topology';
import { cloudFrontBehaviors, cloudFrontOrigins, type CfBehavior } from './cf-behaviors';
import { adjacency, computeHighlight, type BehaviorOrigin } from './site-flow-highlight';
import { extractManagedDbHosts } from './db-endpoint';
import { parseEksClusterId } from './eks-cluster-id';
import type { Binding } from './service-topology/types';
import { qualifyEvidence } from './service-topology/evidence';
import type { TraceOverlay, TraceOverlayReason } from './k8s-trace-overlay';
import type { DbRef, WorkloadRef } from './eks-db-refs';
import type { DbHostResolution, DbResource } from './db-ref-resolve';

export type SiteKind = 'dns' | 'cdn' | 'behavior' | 'origin' | 'lb' | 'rule' | 'tg' | 'target' | 'workload' | 'service' | 'datastore';
export type SiteEvidence = 'observed' | 'inferred' | 'configured' | 'traced';
export interface SiteNode {
  id: string; kind: SiteKind; label: string; group?: string; account?: string; region?: string;
  ref?: { flowNodeId?: string; cluster?: string; namespace?: string; workload?: string };
}
export interface SiteEdge { id: string; source: string; target: string; evidence: SiteEvidence; route?: string; calls?: number; errors?: number }
export interface SiteGroup { id: string; kind: 'host' | 'cdn' | 'lb' | 'cluster' | 'namespace' | 'datastore'; label: string; parent?: string }
export type SiteGap = 'inventory_incomplete' | 'pods_unresolved' | 'trace_unavailable' | 'ambiguous_cluster' | 'incomplete_listing'
  | 'partial_snapshot' | 'route_unavailable' | 'db_refs_partial' | 'host_not_found' | 'behaviors_unavailable' | 'route_ambiguous'
  | 'trace_unmapped' | 'private_zone_only' | 'rule_unresolved' | 'path_unmatched';
export interface SiteFlow {
  host: string;
  /** Normalized requested path (query/fragment stripped, leading '/'), or null. */
  path: string | null;
  nodes: SiteNode[]; edges: SiteEdge[]; groups: SiteGroup[];
  /** `inferred` = node/edge ids added only by page→API name inference (disjoint from nodes/edges). */
  highlight: { nodes: string[]; edges: string[]; inferred: string[] } | null;
  gaps: SiteGap[];
}
export interface SiteRoute { service: string; route: string; next?: { service: string; route?: string }[] }
export interface SiteFlowInput {
  host: string; path?: string; flow: FlowGraph; cloudfrontRows: Record<string, unknown>[]; bindings: Binding[];
  /** `cluster` = EKS cluster ARN (must equal Binding.authority). */
  traces: { cluster: string; overlay: TraceOverlay }[];
  dbRefs: { cluster: string; refs: DbRef[]; resolved: DbHostResolution; partial: boolean }[];
  routes?: SiteRoute[] | null;
  gaps?: SiteGap[];
}

type Row = Record<string, unknown>;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = <T extends { id: string }>(xs: Iterable<T>) => [...xs].sort((a, b) => cmp(a.id, b.id));
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const rowOf = (n: FlowNode): Row => (n.meta?.row && typeof n.meta.row === 'object' ? n.meta.row as Row : {});
/** Spread helper that omits empty values so output objects carry no `undefined` keys. */
const opt = <K extends string, V extends string | number>(k: K, v: V | undefined | null) =>
  (v === undefined || v === null || v === '' ? {} : { [k]: v }) as Partial<Record<K, V>>;

const KIND: Record<FlowKind, SiteKind> = {
  route53: 'dns', cloudfront: 'cdn', alb: 'lb', nlb: 'lb', apigw: 'lb', tg: 'tg', target: 'target', lambda: 'target',
  more: 'target', origin: 'origin', waf: 'rule',
};
const TRACE_GAP: Record<TraceOverlayReason, SiteGap> = {
  disabled: 'trace_unavailable', unsupported_scope: 'trace_unavailable', unavailable: 'trace_unavailable',
  partial_snapshot: 'partial_snapshot', ambiguous_cluster: 'ambiguous_cluster',
  incomplete_listing: 'incomplete_listing',
};
const EVIDENCE_RANK: Record<SiteEvidence, number> = { inferred: 0, configured: 1, observed: 2, traced: 3 };
const ROUTE_LABEL_CAP = 3;

/** Lowercase, trim, strip scheme/userinfo/path/query/port and trailing dots (Route53 spelling). */
export function normalizeHost(raw: string): string {
  return String(raw ?? '').trim().toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .split(/[/?#]/, 1)[0]
    .replace(/^[^@]*@/, '')
    .replace(/:\d*$/, '')
    .replace(/\.+$/, '');
}

/** CloudFront path semantics: case-sensitive, query/fragment ignored, leading '/' ensured. */
function normalizePath(raw: string | undefined): string | null {
  const p = String(raw ?? '').trim().split(/[?#]/, 1)[0];
  return p ? (p.startsWith('/') ? p : `/${p}`) : null;
}

/** Host names a flow node answers to: Route53 record name, CloudFront aliases, LB DNS name. */
function hostNames(n: FlowNode): string[] {
  if (n.kind === 'route53') return [str(rowOf(n).name) || n.label];
  if (n.kind === 'cloudfront') return Array.isArray(n.meta?.aliases) ? (n.meta.aliases as unknown[]).map(str) : [];
  if (n.kind === 'alb' || n.kind === 'nlb') return [str(rowOf(n).dns_name) || n.label];
  return [];
}

/** Normalized host → the flow nodes answering to it (built once per flow). */
function hostIndex(flow: FlowGraph): Map<string, FlowNode[]> {
  const index = new Map<string, FlowNode[]>();
  for (const n of flow.nodes) for (const h of new Set(hostNames(n).map(normalizeHost))) {
    if (h) (index.get(h) ?? index.set(h, []).get(h)!).push(n);
  }
  return index;
}

/** Same predicate as flow-topology's public Route53 resolution: only `private_zone === false` is public. */
const isPublicRecord = (n: FlowNode) => rowOf(n).private_zone === false;

/**
 * Rule 1: the first non-empty tier — Route53 records, else CloudFront aliases, else LB DNS names. Within the
 * Route53 tier, public-zone records win (split-horizon DNS); private/unknown-zone records are entries only when
 * no public record exists, and then `privateOnly` is set (the caller computes no highlight).
 */
function entriesOf(index: Map<string, FlowNode[]>, host: string): { ids: string[]; privateOnly: boolean } {
  const hits = host ? index.get(host) ?? [] : [];
  const ids = (ns: FlowNode[]) => ns.map((n) => n.id).sort(cmp);
  const records = hits.filter((n) => n.kind === 'route53');
  if (records.length) {
    const pub = records.filter(isPublicRecord);
    return pub.length ? { ids: ids(pub), privateOnly: false } : { ids: ids(records), privateOnly: true };
  }
  for (const tier of [['cloudfront'], ['alb', 'nlb']]) {
    const found = hits.filter((n) => tier.includes(n.kind));
    if (found.length) return { ids: ids(found), privateOnly: false };
  }
  return { ids: [], privateOnly: false };
}

/** Host index (inventory only): hops = nodes on the deepest shortest chain from any one of the host's entries. */
export function siteHosts(flow: FlowGraph): { host: string; hops: number }[] {
  const out = adjacency(flow.edges), index = hostIndex(flow);
  const hosts = new Map<string, number>();
  for (const host of index.keys()) {
    let hops = 0;
    for (const entry of entriesOf(index, host).ids) { // per entry: a CF alias entry must not shorten the Route53 chain
      const depth = new Map([[entry, 1]]), queue = [entry];
      while (queue.length) {
        const cur = queue.shift()!;
        for (const e of out.get(cur) ?? []) if (!depth.has(e.target)) { depth.set(e.target, depth.get(cur)! + 1); queue.push(e.target); }
      }
      hops = Math.max(hops, ...depth.values());
    }
    hosts.set(host, hops);
  }
  return [...hosts].map(([host, hops]) => ({ host, hops })).sort((a, b) => b.hops - a.hops || cmp(a.host, b.host));
}

/** The single cluster ARN that observed pod bindings prove for every member of an EKS target node, or null. */
function boundCluster(meta: Row, members: { id: string; pod?: string; namespace?: string; workload?: string }[], byIp: Map<string, Binding[]>): string | null {
  const ns = str(meta.namespace), wl = str(meta.workload);
  if (!ns || !wl || !members.length) return null;
  const arns = new Set<string>();
  for (const m of members) {
    // Each member's own owner-derived workload must be exactly the group's (no pod-name prefix guess: `api-canary`
    // pods are not `api`); a member without one (e.g. a legacy graph) cannot be proven.
    if (m.namespace !== ns || !m.pod || m.workload !== wl) return null;
    const hits = (byIp.get(m.id) ?? []).filter((b) => b.kind === 'pod' && b.region === meta.region && b.vpc === meta.vpcId);
    if (hits.length !== 1 || hits[0].confidence !== 'observed' || hits[0].label !== `${ns}/${m.pod}`) return null;
    // Only current, complete, ok source evidence (not stale or retained) proves the pod — as every binding consumer gates.
    const b = hits[0], authority = parseEksClusterId(b.authority);
    if (qualifyEvidence(b.evidence, { account: b.account, region: b.region, vpc: b.vpc }, b.window) !== 'qualified') return null;
    // The cluster ARN must live where the binding was observed (same account and region).
    if (authority?.accountId !== b.account || authority?.region !== b.region) return null;
    arns.add(hits[0].authority);
  }
  const [arn] = arns;
  const parsed = arns.size === 1 ? parseEksClusterId(arn) : null;
  return parsed?.accountId && parsed.name === str(meta.cluster) ? arn : null;
}

export function buildSiteFlow(input: SiteFlowInput): SiteFlow {
  const host = normalizeHost(input.host), path = normalizePath(input.path);
  const gaps = new Set<SiteGap>(input.gaps ?? []);
  const finish = (rest: Omit<SiteFlow, 'host' | 'path' | 'gaps'>): SiteFlow => ({ host, path, ...rest, gaps: [...gaps].sort(cmp) });
  const { ids: entries, privateOnly } = entriesOf(hostIndex(input.flow), host);
  if (privateOnly) gaps.add('private_zone_only');
  if (!entries.length) {
    gaps.add('host_not_found');
    return finish({ nodes: [], edges: [], groups: [], highlight: null });
  }

  // Rule 2: union of every entry's downstream subgraph.
  const keepN = new Map<string, FlowNode>(), keepE = new Map<string, FlowEdge>();
  for (const id of entries) {
    const sub = filterFromEntry(input.flow, id);
    for (const n of sub.nodes) keepN.set(n.id, n);
    for (const e of sub.edges) keepE.set(e.id, e);
  }

  const nodes = new Map<string, SiteNode>(), edges = new Map<string, SiteEdge>();
  const addNode = (n: SiteNode) => { if (!nodes.has(n.id)) nodes.set(n.id, n); };
  const addEdge = (source: string, target: string, evidence: SiteEvidence, extra: Partial<SiteEdge> = {}) => {
    if (source === target) return;
    const id = `${source}->${target}`, prev = edges.get(id);
    if (prev && prev.evidence === 'traced' && evidence === 'traced') {
      // Two traced calls landing on one pair (e.g. writer + reader endpoint of one cluster): sum, order-free.
      for (const k of ['calls', 'errors'] as const) if (extra[k] !== undefined) prev[k] = (prev[k] ?? 0) + extra[k]!;
    } else if (!prev || EVIDENCE_RANK[evidence] > EVIDENCE_RANK[prev.evidence]) edges.set(id, { id, source, target, evidence, ...extra });
  };

  // Rule 4: TG targets proven to be EKS pods → workload nodes `wl:<clusterArn>:<ns>/<name>`.
  const byIp = new Map<string, Binding[]>();
  for (const b of input.bindings) (byIp.get(b.ip) ?? byIp.set(b.ip, []).get(b.ip)!).push(b);
  const wlInfo = new Map<string, { arn: string; namespace: string; name: string }>();
  const targetToWl = new Map<string, string>();
  const wlId = (arn: string, w: WorkloadRef) => `wl:${arn}:${w.namespace}/${w.name}`;
  const addWorkload = (arn: string, w: WorkloadRef, kind: 'workload' | 'service') => {
    const id = wlId(arn, w), c = parseEksClusterId(arn);
    if (!nodes.has(id)) wlInfo.set(id, { arn, namespace: w.namespace, name: w.name });
    addNode({ id, kind, label: w.name, group: `ns:${arn}:${w.namespace}`, ...opt('account', c?.accountId), ...opt('region', c?.region),
      ref: { cluster: arn, namespace: w.namespace, workload: w.name } });
    return id;
  };
  for (const n of sorted(keepN.values())) {
    if (n.kind !== 'target') continue;
    const meta = n.meta ?? {}, ambiguity = str(meta.ambiguity);
    if (ambiguity) gaps.add(ambiguity.startsWith('eks_') || ambiguity === 'ownership_unverified' ? 'pods_unresolved' : 'inventory_incomplete');
    if (meta.resolved !== 'eks') continue;
    const arn = boundCluster(meta, input.flow.targetMembers?.[n.id] ?? [], byIp);
    if (!arn) { gaps.add('pods_unresolved'); continue; }
    targetToWl.set(n.id, addWorkload(arn, { namespace: str(meta.namespace), name: str(meta.workload) }, 'workload'));
  }
  for (const n of keepN.values()) {
    if (targetToWl.has(n.id)) continue;
    const row = rowOf(n);
    addNode({ id: n.id, kind: KIND[n.kind], label: n.label, ...opt('account', str(row.account_id)), ...opt('region', str(row.region)),
      ref: { flowNodeId: n.id } });
  }

  // Rule 3: cache behaviors between CloudFront and its origin edges (joined by CF origin Id).
  const cfRows = new Map(input.cloudfrontRows.map((r) => [`cf:${str(r.resource_id)}`, r]));
  const behaviorsOf = new Map<string, { b: CfBehavior; id: string }[]>();
  const originOf = new Map<string, BehaviorOrigin | null>(); // behavior id → what its origin is sent (null: unreadable)
  for (const n of sorted(keepN.values())) {
    if (n.kind !== 'cloudfront') continue;
    const row = cfRows.get(n.id) ?? rowOf(n);
    const list = cloudFrontBehaviors(row);
    if (!list.length) { gaps.add('behaviors_unavailable'); continue; } // keep CF→origin edges as-is
    const behs = list.map((b) => ({ b, id: `${n.id}/beh:${b.isDefault ? 'default' : b.order}` }));
    behaviorsOf.set(n.id, behs);
    // The flow node's own row built the origin edges; prefer it when the passed row lacks `origins`.
    const origins = cloudFrontOrigins(row.origins == null ? rowOf(n) : row);
    for (const x of behs) {
      const o = origins?.get(x.b.targetOriginId);
      // The origin sees the viewer Host only if it is forwarded (not in inventory) or the origin domain is that host.
      originOf.set(x.id, o ? { hostKept: normalizeHost(o.domainName) === host, originPath: o.originPath } : null);
    }
  }
  const mapId = (id: string) => targetToWl.get(id) ?? id;
  // A merged origin edge can carry a direct (observed) and a DNS-chain (inferred) origin: each behavior takes
  // its own origin's confidence. Without the per-origin map, only a single-origin edge's confidence is trusted.
  const originEvidence = (e: FlowEdge, oid: string): SiteEvidence => e.originConfidence && Object.hasOwn(e.originConfidence, oid)
    ? e.originConfidence[oid] : e.originIds?.length === 1 ? e.confidence : 'inferred';
  for (const e of sorted(keepE.values())) {
    const users = e.originIds?.length ? (behaviorsOf.get(e.source) ?? []).filter((x) => e.originIds!.includes(x.b.targetOriginId)) : [];
    if (!users.length) { addEdge(mapId(e.source), mapId(e.target), e.confidence, opt('route', e.label)); continue; } // unreferenced origins, WAF, LB→TG…
    for (const x of users) addEdge(x.id, mapId(e.target), originEvidence(e, x.b.targetOriginId));
    // A merged edge can also carry origins no behavior references: those keep their direct CF→origin edge.
    const used = new Set(users.map((x) => x.b.targetOriginId));
    for (const oid of e.originIds!) if (!used.has(oid)) addEdge(mapId(e.source), mapId(e.target), originEvidence(e, oid));
  }
  for (const [cf, behs] of behaviorsOf) for (const x of behs) {
    addNode({ id: x.id, kind: 'behavior', label: x.b.pathPattern, group: `cdn:${cf}`, ref: { flowNodeId: cf } });
    addEdge(cf, x.id, 'configured');
    if ([...keepE.values()].some((e) => e.source === cf && e.originIds?.includes(x.b.targetOriginId))) continue;
    const dangling = `${cf}/oid:${x.b.targetOriginId}`; // behavior whose origin Id no origin edge carries
    addNode({ id: dangling, kind: 'origin', label: x.b.targetOriginId, ref: { flowNodeId: cf } });
    addEdge(x.id, dangling, 'configured');
  }

  // Rule 5: trace calls (closure from bound workloads) and DB refs, per exact cluster ARN.
  const bound = [...new Set([...wlInfo.values()].map((w) => w.arn))].sort(cmp);
  const byName = new Map<string, number>();
  for (const arn of bound) { const name = parseEksClusterId(arn)?.name ?? arn; byName.set(name, (byName.get(name) ?? 0) + 1); }
  const collided = new Set(bound.filter((arn) => byName.get(parseEksClusterId(arn)?.name ?? arn)! > 1));
  if (collided.size) gaps.add('ambiguous_cluster');
  const resolutionOf = new Map<string, Map<string, DbResource>>();
  for (const d of input.dbRefs) {
    const m = resolutionOf.get(d.cluster) ?? new Map<string, DbResource>();
    for (const [h, r] of [...d.resolved.map].sort(([a], [b]) => cmp(a, b))) if (!m.has(h.toLowerCase())) m.set(h.toLowerCase(), r);
    resolutionOf.set(d.cluster, m);
  }
  // DNS names are global: a host resolved by any cluster's lookup names the same resource for every
  // cluster that dials it (one node across clusters). A cluster's own resolution always wins for that
  // cluster; when clusters resolve one host to different resources, a cluster without its own
  // resolution gets the unresolved host node, and placing that host adds `inventory_incomplete`.
  const anyCluster = new Map<string, DbResource | null>();
  const conflicted = new Set<string>();
  for (const m of [...resolutionOf].sort(([a], [b]) => cmp(a, b)).map(([, m]) => m)) for (const [h, r] of m) {
    const prev = anyCluster.get(h);
    const same = prev === undefined || (prev && prev.type === r.type && prev.id === r.id && prev.accountId === r.accountId
      && prev.region === r.region);
    if (!same) conflicted.add(h);
    anyCluster.set(h, same ? r : null);
  }
  const addDatastore = (arn: string, rawHost: string, kind: string) => {
    const h = rawHost.toLowerCase(), r = resolutionOf.get(arn)?.get(h) ?? anyCluster.get(h);
    if (conflicted.has(h)) gaps.add('inventory_incomplete'); // the clusters' inventories disagree on this host
    if (r?.id) {
      const id = `ds:${r.type}:${r.accountId || '-'}:${r.region || '-'}:${r.id}`;
      addNode({ id, kind: 'datastore', label: r.id, group: `datastore:${r.type}`, ...opt('account', r.accountId), ...opt('region', r.region) });
      return id;
    }
    const id = `ds:${kind}:${h}`;
    addNode({ id, kind: 'datastore', label: h, group: 'datastore:unresolved' });
    return id;
  };
  // One overlay per cluster ARN: a duplicated entry must not double-count calls (first entry wins).
  const traceOf = new Map<string, TraceOverlay>();
  for (const t of input.traces) if (!traceOf.has(t.cluster)) traceOf.set(t.cluster, t.overlay);
  for (const arn of bound) {
    const overlays = traceOf.has(arn) ? [traceOf.get(arn)!] : [];
    if (!overlays.length) gaps.add('trace_unavailable');
    if (collided.has(arn)) continue;
    for (const o of overlays) {
      if (!o.available) { gaps.add(TRACE_GAP[o.reason ?? 'unavailable'] ?? 'trace_unavailable'); continue; }
      if (o.omitted > 0) { gaps.add('partial_snapshot'); continue; }
      if ((o.skipped ?? 0) > 0) gaps.add('trace_unmapped'); // unmappable calls are disclosed; mapped ones stay
      const pending = [...o.workloadCalls];
      for (let changed = true; changed;) {
        changed = false;
        for (let i = 0; i < pending.length; i++) {
          const c = pending[i], from = wlId(arn, c.fromWorkload);
          if (!nodes.has(from)) continue; // not (yet) reachable from this flow: never an orphan
          pending.splice(i--, 1); changed = true;
          const to = 'workload' in c.to ? addWorkload(arn, c.to.workload, 'service')
            : addDatastore(arn, c.to.datastoreHost, extractManagedDbHosts(c.to.datastoreHost)[0]?.kind ?? 'unknown');
          addEdge(from, to, 'traced', { ...opt('calls', c.spanCount), ...opt('errors', c.errors) });
        }
      }
    }
  }
  for (const arn of bound) {
    const refs = input.dbRefs.filter((d) => d.cluster === arn);
    if (!refs.length) gaps.add('db_refs_partial');
    for (const d of refs) {
      if (d.partial) gaps.add('db_refs_partial');
      if (d.resolved.capped || d.resolved.incomplete) gaps.add('inventory_incomplete');
      for (const r of d.refs) {
        const from = wlId(arn, r.workload);
        if (nodes.has(from)) addEdge(from, addDatastore(arn, r.host, r.kind), 'configured');
      }
    }
  }
  const routes = input.routes ?? null;
  if (routes) for (const e of edges.values()) {
    const a = wlInfo.get(e.source), b = wlInfo.get(e.target);
    if (e.evidence !== 'traced' || !a || !b) continue;
    const via = [...new Set(routes.filter((r) => r.service === a.name && r.next?.some((x) => x.service === b.name)).map((r) => r.route))].sort(cmp);
    if (via.length) e.route = via.slice(0, ROUTE_LABEL_CAP).join(' | ') + (via.length > ROUTE_LABEL_CAP ? ` (+${via.length - ROUTE_LABEL_CAP})` : '');
  }

  // Rule 6: path highlight (site-flow-highlight.ts).
  const highlight: SiteFlow['highlight'] = path && !privateOnly // a private-zone-only host has no public request path
    ? computeHighlight({ host, path, entries, nodes, edges, behaviorsOf, originOf, wlInfo, flowNodes: keepN, flowEdges: keepE, routes, gaps })
    : null;

  // Rule 7: groups host → cdn → lb → cluster → namespace; datastores by type under the host.
  const hostGroup = `host:${host}`;
  const groups = new Map<string, SiteGroup>([[hostGroup, { id: hostGroup, kind: 'host', label: host }]]);
  const incoming = new Map<string, string[]>();
  for (const e of sorted(edges.values())) (incoming.get(e.target) ?? incoming.set(e.target, []).get(e.target)!).push(e.source);
  const uniqueUp = (ids: string[], prefix: string): string | undefined => {
    const gs = new Set(ids.flatMap((id) => incoming.get(id) ?? []).map((s) => nodes.get(s)?.group ?? '').filter((g) => g.startsWith(prefix)));
    return gs.size === 1 ? [...gs][0] : undefined;
  };
  const ORDER: SiteKind[] = ['dns', 'cdn', 'behavior', 'rule', 'origin', 'lb', 'tg', 'target', 'workload', 'service', 'datastore'];
  const ordered = sorted(nodes.values()).sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  for (const n of ordered) {
    if (n.kind === 'dns') n.group = hostGroup;
    else if (n.kind === 'cdn') { n.group = `cdn:${n.id}`; groups.set(n.group, { id: n.group, kind: 'cdn', label: n.label, parent: hostGroup }); }
    else if (n.kind === 'rule' || n.kind === 'origin') n.group = uniqueUp([n.id], 'cdn:') ?? hostGroup;
    else if (n.kind === 'lb') { n.group = `lb:${n.id}`; groups.set(n.group, { id: n.group, kind: 'lb', label: n.label, parent: uniqueUp([n.id], 'cdn:') ?? hostGroup }); }
    else if (n.kind === 'tg' || n.kind === 'target') n.group = uniqueUp([n.id], 'lb:') ?? hostGroup;
    else if (n.kind === 'datastore') {
      const type = n.group!.slice('datastore:'.length);
      groups.set(n.group!, { id: n.group!, kind: 'datastore', label: type, parent: hostGroup });
    }
  }
  for (const arn of [...new Set([...wlInfo.values()].map((w) => w.arn))].sort(cmp)) {
    const members = [...wlInfo].filter(([id, w]) => w.arn === arn && nodes.has(id)).map(([id]) => id);
    const cluster = `cluster:${arn}`;
    groups.set(cluster, { id: cluster, kind: 'cluster', label: parseEksClusterId(arn)?.name ?? arn, parent: uniqueUp(members, 'lb:') ?? hostGroup });
    for (const id of members) {
      const ns = wlInfo.get(id)!.namespace;
      groups.set(`ns:${arn}:${ns}`, { id: `ns:${arn}:${ns}`, kind: 'namespace', label: ns, parent: cluster });
    }
  }

  return finish({ nodes: sorted(nodes.values()), edges: sorted(edges.values()), groups: sorted(groups.values()), highlight });
}
