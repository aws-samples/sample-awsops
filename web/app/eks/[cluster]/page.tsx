'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { Search, X } from 'lucide-react';
import DataTable, { type Column } from '@/components/ui/DataTable';
import DetailPanel from '@/components/ui/DetailPanel';
import PageHeader from '@/components/ui/PageHeader';
import { usePublishDockedWidth } from '@/lib/useResizablePanel';
import SegmentedControl from '@/components/ui/SegmentedControl';
import Input from '@/components/ui/Input';
import Badge from '@/components/ui/Badge';
import Card from '@/components/ui/Card';
import Meter from '@/components/ui/Meter';
import StatCard from '@/components/ui/StatCard';
import DonutBreakdown from '@/components/charts/DonutBreakdown';
import { aggregateNodeResources, type NodeRow, type PodRow, type NodeResourceAgg } from '@/lib/eks-resources';
import { podStatusCounts, deploymentHealth, serviceTypeCounts } from '@/lib/eks-tab-stats';
import OpencostPanel from './OpencostPanel';
import CostPanel from './CostPanel';
import NodeEniSection from '@/components/eks/NodeEniSection';
import { useI18n } from '@/components/shell/LanguageProvider';
import NodeCapacityCards from '@/components/eks/NodeCapacityCards';
import NodePodsSection from '@/components/eks/NodePodsSection';
import EksDiagnosis from '@/components/eks/EksDiagnosis';

type Row = Record<string, unknown>;
type Tab = 'nodes' | 'pods' | 'deployments' | 'services' | 'events' | 'diagnosis' | 'cost';

const TABS: { value: Tab; label: string }[] = [
  { value: 'nodes', label: 'Nodes' },
  { value: 'pods', label: 'Pods' },
  { value: 'deployments', label: 'Deployments' },
  { value: 'services', label: 'Services' },
  { value: 'events', label: 'Events' },
  { value: 'diagnosis', label: 'Diagnosis' },
  { value: 'cost', label: 'Cost' },
];

// ADR-035 Rule 7: the deterministic K8sGPT analyzer fact (FACT half).
interface AnalyzerResult {
  analyzer: string;
  resourceName: string;
  namespace: string;
  errors: string[];
  details: string;
  parentObject: string;
}
// ADR-035 Rule 8: analyzer_result (FACT) is kept structurally separate from
// llm_explanation (HYPOTHESIS — Haiku narration, may be null).
interface DiagnosisFinding {
  analyzer_result: AnalyzerResult;
  llm_explanation: string | null;
  llm_model: string | null;
}
interface DiagnosisResult {
  enabled: boolean;
  stale: boolean;
  operator_detected?: boolean;
  findings: DiagnosisFinding[];
}

// Per-kind columns (match the lib's normalized rows). Kinds with a `namespace`
// field get the in-page namespace filter. Diagnosis uses DIAGNOSIS_COLUMNS.
const COLUMNS: Record<Exclude<Tab, 'diagnosis' | 'cost'>, Column[]> = {
  nodes: [
    { key: 'name', label: 'Name' },
    { key: 'status', label: 'Status' },
    { key: 'roles', label: 'Roles' },
    { key: 'version', label: 'Version' },
    { key: 'instanceType', label: 'Instance Type' },
    { key: 'zone', label: 'Zone' },
    { key: 'age', label: 'Age' },
  ],
  pods: [
    { key: 'name', label: 'Name' },
    { key: 'namespace', label: 'Namespace' },
    { key: 'status', label: 'Status' },
    { key: 'node', label: 'Node' },
    { key: 'restarts', label: 'Restarts' },
    { key: 'age', label: 'Age' },
  ],
  deployments: [
    { key: 'name', label: 'Name' },
    { key: 'namespace', label: 'Namespace' },
    { key: 'ready', label: 'Ready' },
    { key: 'upToDate', label: 'Up-to-date' },
    { key: 'available', label: 'Available' },
    { key: 'age', label: 'Age' },
  ],
  services: [
    { key: 'name', label: 'Name' },
    { key: 'namespace', label: 'Namespace' },
    { key: 'type', label: 'Type' },
    { key: 'clusterIP', label: 'Cluster IP' },
    { key: 'ports', label: 'Ports' },
    { key: 'age', label: 'Age' },
  ],
  events: [
    { key: 'kind', label: 'Kind' },
    { key: 'object', label: 'Object' },
    { key: 'reason', label: 'Reason' },
    { key: 'message', label: 'Message' },
    { key: 'count', label: 'Count' },
    { key: 'lastSeen', label: 'Last Seen' },
  ],
};

// ADR-035 Rule 8: the table surfaces ONLY the deterministic facts. The AI
// hypothesis (llm_explanation) is shown distinctly in the detail panel below.
const DIAGNOSIS_COLUMNS: Column[] = [
  { key: 'analyzer', label: 'Analyzer' },
  { key: 'resourceName', label: 'Resource' },
  { key: 'namespace', label: 'Namespace' },
  { key: 'errors', label: 'Finding (deterministic)' }, // Rule 8 FACT
];

const NAMESPACED: Set<Tab> = new Set(['pods', 'deployments', 'services']);

export default function EksClusterPage() {
  const { tt } = useI18n();
  const params = useParams();
  const cluster = String(params.cluster);

  const [tab, setTab] = useState<Tab>('nodes');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [nodeAgg, setNodeAgg] = useState<NodeResourceAgg[] | null>(null);
  const [nodePods, setNodePods] = useState<PodRow[] | null>(null);
  const [nodePodsErr, setNodePodsErr] = useState('');
  const [diag, setDiag] = useState<DiagnosisResult | null>(null);
  const [err, setErr] = useState('');
  const [query, setQuery] = useState('');
  const [ns, setNs] = useState('전체');
  const [selected, setSelected] = useState<Row | null>(null);

  // Monotonic load sequence — a late response from a superseded load (rapid
  // tab/cluster switch) must not write stale rows/nodeAgg over the newer view
  // (P4 gate: kimi-k2.5).
  const loadSeqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    const fresh = () => seq === loadSeqRef.current;
    setRows(null);
    setNodeAgg(null);
    setNodePods(null);
    setNodePodsErr('');
    setDiag(null);
    setErr('');
    try {
      // ADR-035: the diagnosis endpoint returns {enabled,stale,findings:[...]},
      // NOT {rows}. 503 (flag off) → degrade-safe disabled state, no thrown error.
      if (tab === 'cost') return; // CostPanel fetches its own data
      if (tab === 'diagnosis') {
        const r = await fetch(`/api/eks/${encodeURIComponent(cluster)}/k8sgpt`);
        if (!fresh()) return;
        if (r.status === 503) {
          setDiag({ enabled: false, stale: true, findings: [] });
          return;
        }
        if (!r.ok) {
          const d = await r.json().catch(() => null);
          throw new Error(d?.message ? String(d.message) : String(r.status));
        }
        const diagBody = (await r.json()) as DiagnosisResult;
        if (fresh()) setDiag(diagBody);
        return;
      }
      // Nodes tab also needs pods for the per-node request aggregation — fire both
      // fetches concurrently so the table and the bars land in one paint instead of
      // table-then-bars (P4 gate: gemini). The pods leg is best-effort (null on failure).
      const podsP = tab === 'nodes'
        ? fetch(`/api/eks/${encodeURIComponent(cluster)}/incluster?kind=pods`)
            .then(async (pr) => {
              if (!pr.ok) return { rows: null, error: String(pr.status) };
              const body = await pr.json();
              return { rows: (body.rows ?? []) as PodRow[], error: '' };
            })
            .catch((e) => ({ rows: null, error: e instanceof Error ? e.message : String(e) }))
        : null;
      const r = await fetch(`/api/eks/${encodeURIComponent(cluster)}/incluster?kind=${tab}`);
      if (!r.ok) {
        const d = await r.json().catch(() => null);
        throw new Error(d?.message ? String(d.message) : String(r.status));
      }
      const d = await r.json();
      if (!fresh()) return;
      // Events have no stable server order → sort newest-first (an unsorted
      // events table is a defect). Other kinds pass through untouched.
      const sorted = tab === 'events'
        ? [...(d.rows as Row[])].sort((a, b) => Number(b.lastSeenTs ?? 0) - Number(a.lastSeenTs ?? 0))
        : (d.rows as Row[]);
      setRows(sorted);
      if (podsP) {
        const pd = await podsP;
        if (!fresh()) return;
        if (pd.rows) {
          setNodePods(pd.rows);
          setNodeAgg(aggregateNodeResources((d.rows ?? []) as NodeRow[], pd.rows));
        } else {
          setNodePods([]);
          setNodePodsErr(pd.error || 'pod list unavailable');
        }
      }
    } catch (e) {
      if (fresh()) setErr(e instanceof Error ? e.message : String(e));
    }
  }, [cluster, tab]);

  // Reset filters when switching kinds, then reload.
  useEffect(() => {
    setQuery('');
    setNs('전체');
    setSelected(null);
    load();
  }, [load]);

  const allRows = useMemo(() => rows ?? [], [rows]);

  // Distinct namespaces (namespaced kinds only) → filter options.
  const nsOptions = useMemo(() => {
    if (!NAMESPACED.has(tab)) return [];
    const set = new Set<string>();
    for (const r of allRows) {
      const v = r.namespace;
      if (v != null && v !== '') set.add(String(v));
    }
    return ['전체', ...[...set].sort((a, b) => a.localeCompare(b))];
  }, [allRows, tab]);

  const filteredRows = useMemo(() => {
    let out = allRows;
    if (NAMESPACED.has(tab) && ns !== '전체') {
      out = out.filter((r) => String(r.namespace ?? '') === ns);
    }
    const q = query.trim().toLowerCase();
    if (q) {
      out = out.filter((r) => Object.values(r).some((v) => String(v ?? '').toLowerCase().includes(q)));
    }
    return out;
  }, [allRows, tab, ns, query]);

  // ADR-035 Step 1: map each deterministic finding to a table row. The table
  // shows only the FACT columns; the full finding rides along under `_finding`
  // so the detail panel can render the HYPOTHESIS distinctly (Rule 8).
  const diagnosisRows = useMemo<Row[]>(() => {
    if (!diag) return [];
    return diag.findings.map((f) => ({
      analyzer: f.analyzer_result.analyzer,
      resourceName: f.analyzer_result.resourceName,
      namespace: f.analyzer_result.namespace,
      errors: f.analyzer_result.errors.join('; '),
      hypothesis: f.llm_explanation ?? '—',
      _finding: f,
    }));
  }, [diag]);

  const selectedFinding =
    selected && selected._finding ? (selected._finding as DiagnosisFinding) : null;
  const selectedNode =
    tab === 'nodes' && selected && typeof selected.name === 'string' && 'roles' in selected
      ? (selected as unknown as NodeRow)
      : null;
  const selectedNodeAgg = useMemo(() => {
    if (!selectedNode || !nodeAgg) return null;
    return nodeAgg.find((n) => n.name === selectedNode.name) ?? null;
  }, [nodeAgg, selectedNode]);
  const selectedNodePods = useMemo(() => {
    if (!selectedNode || !nodePods) return null;
    return nodePods
      .filter((p) => p.node === selectedNode.name)
      .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
  }, [nodePods, selectedNode]);
  const selectedNodeData = useMemo(() => {
    if (!selectedNode) return null;
    return {
      ...selectedNode,
      podCount: selectedNodeAgg?.podCount ?? selectedNodePods?.length ?? 0,
      cpuRequest: selectedNodeAgg?.cpuRequest,
      cpuRequestPct: selectedNodeAgg?.cpuPct,
      memRequestMiB: selectedNodeAgg?.memRequest,
      memRequestPct: selectedNodeAgg?.memPct,
      diskRequestMiB: selectedNodeAgg?.diskRequest,
      diskRequestPct: selectedNodeAgg?.diskPct,
    } satisfies Record<string, unknown>;
  }, [selectedNode, selectedNodeAgg, selectedNodePods]);

  const isDiagnosis = tab === 'diagnosis';
  // ADR-035 Rule 9: disabled (503/enabled:false) or zero findings → quiet,
  // degrade-safe state. No operator detected reads the same.
  const diagDisabled = !!diag && (!diag.enabled || diag.findings.length === 0);

  return (
    <>
      <PageHeader
        title={cluster}
        subtitle={
          isDiagnosis
            ? 'EKS · K8sGPT 진단 (read-only) · AI 가설은 검증 후 조치'
            : `EKS · 인-클러스터 리소스 (read-only) · ${allRows.length.toLocaleString()}개`
        }
      />
      <div className="px-8 py-8 flex flex-col gap-6">
        <div className="overflow-x-auto">
          <SegmentedControl options={TABS} value={tab} onChange={(v) => setTab(v as Tab)} />
        </div>

        {/* Cluster-scoped OpenCost: read-only install status + download guide (collapses when
            installed, auto-opens the guide when not). Shown on every tab. */}
        <OpencostPanel cluster={cluster} />

        {err && <div className="text-[13px] text-rose-600">{tt('로드 실패:')} {err}</div>}

        {tab === 'cost' ? (
          <CostPanel cluster={cluster} />
        ) : isDiagnosis ? (
          <>
            {/* Metric diagnosis tier (owner 가이드): control plane / nodes / workload / addons.
                Self-fetching — independent of the K8sGPT analyzer block below. */}
            <EksDiagnosis cluster={cluster} />
            {!diag && !err && <div className="text-ink-400">{tt('로딩 중…')}</div>}
            {diag && !err && (
              <>
                {/* Rule 9: stale (operator down/slow, last scan > threshold) banner. */}
                {diag.enabled && diag.stale && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-700">
                    last scan stale (&gt;5m)
                  </div>
                )}
                {diagDisabled ? (
                  <div className="rounded-md border border-ink-100 bg-ink-50 px-3 py-3 text-[13px] text-ink-400">
                    {tt('진단 비활성 또는 K8sGPT operator 미감지 (read-only)')}
                  </div>
                ) : (
                  <DataTable
                    columns={DIAGNOSIS_COLUMNS}
                    rows={diagnosisRows}
                    onRowClick={setSelected}
                  />
                )}
              </>
            )}
          </>
        ) : (
          <>
            {!rows && !err && <div className="text-ink-400">{tt('로딩 중…')}</div>}
            {rows && !err && (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="w-full max-w-[280px]">
                    <Input
                      inputSize="sm"
                      placeholder={tt('검색…')}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      icon={<Search className="h-3.5 w-3.5" />}
                    />
                  </div>
                  {nsOptions.length > 1 && (
                    <div className="overflow-x-auto">
                      <SegmentedControl options={nsOptions} value={ns} onChange={setNs} />
                    </div>
                  )}
                </div>

                {/* Per-tab KPI/viz — ALWAYS computed from allRows (pre-filter) so
                    the summary describes the whole set, not the filtered table. */}
                {tab === 'pods' && allRows.length > 0 && (() => {
                  const s = podStatusCounts(allRows);
                  const donut = Object.entries(s).map(([name, value]) => ({ name, value }));
                  return (
                    <>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <StatCard label="Total" value={allRows.length} />
                        <StatCard label="Running" value={s.Running ?? 0} />
                        <StatCard label="Pending" value={s.Pending ?? 0} variant={s.Pending ? 'warn' : 'default'} />
                        <StatCard label="Failed" value={s.Failed ?? 0} variant={s.Failed ? 'danger' : 'default'} />
                      </div>
                      <DonutBreakdown title="Pod Status" data={donut} nameKey="name" valueKey="value" />
                    </>
                  );
                })()}

                {tab === 'deployments' && allRows.length > 0 && (() => {
                  const health = deploymentHealth(allRows);
                  const degraded = health.filter((h) => h.pct < 100).length;
                  return (
                    <>
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                        <StatCard label="Total" value={health.length} />
                        <StatCard label="Fully available" value={health.length - degraded} />
                        <StatCard label="Degraded" value={degraded} variant={degraded > 0 ? 'danger' : 'default'} />
                      </div>
                      <Card title="레플리카 가용성" subtitle="available / desired (degraded 우선)">
                        <div className="flex flex-col gap-2">
                          {health.map((h) => (
                            <div key={`${h.namespace}/${h.name}`} className="grid grid-cols-[1fr_auto_auto] items-center gap-4 text-[12px]">
                              <span className="min-w-0 truncate font-mono text-ink-700" title={`${h.namespace}/${h.name}`}>
                                {h.namespace}/{h.name}
                              </span>
                              <Meter value={h.pct} />
                              <span className="tabular text-ink-400">{h.available}/{h.desired}</span>
                            </div>
                          ))}
                        </div>
                      </Card>
                    </>
                  );
                })()}

                {tab === 'services' && allRows.length > 0 && (() => {
                  const t = serviceTypeCounts(allRows);
                  const donut = Object.entries(t).map(([name, value]) => ({ name, value }));
                  return (
                    <>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <StatCard label="Total" value={allRows.length} />
                        <StatCard label="ClusterIP" value={t.ClusterIP ?? 0} />
                        <StatCard label="NodePort" value={t.NodePort ?? 0} />
                        <StatCard label="LoadBalancer" value={t.LoadBalancer ?? 0} />
                      </div>
                      <DonutBreakdown title="Service Types" data={donut} nameKey="name" valueKey="value" />
                    </>
                  );
                })()}

                {tab === 'nodes' && nodeAgg && nodeAgg.length > 0 && (
                  <Card title="노드 리소스" subtitle="Pod 요청 합계 대비 노드 allocatable (CPU 코어 · 메모리 MiB)">
                    <div className="flex flex-col gap-3">
                      {nodeAgg.map((n) => (
                        <div key={n.name} className="grid grid-cols-1 gap-1 sm:grid-cols-[1fr_auto_auto] sm:items-center sm:gap-6 text-[12px]">
                          <span className="min-w-0 truncate font-mono text-ink-700" title={n.name}>
                            {n.name}
                            <span className="ml-2 text-ink-400">{n.podCount} pods</span>
                          </span>
                          <span className="flex items-center gap-2 text-ink-500">
                            <span className="w-8">CPU</span>
                            <Meter value={n.cpuPct} />
                            <span className="tabular text-ink-400">{n.cpuRequest.toFixed(1)}/{n.cpuAllocatable.toFixed(1)}</span>
                          </span>
                          <span className="flex items-center gap-2 text-ink-500">
                            <span className="w-8">Mem</span>
                            <Meter value={n.memPct} />
                            <span className="tabular text-ink-400">{Math.round(n.memRequest)}/{Math.round(n.memAllocatable)}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  </Card>
                )}
                <DataTable
                  columns={COLUMNS[tab as Exclude<Tab, 'diagnosis' | 'cost'>]}
                  rows={filteredRows}
                  onRowClick={setSelected}
                />
              </>
            )}
          </>
        )}
      </div>

      {/* Diagnosis detail: deterministic FACTS + a visually distinct, badged AI
          HYPOTHESIS block (Rule 8). The generic DetailPanel can't surface that
          fact/hypothesis split, so diagnosis rows get a dedicated panel. */}
      {selectedFinding ? (
        <DiagnosisDetailPanel finding={selectedFinding} onClose={() => setSelected(null)} />
      ) : selectedNode ? (
        <DetailPanel
          title={selectedNode.name}
          data={selectedNodeData}
          onClose={() => setSelected(null)}
        >
          {/* v1 노드 상세 3분할 카드: CPU/Memory 스택 바 (Requested/Available/Reserved) + Pod Info */}
          <NodeCapacityCards
            cpuCapacity={selectedNode.cpuCapacity}
            cpuAllocatable={selectedNode.cpuAllocatable}
            cpuRequest={selectedNodeAgg?.cpuRequest ?? 0}
            memCapacityMiB={selectedNode.memCapacity}
            memAllocatableMiB={selectedNode.memAllocatable}
            memRequestMiB={selectedNodeAgg?.memRequest ?? 0}
            podCIDR={selectedNode.podCIDR}
            podCount={selectedNodePods?.length ?? 0}
            podRunning={(selectedNodePods ?? []).filter((x) => x.status === 'Running').length}
            podPending={(selectedNodePods ?? []).filter((x) => x.status === 'Pending').length}
            podFailed={(selectedNodePods ?? []).filter((x) => x.status === 'Failed').length}
            createdAt={selectedNode.createdAt}
          />
          <NodePodsSection pods={selectedNodePods} error={nodePodsErr} />
          <NodeEniSection nodeName={selectedNode.name} />
        </DetailPanel>
      ) : (
        <DetailPanel
          title={selected?.name as string | undefined}
          data={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}

/**
 * DiagnosisDetailPanel — ADR-035 Rule 8 surface. Shows the DETERMINISTIC
 * analyzer_result facts (high confidence) and, in a visually distinct block
 * below, the Haiku narration explicitly badged as an UNVERIFIED hypothesis.
 * Read-only: nothing here mutates the cluster.
 */
function DiagnosisDetailPanel({
  finding,
  onClose,
}: {
  finding: DiagnosisFinding;
  onClose: () => void;
}) {
  const { tt } = useI18n();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Coordinate this fixed 420px panel with the global chat so they don't overlap.
  usePublishDockedWidth(!!finding, 420);

  const r = finding.analyzer_result;
  const facts: { label: string; value: string }[] = [
    { label: 'analyzer', value: r.analyzer },
    { label: 'resource', value: r.resourceName },
    { label: 'namespace', value: r.namespace },
    { label: 'errors', value: r.errors.join('\n') },
    { label: 'details', value: r.details },
    { label: 'parentObject', value: r.parentObject },
  ];

  return (
    <>
      <div aria-hidden onClick={onClose} className="fixed inset-0 z-40 bg-ink-900/20" />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={r.resourceName || tt('진단 상세')}
        className="fixed right-0 top-0 z-50 flex h-full w-[420px] max-w-full flex-col border-l border-ink-100 bg-card shadow-pop"
      >
        <header className="flex items-start justify-between gap-2 border-b border-ink-100 px-4 py-3">
          <h2 className="min-w-0 break-words font-mono text-[13px] font-semibold text-ink-800">
            {r.resourceName || tt('진단 상세')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={tt('닫기')}
            className="-mr-1 shrink-0 rounded p-1 text-ink-400 hover:bg-ink-50 hover:text-ink-700"
          >
            <X size={16} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {/* FACT half — deterministic K8sGPT analyzer result (Rule 8). */}
          <div className="mb-2 flex items-center gap-2">
            <Badge tone="neutral" variant="outline">
              deterministic fact
            </Badge>
          </div>
          <dl className="space-y-2.5">
            {facts.map((f) => (
              <div key={f.label} className="grid grid-cols-1 gap-0.5">
                <dt className="font-mono text-[11px] text-ink-500">{f.label}</dt>
                <dd className="text-[13px] text-ink-800">
                  {f.value ? (
                    <span className="block whitespace-pre-wrap break-words select-text">{f.value}</span>
                  ) : (
                    <span className="text-ink-300">—</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>

          {/* HYPOTHESIS half — Haiku narration, explicitly labelled UNVERIFIED. */}
          <div className="mt-5 rounded-md border border-brand-200 bg-brand-50 px-3 py-3">
            <div className="mb-1.5">
              <Badge tone="brand" variant="solid">
                AI hypothesis (Haiku) — verify before acting
              </Badge>
            </div>
            <p className="text-[13px] leading-snug text-ink-700 whitespace-pre-wrap break-words select-text">
              {finding.llm_explanation ?? tt('가설 없음 (deterministic finding only)')}
            </p>
          </div>
        </div>
      </aside>
    </>
  );
}
