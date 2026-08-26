'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import DataTable, { type Column } from '@/components/ui/DataTable';
import DetailPanel from '@/components/ui/DetailPanel';
import PageHeader from '@/components/ui/PageHeader';
import RefreshButton from '@/components/ui/RefreshButton';
import SegmentedControl from '@/components/ui/SegmentedControl';
import Input from '@/components/ui/Input';

// EKS 탐색기 — v1 K9s-style explorer parity. Read-only browser over the
// in-cluster BFF: kind tabs (k9s lowercase), cluster picker ('전체 클러스터'
// merges every connected cluster with a leading CLUSTER column), 30s
// auto-refresh, client-side 검색/namespace/status filters and '더 보기' paging.
// The K9s flavor comes from UPPERCASE column labels — the standard light
// DataTable stays (no dark fork).

type Row = Record<string, unknown>;
type Kind =
  | 'pods' | 'deployments' | 'services' | 'replicasets' | 'daemonsets'
  | 'statefulsets' | 'jobs' | 'configmaps' | 'pvcs' | 'nodes' | 'events';

// k9s-style lowercase tab labels (SegmentedControl accepts plain strings).
const KINDS: Kind[] = [
  'pods', 'deployments', 'services', 'replicasets', 'daemonsets',
  'statefulsets', 'jobs', 'configmaps', 'pvcs', 'nodes', 'events',
];

const ALL_CLUSTERS = '__all__';
const ALL = '전체';

const CLUSTER_COL: Column = { key: 'cluster', label: 'CLUSTER' };

// Per-kind columns mirror the normalized row types in lib/eks-incluster.ts
// (PodRow/DeploymentRow/ServiceRow + explorer kinds ReplicaSetRow{desired,ready},
// DaemonSetRow{desired,current,ready}, StatefulSetRow{ready}, JobRow{completions,status},
// ConfigMapRow{keys}, PvcRow{status,volume,capacity,storageClass}).
const COLUMNS: Record<Kind, Column[]> = {
  pods: [
    { key: 'name', label: 'NAME' },
    { key: 'namespace', label: 'NAMESPACE' },
    { key: 'status', label: 'STATUS' },
    { key: 'node', label: 'NODE' },
    { key: 'restarts', label: 'RESTARTS' },
    { key: 'age', label: 'AGE' },
  ],
  deployments: [
    { key: 'name', label: 'NAME' },
    { key: 'namespace', label: 'NAMESPACE' },
    { key: 'ready', label: 'READY' },
    { key: 'upToDate', label: 'UP-TO-DATE' },
    { key: 'available', label: 'AVAILABLE' },
    { key: 'age', label: 'AGE' },
  ],
  services: [
    { key: 'name', label: 'NAME' },
    { key: 'namespace', label: 'NAMESPACE' },
    { key: 'type', label: 'TYPE' },
    { key: 'clusterIP', label: 'CLUSTER-IP' },
    { key: 'ports', label: 'PORTS' },
    { key: 'age', label: 'AGE' },
  ],
  replicasets: [
    { key: 'name', label: 'NAME' },
    { key: 'namespace', label: 'NAMESPACE' },
    { key: 'desired', label: 'DESIRED' },
    { key: 'ready', label: 'READY' },
    { key: 'age', label: 'AGE' },
  ],
  daemonsets: [
    { key: 'name', label: 'NAME' },
    { key: 'namespace', label: 'NAMESPACE' },
    { key: 'desired', label: 'DESIRED' },
    { key: 'current', label: 'CURRENT' },
    { key: 'ready', label: 'READY' },
    { key: 'age', label: 'AGE' },
  ],
  statefulsets: [
    { key: 'name', label: 'NAME' },
    { key: 'namespace', label: 'NAMESPACE' },
    { key: 'ready', label: 'READY' },
    { key: 'age', label: 'AGE' },
  ],
  jobs: [
    { key: 'name', label: 'NAME' },
    { key: 'namespace', label: 'NAMESPACE' },
    { key: 'completions', label: 'COMPLETIONS' },
    { key: 'status', label: 'STATUS' },
    { key: 'age', label: 'AGE' },
  ],
  configmaps: [
    { key: 'name', label: 'NAME' },
    { key: 'namespace', label: 'NAMESPACE' },
    { key: 'keys', label: 'KEYS' },
    { key: 'age', label: 'AGE' },
  ],
  pvcs: [
    { key: 'name', label: 'NAME' },
    { key: 'namespace', label: 'NAMESPACE' },
    { key: 'status', label: 'STATUS' },
    { key: 'volume', label: 'VOLUME' },
    { key: 'capacity', label: 'CAPACITY' },
    { key: 'storageClass', label: 'STORAGECLASS' },
    { key: 'age', label: 'AGE' },
  ],
  nodes: [
    { key: 'name', label: 'NAME' },
    { key: 'status', label: 'STATUS' },
    { key: 'roles', label: 'ROLES' },
    { key: 'version', label: 'VERSION' },
    { key: 'instanceType', label: 'INSTANCE-TYPE' },
    { key: 'zone', label: 'ZONE' },
    { key: 'age', label: 'AGE' },
  ],
  events: [
    { key: 'kind', label: 'KIND' },
    { key: 'object', label: 'OBJECT' },
    { key: 'reason', label: 'REASON' },
    { key: 'message', label: 'MESSAGE' },
    { key: 'count', label: 'COUNT' },
    { key: 'lastSeen', label: 'LAST SEEN' },
  ],
};

// Kinds carrying a `namespace` field → namespace <select> shows.
const NAMESPACED: Set<Kind> = new Set([
  'pods', 'deployments', 'services', 'replicasets', 'daemonsets',
  'statefulsets', 'jobs', 'configmaps', 'pvcs',
]);

// Kinds with a status/phase-ish column → status <select> shows.
const STATUS_KEY: Partial<Record<Kind, string>> = {
  pods: 'status',
  jobs: 'status',
  pvcs: 'status',
  nodes: 'status',
};

const PAGE_SIZE = 100;

const selCls = 'rounded-md border border-ink-200 bg-card px-2 py-1 font-mono text-[12px] text-ink-700';
const btnCls = 'rounded-md border border-ink-200 px-2 py-0.5 text-[11px] text-ink-600 hover:bg-ink-100 disabled:opacity-50';

interface ClusterInfo { name: string; access: 'connected' | 'entry-only' | 'no-entry' | 'unknown' }

export default function EksExplorerPage() {
  const [clusters, setClusters] = useState<string[] | null>(null);
  const [cluster, setCluster] = useState<string>(ALL_CLUSTERS);
  const [kind, setKind] = useState<Kind>('pods');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState('');
  const [warn, setWarn] = useState('');
  const [busy, setBusy] = useState(false);
  const [capturedAt, setCapturedAt] = useState<string | null>(null);
  const [auto, setAuto] = useState(false);
  const [query, setQuery] = useState('');
  const [ns, setNs] = useState(ALL);
  const [status, setStatus] = useState(ALL);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<Row | null>(null);
  // describe 심층 조회 (v1 K9s row-describe parity): 선택 시 전체 오브젝트를 읽어 패널에 표시
  // (managedFields 제거, configmap 값은 서버에서 redact). 실패하면 행 요약으로 폴백.
  const [describe, setDescribe] = useState<Record<string, unknown> | null>(null);
  const describeSeq = useRef(0);
  const openRow = useCallback((row: Row) => {
    setSelected(row);
    setDescribe(null);
    const name = typeof row.name === 'string' ? row.name : '';
    if (!name || kind === 'events') return; // events는 행 자체가 내용
    const rowCluster = typeof row.cluster === 'string' ? row.cluster : cluster;
    if (!rowCluster || rowCluster === ALL_CLUSTERS) return;
    const nsQ = typeof row.namespace === 'string' && row.namespace ? `&namespace=${encodeURIComponent(row.namespace)}` : '';
    const seq = ++describeSeq.current;
    fetch(`/api/eks/${encodeURIComponent(rowCluster)}/incluster/describe?kind=${kind}&name=${encodeURIComponent(name)}${nsQ}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.object && seq === describeSeq.current) setDescribe(d.object as Record<string, unknown>); })
      .catch(() => {});
  }, [kind, cluster]);

  // Connected clusters only — everything else is not queryable via the BFF.
  useEffect(() => {
    fetch('/api/eks?account=self')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        const names = ((d.clusters ?? []) as ClusterInfo[])
          .filter((c) => c.access === 'connected')
          .map((c) => c.name);
        setClusters(names);
      })
      .catch((e) => { setClusters([]); setErr(e instanceof Error ? e.message : String(e)); });
  }, []);

  // Monotonic load sequence — a late response from a superseded load (rapid
  // kind/cluster switch, overlapping auto-refresh) must not write stale rows.
  const loadSeqRef = useRef(0);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!clusters) return; // cluster list not loaded yet
    const targets = cluster === ALL_CLUSTERS ? clusters : [cluster];
    const seq = ++loadSeqRef.current;
    const fresh = () => seq === loadSeqRef.current;
    if (!opts?.silent) { setRows(null); setWarn(''); }
    setBusy(true);
    try {
      // Per-cluster fetch failures (403 RBAC, timeout, …) degrade to [] and an
      // inline warn — one bad cluster/kind must never blank the whole page.
      const results = await Promise.all(targets.map(async (name) => {
        try {
          const r = await fetch(`/api/eks/${encodeURIComponent(name)}/incluster?kind=${kind}`);
          if (!r.ok) return { name, rows: null as Row[] | null };
          const d = await r.json();
          return { name, rows: (d.rows ?? []) as Row[] };
        } catch {
          return { name, rows: null as Row[] | null };
        }
      }));
      if (!fresh()) return;
      const failed = results.filter((x) => x.rows === null).map((x) => x.name);
      const merged: Row[] = results.flatMap((x) => (x.rows ?? []).map((row) => ({ cluster: x.name, ...row })));
      // Events have no stable server order → newest first (v1 parity).
      const sorted = kind === 'events'
        ? merged.sort((a, b) => Number(b.lastSeenTs ?? 0) - Number(a.lastSeenTs ?? 0))
        : merged;
      setRows(sorted);
      setWarn(failed.length
        ? `일부 kind는 클러스터 RBAC 갱신 필요 — 인증 재등록 스크립트 참조 (조회 실패: ${failed.join(', ')})`
        : '');
      setCapturedAt(new Date().toISOString());
    } finally {
      if (fresh()) setBusy(false);
    }
  }, [clusters, cluster, kind]);

  // Reset filters/selection when the kind or cluster scope changes, then load.
  useEffect(() => {
    setQuery('');
    setNs(ALL);
    setStatus(ALL);
    setSelected(null);
    void load();
  }, [load]);

  // 자동 새로고침 30s — silent (keeps the table on screen while re-fetching).
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => { void load({ silent: true }); }, 30_000);
    return () => clearInterval(id);
  }, [auto, load]);

  // '더 보기' paging resets whenever the visible set could change shape.
  useEffect(() => { setVisible(PAGE_SIZE); }, [kind, cluster, query, ns, status]);

  const allRows = useMemo(() => rows ?? [], [rows]);

  const nsOptions = useMemo(() => {
    if (!NAMESPACED.has(kind)) return [];
    const set = new Set<string>();
    for (const r of allRows) {
      const v = r.namespace;
      if (v != null && v !== '') set.add(String(v));
    }
    return [ALL, ...[...set].sort((a, b) => a.localeCompare(b))];
  }, [allRows, kind]);

  const statusKey = STATUS_KEY[kind];
  const statusOptions = useMemo(() => {
    if (!statusKey) return [];
    const set = new Set<string>();
    for (const r of allRows) {
      const v = r[statusKey];
      if (v != null && v !== '') set.add(String(v));
    }
    return [ALL, ...[...set].sort((a, b) => a.localeCompare(b))];
  }, [allRows, statusKey]);

  const filteredRows = useMemo(() => {
    let out = allRows;
    if (NAMESPACED.has(kind) && ns !== ALL) {
      out = out.filter((r) => String(r.namespace ?? '') === ns);
    }
    if (statusKey && status !== ALL) {
      out = out.filter((r) => String(r[statusKey] ?? '') === status);
    }
    const q = query.trim().toLowerCase();
    if (q) {
      out = out.filter((r) => Object.values(r).some((v) => String(v ?? '').toLowerCase().includes(q)));
    }
    return out;
  }, [allRows, kind, ns, statusKey, status, query]);

  const visibleRows = useMemo(() => filteredRows.slice(0, visible), [filteredRows, visible]);

  const columns = useMemo<Column[]>(
    () => (cluster === ALL_CLUSTERS ? [CLUSTER_COL, ...COLUMNS[kind]] : COLUMNS[kind]),
    [cluster, kind],
  );

  const hasFilter = query.trim() !== '' || ns !== ALL || status !== ALL;

  const detailTitle =
    typeof selected?.name === 'string' && selected.name
      ? (selected.name as string)
      : typeof selected?.object === 'string'
        ? (selected.object as string)
        : undefined;

  return (
    <>
      <PageHeader
        title="EKS 탐색기"
        subtitle="K9s 스타일 리소스 브라우저 (read-only) — 연결된 클러스터의 in-cluster 리소스를 kind별로 조회합니다."
        right={<RefreshButton busy={busy} onClick={() => void load({ silent: true })} capturedAt={capturedAt} />}
      />
      <div className="px-8 py-8 flex flex-col gap-4">
        {/* kind tabs — k9s lowercase */}
        <div className="overflow-x-auto">
          <SegmentedControl options={KINDS} value={kind} onChange={(v) => setKind(v as Kind)} />
        </div>

        {/* top bar: cluster picker · auto-refresh · row count */}
        <div className="flex flex-wrap items-center gap-3 text-[12px]">
          <select
            value={cluster}
            onChange={(e) => setCluster(e.target.value)}
            className={`${selCls} max-w-[260px]`}
            aria-label="클러스터 선택"
          >
            <option value={ALL_CLUSTERS}>전체 클러스터</option>
            {(clusters ?? []).map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-ink-600">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            자동 새로고침 30s
          </label>
          <span className="ml-auto tabular text-ink-500">
            {hasFilter
              ? `${filteredRows.length.toLocaleString()} / ${allRows.length.toLocaleString()}개`
              : `${allRows.length.toLocaleString()}개`}
          </span>
        </div>

        {/* filters: 검색 · namespace · status · Clear */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-full max-w-[260px]">
            <Input
              inputSize="sm"
              placeholder="검색…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              icon={<Search className="h-3.5 w-3.5" />}
            />
          </div>
          {nsOptions.length > 1 && (
            <select value={ns} onChange={(e) => setNs(e.target.value)} className={selCls} aria-label="namespace 필터">
              {nsOptions.map((o) => (
                <option key={o} value={o}>{o === ALL ? 'namespace: 전체' : o}</option>
              ))}
            </select>
          )}
          {statusOptions.length > 1 && (
            <select value={status} onChange={(e) => setStatus(e.target.value)} className={selCls} aria-label="status 필터">
              {statusOptions.map((o) => (
                <option key={o} value={o}>{o === ALL ? 'status: 전체' : o}</option>
              ))}
            </select>
          )}
          {hasFilter && (
            <button className={btnCls} onClick={() => { setQuery(''); setNs(ALL); setStatus(ALL); }}>
              Clear
            </button>
          )}
        </div>

        <div className="text-[11px] text-ink-400">
          secrets는 보안 정책상 제공되지 않습니다 · configmaps는 메타데이터(키 개수)만 표시
        </div>

        {err && <div className="text-[13px] text-rose-600">로드 실패: {err}</div>}
        {warn && (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-700">
            {warn}
          </div>
        )}
        {clusters && clusters.length === 0 && !err && (
          <div className="text-[13px] text-ink-400">
            연결된 클러스터가 없습니다 — EKS 페이지에서 클러스터를 등록하세요.
          </div>
        )}

        {!rows && !err && <div className="text-ink-400">로딩 중…</div>}
        {rows && (
          <>
            <DataTable columns={columns} rows={visibleRows} onRowClick={openRow} />
            {filteredRows.length > visible && (
              <button
                className={`${btnCls} self-center px-3 py-1`}
                onClick={() => setVisible((v) => v + PAGE_SIZE)}
              >
                더 보기 ({visibleRows.length.toLocaleString()} / {filteredRows.length.toLocaleString()})
              </button>
            )}
          </>
        )}
      </div>

      <DetailPanel
        title={detailTitle}
        data={selected ? (describe ? { ...selected, ...describe } : selected) : null}
        onClose={() => { setSelected(null); setDescribe(null); }}
      />
    </>
  );
}
