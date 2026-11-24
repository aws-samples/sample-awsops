'use client';

// K8s namespaced service graph (Kiali-style), per registered cluster.
// Data flow per selected cluster (all reads abort/stale-safe: switching clusters aborts in-flight
// requests, clears state, and every late result is dropped by the `live` flag / `signal.aborted`):
//  - in-cluster kinds ingresses/services/pods/endpoints (failed kinds are disclosed, never hidden)
//  - db-refs (config-inferred datastores; failure/partial/truncated and a capped or unconfirmed inventory match are disclosed, the graph still renders)
//  - trace overlay (host and member clusters alike; the module refuses ambiguous clusters and an
//    incomplete listing itself). Name uniqueness is checked against the FLEET-wide listing, not the
//    selector's scope: a narrowed scope (incl. the UI default, host account only — DEFAULT_SCOPE in
//    web/lib/account-context.ts, resolved by getEksScope in web/lib/eks-scope.ts) hides same-named clusters
//    of other accounts/regions without any truncated/error disclosure. The fleet is read per registered
//    account (web/lib/eks-fleet.ts readFleet, from the same /api/accounts body) plus /api/eks/registrations
//    (uniqueness = listed ∪ registered clusters): a single all-account listing is capped at 12 account×region
//    targets and truncates on a real fleet. The trace read therefore
//    waits for the /api/accounts lookup; a failed or malformed lookup fails the join closed (incomplete_listing).
//  - Route53 records for the cluster's account (a capped or failed read is disclosed; the graph still renders).
//    An ARN id reads 'self' only when its account equals the unique isHost account of /api/accounts;
//    if that lookup fails, an ARN id reads its own numeric account.
//  - nodes LAZILY, the first time a Service is selected (detail panel only).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import ServiceGraphCanvas from '@/components/topology/ServiceGraphCanvas';
import { buildServiceGraph, filterGraphInputByNamespace, SYSTEM_NAMESPACES, type GraphInput } from '@/lib/k8s-service-graph';
import { fetchTraceOverlay, type TraceOverlay, type TraceOverlayReason } from '@/lib/k8s-trace-overlay';
import { fetchDnsRecords, type DnsRead } from '@/lib/k8s-dns';
import type { DbRef, SecretRef } from '@/lib/eks-db-refs';
import type { DbResource } from '@/lib/db-ref-resolve';
import type { IngressRow, ServiceRow, EndpointRow } from '@/lib/eks-incluster';
import type { PodRow, NodeRow } from '@/lib/eks-resources';
import { useI18n } from '@/components/shell/LanguageProvider';
import { useTheme } from '@/lib/use-theme';
import { useActiveScope, scopeParams } from '@/lib/account-context';
import { readFleet } from '@/lib/eks-fleet';
import { eksClusterLabel, parseEksClusterId } from '@/lib/eks-cluster-id';
import { EksCollectionNotice, type EksCollectionStatus } from '@/components/eks/EksFilterPanel';
import { hostAccountOf } from '@/lib/host-account';

const KINDS = ['ingresses', 'services', 'pods', 'endpoints'] as const;

interface ClusterRows { ingresses: IngressRow[]; services: ServiceRow[]; pods: PodRow[]; endpoints: EndpointRow[]; failedKinds: string[] }
type ResolvedRef = DbRef & { resource: DbResource | null };
type DbRefsState =
  | { status: 'ok'; refs: ResolvedRef[]; secretRefs: SecretRef[]; truncated: boolean; partial: boolean; inventoryCapped: boolean; inventoryIncomplete: boolean }
  | { status: 'failed' };
type NodesState = { status: 'loading' | 'failed'; rows: NodeRow[] } | { status: 'ok'; rows: NodeRow[] };

// One notice per non-available trace-overlay reason (Korean source, translated via tt()).
export const TRACE_NOTICE: Record<TraceOverlayReason, string> = {
  disabled: '트레이스 토폴로지가 비활성화되어 있어 트레이스로 관측된 호출을 표시하지 않습니다.',
  unsupported_scope: '현재 범위에서는 트레이스로 관측된 호출을 표시할 수 없습니다.',
  unavailable: '트레이스 스냅샷을 읽지 못해 트레이스로 관측된 호출을 표시하지 않습니다.',
  ambiguous_cluster: '같은 이름의 클러스터가 여러 개라 트레이스 호출을 이 클러스터에 연결할 수 없습니다.',
  incomplete_listing: '클러스터 목록이 일부만 조회되어 같은 이름의 클러스터가 없는지 확인할 수 없으므로 트레이스로 관측된 호출을 표시하지 않습니다.',
  partial_snapshot: '트레이스 스냅샷이 일부만 수집되었거나 오래된 원본을 포함해 트레이스로 관측된 호출을 표시하지 않습니다.',
};

/**
 * Visible notice for an available but partially read trace snapshot (page/edge caps): the overlay
 * then yields no calls, and `omitted` is the real number of snapshot records it could not inspect.
 * Korean source, translated through an i18n RULE (lockstep-tested).
 */
export const traceOmittedNotice = (omitted: number) =>
  `트레이스 스냅샷이 커서 전부 읽지 못해 트레이스로 관측된 호출을 표시하지 않습니다 (확인하지 못한 레코드 ${omitted}개).`;

/**
 * Account whose Route53 inventory is read. Inventory keys host rows as 'self', so a bare-name id and an
 * ARN whose account is the resolved host account both read 'self'; any other ARN reads its own account.
 * With an unknown host account (null) an ARN keeps its numeric account (the conservative member handling).
 * Route53 only: the trace join gates host and member clusters alike and never reads the host account.
 */
const dnsAccountOf = (id: string, hostAccountId: string | null) => {
  const account = parseEksClusterId(id)?.accountId;
  return !account || account === hostAccountId ? 'self' : account;
};

async function readJson(r: Response): Promise<Record<string, unknown>> {
  // An OK response must parse; error bodies are best-effort only (message is never shown for kinds).
  if (r.ok) return r.json();
  const d = await r.json().catch(() => ({}));
  throw new Error(String(d?.message ?? r.status));
}

/** `initialCluster` (a listed cluster id, e.g. from `?cluster=` deep links) preselects that cluster when the
 *  scoped listing contains it; otherwise the first connected cluster is selected as before. */
export default function K8sMapView({ query, initialCluster = '' }: { query: string; initialCluster?: string }) {
  // Only 'dark' is a dark theme (cobalt/teal are light variants) — same mapping as /topology.
  const theme = useTheme() === 'dark' ? 'dark' as const : 'light' as const;
  const { tt } = useI18n();
  const [clusters, setClusters] = useState<{ id: string; label: string }[] | null>(null);
  const [cluster, setCluster] = useState('');
  const initialClusterRef = useRef(initialCluster);
  const [err, setErr] = useState('');
  const [collection, setCollection] = useState<EksCollectionStatus>({});
  const [scope, , scopeReady] = useActiveScope();
  const scopeQuery = scopeParams(scope);
  const [rows, setRows] = useState<ClusterRows | null>(null);
  const [dbRefs, setDbRefs] = useState<DbRefsState | null>(null);
  const [trace, setTrace] = useState<TraceOverlay | null>(null);
  const [dnsRead, setDnsRead] = useState<DnsRead | null>(null);
  const [nodes, setNodes] = useState<NodesState | null>(null);
  const nodesAbort = useRef<AbortController | null>(null);
  const [hiddenNs, setHiddenNs] = useState<ReadonlySet<string>>(new Set());
  const [showSystem, setShowSystem] = useState(false);
  // `/api/accounts` body: the host account id (Route53 read of ARN-identified clusters) and the fleet's account
  // list. undefined = lookup pending; null = failed (the host is then not determinable, the fleet incomplete).
  const [accountsBody, setAccountsBody] = useState<unknown>(undefined);
  const hostAccount = accountsBody === undefined ? undefined : hostAccountOf(accountsBody);
  useEffect(() => {
    let live = true;
    fetch('/api/accounts')
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => { if (live) setAccountsBody(body ?? null); })
      .catch(() => { if (live) setAccountsBody(null); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!scopeReady) return;
    let live = true;
    setClusters(null);
    setCluster('');
    setErr('');
    setCollection({});
    // Follows the shared account/region selector like /eks. Member clusters are keyed by their full
    // EKS ARN (`id`), which the in-cluster route resolves to the member read role — never by bare
    // name, so a name shared by two accounts can never render the other cluster's data.
    fetch(`/api/eks?${scopeQuery}`)
      .then(async (r) => {
        // An OK response must parse: an unparseable body (e.g. a login page after session expiry)
        // is a failed listing, never an empty complete one. Error bodies are best-effort only.
        if (r.ok) return r.json();
        const d = await r.json().catch(() => ({}));
        throw new Error(String(d?.message ?? r.status));
      })
      .then((d: { clusters?: { id?: string; name: string; access?: string }[]; errors?: EksCollectionStatus['errors']; truncated?: boolean }) => {
        if (!live) return;
        const listed = d.clusters ?? [];
        // Only 'connected' clusters are readable in-cluster — others would 502 on first fetch.
        const rows = listed.filter((c) => c.access === 'connected').map((c) => {
          const id = c.id || c.name;
          return { id, label: eksClusterLabel(id) };
        });
        setClusters(rows);
        const wanted = initialClusterRef.current;
        if (rows.length > 0) setCluster((cur) => cur || (rows.some((c) => c.id === wanted) ? wanted : rows[0].id));
        // Same disclosure as /eks: scope notes, per-target read failures and truncation stay visible.
        setCollection({ errors: Array.isArray(d.errors) ? d.errors : undefined, truncated: !!d.truncated });
      })
      .catch((e) => { if (live) { setClusters([]); setErr(String(e instanceof Error ? e.message : e)); } });
    return () => { live = false; };
  }, [scopeQuery, scopeReady]);

  // Fleet listing for the trace join's name-uniqueness check only (never the cluster selector). A
  // narrowed scope hides same-named clusters of other accounts/regions without disclosure (see header),
  // so uniqueness is proven against every registered account's all-region listing. null = pending.
  const [fleetRead, setFleetRead] = useState<{ names: string[]; incomplete: boolean } | null>(null);
  useEffect(() => {
    setFleetRead(null);
    if (accountsBody === undefined) return;
    let live = true;
    const ctrl = new AbortController();
    // readFleet fails closed (failed, aborted, unparseable, truncated or reasoned-error listing → incomplete).
    void readFleet(accountsBody, ctrl.signal)
      .then((f) => { if (live && !ctrl.signal.aborted) setFleetRead({ names: f.names, incomplete: f.incomplete }); });
    return () => { live = false; ctrl.abort(); };
  }, [accountsBody]);

  // Only a real read failure (route `eksReadFailure` shape carries `reason`) or truncation makes the
  // listing incomplete; the informational wildcard-scope note does not. An incomplete listing also
  // cannot prove the selected name is unique, so it blocks the trace join.
  const inconclusive = !!collection.truncated || (collection.errors ?? []).some((e) => !!e.reason);
  const fleet = fleetRead;
  // Stable effect keys (null = fleet listing pending).
  const fleetNamesKey = fleet ? fleet.names.join('\n') : null;
  const traceListingIncomplete = inconclusive || !!fleet?.incomplete;
  // Only an ARN id's Route53 read needs the host account. A bare name is the host by construction, so it
  // neither waits for the lookup nor re-reads when it settles. undefined = an ARN id whose lookup is still pending.
  const hostForCluster = cluster && parseEksClusterId(cluster)?.accountId ? hostAccount : null;
  useEffect(() => {
    // Switching clusters (or scope) clears every per-cluster piece before anything new arrives.
    setRows(null);
    setDbRefs(null);
    setNodes(null);
    setHiddenNs(new Set());
    if (!cluster) return;
    let live = true;
    const ctrl = new AbortController();
    const { signal } = ctrl;
    // Same addressing as before: the encoded cluster id (full ARN for members) carries the scope;
    // these single-cluster routes reject the collection scope params (`accounts`/`regions`).
    const base = `/api/eks/${encodeURIComponent(cluster)}`;
    const current = () => live && !signal.aborted;

    Promise.allSettled(KINDS.map(async (kind) => {
      const d = await readJson(await fetch(`${base}/incluster?kind=${kind}`, { signal }));
      return [kind, Array.isArray(d.rows) ? d.rows : []] as const;
    })).then((settled) => {
      if (!current()) return;
      const got: Record<string, unknown[]> = {};
      const failedKinds: string[] = [];
      settled.forEach((s, i) => {
        if (s.status === 'fulfilled') got[s.value[0]] = s.value[1];
        else failedKinds.push(KINDS[i]);
      });
      setRows({
        ingresses: (got.ingresses ?? []) as IngressRow[], services: (got.services ?? []) as ServiceRow[],
        pods: (got.pods ?? []) as PodRow[], endpoints: (got.endpoints ?? []) as EndpointRow[], failedKinds,
      });
    });

    fetch(`${base}/db-refs`, { signal })
      .then(readJson)
      .then((d) => {
        if (!current()) return;
        if (!Array.isArray(d.refs) || !Array.isArray(d.secretRefs)) throw new Error('malformed');
        setDbRefs({ status: 'ok', refs: d.refs as ResolvedRef[],
          secretRefs: d.secretRefs as SecretRef[], truncated: d.truncated === true, partial: d.partial === true,
          inventoryCapped: d.inventoryCapped === true, inventoryIncomplete: d.inventoryIncomplete === true });
      })
      .catch(() => { if (current()) setDbRefs({ status: 'failed' }); });

    return () => {
      live = false;
      ctrl.abort();
      nodesAbort.current?.abort();
      nodesAbort.current = null;
    };
  }, [cluster]);

  useEffect(() => {
    setTrace(null);
    // The join waits for the per-account fleet, which itself depends on the /api/accounts lookup
    // (name uniqueness is checked against that fleet; see header): host and member clusters are gated alike.
    if (!cluster || fleetNamesKey === null) return;
    let live = true;
    const ctrl = new AbortController();
    const { signal } = ctrl;
    const current = () => live && !signal.aborted;
    fetchTraceOverlay({
      id: cluster, registeredNames: fleetNamesKey ? fleetNamesKey.split('\n') : [], listingIncomplete: traceListingIncomplete,
    }, signal)
      .then((o) => { if (current()) setTrace(o); })
      .catch(() => { if (current()) setTrace({ available: false, reason: 'unavailable', workloadCalls: [], omitted: 0 }); });
    return () => { live = false; ctrl.abort(); };
  }, [cluster, fleetNamesKey, traceListingIncomplete]);

  // Route53 does not depend on the fleet listing; only an ARN id waits for the host-account lookup.
  useEffect(() => {
    setDnsRead(null);
    if (!cluster || hostForCluster === undefined) return;
    let live = true;
    const ctrl = new AbortController();
    const { signal } = ctrl;
    const current = () => live && !signal.aborted;
    fetchDnsRecords(dnsAccountOf(cluster, hostForCluster), signal)
      .then((r) => { if (current()) setDnsRead(r); })
      .catch(() => { if (current()) setDnsRead({ records: [], truncated: false, failed: true, incomplete: false }); });
    return () => { live = false; ctrl.abort(); };
  }, [cluster, hostForCluster]);

  // Nodes only feed the detail panel: read them the first time a Service is selected (again after a failure).
  const nodesStatus = nodes?.status;
  const onSelectService = useCallback(() => {
    if (!cluster || nodesStatus === 'loading' || nodesStatus === 'ok') return;
    const ctrl = new AbortController();
    nodesAbort.current = ctrl;
    setNodes({ status: 'loading', rows: [] });
    fetch(`/api/eks/${encodeURIComponent(cluster)}/incluster?kind=nodes`, { signal: ctrl.signal })
      .then(readJson)
      .then((d) => { if (!ctrl.signal.aborted) setNodes({ status: 'ok', rows: (Array.isArray(d.rows) ? d.rows : []) as NodeRow[] }); })
      .catch(() => { if (!ctrl.signal.aborted) setNodes({ status: 'failed', rows: [] }); });
  }, [cluster, nodesStatus]);

  // Graph input WITHOUT nodes: nodes never change the graph, so a lazy node read never re-lays it out.
  const fullInput = useMemo<Omit<GraphInput, 'nodes'> | null>(() => rows && {
    services: rows.services, endpoints: rows.endpoints, pods: rows.pods, ingresses: rows.ingresses,
    dbRefs: dbRefs?.status === 'ok' ? dbRefs.refs : [], secretRefs: dbRefs?.status === 'ok' ? dbRefs.secretRefs : [],
    trace, dns: dnsRead?.records ?? [],
  }, [rows, dbRefs, trace, dnsRead]);

  const allNamespaces = useMemo(() => {
    if (!rows) return [];
    return [...new Set([...rows.services, ...rows.ingresses].map((r) => r.namespace))].sort();
  }, [rows]);
  const listedNamespaces = allNamespaces.filter((ns) => showSystem || !SYSTEM_NAMESPACES.has(ns));
  const visible = useCallback((ns: string) => (showSystem || !SYSTEM_NAMESPACES.has(ns)) && !hiddenNs.has(ns), [showSystem, hiddenNs]);

  const filtered = useMemo(() => fullInput && filterGraphInputByNamespace({ ...fullInput, nodes: [] }, visible), [fullInput, visible]);
  const graph = useMemo(() => filtered && buildServiceGraph(filtered), [filtered]);
  const nodeRows = nodes?.rows;
  const canvasInput = useMemo<GraphInput | null>(() => filtered && { ...filtered, nodes: nodeRows ?? [] }, [filtered, nodeRows]);

  const toggleNs = (ns: string) => setHiddenNs((prev) => {
    const next = new Set(prev);
    if (next.has(ns)) next.delete(ns); else next.add(ns);
    return next;
  });

  if (clusters !== null && clusters.length === 0 && !err) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-[13px] text-ink-500">
        <EksCollectionNotice status={collection} />
        {!inconclusive && <span>{tt('연결된 EKS 클러스터가 없습니다 —')} <Link href="/eks" className="text-brand-700 underline">{tt('/eks에서 클러스터를 등록')}</Link>{tt('하세요.')}</span>}
      </div>
    );
  }

  const busy = !!cluster && rows === null;
  const evidencePending = !!rows && (dbRefs === null || trace === null || dnsRead === null);
  const visibleCount = listedNamespaces.filter((ns) => !hiddenNs.has(ns)).length;
  const notices: string[] = [];
  if (rows?.failedKinds.length) notices.push(`${tt('일부 리소스를 조회하지 못했습니다:')} ${rows.failedKinds.join(', ')}`);
  if (dbRefs?.status === 'failed') notices.push(tt('데이터 저장소 참조를 불러오지 못해 설정 기반 연결을 표시하지 않습니다.'));
  if (dbRefs?.status === 'ok' && dbRefs.partial) notices.push(tt('일부 워크로드의 설정을 읽지 못해 데이터 저장소 연결이 일부만 표시됩니다.'));
  if (dbRefs?.status === 'ok' && dbRefs.truncated) notices.push(tt('데이터 저장소 참조 조회가 상한에 도달해 일부만 표시됩니다.'));
  if (dbRefs?.status === 'ok' && dbRefs.inventoryIncomplete) notices.push(tt('인벤토리 동기화 완료를 확인할 수 없어 일부 데이터 저장소를 인벤토리 리소스와 연결하지 않고 호스트 이름으로 표시합니다.'));
  if (dbRefs?.status === 'ok' && dbRefs.inventoryCapped) notices.push(tt('인벤토리 조회가 상한에 도달해 일부 데이터 저장소를 인벤토리 리소스와 연결하지 않고 호스트 이름으로 표시합니다.'));
  if (dnsRead?.truncated) notices.push(tt('Route 53 레코드 조회가 상한에 도달해 DNS 연결이 일부만 표시될 수 있습니다.'));
  if (dnsRead?.failed) notices.push(tt('Route 53 레코드를 불러오지 못해 DNS 연결을 표시하지 않습니다.'));
  if (dnsRead?.incomplete) notices.push(tt('Route 53 인벤토리 동기화 완료를 확인할 수 없어 DNS 연결을 표시하지 않습니다.'));
  if (trace && !trace.available) notices.push(tt(TRACE_NOTICE[trace.reason ?? 'unavailable']));
  if (trace?.available && trace.omitted > 0) notices.push(tt(traceOmittedNotice(trace.omitted)));
  if (nodes?.status === 'failed') notices.push(tt('노드 정보를 불러오지 못했습니다.'));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-4 pt-1"><EksCollectionNotice status={collection} /></div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-1 text-[11px] text-ink-500">
        <select
          aria-label={tt('클러스터')}
          value={cluster}
          onChange={(e) => setCluster(e.target.value)}
          className="rounded-md border border-ink-200 bg-card px-2 py-1 text-[12px]"
        >
          {(clusters ?? []).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        {rows && (
          <details className="relative">
            <summary className="cursor-pointer list-none rounded-md border border-ink-200 bg-card px-2 py-1 text-[12px]">
              {`${tt('네임스페이스')}: ${visibleCount}/${listedNamespaces.length}`}
            </summary>
            <div className="absolute left-0 z-20 mt-1 max-h-72 min-w-48 space-y-1 overflow-auto rounded-md border border-ink-200 bg-card p-2 text-[12px] shadow-pop">
              {listedNamespaces.map((ns) => (
                <label key={ns} className="flex items-center gap-2">
                  <input type="checkbox" checked={!hiddenNs.has(ns)} onChange={() => toggleNs(ns)} />
                  <span>{ns}</span>
                </label>
              ))}
            </div>
          </details>
        )}
        {rows && (
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} />
            <span>{tt('시스템 네임스페이스 표시')}</span>
          </label>
        )}
        {busy && <span>{tt('불러오는 중…')}</span>}
        {evidencePending && <span>{tt('연결 근거(데이터 저장소·트레이스·DNS)를 불러오는 중…')}</span>}
        {nodes?.status === 'loading' && <span>{tt('노드 정보를 불러오는 중…')}</span>}
        {err && <span className="text-red-600">{tt('조회 실패:')} {err}</span>}
      </div>
      {notices.length > 0 && (
        <div role="status" className="flex flex-col gap-0.5 px-4 pb-1 text-[11px] text-warning-text">
          {notices.map((n) => <span key={n}>{n}</span>)}
        </div>
      )}
      {graph && canvasInput && (
        <ServiceGraphCanvas graph={graph} input={canvasInput} query={query} theme={theme} onSelectService={onSelectService} />
      )}
    </div>
  );
}
