'use client';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import AreaTrend from '@/components/charts/AreaTrend';
import StatTile from '@/components/ui/StatTile';
import { useI18n } from '@/components/shell/LanguageProvider';
import type { TrendSample } from '@/lib/metrics';

// EC2 per-instance 24h network drill-down (gap L139, v1 parity): a row click on the EC2
// diagnostics table slides in NetworkIn + NetworkOut hourly charts with Total In/Out (24h)
// stat tiles. One opt-in trends=1 fetch; a missing series reads '데이터 불가'; a 200 without
// trends (rolling-deploy skew) takes the error branch — never a pinned loading state.
// Portaled to body (the v1 slide-in), Escape / overlay / × to close.

interface NetTrends { netIn: TrendSample[] | null; netOut: TrendSample[] | null }

const mb = (bytes: number) => bytes / 1e6;
function totalMb(samples: TrendSample[] | null): string {
  if (!samples || !samples.length) return '—';
  const sum = samples.reduce((a, s) => a + s.v, 0);
  return sum >= 1e9 ? `${(sum / 1e9).toFixed(2)} GB` : `${mb(sum).toFixed(1)} MB`;
}

export function Ec2NetworkPanel({ instanceId, accountId, region, onClose }: {
  instanceId: string; accountId?: string; region?: string; onClose: () => void;
}) {
  const { tt } = useI18n();
  const [trends, setTrends] = useState<NetTrends | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    setTrends(null); setErr(false);
    const scope = (accountId ? `&account=${encodeURIComponent(accountId)}` : '')
      + (region ? `&region=${encodeURIComponent(region)}` : '');
    fetch(`/api/inventory/ec2/metrics?id=${encodeURIComponent(instanceId)}&trends=1${scope}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (!alive) return;
        if (d && typeof d === 'object' && d.trends) setTrends(d.trends as NetTrends);
        else setErr(true);
      })
      .catch(() => { if (alive) setErr(true); });
    return () => { alive = false; };
  }, [instanceId, accountId, region]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const kstTime = (iso: string) => new Date(iso).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false });
  const chartData = (samples: TrendSample[] | null) =>
    (samples ?? []).map((s) => ({ t: kstTime(s.t), v: Math.round(mb(s.v) * 10) / 10 }));

  const block = (label: string, samples: TrendSample[] | null) =>
    !samples ? (
      <div>
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400">{label}</div>
        <p className="text-[12px] text-ink-300">{tt('데이터 불가')}</p>
      </div>
    ) : (
      <AreaTrend title={label} data={chartData(samples)} xKey="t" yKey="v" />
    );

  const panel = (
    <>
      <div className="fixed inset-0 z-40 bg-ink-900/20" onClick={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-label={tt('네트워크 트래픽 (24시간)')}
        className="fixed inset-y-0 right-0 z-50 flex w-[440px] max-w-[92vw] flex-col gap-4 overflow-y-auto border-l border-ink-100 bg-paper p-4 shadow-xl"
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-[13px] font-semibold text-ink-800">{tt('네트워크 트래픽 (24시간)')}</h3>
            <div className="font-mono text-[11px] text-ink-500 select-text">{instanceId}</div>
          </div>
          <button onClick={onClose} aria-label="close" className="rounded p-1 text-ink-400 hover:bg-ink-50 hover:text-ink-700">
            <X size={16} />
          </button>
        </div>
        {err ? (
          <p className="text-[12px] text-rose-600">{tt('메트릭 추이 조회 실패')}</p>
        ) : !trends ? (
          <p className="text-[12px] text-ink-400">{tt('메트릭 추이 로딩 중…')}</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <StatTile label={tt('Total In (24h)')} value={totalMb(trends.netIn)} variant="accent" />
              <StatTile label={tt('Total Out (24h)')} value={totalMb(trends.netOut)} variant="accent" />
            </div>
            {block('Network In (MB/h, KST)', trends.netIn)}
            {block('Network Out (MB/h, KST)', trends.netOut)}
          </>
        )}
      </aside>
    </>
  );

  return typeof document === 'undefined' ? null : createPortal(panel, document.body);
}
