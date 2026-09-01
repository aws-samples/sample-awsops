'use client';
import { useEffect, useState } from 'react';
import { LineChart, Line, ResponsiveContainer } from 'recharts';
import AreaTrend from '@/components/charts/AreaTrend';
import { useI18n } from '@/components/shell/LanguageProvider';
import { useChartColors } from '@/lib/use-chart-colors';
import type { RdsInstanceTrends, RdsSparkField, TrendSample } from '@/lib/metrics';

// RDS detail time-series (gap L141/L142/L155, v1 parity): 6-metric 1h sparklines (≤2 points →
// the v1 Avg/Max/Min fallback grid, never a misleading 2-point line), FreeableMemory 24h trend,
// CPU 14d daily trend — one opt-in `trends=1` fetch. Named export per the metrics-module
// convention; mounted by DetailPanel below RdsMetricsSection.

// field is the keyed union — a field-name drift vs the lib's SPARK_METRICS now fails to compile
// instead of silently rendering '데이터 불가'.
const SPARKS: { field: RdsSparkField; label: string; fmt: (v: number) => string }[] = [
  { field: 'cpu', label: 'CPU (%)', fmt: (v) => `${v.toFixed(1)}%` },
  { field: 'freeableMemory', label: 'Freeable Mem', fmt: gb },
  { field: 'connections', label: 'Connections', fmt: (v) => String(Math.round(v)) },
  { field: 'readIops', label: 'Read IOPS', fmt: (v) => v.toFixed(1) },
  { field: 'writeIops', label: 'Write IOPS', fmt: (v) => v.toFixed(1) },
  { field: 'freeStorage', label: 'Free Storage', fmt: gb },
];

function gb(v: number): string {
  return `${(v / 1024 ** 3).toFixed(1)} GB`;
}

function stats(samples: TrendSample[]): { avg: number; max: number; min: number } | null {
  if (!samples.length) return null; // defense-in-depth — series() already maps [] → null
  const vs = samples.map((s) => s.v);
  return {
    avg: vs.reduce((a, b) => a + b, 0) / vs.length,
    max: Math.max(...vs),
    min: Math.min(...vs),
  };
}

function AvgMaxMin({ samples, fmt }: { samples: TrendSample[]; fmt: (v: number) => string }) {
  const { tt } = useI18n();
  const s = stats(samples);
  if (!s) return null;
  return (
    <div className="grid grid-cols-3 gap-1 text-center">
      {([['Avg', s.avg], ['Max', s.max], ['Min', s.min]] as const).map(([label, v]) => (
        <div key={label} className="rounded bg-paper px-1 py-0.5">
          <div className="text-[9px] uppercase text-ink-400">{tt(label)}</div>
          <div className="text-[11px] font-medium text-ink-700">{fmt(v)}</div>
        </div>
      ))}
    </div>
  );
}

export function RdsTrendsSection({ instanceId }: { instanceId: string }) {
  const { tt } = useI18n();
  const c = useChartColors();
  const [trends, setTrends] = useState<RdsInstanceTrends | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    setTrends(null); setErr(false);
    fetch(`/api/inventory/rds/metrics?id=${encodeURIComponent(instanceId)}&trends=1`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (!alive) return;
        // A 200 without `trends` (an old task ignoring the param during a rolling deploy)
        // must not pin the loading state forever — treat it as the error branch.
        if (d && typeof d === 'object' && d.trends) setTrends(d.trends as RdsInstanceTrends);
        else setErr(true);
      })
      .catch(() => { if (alive) setErr(true); });
    return () => { alive = false; };
  }, [instanceId]);

  if (err) return <p className="text-[12px] text-rose-600">{tt('메트릭 추이 조회 실패')}</p>;
  if (!trends) return <p className="text-[12px] text-ink-400">{tt('메트릭 추이 로딩 중…')}</p>;

  // Axis labels in KST (raw ISO slices read 9h shifted for the operator's timezone).
  const kstTime = (iso: string) => new Date(iso).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false });
  const kstDay = (iso: string) => new Date(iso).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit' });
  const memData = (trends.mem24h ?? []).map((s) => ({ t: kstTime(s.t), v: Math.round((s.v / 1024 ** 3) * 10) / 10 }));
  const cpuData = (trends.cpu14d ?? []).map((s) => ({ t: kstDay(s.t), v: s.v }));

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400">{tt('최근 1시간 (5분 단위)')}</div>
        <div className="grid grid-cols-2 gap-2">
          {SPARKS.map((m) => {
            const samples = trends.spark[m.field];
            return (
              <div key={m.field} className="rounded-md border border-ink-100 bg-paper p-2">
                <div className="mb-1 text-[10px] text-ink-500">{m.label}</div>
                {!samples ? (
                  // Honest-degrade: no datapoints (stopped instance / metric absent).
                  <div className="text-[11px] text-ink-300">{tt('데이터 불가')}</div>
                ) : samples.length <= 2 ? (
                  // v1 fallback: ≤2 points render Avg/Max/Min, never a misleading 2-point line.
                  <AvgMaxMin samples={samples} fmt={m.fmt} />
                ) : (
                  <div className="h-[44px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={samples}>
                        <Line type="monotone" dataKey="v" stroke={c.palette[0]} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                      </LineChart>
                    </ResponsiveContainer>
                    <div className="mt-0.5 text-right text-[10px] text-ink-500">{m.fmt(samples[samples.length - 1].v)}</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div>
        {!trends.mem24h ? (
          <>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400">{tt('여유 메모리 24시간 (GB, KST)')}</div>
            <p className="text-[12px] text-ink-300">{tt('데이터 불가')}</p>
          </>
        ) : (
          <>
            <AreaTrend title={tt('여유 메모리 24시간 (GB, KST)')} data={memData} xKey="t" yKey="v" />
            <div className="mt-1"><AvgMaxMin samples={trends.mem24h} fmt={gb} /></div>
          </>
        )}
      </div>
      <div>
        {!trends.cpu14d ? (
          <>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400">{tt('CPU 14일 일별 추이 (%)')}</div>
            <p className="text-[12px] text-ink-300">{tt('데이터 불가')}</p>
          </>
        ) : (
          <>
            <AreaTrend title={tt('CPU 14일 일별 추이 (%)')} data={cpuData} xKey="t" yKey="v" />
            <div className="mt-1"><AvgMaxMin samples={trends.cpu14d} fmt={(v) => `${v.toFixed(1)}%`} /></div>
          </>
        )}
      </div>
    </div>
  );
}
