'use client';
import Badge from '@/components/ui/Badge';
import type { PodRow } from '@/lib/eks-resources';

// 노드에 스케줄된 Pods 테이블 (v1 노드 상세 parity) — [cluster] 페이지에서 추출해
// /eks 개요의 노드 드릴다운과 공유 (2026-07-22).
function fmtCpu(v: unknown): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return '0';
  return n.toFixed(2).replace(/\.?0+$/, '');
}

function fmtMiB(v: unknown): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString();
}

function podTone(status: string): 'positive' | 'negative' | 'neutral' {
  if (status === 'Running' || status === 'Succeeded') return 'positive';
  if (status === 'Failed' || status === 'CrashLoopBackOff') return 'negative';
  return 'neutral';
}

export function NodePodsSection({
  pods,
  error,
}: {
  pods: PodRow[] | null;
  error: string;
}) {
  return (
    <section>
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-400">
        Pods on this node
      </h3>
      {error ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-700">
          Pod list unavailable: {error}
        </div>
      ) : pods === null ? (
        <div className="rounded-md border border-ink-100 bg-ink-50 px-3 py-2 text-[12px] text-ink-500">
          Pod list loading...
        </div>
      ) : pods.length === 0 ? (
        <div className="rounded-md border border-ink-100 bg-ink-50 px-3 py-2 text-[12px] text-ink-500">
          No scheduled pods
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-ink-100">
          <table className="w-full min-w-[520px] text-[12px]">
            <thead className="bg-ink-50 text-[10px] uppercase tracking-[0.04em] text-ink-400">
              <tr>
                <th className="px-2.5 py-2 text-left font-medium">Namespace</th>
                <th className="px-2.5 py-2 text-left font-medium">Pod</th>
                <th className="px-2.5 py-2 text-left font-medium">Status</th>
                <th className="px-2.5 py-2 text-left font-medium">Owner</th>
                <th className="px-2.5 py-2 text-right font-medium">Restarts</th>
                <th className="px-2.5 py-2 text-right font-medium">CPU</th>
                <th className="px-2.5 py-2 text-right font-medium">Mem MiB</th>
                <th className="px-2.5 py-2 text-left font-medium">Age</th>
              </tr>
            </thead>
            <tbody>
              {pods.map((p) => (
                <tr key={`${p.namespace}/${p.name}`} className="border-t border-ink-100">
                  <td className="px-2.5 py-2 font-mono text-ink-500">{p.namespace || 'default'}</td>
                  <td className="px-2.5 py-2 font-mono text-ink-800">{p.name}</td>
                  <td className="px-2.5 py-2">
                    <Badge tone={podTone(p.status)} variant="soft" dot>
                      {p.status || 'Unknown'}
                    </Badge>
                  </td>
                  <td className="px-2.5 py-2 font-mono text-ink-600">{p.workload || '-'}</td>
                  <td className="px-2.5 py-2 text-right tabular text-ink-700">{p.restarts ?? 0}</td>
                  <td className="px-2.5 py-2 text-right tabular text-ink-700">{fmtCpu(p.cpuRequest)}</td>
                  <td className="px-2.5 py-2 text-right tabular text-ink-700">{fmtMiB(p.memRequest)}</td>
                  <td className="px-2.5 py-2 text-ink-500">{p.age || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default NodePodsSection;
