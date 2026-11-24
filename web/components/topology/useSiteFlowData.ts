'use client';

// Data loading for the site view (`/topology?view=site`). Everything is read from existing endpoints and
// composed in the browser (buildSiteFlow); every read is abort-safe and fails closed into a gap/notice:
//  - inventory: loadFlowInput with the page scope (full live rows, incl. CloudFront behaviors and ALB listener
//    rules). Any interactive type that failed, was capped, swept unstably or whose aggregate run is failed,
//    partial or running yields `inventory_incomplete`; so does a missing sync record (`unknown`) for the hop types
//    the builder walks (HOP_TYPES).
//  - EKS pod map + bindings: the scoped listing (`eksScope`). An all-region listing returns a discovery note that
//    withholds bindings (`binding_scope_partial`), so the EKS read gets EXPLICIT regions derived from a COMPLETE
//    fleet listing: one listing per account over the regions where any account has a connected cluster (see
//    deriveEksScope; an incomplete fleet fails the EKS read closed). Inventory reads keep the page scope, so no LB/TG row is
//    dropped. Targets outside those regions stay unresolved (`eks_not_enumerated`).
//  - host account: `/api/accounts` (unique isHost row). Host inventory rows are keyed `self` while the listing
//    reports the numeric id, so `<hostId>|region` coverage is mirrored to `self|region`, and host clusters are
//    recognized when deriving the EKS scope. The EKS read waits for this lookup (evidence pending meanwhile).
//  - fleet listing: one `/api/eks?accounts=<id>&regions=__all__&includeGlobal=1` per enabled registered account
//    from `/api/accounts` (host as `self`), merged. A single all-account request is capped at 12 account×region
//    targets server-side and truncates on a real fleet. The merged fleet drives deriveEksScope and the trace
//    join's name uniqueness; any failed / reasoned-error / truncated request, or a failed or malformed
//    `/api/accounts`, marks it incomplete.
//  - per bound cluster (Binding.authority ARN): the trace overlay and db-refs, cached per ARN for the mount.
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildFlowGraph, type FlowGraph } from '@/lib/flow-topology';
import { loadFlowInput, type Row } from '@/lib/flow-load';
import type { EksIpResolution } from '@/lib/topology-config';
import type { Binding } from '@/lib/service-topology/types';
import { fetchTraceOverlay, type TraceOverlay } from '@/lib/k8s-trace-overlay';
import type { DbRef } from '@/lib/eks-db-refs';
import type { DbResource } from '@/lib/db-ref-resolve';
import type { SiteFlowInput } from '@/lib/site-flow';
import { hostAccountOf } from '@/lib/host-account';
import { ALL_ACCOUNTS, ALL_REGIONS } from '@/lib/account-context';
import { INCOMPLETE_FLEET, readFleet, type Fleet, type FleetCluster } from '@/lib/eks-fleet';
import { INTERACTIVE_FLOW_TYPES as TYPES } from '@/lib/flow-inventory-types';

const DEADLINE_MS = 30000;
const REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;

export interface InventoryIssue { type: string; issue: 'failed' | 'capped' | 'incomplete' | 'running' | 'partial' | 'unknown' }
/** Hop types the builder walks: a missing sync record there cannot prove the chain complete. Optional enrichment
 *  types stay exempt (a never-collected one would flag every load). Critical types already require a ledger. */
export const HOP_TYPES: ReadonlySet<string> = new Set(['route53', 'cloudfront', 'alb', 'nlb', 'alb_listener_rule']);
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

/** Host-alias account of a listed cluster: bare-id rows are host default-region clusters by construction. */
const ownerOf = (c: FleetCluster, hostAccount: string | null) =>
  !c.id.startsWith('arn:') || (hostAccount && c.accountId === hostAccount) ? 'self' : c.accountId ?? '';

/** Binding reason when the fleet listing needed to derive the EKS scope was incomplete (read failed closed). */
export const FLEET_INCOMPLETE_REASON = 'binding_fleet_incomplete';

/**
 * The scope for the EKS read. Explicit page regions pass through unchanged. For an all-region page scope:
 * R = the regions of every CONNECTED fleet cluster in the selected accounts (any account). Each selected account
 * with ANY fleet cluster (any access) in a region of R is listed in exactly those regions (its fleet regions ∩ R),
 * so a not-connected cluster of any account in a region we resolve is always listed and can veto its VPC (e.g. a
 * RAM-shared VPC): fetchEksIpMap then blocks that region|vpc (`binding_scope_blocked`, disclosed). One query per
 * account avoids the server's accounts × regions product (a region one account lacks 403s the whole listing);
 * an account spanning >12 regions fails closed as a truncated listing. Accounts with no fleet cluster in R need no
 * request, except wildcard-scan accounts (fleet `wildcard`), which are listed in all of R. A truncated, errored or failed fleet listing cannot prove which clusters exist: `null` (the caller fails
 * the EKS read closed). No connected cluster in scope keeps the page scope (its all-region note withholds
 * bindings with a disclosed reason).
 */
export function deriveEksScope(inventoryScope: string, fleet: Fleet | null, hostAccount: string | null): string | string[] | null {
  const q = new URLSearchParams(inventoryScope);
  if ((q.get('regions') ?? ALL_REGIONS) !== ALL_REGIONS) return inventoryScope;
  if (!fleet || fleet.incomplete) return null;
  const accounts = q.get('accounts') || 'self';
  const selected = accounts === ALL_ACCOUNTS ? null : new Set(accounts.split(','));
  const inScope = fleet.clusters.filter((c) => nonempty(c.region) && REGION_RE.test(c.region)
    && ownerOf(c, hostAccount) && (!selected || selected.has(ownerOf(c, hostAccount))));
  const resolving = new Set(inScope.filter((c) => c.access === 'connected').map((c) => c.region!));
  if (!resolving.size) return inventoryScope;
  const byOwner = new Map<string, Set<string>>();
  for (const c of inScope) {
    if (!resolving.has(c.region!)) continue;
    const owner = ownerOf(c, hostAccount);
    (byOwner.get(owner) ?? byOwner.set(owner, new Set()).get(owner)!).add(c.region!);
  }
  // A wildcard-scan account's fleet listing (all-region discovery note) only covers its configured, registered and
  // home regions, so it may hold unlisted clusters elsewhere: list it explicitly in ALL of R (the server accepts any
  // explicit region for a `*` scan scope), so its not-connected clusters in any resolved region can veto.
  for (const owner of fleet.wildcard) {
    if (!selected || selected.has(owner)) byOwner.set(owner, new Set(resolving));
  }
  return [...byOwner.keys()].sort().map((owner) => new URLSearchParams({ accounts: owner,
    regions: [...byOwner.get(owner)!].sort().join(','), includeGlobal: q.get('includeGlobal') ?? '1' }).toString());
}

/** Mirror each enumerated `<hostId>|region` to the `self|region` key host inventory rows use. */
export function withHostAlias(keys: string[], hostAccount: string | null): string[] {
  if (!hostAccount) return keys;
  const extra = keys.filter((k) => k.startsWith(`${hostAccount}|`)).map((k) => `self|${k.slice(hostAccount.length + 1)}`);
  return [...new Set([...keys, ...extra])].sort();
}

/** Inventory + EKS map + host lookup + fleet listing for one page scope (the view is keyed by it). */
export function useSiteInventory(inventoryScope: string): {
  data: SiteInventory | null; error: string; hostAccount: string | null | undefined; fleet: Fleet | null; pending: boolean;
} {
  const [data, setData] = useState<SiteInventory | null>(null);
  const [error, setError] = useState('');
  const [hostAccount, setHostAccount] = useState<string | null | undefined>(undefined);
  const [fleet, setFleet] = useState<Fleet | null>(null);
  useEffect(() => {
    let live = true;
    const ctrl = new AbortController();
    const { signal } = ctrl;
    const deadline = setTimeout(() => ctrl.abort(), DEADLINE_MS);
    const accountsBody: Promise<unknown> = fetch('/api/accounts', { signal })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const host = accountsBody.then(hostAccountOf);
    // Fail closed: a failed, aborted or unparseable fleet listing cannot prove name uniqueness.
    const fleetRead = accountsBody.then((body) => readFleet(body, signal)).catch(INCOMPLETE_FLEET);
    void host.then((h) => { if (live) setHostAccount(h); });
    void fleetRead.then((f) => { if (live) setFleet(f); });
    const eksScope = Promise.all([host, fleetRead]).then(([h, f]) => deriveEksScope(inventoryScope, f, h));
    // An underivable scope (incomplete fleet) issues no listing: fetchEksIpMap fails an empty query list closed.
    loadFlowInput(inventoryScope, signal, true, { eksScope: true, eksScopeQuery: eksScope.then((scope) => scope ?? []) })
      .then(async (loaded) => {
        const [h, scope] = await Promise.all([host, eksScope]);
        if (!live) return;
        if (loaded.allFailed) { setError(loaded.failed.map((r) => r.error).join('; ')); return; }
        if (scope === null && loaded.eks) loaded.eks.bindingRead = { status: 'withheld', reasons: [FLEET_INCOMPLETE_REASON] };
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
      .catch(() => { if (live) setError('site: invalid inventory response'); })
      .finally(() => clearTimeout(deadline));
    return () => { live = false; clearTimeout(deadline); ctrl.abort(); };
  }, [inventoryScope]);
  return { data, error, hostAccount, fleet, pending: !data && !error };
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

async function readClusterEvidence(arn: string, fleet: Fleet, signal: AbortSignal): Promise<ClusterEvidence> {
  // Routes address a cluster by its listed id (bare name for host default-region clusters, else the ARN).
  const id = fleet.clusters.find((c) => c.arn === arn)?.id ?? arn;
  const [trace, db] = await Promise.all([
    fetchTraceOverlay({ id: arn, registeredNames: fleet.names, listingIncomplete: fleet.incomplete }, signal)
      .catch((): TraceOverlay => ({ available: false, reason: 'unavailable', workloadCalls: [], omitted: 0 })),
    readDbRefs(id, signal),
  ]);
  const { failed, ...rest } = db;
  return { trace, dbRefs: { cluster: arn, ...rest }, dbRefsFailed: failed };
}

/**
 * Trace overlay + db-refs per bound cluster ARN (sorted, deduped by the caller). Results are cached per ARN for the
 * mount and committed in ONE state update per batch, so the flow is rebuilt once when the evidence lands.
 */
export function useClusterEvidence(arns: string[], fleet: Fleet | null): {
  pending: boolean; traces: SiteFlowInput['traces']; dbRefs: SiteFlowInput['dbRefs']; failedDbRefs: string[];
} {
  const key = arns.join('\n');
  const cache = useRef(new Map<string, ClusterEvidence>());
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!key || !fleet) return undefined;
    const missing = key.split('\n').filter((a) => !cache.current.has(a));
    if (!missing.length) return undefined;
    let live = true;
    const ctrl = new AbortController();
    void Promise.all(missing.map((arn) => readClusterEvidence(arn, fleet, ctrl.signal))).then((list) => {
      if (!live) return;
      list.forEach((ev, i) => cache.current.set(missing[i], ev));
      setVersion((v) => v + 1);
    });
    return () => { live = false; ctrl.abort(); };
  }, [key, fleet]);
  return useMemo(() => {
    const entries = key ? key.split('\n').map((a) => cache.current.get(a)) : [];
    const pending = !!key && (fleet === null || entries.some((e) => !e));
    const done = pending ? [] : (entries as ClusterEvidence[]);
    return {
      pending,
      traces: done.map((e) => ({ cluster: e.dbRefs.cluster, overlay: e.trace })),
      dbRefs: done.map((e) => e.dbRefs),
      failedDbRefs: done.filter((e) => e.dbRefsFailed).map((e) => e.dbRefs.cluster),
    };
  }, [key, fleet, version]); // `version` re-reads the ref cache after each committed batch
}
