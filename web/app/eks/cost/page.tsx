'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CostBasisPanel from '@/components/eks/CostBasisPanel';
import GroupedBarList from '@/components/charts/GroupedBarList';
import { DollarSign, CalendarDays, Boxes, Crown, Search } from 'lucide-react';
import PageHeader from '@/components/ui/PageHeader';
import RefreshButton from '@/components/ui/RefreshButton';
import Card from '@/components/ui/Card';
import StatTile from '@/components/ui/StatTile';
import Badge from '@/components/ui/Badge';
import Input from '@/components/ui/Input';
import SegmentedControl from '@/components/ui/SegmentedControl';
import DataTable, { type Column } from '@/components/ui/DataTable';
import DetailPanel from '@/components/ui/DetailPanel';
import DonutBreakdown from '@/components/charts/DonutBreakdown';
import { useI18n } from '@/components/shell/LanguageProvider';
import PodTransferSection from '@/components/eks/PodTransferSection';

// EKS 컨테이너 비용 (fleet-wide) — v1 /eks-container-cost parity. Every connected
// cluster's OpenCost 1d allocation is fetched in parallel and merged; per-cluster
// failures degrade to "미가용" chips (never blank the page).

interface PodCost {
  namespace: string; pod: string; node: string;
  cpuCost: number; ramCost: number; networkCost: number; pvCost: number; gpuCost: number; totalCost: number;
}
interface NodeCost { node: string; cpuCost: number; ramCost: number; totalCost: number }
interface AllocationResult {
  available: boolean; message?: string;
  source?: 'opencost' | 'request-estimate';
  nodes?: NodeCost[];
  pods: PodCost[]; namespaces: { name: string; value: number }[];
  kpi: { dailyTotal: number; monthly: number; podCount: number; topNamespace: { name: string; cost: number } | null };
  hasNetwork: boolean; hasPv: boolean; hasGpu: boolean;
}
// data === null → 미가용 (fetch failed, non-200, or available:false).
interface ClusterAlloc { cluster: string; data: AllocationResult | null }

const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const ALL = '전체';

export default function EksFleetCostPage() {
  const { tt } = useI18n();
  const [results, setResults] = useState<ClusterAlloc[] | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [capturedAt, setCapturedAt] = useState<string | null>(null);
  // 상단 클러스터 선택: '전체' = 합산 뷰, 개별 = 해당 클러스터만.
  const [sel, setSel] = useState(ALL);
  // 테이블 필터 (검색 + cluster/namespace select).
  const [query, setQuery] = useState('');
  const [tableCluster, setTableCluster] = useState(ALL);
  const [tableNs, setTableNs] = useState(ALL);
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  // connected 클러스터 이름 목록 — 최하단 Pod 전송량 (NFM) 섹션에 전달.
  const [clusterNames, setClusterNames] = useState<string[]>([]);

  // Monotonic load sequence — a late response from a superseded refresh must not
  // overwrite newer results (same guard as the cluster detail page).
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    const fresh = () => seq === seqRef.current;
    setBusy(true);
    setErr('');
    try {
      const r = await fetch('/api/eks?account=self');
      if (!r.ok) throw new Error(String(r.status));
      const d = await r.json();
      const names = ((d.clusters ?? []) as { name: string; access: string }[])
        .filter((c) => c.access === 'connected')
        .map((c) => c.name);
      // Per-cluster allocation in parallel — a failing cluster becomes {data:null}
      // (미가용) instead of failing the whole page.
      const settled = await Promise.all(names.map(async (cluster): Promise<ClusterAlloc> => {
        try {
          const rr = await fetch(`/api/opencost/${encodeURIComponent(cluster)}/allocation`);
          if (!rr.ok) return { cluster, data: null };
          const body = (await rr.json()) as AllocationResult;
          return { cluster, data: body.available ? body : null };
        } catch {
          return { cluster, data: null };
        }
      }));
      if (!fresh()) return;
      setResults(settled);
      setClusterNames(names);
      setCapturedAt(new Date().toISOString());
    } catch (e) {
      if (fresh()) setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (fresh()) setBusy(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Pod별 NFM 전송비용: NFM 모니터 쿼리는 최대 1시간 윈도우(API 한도)라 최근 1h를 실측하고
  // 테이블의 '일간' 기준에 맞춰 ×24 외삽한다 (KPI의 '월간 추정 = 일간 × 30'과 같은 방식).
  // 미온보딩 클러스터/실패는 조용히 빠지고 해당 셀은 '—' (best-effort, 테이블을 막지 않음).
  const [xfer, setXfer] = useState<Map<string, number> | null>(null);
  useEffect(() => {
    if (clusterNames.length === 0) return;
    let live = true;
    Promise.all(clusterNames.map(async (cluster) => {
      try {
        const r = await fetch(`/api/eks/${encodeURIComponent(cluster)}/pod-transfer?range=3600`);
        if (!r.ok) return [] as [string, number][];
        const d = await r.json();
        if (!d.available) return [] as [string, number][];
        return (d.pods as { podName: string | null; namespace: string | null; estUsd: number }[])
          .filter((p) => p.podName)
          .map((p): [string, number] => [`${cluster}|${p.namespace ?? ''}/${p.podName}`, p.estUsd]);
      } catch { return [] as [string, number][]; }
    })).then((entries) => { if (live) setXfer(new Map(entries.flat())); });
    return () => { live = false; };
  }, [clusterNames]);

  // 새로고침으로 클러스터 목록이 바뀌어 선택이 무효가 되면 '전체'로 복귀.
  useEffect(() => {
    if (sel !== ALL && results && !results.some((r) => r.cluster === sel)) setSel(ALL);
  }, [results, sel]);
  // 클러스터 선택이 바뀌면 테이블 필터/상세 초기화.
  useEffect(() => {
    setQuery('');
    setTableCluster(ALL);
    setTableNs(ALL);
    setSelected(null);
  }, [sel]);

  const available = useMemo(
    () => (results ?? []).filter((r): r is { cluster: string; data: AllocationResult } => r.data !== null),
    [results],
  );
  const scoped = useMemo(
    () => (sel === ALL ? available : available.filter((r) => r.cluster === sel)),
    [available, sel],
  );

  // '전체' 병합: KPI 합산(dailyTotal/monthly/podCount), namespace 도넛은 이름별 합,
  // topNamespace는 병합된 namespace 합계의 최대값. Pod/Node 테이블은 cluster 태깅 병합.
  const merged = useMemo(() => {
    let dailyTotal = 0, monthly = 0, podCount = 0;
    let hasNetwork = false, hasPv = false, hasGpu = false;
    const nsMap = new Map<string, number>();
    const pods: (PodCost & { cluster: string })[] = [];
    const nodes: (NodeCost & { cluster: string })[] = [];
    for (const { cluster, data } of scoped) {
      dailyTotal += data.kpi.dailyTotal;
      monthly += data.kpi.monthly;
      podCount += data.kpi.podCount;
      for (const ns of data.namespaces) nsMap.set(ns.name, (nsMap.get(ns.name) ?? 0) + ns.value);
      for (const p of data.pods) pods.push({ cluster, ...p });
      for (const n of data.nodes ?? []) nodes.push({ cluster, ...n });
      hasNetwork = hasNetwork || data.hasNetwork;
      hasPv = hasPv || data.hasPv;
      hasGpu = hasGpu || data.hasGpu;
    }
    const namespaces = [...nsMap.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
    const top = namespaces[0];
    pods.sort((a, b) => b.totalCost - a.totalCost);
    return {
      kpi: { dailyTotal, monthly, podCount, topNamespace: top ? { name: top.name, cost: top.value } : null },
      namespaces, pods, nodes, hasNetwork, hasPv, hasGpu,
    };
  }, [scoped]);

  // 테이블 select 옵션 — scoped 데이터에서 파생.
  const clusterOptions = useMemo(() => [ALL, ...scoped.map((r) => r.cluster)], [scoped]);
  const nsOptions = useMemo(() => {
    const set = new Set<string>();
    for (const p of merged.pods) if (p.namespace) set.add(p.namespace);
    return [ALL, ...[...set].sort((a, b) => a.localeCompare(b))];
  }, [merged.pods]);

  const filteredPods = useMemo(() => {
    let out = merged.pods;
    if (tableCluster !== ALL) out = out.filter((p) => p.cluster === tableCluster);
    if (tableNs !== ALL) out = out.filter((p) => p.namespace === tableNs);
    const q = query.trim().toLowerCase();
    if (q) {
      out = out.filter((p) =>
        [p.cluster, p.namespace, p.pod, p.node].some((v) => String(v ?? '').toLowerCase().includes(q)));
    }
    return out;
  }, [merged.pods, tableCluster, tableNs, query]);

  // v1 parity: Network/Storage(PV)/GPU 컬럼은 어떤 클러스터라도 해당 값을 보고할 때만 표시.
  const columns: Column[] = [
    { key: 'cluster', label: 'Cluster' },
    { key: 'namespace', label: 'Namespace' },
    { key: 'pod', label: 'Pod' },
    { key: 'node', label: 'Node' },
    { key: 'cpu_h', label: 'CPU' },
    { key: 'ram_h', label: 'Memory' },
    ...(merged.hasNetwork ? [{ key: 'net_h', label: 'Network' }] : []),
    ...(merged.hasPv ? [{ key: 'pv_h', label: 'Storage(PV)' }] : []),
    ...(merged.hasGpu ? [{ key: 'gpu_h', label: 'GPU' }] : []),
    // NFM 전송비용(일간 = 최근 1h 실측 ×24 외삽, 방향당 $0.01/GB) — 온보딩 클러스터가 있을 때만 노출.
    ...(xfer && xfer.size > 0 ? [{ key: 'xfer_h', label: 'Transfer/Day (NFM)' }] : []),
    { key: 'total_h', label: 'Total/Day' },
  ];
  // NFM 추정치는 센트 미만이 흔함 — $0.01 미만은 4자리로 표기해 전부 $0.00으로 뭉개지지 않게.
  const xferUsd = (v: number | undefined) => (v == null ? '—' : v >= 0.01 ? usd(v) : `$${v.toFixed(4)}`);
  const rows = filteredPods.map((p) => {
    const x1h = xfer?.get(`${p.cluster}|${p.namespace}/${p.pod}`);
    const xDay = x1h == null ? undefined : x1h * 24;
    return {
      cluster: p.cluster, namespace: p.namespace, pod: p.pod, node: p.node,
      cpu_h: usd(p.cpuCost), ram_h: usd(p.ramCost), net_h: usd(p.networkCost),
      pv_h: usd(p.pvCost), gpu_h: usd(p.gpuCost), xfer_h: xferUsd(xDay), total_h: usd(p.totalCost),
      _raw: { ...p, nfmTransferUsd1h: x1h ?? null, nfmTransferUsdDayEst: xDay ?? null } as unknown as Record<string, unknown>,
    };
  });

  const segOptions = useMemo(() => [ALL, ...(results ?? []).map((r) => r.cluster)], [results]);
  const anyEstimate = scoped.some((r) => r.data.source === 'request-estimate');
  const selectCls = 'rounded-md border border-ink-200 bg-card px-2 py-1.5 font-mono text-[12px]';

  return (
    <>
      <PageHeader
        title="EKS 컨테이너 비용"
        subtitle="OpenCost 1일 allocation 기반 — 연결된 전체 클러스터 합산 (read-only)"
        right={<RefreshButton busy={busy} onClick={load} capturedAt={capturedAt} />}
      />
      <div className="px-8 py-8 flex flex-col gap-6">
        {err && <div className="text-[13px] text-rose-600">{tt('로드 실패:')} {err}</div>}
        {!results && !err && <div className="text-ink-400">{tt('로딩 중…')}</div>}

        {results && !err && (
          <>
            {results.length === 0 ? (
              <Card>
                <p className="text-[13px] text-ink-600">
                  {tt('연결된 EKS 클러스터가 없습니다 — EKS 페이지에서 클러스터를 등록하세요.')}
                </p>
              </Card>
            ) : (
              <>
                {/* 클러스터별 데이터 소스 칩: OpenCost 실측 / 요청 기반 추정 / 미가용. */}
                <div className="flex flex-wrap items-center gap-2">
                  {results.map(({ cluster, data }) =>
                    data === null ? (
                      <Badge key={cluster} tone="neutral" variant="soft">{cluster}: {tt('미가용')}</Badge>
                    ) : data.source === 'request-estimate' ? (
                      <Badge key={cluster} tone="brand" variant="soft" dot>{cluster}: {tt('요청 기반 추정')}</Badge>
                    ) : (
                      <Badge key={cluster} tone="positive" variant="soft" dot>{cluster}: {tt('OpenCost 실측')}</Badge>
                    ),
                  )}
                </div>

                <div className="overflow-x-auto">
                  <SegmentedControl options={segOptions} value={sel} onChange={setSel} />
                </div>

                {anyEstimate && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-[12px] text-amber-700">
                    {tt('일부 클러스터는 OpenCost 미가용 — Pod 리소스 요청(request) 기반 추정입니다 (요청 × 단가, 실측 아님). 정확한 비용은 OpenCost 설치 후 표시됩니다.')}
                  </div>
                )}

                {scoped.length === 0 ? (
                  <Card>
                    <p className="text-[13px] text-ink-600">
                      {sel === ALL
                        ? tt('비용 데이터를 사용할 수 있는 클러스터가 없습니다 — 각 클러스터의 OpenCost 설치 상태를 확인하세요.')
                        : `${sel}: ${tt('비용 데이터 미가용 — 클러스터의 OpenCost 설치 상태를 확인하세요.')}`}
                    </p>
                  </Card>
                ) : (
                  <>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                      <StatTile label="Pod 비용 (일간)" value={usd(merged.kpi.dailyTotal)} variant="accent" icon={<DollarSign size={16} />} />
                      <StatTile label="Pod 비용 (월간 추정)" value={usd(merged.kpi.monthly)} hint="일간 × 30" icon={<CalendarDays size={16} />} />
                      <StatTile label="Pods" value={merged.kpi.podCount} icon={<Boxes size={16} />} />
                      <StatTile
                        label="Top Namespace"
                        value={merged.kpi.topNamespace ? usd(merged.kpi.topNamespace.cost) : '—'}
                        hint={merged.kpi.topNamespace?.name}
                        icon={<Crown size={16} />}
                      />
                    </div>

                    {merged.namespaces.length > 0 && (
                      <DonutBreakdown
                        title="Namespace별 비용 (일간)"
                        data={merged.namespaces}
                        nameKey="name"
                        valueKey="value"
                        valuePrefix="$"
                      />
                    )}

                    <div className="flex flex-wrap items-center gap-3">
                      <div className="w-full max-w-[280px]">
                        <Input
                          inputSize="sm"
                          placeholder={tt('검색…')}
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                          icon={<Search className="h-3.5 w-3.5" />}
                        />
                      </div>
                      {sel === ALL && clusterOptions.length > 2 && (
                        <label className="flex items-center gap-1.5 text-[12px] text-ink-500">
                          Cluster
                          <select value={tableCluster} onChange={(e) => setTableCluster(e.target.value)} className={selectCls}>
                            {clusterOptions.map((c) => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </label>
                      )}
                      {nsOptions.length > 1 && (
                        <label className="flex items-center gap-1.5 text-[12px] text-ink-500">
                          Namespace
                          <select value={tableNs} onChange={(e) => setTableNs(e.target.value)} className={selectCls}>
                            {nsOptions.map((n) => <option key={n} value={n}>{n}</option>)}
                          </select>
                        </label>
                      )}
                    </div>

                    {xfer && xfer.size > 0 && (
                      <div className="text-[11.5px] text-ink-400">
                        {tt('Transfer/Day (NFM): 최근 1시간 실측 ×24 외삽 · 방향당 $0.01/GB 추정 — 정확한 청구 아님')}
                      </div>
                    )}
                    <DataTable
                      columns={columns}
                      rows={rows}
                      onRowClick={(r) => setSelected((r._raw ?? r) as Record<string, unknown>)}
                    />

                    {/* gap L218 (v1 dual-axis parity → per-series-scaled grouped bars): node
                        daily cost + pod count from the SAME merged data (no new fetch).
                        Cost-desc sorted, Top 15. Pod counts render ONLY for clusters whose
                        attribution is COMPLETE (every pod carries a node — OpenCost can omit
                        pod→node per pod); any unattributed pod makes the whole cluster's
                        counts unknowable (a shown count could undercount), so its nodes
                        render '—', never a confident 0. */}
                    {merged.nodes.length > 0 && (() => {
                      const podsByNode = new Map<string, number>();
                      const clustersWithUnattributed = new Set<string>();
                      for (const pd of merged.pods) {
                        if (!pd.node) { clustersWithUnattributed.add(pd.cluster); continue; }
                        const k = `${pd.cluster}/${pd.node}`;
                        podsByNode.set(k, (podsByNode.get(k) ?? 0) + 1);
                      }
                      const data = [...merged.nodes]
                        .sort((a, b) => b.totalCost - a.totalCost)
                        .slice(0, 15)
                        .map((n) => ({
                          label: `${n.cluster}/${n.node}`,
                          cost: n.totalCost,
                          pods: clustersWithUnattributed.has(n.cluster) ? null : podsByNode.get(`${n.cluster}/${n.node}`) ?? 0,
                        }));
                      return (
                        <GroupedBarList
                          title={merged.nodes.length > 15 ? `${tt('Node별 일일 비용 + Pod 수')} (Top 15/${merged.nodes.length})` : tt('Node별 일일 비용 + Pod 수')}
                          data={data}
                          labelKey="label"
                          series={[
                            { key: 'cost', label: tt('일일 비용'), color: '#3D6FB5', fmt: (v) => usd(v) },
                            { key: 'pods', label: 'Pods', color: '#39C2B0' },
                          ]}
                        />
                      );
                    })()}

                    {merged.nodes.length > 0 && (
                      <Card title="Node별 비용 (일간)" padded={false}>
                        <table className="w-full">
                          <thead><tr className="border-b border-ink-100 text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400">
                            <th className="px-3 py-2">Cluster</th><th className="px-3 py-2">Node</th><th className="px-3 py-2">CPU</th><th className="px-3 py-2">Memory</th><th className="px-3 py-2">Total/Day</th>
                          </tr></thead>
                          <tbody>
                            {merged.nodes.map((n) => (
                              <tr key={`${n.cluster}/${n.node}`} className="border-b border-ink-50 last:border-0">
                                <td className="px-3 py-1.5 font-mono text-[11.5px] text-ink-500">{n.cluster}</td>
                                <td className="px-3 py-1.5 font-mono text-[11.5px] text-ink-600">{n.node}</td>
                                <td className="tabular px-3 py-1.5 text-[12px] text-ink-600">{usd(n.cpuCost)}</td>
                                <td className="tabular px-3 py-1.5 text-[12px] text-ink-600">{usd(n.ramCost)}</td>
                                <td className="tabular px-3 py-1.5 text-[12px] font-semibold text-ink-800">{usd(n.totalCost)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </Card>
                    )}
                  </>
                )}
              </>
            )}
          </>
        )}

        {clusterNames.length > 0 && <PodTransferSection clusters={clusterNames} />}

        {/* Gap L217: collapsible calculation-transparency panel — always available. */}
        <CostBasisPanel />
      </div>

      <DetailPanel
        title={selected?.pod as string | undefined}
        data={selected}
        onClose={() => setSelected(null)}
      />
    </>
  );
}
