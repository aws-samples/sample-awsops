'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import DataTable, { type Column } from '@/components/ui/DataTable';
import NodeDrilldownPanel from '@/components/eks/NodeDrilldownPanel';
import NodeCapacityList, { type NodeCapacityRow } from '@/components/eks/NodeCapacityList';
import { isTerminalPodPhase } from '@/lib/eks-resources';
import DetailPanel from '@/components/ui/DetailPanel';
import PageHeader from '@/components/ui/PageHeader';
import RefreshButton from '@/components/ui/RefreshButton';
import SegmentedControl from '@/components/ui/SegmentedControl';
import Input from '@/components/ui/Input';
import Card from '@/components/ui/Card';
import Meter from '@/components/ui/Meter';
import StatCard from '@/components/ui/StatCard';
import DonutBreakdown from '@/components/charts/DonutBreakdown';
import { podStatusCounts, serviceTypeCounts } from '@/lib/eks-tab-stats';

// Fleet-wide kind page (v1 /k8s/nodes|pods|deployments|services parity):
// GET /api/eks → connected cluster names → per-cluster GET
// /api/eks/{name}/incluster?kind=K (Promise.all) → each row tagged with
// {cluster} → one merged table. A failing cluster degrades to [] (its name is
// listed in an amber note) — a partial fleet beats a blank page.

export type FleetKind = 'nodes' | 'pods' | 'deployments' | 'services';

type Row = Record<string, unknown>;

const KIND_META: Record<FleetKind, { title: string; noun: string }> = {
  nodes: { title: 'EKS Nodes — 전체 클러스터', noun: '노드' },
  pods: { title: 'EKS Pods — 전체 클러스터', noun: '파드' },
  deployments: { title: 'EKS Deployments — 전체 클러스터', noun: '디플로이먼트' },
  services: { title: 'EKS Services — 전체 클러스터', noun: '서비스' },
};

// Per-kind columns — the cluster page's COLUMNS plus a leading `cluster`
// column ('status' cells render as StatePill automatically in DataTable).
const COLUMNS: Record<FleetKind, Column[]> = {
  nodes: [
    { key: 'cluster', label: 'Cluster' },
    { key: 'name', label: 'Name' },
    { key: 'status', label: 'Status' },
    { key: 'roles', label: 'Roles' },
    { key: 'version', label: 'Version' },
    { key: 'instanceType', label: 'Instance Type' },
    { key: 'zone', label: 'Zone' },
    { key: 'age', label: 'Age' },
  ],
  pods: [
    { key: 'cluster', label: 'Cluster' },
    { key: 'name', label: 'Name' },
    { key: 'namespace', label: 'Namespace' },
    { key: 'status', label: 'Status' },
    { key: 'node', label: 'Node' },
    { key: 'restarts', label: 'Restarts' },
    { key: 'age', label: 'Age' },
  ],
  deployments: [
    { key: 'cluster', label: 'Cluster' },
    { key: 'name', label: 'Name' },
    { key: 'namespace', label: 'Namespace' },
    { key: 'ready', label: 'Ready' },
    { key: 'upToDate', label: 'Up-to-date' },
    { key: 'available', label: 'Available' },
    { key: 'age', label: 'Age' },
  ],
  services: [
    { key: 'cluster', label: 'Cluster' },
    { key: 'name', label: 'Name' },
    { key: 'namespace', label: 'Namespace' },
    { key: 'type', label: 'Type' },
    { key: 'clusterIP', label: 'Cluster IP' },
    { key: 'ports', label: 'Ports' },
    { key: 'age', label: 'Age' },
  ],
};

const NAMESPACED: Set<FleetKind> = new Set(['pods', 'deployments', 'services']);

/** "a/b" → { ready: a, desired: b } (0 on any unparseable part). */
function readyParts(ready: unknown): { ready: number; desired: number } {
  const p = String(ready ?? '').split('/');
  return { ready: parseInt(p[0] ?? '0', 10) || 0, desired: parseInt(p[1] ?? '0', 10) || 0 };
}

export default function FleetKindPage({ kind }: { kind: FleetKind }) {
  const meta = KIND_META[kind];
  const [rows, setRows] = useState<Row[] | null>(null);
  const [clusters, setClusters] = useState<string[]>([]);
  const [failed, setFailed] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [capturedAt, setCapturedAt] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [ns, setNs] = useState('전체');
  const [clusterSel, setClusterSel] = useState('전체');
  // nodes 전용 드릴다운 (v1 parity — 개요와 동일 패널): 행 클릭 → CPU/Memory/Pods/ENI
  const [nodeSel, setNodeSel] = useState<{ cluster: string; name: string } | null>(null);
  // Gap L132 (nodes only): per-cluster pod request aggregation keyed by node name; a cluster
  // whose pods fetch failed maps to null so its bars degrade honestly ('요청량 미상').
  const [podReq, setPodReq] = useState<Record<string, Record<string, { cpu: number; mem: number }> | null>>({});
  // Tri-state: false = pods fan-out still pending (bars caption '로딩 중', not '미상').
  const [podReqReady, setPodReqReady] = useState(false);
  const [selected, setSelected] = useState<Row | null>(null);

  // Monotonic load sequence — a late response from a superseded load must not
  // overwrite the newer view (same guard as the cluster page).
  const loadSeqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    const fresh = () => seq === loadSeqRef.current;
    setBusy(true);
    setErr('');
    // A refresh must not pair NEW node rows with the PREVIOUS run's request numbers.
    setPodReq({});
    setPodReqReady(false);
    try {
      const r = await fetch('/api/eks?account=self');
      if (!r.ok) throw new Error(String(r.status));
      const d = await r.json();
      const names = ((d.clusters ?? []) as { name?: string; access?: string }[])
        .filter((c) => c.access === 'connected' && c.name)
        .map((c) => String(c.name));
      if (!fresh()) return;
      setClusters(names);
      // Per-cluster fetch: a failing cluster degrades to null (→ amber note),
      // never blanking the merged page.
      const results = await Promise.all(
        names.map(async (name) => {
          try {
            const rr = await fetch(`/api/eks/${encodeURIComponent(name)}/incluster?kind=${kind}`);
            if (!rr.ok) return { name, rows: null as Row[] | null };
            const dd = await rr.json();
            return { name, rows: (dd.rows ?? []) as Row[] };
          } catch {
            return { name, rows: null as Row[] | null };
          }
        }),
      );
      if (!fresh()) return;
      const merged: Row[] = [];
      const failedNames: string[] = [];
      for (const res of results) {
        if (res.rows) merged.push(...res.rows.map((row) => ({ cluster: res.name, ...row })));
        else failedNames.push(res.name);
      }
      setRows(merged);
      setFailed(failedNames);
      setCapturedAt(new Date().toISOString());
      // Gap L132: the capacity bars need scheduler-requested totals — one pods fetch per
      // cluster, aggregated by node. Failures degrade per cluster (null), never the page.
      if (kind === 'nodes') {
        const podResults = await Promise.all(
          names.map(async (name) => {
            try {
              const rr = await fetch(`/api/eks/${encodeURIComponent(name)}/incluster?kind=pods`);
              if (!rr.ok) return { name, agg: null as Record<string, { cpu: number; mem: number }> | null };
              const dd = await rr.json();
              // Null prototype: a node legally named 'constructor' must not collide with
              // inherited Object members during accumulation.
              const agg: Record<string, { cpu: number; mem: number }> = Object.create(null);
              for (const pod of (dd.rows ?? []) as { node?: string; status?: string; cpuRequest?: number; memRequest?: number }[]) {
                if (!pod.node) continue;
                // Same exclusion as aggregateNodeResources: terminal pods hold no reservation.
                if (isTerminalPodPhase(pod.status)) continue;
                const cur = (agg[pod.node] ??= { cpu: 0, mem: 0 });
                cur.cpu += Number(pod.cpuRequest) || 0;
                cur.mem += Number(pod.memRequest) || 0;
              }
              return { name, agg };
            } catch {
              return { name, agg: null as Record<string, { cpu: number; mem: number }> | null };
            }
          }),
        );
        if (!fresh()) return;
        setPodReq(Object.fromEntries(podResults.map((p) => [p.name, p.agg])));
        setPodReqReady(true);
      }
    } catch (e) {
      if (fresh()) setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (fresh()) setBusy(false);
    }
  }, [kind]);

  useEffect(() => {
    setQuery('');
    setNs('전체');
    setClusterSel('전체');
    setSelected(null);
    setRows(null);
    setPodReq({});
    setPodReqReady(false);
    void load();
  }, [load]);

  const allRows = useMemo(() => rows ?? [], [rows]);

  // Distinct namespaces (namespaced kinds only) → filter options, capped at 12.
  const nsOptions = useMemo(() => {
    if (!NAMESPACED.has(kind)) return [];
    const set = new Set<string>();
    for (const r of allRows) {
      const v = r.namespace;
      if (v != null && v !== '') set.add(String(v));
    }
    return ['전체', ...[...set].sort((a, b) => a.localeCompare(b)).slice(0, 12)];
  }, [allRows, kind]);

  const filteredRows = useMemo(() => {
    let out = allRows;
    if (clusterSel !== '전체') {
      out = out.filter((r) => String(r.cluster ?? '') === clusterSel);
    }
    if (NAMESPACED.has(kind) && ns !== '전체') {
      out = out.filter((r) => String(r.namespace ?? '') === ns);
    }
    const q = query.trim().toLowerCase();
    if (q) {
      out = out.filter((r) => Object.values(r).some((v) => String(v ?? '').toLowerCase().includes(q)));
    }
    return out;
  }, [allRows, kind, clusterSel, ns, query]);

  return (
    <>
      <PageHeader
        title={meta.title}
        subtitle={`연결 클러스터 ${clusters.length}개 · ${meta.noun} ${allRows.length.toLocaleString()}개 (read-only)`}
        right={<RefreshButton busy={busy} onClick={() => void load()} capturedAt={capturedAt} />}
      />
      <div className="px-8 py-8 flex flex-col gap-6">
        {err && <div className="text-[13px] text-rose-600">로드 실패: {err}</div>}
        {failed.length > 0 && (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-700">
            조회 실패 클러스터 (제외됨): {failed.join(', ')}
          </div>
        )}
        {!rows && !err && <div className="text-ink-400">로딩 중…</div>}
        {rows && !err && clusters.length === 0 && (
          <div className="rounded-md border border-ink-100 bg-ink-50 px-3 py-3 text-[13px] text-ink-400">
            연결된(connected) 클러스터가 없습니다 — /eks에서 클러스터를 등록하세요.
          </div>
        )}
        {rows && !err && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <div className="w-full max-w-[280px]">
                  <Input
                    inputSize="sm"
                    placeholder="검색…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    icon={<Search className="h-3.5 w-3.5" />}
                  />
                </div>
                {clusters.length > 1 && (
                  <select
                    value={clusterSel}
                    onChange={(e) => setClusterSel(e.target.value)}
                    aria-label="클러스터 필터"
                    className="rounded-md border border-ink-200 bg-card px-2 py-1.5 font-mono text-[12px] text-ink-700"
                  >
                    {['전체', ...clusters].map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                )}
              </div>
              {nsOptions.length > 1 && (
                <div className="overflow-x-auto">
                  <SegmentedControl options={nsOptions} value={ns} onChange={setNs} />
                </div>
              )}
            </div>

            {/* Per-kind KPI/viz — ALWAYS computed from allRows (pre-filter) so
                the summary describes the whole fleet, not the filtered table. */}
            {kind === 'nodes' && allRows.length > 0 && (() => {
              const ready = allRows.filter((r) => String(r.status ?? '') === 'Ready').length;
              const cpu = allRows.reduce((s, r) => s + (Number(r.cpuCapacity) || 0), 0);
              const memMiB = allRows.reduce((s, r) => s + (Number(r.memCapacity) || 0), 0);
              const types = new Map<string, number>();
              for (const r of allRows) {
                const t = String(r.instanceType ?? '') || 'unknown';
                types.set(t, (types.get(t) ?? 0) + 1);
              }
              const donut = [...types.entries()].map(([name, value]) => ({ name, value }));
              return (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <StatCard label="총 노드" value={allRows.length} />
                    <StatCard label="Ready" value={ready} variant={ready < allRows.length ? 'warn' : 'default'} />
                    <StatCard label="총 vCPU" value={Math.round(cpu).toLocaleString()} />
                    <StatCard label="총 Memory (GiB)" value={Math.round(memMiB / 1024).toLocaleString()} />
                  </div>
                  <DonutBreakdown title="Instance Types" data={donut} nameKey="name" valueKey="value" />
                </>
              );
            })()}

            {/* Gap L132: per-node 3-segment capacity bars (v1 nodes subpage) — follows the
                table's filters so the list narrows with the operator's scope. */}
            {kind === 'nodes' && filteredRows.length > 0 && (
              <NodeCapacityList
                requestsPending={!podReqReady}
                rows={filteredRows.map((r): NodeCapacityRow => {
                  const cluster = String(r.cluster ?? '');
                  // hasOwn guard: cluster names may legally shadow Object.prototype members.
                  const clusterAgg = Object.hasOwn(podReq, cluster) ? podReq[cluster] : null;
                  const nodeAgg = clusterAgg == null ? null : (Object.hasOwn(clusterAgg, String(r.name ?? '')) ? clusterAgg[String(r.name ?? '')] : { cpu: 0, mem: 0 });
                  return {
                    cluster,
                    name: String(r.name ?? ''),
                    cpuCapacity: Number(r.cpuCapacity) || 0,
                    cpuAllocatable: Number(r.cpuAllocatable) || 0,
                    cpuRequest: nodeAgg == null ? null : nodeAgg.cpu,
                    memCapacityMiB: Number(r.memCapacity) || 0,
                    memAllocatableMiB: Number(r.memAllocatable) || 0,
                    memRequestMiB: nodeAgg == null ? null : nodeAgg.mem,
                  };
                })}
              />
            )}

            {kind === 'pods' && allRows.length > 0 && (() => {
              const s = podStatusCounts(allRows);
              const donut = Object.entries(s).map(([name, value]) => ({ name, value }));
              return (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <StatCard label="총 파드" value={allRows.length} />
                    <StatCard label="Running" value={s.Running ?? 0} />
                    <StatCard label="Pending" value={s.Pending ?? 0} variant={s.Pending ? 'warn' : 'default'} />
                    <StatCard label="Failed" value={s.Failed ?? 0} variant={s.Failed ? 'danger' : 'default'} />
                  </div>
                  <DonutBreakdown title="Pod Status" data={donut} nameKey="name" valueKey="value" />
                </>
              );
            })()}

            {kind === 'deployments' && allRows.length > 0 && (() => {
              const parsed = allRows.map((r) => {
                const { ready: rdy, desired } = readyParts(r.ready);
                const available = Number(r.available) || 0;
                const pct = desired > 0 ? Math.max(0, Math.min(100, Math.round((available / desired) * 100))) : 100;
                return {
                  cluster: String(r.cluster ?? ''),
                  name: String(r.name ?? ''),
                  namespace: String(r.namespace ?? ''),
                  ready: rdy,
                  desired,
                  available,
                  pct,
                };
              });
              const fully = parsed.filter((d) => d.desired > 0 && d.ready === d.desired).length;
              const partial = parsed.length - fully;
              const top = [...parsed].sort((a, b) => b.desired - a.desired || a.name.localeCompare(b.name)).slice(0, 20);
              return (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                    <StatCard label="총 디플로이먼트" value={parsed.length} />
                    <StatCard label="Fully available" value={fully} />
                    <StatCard label="Partial" value={partial} variant={partial > 0 ? 'danger' : 'default'} />
                  </div>
                  <Card title="레플리카" subtitle="available / desired (desired 상위 20)">
                    <div className="flex flex-col gap-2">
                      {top.map((d) => (
                        <div
                          key={`${d.cluster}/${d.namespace}/${d.name}`}
                          className="grid grid-cols-[1fr_auto_auto] items-center gap-4 text-[12px]"
                        >
                          <span className="min-w-0 truncate font-mono text-ink-700" title={`${d.cluster} · ${d.namespace}/${d.name}`}>
                            {d.namespace}/{d.name}
                            <span className="ml-2 text-ink-400">{d.cluster}</span>
                          </span>
                          <Meter value={d.pct} />
                          <span className="tabular text-ink-400">{d.available}/{d.desired}</span>
                        </div>
                      ))}
                    </div>
                  </Card>
                </>
              );
            })()}

            {kind === 'services' && allRows.length > 0 && (() => {
              const t = serviceTypeCounts(allRows);
              const donut = Object.entries(t).map(([name, value]) => ({ name, value }));
              return (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <StatCard label="총 서비스" value={allRows.length} />
                    <StatCard label="ClusterIP" value={t.ClusterIP ?? 0} />
                    <StatCard label="NodePort" value={t.NodePort ?? 0} />
                    <StatCard label="LoadBalancer" value={t.LoadBalancer ?? 0} />
                  </div>
                  <DonutBreakdown title="Service Types" data={donut} nameKey="name" valueKey="value" />
                </>
              );
            })()}

            <DataTable
              columns={COLUMNS[kind]}
              rows={filteredRows}
              onRowClick={(row) => {
                // nodes는 개요와 동일한 리치 드릴다운(CPU/Memory/Pods/ENI), 그 외 kind는 기존 raw 패널.
                if (kind === 'nodes' && typeof row.cluster === 'string' && typeof row.name === 'string') {
                  setNodeSel({ cluster: row.cluster, name: row.name });
                } else {
                  setSelected(row);
                }
              }}
            />
          </>
        )}
      </div>

      <DetailPanel
        title={selected?.name as string | undefined}
        data={selected}
        onClose={() => setSelected(null)}
      />
      {nodeSel && (
        <NodeDrilldownPanel cluster={nodeSel.cluster} nodeName={nodeSel.name} onClose={() => setNodeSel(null)} />
      )}
    </>
  );
}
