'use client';

// Data loading for the site view (`/topology?view=site`). Everything is read from existing endpoints and
// composed in the browser (buildSiteFlow); every read is abort-safe and fails closed into a gap/notice:
//  - inventory: loadFlowInput with the page scope (full live rows, incl. CloudFront behaviors and ALB listener
//    rules). Any interactive type that failed, was capped, swept unstably or whose aggregate run is failed,
//    partial or running yields `inventory_incomplete`.
//  - EKS pod map + bindings: the scoped listing (`eksScope`). An all-region listing returns a discovery note that
//    withholds bindings (`binding_scope_partial`), so the EKS read gets EXPLICIT regions: the regions of the
//    connected clusters the fleet listing reports in the selected accounts. Inventory reads keep the page scope,
//    so no LB/TG row is dropped. Targets outside those regions stay unresolved (`eks_not_enumerated`).
//  - host account: `/api/accounts` (unique isHost row). Host inventory rows are keyed `self` while the listing
//    reports the numeric id, so `<hostId>|region` coverage is mirrored to `self|region`, and host clusters are
//    recognized when deriving the EKS scope. The EKS read waits for this lookup (evidence pending meanwhile).
//  - fleet listing (`/api/eks?accounts=__all__&regions=__all__&includeGlobal=1`, as K8sMapView): name
//    uniqueness for the trace join; truncation or a read error with a `reason` marks it incomplete.
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
import { scopeParams, ALL_ACCOUNTS, ALL_REGIONS } from '@/lib/account-context';
import { INTERACTIVE_FLOW_TYPES as TYPES } from '@/lib/flow-inventory-types';

export const FLEET_URL = `/api/eks?${scopeParams({ accounts: ALL_ACCOUNTS, regions: ALL_REGIONS, includeGlobal: true })}`;
const DEADLINE_MS = 30000;
const REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;

export interface FleetCluster { id: string; name: string; arn?: string; accountId?: string; region?: string; access?: string }
export interface Fleet { clusters: FleetCluster[]; names: string[]; incomplete: boolean }
export interface InventoryIssue { type: string; issue: 'failed' | 'capped' | 'incomplete' | 'running' | 'partial' }
export interface SiteInventory {
  flow: FlowGraph;
  cloudfrontRows: Row[];
  bindings: Binding[];
  eks: EksIpResolution | null;
  issues: InventoryIssue[];
  /** The scope string the EKS read used (explicit regions when derivable). */
  eksScope: string;
}

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Fleet listing body → clusters/names; any malformed, truncated or reasoned-error listing is incomplete. */
export function parseFleet(body: unknown): Fleet {
  const list = record(body) && Array.isArray(body.clusters) ? body.clusters : null;
  if (!list || !list.every((c) => record(c) && nonempty(c.name))) return { clusters: [], names: [], incomplete: true };
  const clusters = (list as Record<string, unknown>[]).map((c) => ({
    id: nonempty(c.id) ? c.id : String(c.name), name: String(c.name),
    ...(nonempty(c.arn) ? { arn: c.arn } : {}), ...(nonempty(c.accountId) ? { accountId: c.accountId } : {}),
    ...(nonempty(c.region) ? { region: c.region } : {}), ...(nonempty(c.access) ? { access: c.access } : {}),
  }));
  const errors = record(body) && Array.isArray(body.errors) ? body.errors : [];
  const incomplete = (record(body) && body.truncated === true) || errors.some((e) => record(e) && !!e.reason)
    || (record(body) && body.status === 'error');
  return { clusters, names: clusters.map((c) => c.id), incomplete };
}

/** Host-alias account of a listed cluster: bare-id rows are host default-region clusters by construction. */
const ownerOf = (c: FleetCluster, hostAccount: string | null) =>
  !c.id.startsWith('arn:') || (hostAccount && c.accountId === hostAccount) ? 'self' : c.accountId ?? '';

/**
 * The scope string for the EKS read. Explicit page regions pass through unchanged. For an all-region page
 * scope: the accounts and regions of the CONNECTED fleet clusters inside the selected accounts (smallest
 * listing that can bind pods; a non-connected cluster in a listed region would block that region's bindings).
 * Nothing derivable (no fleet, no connected cluster in scope) keeps the page scope, whose all-region note then
 * withholds bindings with a disclosed reason.
 */
export function deriveEksScope(inventoryScope: string, fleet: Fleet | null, hostAccount: string | null): string {
  const q = new URLSearchParams(inventoryScope);
  if ((q.get('regions') ?? ALL_REGIONS) !== ALL_REGIONS || !fleet) return inventoryScope;
  const accounts = q.get('accounts') || 'self';
  const selected = accounts === ALL_ACCOUNTS ? null : new Set(accounts.split(','));
  const inScope = fleet.clusters.filter((c) => c.access === 'connected' && nonempty(c.region) && REGION_RE.test(c.region)
    && ownerOf(c, hostAccount) && (!selected || selected.has(ownerOf(c, hostAccount))));
  const regions = [...new Set(inScope.map((c) => c.region!))].sort();
  if (!regions.length) return inventoryScope;
  const owners = [...new Set(inScope.map((c) => ownerOf(c, hostAccount)))].sort();
  return new URLSearchParams({ accounts: owners.join(','), regions: regions.join(','),
    includeGlobal: q.get('includeGlobal') ?? '1' }).toString();
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
    const host = fetch('/api/accounts', { signal })
      .then((r) => (r.ok ? r.json() : null)).then(hostAccountOf).catch(() => null);
    // Fail closed: a failed, aborted or unparseable fleet listing cannot prove name uniqueness.
    const fleetRead = fetch(FLEET_URL, { signal })
      .then((r) => (r.ok ? r.json() : null)).then(parseFleet)
      .catch(() => ({ clusters: [], names: [], incomplete: true }) as Fleet);
    void host.then((h) => { if (live) setHostAccount(h); });
    void fleetRead.then((f) => { if (live) setFleet(f); });
    const eksScope = Promise.all([host, fleetRead]).then(([h, f]) => deriveEksScope(inventoryScope, f, h));
    loadFlowInput(inventoryScope, signal, true, { eksScope: true, eksScopeQuery: eksScope })
      .then(async (loaded) => {
        const [h, scope] = await Promise.all([host, eksScope]);
        if (!live) return;
        if (loaded.allFailed) { setError(loaded.failed.map((r) => r.error).join('; ')); return; }
        const own = loaded.input.ownershipRead;
        if (own?.eksAccountRegions) own.eksAccountRegions = withHostAlias(own.eksAccountRegions, h);
        const issues: InventoryIssue[] = [];
        TYPES.forEach((type, i) => {
          const r = loaded.res[i];
          // A missing ledger (`unknown`) is not flagged here: critical types already require one, and a
          // never-collected optional type would otherwise flag every load.
          const issue: InventoryIssue['issue'] | null = r.readFailed ? 'failed' : r.incomplete ? 'incomplete' : r.capped ? 'capped'
            : r.aggregateStatus === 'failed' || r.aggregateStatus === 'partial' || r.aggregateStatus === 'running' ? r.aggregateStatus : null;
          if (issue) issues.push({ type, issue });
        });
        setData({
          flow: buildFlowGraph(loaded.input),
          cloudfrontRows: (loaded.input.cloudfront ?? []) as Row[],
          bindings: loaded.eks?.bindings ?? [],
          eks: loaded.eks, issues, eksScope: scope,
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
