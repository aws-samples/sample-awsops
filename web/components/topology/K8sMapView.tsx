'use client';

// K8s namespaced service graph (Kiali-style), per registered cluster.
// Data flow per selected cluster (all reads abort/stale-safe: switching clusters aborts in-flight
// requests, clears state, and every late result is dropped by the `live` flag / `signal.aborted`):
//  - in-cluster kinds ingresses/services/pods/endpoints (failed kinds are disclosed, never hidden)
//  - db-refs (config-inferred datastores; failure/partial/truncated is disclosed, the graph still renders)
//  - trace overlay (host-only snapshot; the module refuses member/ambiguous clusters itself)
//  - Route53 records for the cluster's account (optional; any failure yields none)
//  - nodes LAZILY, the first time a Service is selected (detail panel only).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import ServiceGraphCanvas from '@/components/topology/ServiceGraphCanvas';
import { buildServiceGraph, filterGraphInputByNamespace, SYSTEM_NAMESPACES, type GraphInput } from '@/lib/k8s-service-graph';
import { fetchTraceOverlay, type TraceOverlay, type TraceOverlayReason } from '@/lib/k8s-trace-overlay';
import { fetchDnsRecords, type DnsRecord } from '@/lib/k8s-dns';
import type { DbRef, SecretRef } from '@/lib/eks-db-refs';
import type { DbResource } from '@/lib/db-ref-resolve';
import type { IngressRow, ServiceRow, EndpointRow } from '@/lib/eks-incluster';
import type { PodRow, NodeRow } from '@/lib/eks-resources';
import { useI18n } from '@/components/shell/LanguageProvider';
import { useTheme } from '@/lib/use-theme';
import { useActiveScope, scopeParams } from '@/lib/account-context';
import { eksClusterLabel, parseEksClusterId } from '@/lib/eks-cluster-id';
import { EksCollectionNotice, type EksCollectionStatus } from '@/components/eks/EksFilterPanel';

const KINDS = ['ingresses', 'services', 'pods', 'endpoints'] as const;

interface ClusterRows { ingresses: IngressRow[]; services: ServiceRow[]; pods: PodRow[]; endpoints: EndpointRow[]; failedKinds: string[] }
type ResolvedRef = DbRef & { resource: DbResource | null };
type DbRefsState =
  | { status: 'ok'; refs: ResolvedRef[]; secretRefs: SecretRef[]; truncated: boolean; partial: boolean }
  | { status: 'failed' };
type NodesState = { status: 'loading' | 'failed'; rows: NodeRow[] } | { status: 'ok'; rows: NodeRow[] };

// One notice per non-available trace-overlay reason (Korean source, translated via tt()).
export const TRACE_NOTICE: Record<TraceOverlayReason, string> = {
  disabled: '트레이스 토폴로지가 비활성화되어 있어 트레이스로 관측된 호출을 표시하지 않습니다.',
  unsupported_scope: '현재 범위에서는 트레이스로 관측된 호출을 표시할 수 없습니다.',
  unavailable: '트레이스 스냅샷을 읽지 못해 트레이스로 관측된 호출을 표시하지 않습니다.',
  ambiguous_cluster: '같은 이름의 클러스터가 여러 개라 트레이스 호출을 이 클러스터에 연결할 수 없습니다.',
  member_cluster: '멤버 계정 클러스터에는 트레이스로 관측된 호출을 표시하지 않습니다 (호스트 계정 전용).',
};

/** Account whose Route53 inventory is read: a bare-name id is the host ('self'); an ARN carries its account. */
const dnsAccountOf = (id: string) => parseEksClusterId(id)?.accountId ?? 'self';

async function readJson(r: Response): Promise<Record<string, unknown>> {
  // An OK response must parse; error bodies are best-effort only (message is never shown for kinds).
  if (r.ok) return r.json();
  const d = await r.json().catch(() => ({}));
  throw new Error(String(d?.message ?? r.status));
}

export default function K8sMapView({ query }: { query: string }) {
  // Only 'dark' is a dark theme (cobalt/teal are light variants) — same mapping as /topology.
  const theme = useTheme() === 'dark' ? 'dark' as const : 'light' as const;
  const { tt } = useI18n();
  const [clusters, setClusters] = useState<{ id: string; label: string }[] | null>(null);
  // Every listed cluster id in scope (any access state): the trace join requires a unique name.
  const [registeredNames, setRegisteredNames] = useState<string[]>([]);
  const [cluster, setCluster] = useState('');
  const [err, setErr] = useState('');
  const [collection, setCollection] = useState<EksCollectionStatus>({});
  const [scope, , scopeReady] = useActiveScope();
  const scopeQuery = scopeParams(scope);
  const [rows, setRows] = useState<ClusterRows | null>(null);
  const [dbRefs, setDbRefs] = useState<DbRefsState | null>(null);
  const [trace, setTrace] = useState<TraceOverlay | null>(null);
  const [dns, setDns] = useState<DnsRecord[]>([]);
  const [nodes, setNodes] = useState<NodesState | null>(null);
  const nodesAbort = useRef<AbortController | null>(null);
  const [hiddenNs, setHiddenNs] = useState<ReadonlySet<string>>(new Set());
  const [showSystem, setShowSystem] = useState(false);

  useEffect(() => {
    if (!scopeReady) return;
    let live = true;
    setClusters(null);
    setRegisteredNames([]);
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
        setRegisteredNames(listed.map((c) => c.id || c.name));
        if (rows.length > 0) setCluster((cur) => cur || rows[0].id);
        // Same disclosure as /eks: scope notes, per-target read failures and truncation stay visible.
        setCollection({ errors: Array.isArray(d.errors) ? d.errors : undefined, truncated: !!d.truncated });
      })
      .catch((e) => { if (live) { setClusters([]); setErr(String(e instanceof Error ? e.message : e)); } });
    return () => { live = false; };
  }, [scopeQuery, scopeReady]);

  const namesKey = registeredNames.join('\n');
  useEffect(() => {
    // Switching clusters (or scope) clears every per-cluster piece before anything new arrives.
    setRows(null);
    setDbRefs(null);
    setTrace(null);
    setDns([]);
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
          secretRefs: d.secretRefs as SecretRef[], truncated: d.truncated === true, partial: d.partial === true });
      })
      .catch(() => { if (current()) setDbRefs({ status: 'failed' }); });

    // hostAccountId is not knowable from the /api/eks listing (every row carries a numeric account),
    // so it stays undefined: a host cluster outside the default region (ARN id) is refused as a member.
    fetchTraceOverlay({ id: cluster, registeredNames: namesKey ? namesKey.split('\n') : [] }, signal)
      .then((o) => { if (current()) setTrace(o); });

    fetchDnsRecords(dnsAccountOf(cluster), signal)
      .then((r) => { if (current()) setDns(r); });

    return () => {
      live = false;
      ctrl.abort();
      nodesAbort.current?.abort();
      nodesAbort.current = null;
    };
  }, [cluster, namesKey]);

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
    trace, dns,
  }, [rows, dbRefs, trace, dns]);

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

  // Only a real read failure (route `eksReadFailure` shape carries `reason`) or truncation makes an
  // empty listing inconclusive; the informational wildcard-scope note does not.
  const inconclusive = !!collection.truncated || (collection.errors ?? []).some((e) => !!e.reason);
  if (clusters !== null && clusters.length === 0 && !err) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-[13px] text-ink-500">
        <EksCollectionNotice status={collection} />
        {!inconclusive && <span>{tt('연결된 EKS 클러스터가 없습니다 —')} <Link href="/eks" className="text-brand-700 underline">{tt('/eks에서 클러스터를 등록')}</Link>{tt('하세요.')}</span>}
      </div>
    );
  }

  const busy = !!cluster && rows === null;
  const visibleCount = listedNamespaces.filter((ns) => !hiddenNs.has(ns)).length;
  const notices: string[] = [];
  if (rows?.failedKinds.length) notices.push(`${tt('일부 리소스를 조회하지 못했습니다:')} ${rows.failedKinds.join(', ')}`);
  if (dbRefs?.status === 'failed') notices.push(tt('데이터 저장소 참조를 불러오지 못해 설정 기반 연결을 표시하지 않습니다.'));
  if (dbRefs?.status === 'ok' && dbRefs.partial) notices.push(tt('일부 워크로드의 설정을 읽지 못해 데이터 저장소 연결이 일부만 표시됩니다.'));
  if (dbRefs?.status === 'ok' && dbRefs.truncated) notices.push(tt('데이터 저장소 참조 조회가 상한에 도달해 일부만 표시됩니다.'));
  if (trace && !trace.available) notices.push(tt(TRACE_NOTICE[trace.reason ?? 'unavailable']));
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
