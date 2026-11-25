'use client';

// Data loading for the site view (`/topology?view=site`). Everything is read from existing endpoints and
// composed in the browser (buildSiteFlow); every read is abort-safe and fails closed into a gap/notice:
//  - inventory: loadFlowInput with the page scope (full live rows, incl. CloudFront behaviors and ALB listener
//    rules). Any interactive type that failed, was capped, swept unstably or whose aggregate run is failed,
//    partial or running yields `inventory_incomplete`; so does a missing sync record (`unknown`) for the hop types
//    the builder walks (HOP_TYPES).
//  - EKS pod map + bindings: the scoped listing (`eksScope`). An all-region listing returns a discovery note that
//    withholds bindings (`binding_scope_partial`), so the EKS read gets EXPLICIT regions derived from a COMPLETE
//    fleet listing (see deriveEksScope; an incomplete fleet fails the EKS read closed). R = the explicit page regions,
//    or for an all-region page the regions where a SELECTED account has a connected cluster. Only accounts with a
//    fleet cluster in R, selected or not, and wildcard-scan accounts are listed, each in its fleet regions ∩ R
//    (wildcard accounts in all of R). Inventory reads keep the page scope, so no LB/TG row is dropped. Targets
//    outside those regions stay unresolved (`eks_not_enumerated`).
//  - host account: `/api/accounts` (unique isHost row). Host inventory rows are keyed `self` while the listing
//    reports the numeric id, so `<hostId>|region` coverage is mirrored to `self|region`, and host clusters are
//    recognized when deriving the EKS scope. The EKS read waits for this lookup (evidence pending meanwhile).
//  - fleet listing (web/lib/eks-fleet.ts readFleet): one `/api/eks?accounts=<id>&regions=__all__` per enabled
//    registered account from `/api/accounts` (host as `self`), merged, plus `/api/eks/registrations`. A single
//    all-account request is capped at 12 account×region targets server-side and truncates on a real fleet. The
//    listed clusters drive deriveEksScope; the trace join's name uniqueness uses listed ∪ registered clusters.
//    Any failed / errored / truncated / malformed request, or a failed or malformed `/api/accounts`, marks it
//    incomplete.
//  - trace routes: `/api/topology/site-routes` (default 60-minute window), only once a host AND a path exist (routes
//    change nothing drawn otherwise, so the host index and a host without a path read none), then once per load: a
//    path change, or clearing and re-entering a path, reuses the landed read; a refresh or scope change reads again
//    when a path is present (else when one is entered). Its own abort signal and DEADLINE_MS deadline (raced, so a
//    read that ignores the abort still settles). App-level datasources: no account/region scope. Committed on its own
//    (never delays the inventory) and kept across a refresh until the replacement lands. Routes are used only for
//    status `ok`/`partial`; `unavailable`, a 404 (flag off), any other non-OK response, a malformed body or the deadline
//    give no routes (the builder reports `route_unavailable`).
//  - per bound cluster (Binding.authority ARN): the trace overlay and db-refs, cached per ARN for one fleet read.
//  - refresh (`reload`): every read above runs again and no cached cluster evidence is reused.
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildFlowGraph, type FlowGraph } from '@/lib/flow-topology';
import { loadFlowInput, type Row } from '@/lib/flow-load';
import type { EksIpResolution } from '@/lib/topology-config';
import type { Binding } from '@/lib/service-topology/types';
import { fetchTraceOverlay, type TraceOverlay } from '@/lib/k8s-trace-overlay';
import type { DbRef } from '@/lib/eks-db-refs';
import type { DbResource } from '@/lib/db-ref-resolve';
import type { SiteFlowInput, SiteRoute } from '@/lib/site-flow';
import { hostAccountOf } from '@/lib/host-account';
import { ALL_ACCOUNTS, ALL_REGIONS } from '@/lib/account-context';
import { INCOMPLETE_FLEET, readFleet, type Fleet, type FleetCluster } from '@/lib/eks-fleet';
import { INTERACTIVE_FLOW_TYPES as TYPES } from '@/lib/flow-inventory-types';

const DEADLINE_MS = 30000;
/** Per-cluster evidence reads (trace overlay + db-refs) in flight at once, like the other laned loaders. */
const EVIDENCE_LANES = 4;
const REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;

export interface InventoryIssue { type: string; issue: 'failed' | 'capped' | 'incomplete' | 'running' | 'partial' | 'unknown' }
/** Types whose rows add or remove a chain hop in buildFlowGraph: a missing sync record (`unknown`) for any of them
 *  cannot prove the chain complete and is disclosed as `inventory_incomplete`. route53/cloudfront/alb/nlb/
 *  apigatewayv2_api are hop nodes; cloudfront_vpc_origin links a VPC origin to its ALB/NLB; apigatewayv2_integration
 *  links an API to its Lambda/LB; alb_listener_rule decides which TG the highlight follows. Exempt (never add or
 *  remove a hop; a never-collected one would flag every load): label/row-only enrichment (apigatewayv2_route route
 *  labels, s3 bucket rows, lambda/ec2 target names), ENI-owner enrichment (eni/vpc_endpoint/nat_gateway, guarded by
 *  ownerIncomplete) and the CloudFront→WAF side edge (waf). Critical types (target_group, ecs_task, subnet, eni)
 *  already require a ledger: a missing run fails the read (`failed`). */
export const HOP_TYPES: ReadonlySet<string> = new Set(['route53', 'cloudfront', 'cloudfront_vpc_origin', 'alb', 'nlb',
  'alb_listener_rule', 'apigatewayv2_api', 'apigatewayv2_integration']);
export interface SiteInventory {
  flow: FlowGraph;
  cloudfrontRows: Row[];
  bindings: Binding[];
  eks: EksIpResolution | null;
  issues: InventoryIssue[];
  /** The scope the EKS read used: per-account queries when derivable, else the page scope. */
  eksScope: string | string[];
}

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** One `/api/topology/site-routes` read. `routes` is non-null only for status `ok`/`partial`; `failed` = the read itself
 *  failed (404 flag off, non-OK, malformed body, network error, abort or deadline). */
export interface SiteRouteRead {
  status: 'ok' | 'partial' | 'unavailable' | 'failed';
  reasons: string[];
  routes: SiteRoute[] | null;
}
const ROUTE_STATUS = new Set(['ok', 'partial', 'unavailable']);
const ROUTES_FAILED = (): SiteRouteRead => ({ status: 'failed', reasons: [], routes: null });
/** Exactly the `required` keys plus any of `optional`, nothing else. */
const exactKeys = (o: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every((k) => k in o) && Object.keys(o).every((k) => required.includes(k) || optional.includes(k));
const count = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** Strict parse of the route body `{ status, reasons, routes }` (hops `{ service, route, calls, next }`, next entries
 *  `{ service, calls, route? }`); any other key, type or status fails the whole read (no routes). */
export function parseSiteRoutes(body: unknown): SiteRouteRead {
  if (!record(body) || !exactKeys(body, ['status', 'reasons', 'routes']) || typeof body.status !== 'string'
    || !ROUTE_STATUS.has(body.status) || !Array.isArray(body.reasons) || !body.reasons.every(nonempty)
    || !Array.isArray(body.routes)) return ROUTES_FAILED();
  const routes: SiteRoute[] = [];
  for (const h of body.routes) {
    if (!record(h) || !exactKeys(h, ['service', 'route', 'calls', 'next']) || !nonempty(h.service) || !nonempty(h.route)
      || !count(h.calls) || !Array.isArray(h.next)) return ROUTES_FAILED();
    const next: NonNullable<SiteRoute['next']> = [];
    for (const n of h.next) {
      if (!record(n) || !exactKeys(n, ['service', 'calls'], ['route']) || !nonempty(n.service) || !count(n.calls)
        || ('route' in n && !nonempty(n.route))) return ROUTES_FAILED();
      next.push({ service: n.service, ...(nonempty(n.route) ? { route: n.route } : {}) });
    }
    routes.push({ service: h.service, route: h.route, next });
  }
  const status = body.status as SiteRouteRead['status'];
  return { status, reasons: [...body.reasons as string[]], routes: status === 'unavailable' ? null : routes };
}

/** `/api/topology/site-routes` (default window): any failure → `failed` with no routes. */
export async function readSiteRoutes(signal: AbortSignal): Promise<SiteRouteRead> {
  try {
    const r = await fetch('/api/topology/site-routes', { signal });
    return r.ok ? parseSiteRoutes(await r.json()) : ROUTES_FAILED();
  } catch {
    return ROUTES_FAILED();
  }
}

/** Host-alias account of a listed cluster: bare-id rows are host default-region clusters by construction. */
const ownerOf = (c: FleetCluster, hostAccount: string | null) =>
  !c.id.startsWith('arn:') || (hostAccount && c.accountId === hostAccount) ? 'self' : c.accountId ?? '';

/** Binding reason when the fleet listing needed to derive the EKS scope was incomplete (read failed closed). */
export const FLEET_INCOMPLETE_REASON = 'binding_fleet_incomplete';
/** Binding reason when the load deadline (DEADLINE_MS) cut the EKS read or the fleet listing it depends on. */
export const DEADLINE_REASON = 'binding_deadline';

/**
 * The scope for the EKS read: one listing per account (the server's accounts × regions product 403s the whole
 * listing when one account lacks a region, and a single request is capped at 12 targets), over a region set R:
 * the explicit page regions, or for an all-region page scope the regions of every CONNECTED fleet cluster in the
 * SELECTED accounts. The selection decides R and which accounts' inventory (targets) is shown; it does not decide
 * which clusters take part: EVERY enabled account with ANY fleet cluster (any access) in a region of R is listed in
 * exactly those regions (its fleet regions ∩ R), selected or not. A listed CONNECTED cluster of any account may
 * resolve pods and contribute bindings (and gets trace/db-refs reads), since a shared-VPC target can legitimately
 * belong to another account's pod; a listed not-connected cluster vetoes its VPC (e.g. a RAM-shared VPC):
 * fetchEksIpMap then blocks that region|vpc (`binding_scope_blocked`, disclosed). Every wildcard-scan account (fleet `wildcard`) is listed in all of R, since its
 * fleet listing may miss clusters there. An account spanning >12 regions fails closed as a truncated listing. Accounts
 * with no fleet cluster in R need no request. A truncated, errored, malformed or failed fleet listing cannot prove which
 * clusters exist: `null` (the caller fails the EKS read closed). An empty R (all regions, no connected cluster in the
 * selection) or a derivation with no account to list keeps the page scope: there is nothing to resolve, and the
 * all-region note then withholds bindings with a disclosed reason (`binding_scope_partial`).
 */
export function deriveEksScope(inventoryScope: string, fleet: Fleet | null, hostAccount: string | null): string | string[] | null {
  if (!fleet || fleet.incomplete) return null;
  const q = new URLSearchParams(inventoryScope);
  const pageRegions = q.get('regions') ?? ALL_REGIONS;
  const accounts = q.get('accounts') || 'self';
  const selected = accounts === ALL_ACCOUNTS ? null : new Set(accounts.split(','));
  const listed = fleet.clusters.filter((c) => nonempty(c.region) && REGION_RE.test(c.region) && ownerOf(c, hostAccount));
  const resolving = pageRegions === ALL_REGIONS
    ? new Set(listed.filter((c) => c.access === 'connected' && (!selected || selected.has(ownerOf(c, hostAccount))))
      .map((c) => c.region!))
    : new Set(pageRegions.split(',').filter((r) => REGION_RE.test(r)));
  if (!resolving.size) return inventoryScope;
  const byOwner = new Map<string, Set<string>>();
  for (const c of listed) {
    if (!resolving.has(c.region!)) continue;
    const owner = ownerOf(c, hostAccount);
    (byOwner.get(owner) ?? byOwner.set(owner, new Set()).get(owner)!).add(c.region!);
  }
  // A wildcard-scan account's fleet listing (all-region discovery note) only covers its configured, registered and
  // home regions, so it may hold unlisted clusters elsewhere: list it explicitly in ALL of R (the server accepts any
  // explicit region for a `*` scan scope), so its not-connected clusters in any resolved region can veto.
  for (const owner of fleet.wildcard) byOwner.set(owner, new Set(resolving));
  if (!byOwner.size) return inventoryScope;
  return [...byOwner.keys()].sort().map((owner) => new URLSearchParams({ accounts: owner,
    regions: [...byOwner.get(owner)!].sort().join(','), includeGlobal: q.get('includeGlobal') ?? '1' }).toString());
}

/** Mirror each enumerated `<hostId>|region` to the `self|region` key host inventory rows use. */
export function withHostAlias(keys: string[], hostAccount: string | null): string[] {
  if (!hostAccount) return keys;
  const extra = keys.filter((k) => k.startsWith(`${hostAccount}|`)).map((k) => `self|${k.slice(hostAccount.length + 1)}`);
  return [...new Set([...keys, ...extra])].sort();
}

/**
 * Inventory + EKS map + host lookup + fleet listing + trace routes for one page scope (the view is keyed by it). A
 * new `reload` value re-runs every read (the route read only while `wantRoutes`, i.e. a host and a path exist). The previous inventory, host account and fleet stay on screen until the
 * reload lands and are then replaced together; the new fleet makes useClusterEvidence re-read every cluster, which
 * keeps the previous evidence shown until the new batch commits. A reload that fails (every inventory type failed, or
 * an invalid response) clears the inventory: no stale flow beside the failure. The route read commits on its own:
 * `routes` is null until the first read lands, then holds the last landed read (kept while a reload's read runs).
 */
export function useSiteInventory(inventoryScope: string, reload = 0, wantRoutes = false): {
  data: SiteInventory | null; error: string; hostAccount: string | null | undefined; fleet: Fleet | null; pending: boolean;
  routes: SiteRouteRead | null; routesPending: boolean;
} {
  const [data, setData] = useState<SiteInventory | null>(null);
  const [error, setError] = useState('');
  const [hostAccount, setHostAccount] = useState<string | null | undefined>(undefined);
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const [loading, setLoading] = useState(true);
  const [routes, setRoutes] = useState<SiteRouteRead | null>(null);
  // The load (scope + reload) the route read belongs to: latched the first time a route read is wanted in that load,
  // so it starts once per load and a path change or a path cleared and re-entered never refetches. Derived state
  // set during render (React's "adjust state on prop change" pattern), so the read starts on the same commit.
  const load = `${reload}\n${inventoryScope}`;
  const [routeLoad, setRouteLoad] = useState<string | null>(null);
  const [landedLoad, setLandedLoad] = useState<string | null>(null);
  if (wantRoutes && routeLoad !== load) setRouteLoad(load);
  useEffect(() => {
    if (routeLoad === null) return undefined;
    let live = true;
    const ctrl = new AbortController();
    let cut = () => {};
    const routesCut = new Promise<void>((r) => { cut = r; });
    const deadline = setTimeout(() => { ctrl.abort(); cut(); }, DEADLINE_MS);
    void Promise.race([readSiteRoutes(ctrl.signal), routesCut.then(ROUTES_FAILED)]).then((r) => {
      clearTimeout(deadline);
      if (live) { setRoutes(r); setLandedLoad(routeLoad); }
    });
    return () => { live = false; clearTimeout(deadline); ctrl.abort(); };
  }, [routeLoad]);
  useEffect(() => {
    let live = true;
    setLoading(true); setError('');
    const ctrl = new AbortController();
    const { signal } = ctrl;
    // The deadline aborts every read; a read it cut is disclosed as `binding_deadline` (refresh retries), never as
    // a failure of the cluster or fleet. A read that settled before it keeps its own reason.
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; ctrl.abort(); }, DEADLINE_MS);
    let fleetCut = false;
    const accountsBody: Promise<unknown> = fetch('/api/accounts', { signal })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const host = accountsBody.then(hostAccountOf);
    // Fail closed: a failed, aborted or unparseable fleet listing cannot prove name uniqueness.
    const fleetRead = accountsBody.then((body) => readFleet(body, signal)).catch(INCOMPLETE_FLEET)
      .then((f) => { fleetCut = signal.aborted; return f; });
    const eksScope = Promise.all([host, fleetRead]).then(([h, f]) => deriveEksScope(inventoryScope, f, h));
    // An underivable scope (incomplete fleet) issues no listing: fetchEksIpMap fails an empty query list closed.
    const inventoryRead = loadFlowInput(inventoryScope, signal, true, { eksScope: true, eksScopeQuery: eksScope.then((scope) => scope ?? []) })
      .then(async (loaded) => {
        const [h, f, scope] = await Promise.all([host, fleetRead, eksScope]);
        if (!live) return;
        // Inventory, host account and fleet are swapped in together (one batched render).
        setLoading(false); setHostAccount(h); setFleet(f);
        // Fail closed: a failed (re)load never leaves the previous flow and its pod attributions on screen.
        if (loaded.allFailed) { setData(null); setError(loaded.failed.map((r) => r.error).join('; ')); return; }
        const cut = timedOut && (loaded.eksAborted || (scope === null && fleetCut));
        if (loaded.eks && cut) loaded.eks.bindingRead = { status: 'withheld', reasons: [DEADLINE_REASON] };
        else if (scope === null && loaded.eks) loaded.eks.bindingRead = { status: 'withheld', reasons: [FLEET_INCOMPLETE_REASON] };
        const own = loaded.input.ownershipRead;
        if (own?.eksAccountRegions) own.eksAccountRegions = withHostAlias(own.eksAccountRegions, h);
        const issues: InventoryIssue[] = [];
        TYPES.forEach((type, i) => {
          const r = loaded.res[i];
          const issue: InventoryIssue['issue'] | null = r.readFailed ? 'failed' : r.incomplete ? 'incomplete' : r.capped ? 'capped'
            : r.aggregateStatus === 'failed' || r.aggregateStatus === 'partial' || r.aggregateStatus === 'running' ? r.aggregateStatus
            : r.aggregateStatus === 'unknown' && HOP_TYPES.has(type) ? 'unknown' : null;
          if (issue) issues.push({ type, issue });
        });
        setData({
          flow: buildFlowGraph(loaded.input),
          cloudfrontRows: (loaded.input.cloudfront ?? []) as Row[],
          bindings: loaded.eks?.bindings ?? [],
          eks: loaded.eks, issues, eksScope: scope ?? [],
        });
      })
      .catch(() => { if (live) { setLoading(false); setData(null); setFleet(null); setError('site: invalid inventory response'); } });
    void inventoryRead.finally(() => clearTimeout(deadline));
    return () => { live = false; clearTimeout(deadline); ctrl.abort(); };
  }, [inventoryScope, reload]);
  // Pending only while a wanted read for this load has not landed (no path → nothing pending).
  return { data, error, hostAccount, fleet, pending: loading, routes, routesPending: wantRoutes && landedLoad !== routeLoad };
}

export interface ClusterEvidence {
  trace: TraceOverlay;
  dbRefs: SiteFlowInput['dbRefs'][number];
  dbRefsFailed: boolean;
}
type DbRefsRead = Omit<ClusterEvidence['dbRefs'], 'cluster'> & { failed: boolean };
const DB_FAILED = (): DbRefsRead => ({ refs: [], resolved: { map: new Map(), capped: false, incomplete: false }, partial: true, failed: true });

/** `/api/eks/[cluster]/db-refs` → refs + host→resource resolution; any malformed entry fails the whole read. */
export async function readDbRefs(id: string, signal: AbortSignal): Promise<DbRefsRead> {
  try {
    const r = await fetch(`/api/eks/${encodeURIComponent(id)}/db-refs`, { signal });
    if (!r.ok) return DB_FAILED();
    const d: unknown = await r.json();
    if (!record(d) || !Array.isArray(d.refs)) return DB_FAILED();
    const refs: DbRef[] = [];
    const map = new Map<string, DbResource>();
    for (const x of d.refs) {
      const w = record(x) && record(x.workload) ? x.workload : null;
      if (!w || !nonempty(w.namespace) || !nonempty(w.name) || !nonempty(x.host) || !nonempty(x.kind)
        || (x.via !== 'env' && x.via !== 'configmap')) return DB_FAILED();
      refs.push({ workload: { namespace: w.namespace, name: w.name }, via: x.via, host: x.host, kind: x.kind as DbRef['kind'] });
      const res = x.resource;
      if (record(res) && nonempty(res.type) && nonempty(res.id) && typeof res.accountId === 'string') {
        map.set(x.host, { type: res.type, id: res.id, accountId: res.accountId, region: typeof res.region === 'string' ? res.region : null });
      }
    }
    return { refs, resolved: { map, capped: d.inventoryCapped === true, incomplete: d.inventoryIncomplete === true },
      partial: d.partial === true || d.truncated === true, failed: false };
  } catch {
    return DB_FAILED();
  }
}

/** Trace overlay + db-refs of one cluster. Each read that has not settled when `cut` resolves (the batch deadline)
 *  counts as failed (trace unavailable / db-refs failed), so a stuck read is disclosed and never blocks the other one. */
async function readClusterEvidence(arn: string, fleet: Fleet, signal: AbortSignal, cut: Promise<void>): Promise<ClusterEvidence> {
  // Routes address a cluster by its listed id (bare name for host default-region clusters, else the ARN).
  const id = fleet.clusters.find((c) => c.arn === arn)?.id ?? arn;
  const unavailable = (): TraceOverlay => ({ available: false, reason: 'unavailable', workloadCalls: [], omitted: 0 });
  const [trace, db] = await Promise.all([
    Promise.race([fetchTraceOverlay({ id: arn, registeredNames: fleet.names, listingIncomplete: fleet.incomplete }, signal)
      .catch(unavailable), cut.then(unavailable)]),
    Promise.race([readDbRefs(id, signal), cut.then(DB_FAILED)]),
  ]);
  const { failed, ...rest } = db;
  return { trace, dbRefs: { cluster: arn, ...rest }, dbRefsFailed: failed };
}

/**
 * Trace overlay + db-refs per bound cluster ARN (sorted, deduped by the caller). Results are cached per ARN and
 * fleet read (a refresh yields a new fleet, so nothing cached survives it; entries of a superseded fleet are pruned)
 * and committed in ONE state update per batch, so the flow is rebuilt once when the evidence lands. While a batch for
 * the same clusters is pending (e.g. after a refresh) the last committed evidence stays shown, then swaps. Each batch
 * has a DEADLINE_MS deadline: reads still running are aborted and commit as failed (trace unavailable / db-refs failed),
 * so `trace_unavailable` / `db_refs_partial` are disclosed instead of a loading state that never ends. At most
 * EVIDENCE_LANES clusters are read at once.
 */
export function useClusterEvidence(arns: string[], fleet: Fleet | null): {
  pending: boolean; traces: SiteFlowInput['traces']; dbRefs: SiteFlowInput['dbRefs']; failedDbRefs: string[];
} {
  const key = arns.join('\n');
  const cache = useRef(new Map<string, { fleet: Fleet; ev: ClusterEvidence }>());
  const cached = (arn: string) => { const c = cache.current.get(arn); return c && c.fleet === fleet ? c.ev : undefined; };
  const [version, setVersion] = useState(0);
  const lastDone = useRef<{ key: string; traces: SiteFlowInput['traces']; dbRefs: SiteFlowInput['dbRefs']; failedDbRefs: string[] } | null>(null);
  useEffect(() => {
    if (!key || !fleet) return undefined;
    const missing = key.split('\n').filter((a) => !cached(a));
    if (!missing.length) return undefined;
    let live = true;
    const ctrl = new AbortController();
    let cut = () => {};
    const deadline = new Promise<void>((r) => { cut = r; });
    const timer = setTimeout(() => { ctrl.abort(); cut(); }, DEADLINE_MS);
    // At most EVIDENCE_LANES clusters read at once (shared PG pool), lanes pulling from one shared index; the batch
    // still commits once, and a cluster first reached after the deadline settles as failed via `deadline`.
    const list: ClusterEvidence[] = new Array(missing.length);
    let next = 0;
    const lane = async () => {
      for (let i = next++; i < missing.length; i = next++) list[i] = await readClusterEvidence(missing[i], fleet, ctrl.signal, deadline);
    };
    void Promise.all(Array.from({ length: Math.min(EVIDENCE_LANES, missing.length) }, lane)).then(() => {
      clearTimeout(timer);
      if (!live) return;
      for (const [arn, c] of cache.current) if (c.fleet !== fleet) cache.current.delete(arn);
      list.forEach((ev, i) => cache.current.set(missing[i], { fleet, ev }));
      setVersion((v) => v + 1);
    });
    return () => { live = false; clearTimeout(timer); ctrl.abort(); };
  }, [key, fleet]);
  return useMemo(() => {
    const entries = key ? key.split('\n').map(cached) : [];
    const pending = !!key && (fleet === null || entries.some((e) => !e));
    if (pending) {
      // Same clusters, evidence being re-read: keep the last committed evidence on screen until the new batch lands.
      const prev = lastDone.current?.key === key ? lastDone.current : null;
      return { pending, traces: prev?.traces ?? [], dbRefs: prev?.dbRefs ?? [], failedDbRefs: prev?.failedDbRefs ?? [] };
    }
    const done = entries as ClusterEvidence[];
    const result = {
      traces: done.map((e) => ({ cluster: e.dbRefs.cluster, overlay: e.trace })),
      dbRefs: done.map((e) => e.dbRefs),
      failedDbRefs: done.filter((e) => e.dbRefsFailed).map((e) => e.dbRefs.cluster),
    };
    lastDone.current = { key, ...result };
    return { pending, ...result };
  }, [key, fleet, version]); // `version` re-reads the ref cache after each committed batch
}
