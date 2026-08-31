'use client';
import { useEffect, useState } from 'react';
import { DollarSign, CalendarDays, Boxes, Crown } from 'lucide-react';
import StatTile from '@/components/ui/StatTile';
import Card from '@/components/ui/Card';
import DataTable, { type Column } from '@/components/ui/DataTable';
import DonutBreakdown from '@/components/charts/DonutBreakdown';
import { useI18n } from '@/components/shell/LanguageProvider';

interface PodCost {
  namespace: string; pod: string; node: string;
  cpuCost: number; ramCost: number; networkCost: number; pvCost: number; gpuCost: number; totalCost: number;
}
interface AllocationResult {
  available: boolean; message?: string;
  source?: 'opencost' | 'request-estimate';
  nodes?: { node: string; cpuCost: number; ramCost: number; totalCost: number }[];
  pods: PodCost[]; namespaces: { name: string; value: number }[];
  kpi: { dailyTotal: number; monthly: number; podCount: number; topNamespace: { name: string; cost: number } | null };
  hasNetwork: boolean; hasPv: boolean; hasGpu: boolean;
}

const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** EKS 컨테이너 비용 (v1 eks-container-cost parity) — OpenCost 1d allocation 기반 KPI/도넛/Pod 테이블. */
export default function CostPanel({ cluster }: { cluster: string }) {
  const { tt } = useI18n();
  const [d, setD] = useState<AllocationResult | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    setD(null); setErr('');
    fetch(`/api/opencost/${encodeURIComponent(cluster)}/allocation`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body) => { if (alive) setD(body); })
      .catch((e) => { if (alive) { setErr(String(e)); setD(null); } });
    return () => { alive = false; };
  }, [cluster]);

  if (err) return <div className="text-[13px] text-rose-600">{tt('비용 조회 실패:')} {err}</div>;
  if (!d) return <div className="text-ink-400">{tt('OpenCost allocation 조회 중…')}</div>;
  if (!d.available) {
    return (
      <Card>
        <p className="text-[13px] text-ink-600">
          {tt('OpenCost 비용 데이터를 읽을 수 없습니다 — 위의 OpenCost 패널에서 설치 상태를 확인하세요.')}
        </p>
        {d.message && <p className="mt-1 font-mono text-[11px] text-ink-400">{d.message}</p>}
      </Card>
    );
  }

  // v1 parity: Network/Storage(PV)/GPU columns appear only when the cluster actually reports them.
  const columns: Column[] = [
    { key: 'namespace', label: 'Namespace' },
    { key: 'pod', label: 'Pod' },
    { key: 'node', label: 'Node' },
    { key: 'cpu_h', label: 'CPU' },
    { key: 'ram_h', label: 'Memory' },
    ...(d.hasNetwork ? [{ key: 'net_h', label: 'Network' }] : []),
    ...(d.hasPv ? [{ key: 'pv_h', label: 'Storage(PV)' }] : []),
    ...(d.hasGpu ? [{ key: 'gpu_h', label: 'GPU' }] : []),
    { key: 'total_h', label: 'Total/Day' },
  ];
  const rows = d.pods.map((p) => ({
    namespace: p.namespace, pod: p.pod, node: p.node,
    cpu_h: usd(p.cpuCost), ram_h: usd(p.ramCost), net_h: usd(p.networkCost),
    pv_h: usd(p.pvCost), gpu_h: usd(p.gpuCost), total_h: usd(p.totalCost),
  }));

  return (
    <div className="flex flex-col gap-6">
      {/* v1 parity: make the data source explicit — measured vs estimated. */}
      {d.source === 'request-estimate' ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-[12px] text-amber-700">
          {tt('OpenCost 미가용 — Pod 리소스 요청(request) 기반 추정입니다 (요청 × 단가, 실측 아님). 정확한 비용은 OpenCost 설치 후 표시됩니다.')}
        </div>
      ) : (
        <div className="rounded-lg border border-ink-100 bg-paper-muted px-4 py-2 text-[12px] text-ink-500">
          {tt('데이터 소스: OpenCost 실측 allocation (최근 1일)')}
        </div>
      )}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatTile label="Pod 비용 (일간)" value={usd(d.kpi.dailyTotal)} variant="accent" icon={<DollarSign size={16} />} />
        <StatTile label="Pod 비용 (월간 추정)" value={usd(d.kpi.monthly)} hint="일간 × 30" icon={<CalendarDays size={16} />} />
        <StatTile label="Pods" value={d.kpi.podCount} icon={<Boxes size={16} />} />
        <StatTile
          label="Top Namespace"
          value={d.kpi.topNamespace ? usd(d.kpi.topNamespace.cost) : '—'}
          hint={d.kpi.topNamespace?.name}
          icon={<Crown size={16} />}
        />
      </div>
      {d.namespaces.length > 0 && (
        <DonutBreakdown title="Namespace별 비용 (일간)" data={d.namespaces} nameKey="name" valueKey="value" />
      )}
      <DataTable columns={columns} rows={rows} />
      {d.nodes && d.nodes.length > 0 && (
        <Card title="Node별 비용 (일간)" padded={false}>
          <table className="w-full">
            <thead><tr className="border-b border-ink-100 text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400">
              <th className="px-3 py-2">Node</th><th className="px-3 py-2">CPU</th><th className="px-3 py-2">Memory</th><th className="px-3 py-2">Total/Day</th>
            </tr></thead>
            <tbody>
              {d.nodes.map((n) => (
                <tr key={n.node} className="border-b border-ink-50 last:border-0">
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
    </div>
  );
}
