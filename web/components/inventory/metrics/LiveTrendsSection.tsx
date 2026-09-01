'use client';
import { useEffect, useState } from 'react';
import { LineChart, Line, ResponsiveContainer } from 'recharts';
import { useI18n } from '@/components/shell/LanguageProvider';
import { useChartColors } from '@/lib/use-chart-colors';
import type { LiveTrendMetric, TrendSample } from '@/lib/metrics';

// Generic 1h metric sparklines for LIVE_SPECS types (gap L118, v1's elasticache detail
// sparklines — generalized to opensearch/msk which share the spec table). Mirrors
// RdsTrendsSection's contract: ≤2 points → Avg/Max/Min fallback (never a misleading 2-point
// line), missing series → '데이터 불가', 200-without-trends (rolling-deploy skew) → error
// branch, fetch failure → inline error. Named export per the metrics-module convention.

// Client-side twin of the server's fmtLive — importing lib/metrics' formatter would pull the
// AWS SDK into the client bundle.
function fmtValue(v: number, fmt: LiveTrendMetric['fmt']): string {
  switch (fmt) {
    case 'pct': return `${Math.round(v * 10) / 10}%`;
    case 'ratioPct': return `${Math.round((v <= 1 ? v * 100 : v) * 10) / 10}%`; // 0–1 ratio source (CacheHitRate)
    case 'gb': return `${(v / 1e9).toFixed(1)} GB`;
    case 'mb': return `${(v / 1e6).toFixed(1)} MB`;
    case 'mbRaw': return `${v.toFixed(1)} MB`; // source metric already in megabytes (AWS/ES)
    case 'ms': return `${Math.round(v * 1000) / 1000} ms`;
    case 'bps': return `${(v / 1e6).toFixed(1)} MB/s`;
    default: return Math.round(v).toLocaleString();
  }
}

function AvgMaxMin({ samples, fmt }: { samples: TrendSample[]; fmt: LiveTrendMetric['fmt'] }) {
  const { tt } = useI18n();
  if (!samples.length) return null;
  const vs = samples.map((s) => s.v);
  const rows = [
    ['Avg', vs.reduce((a, b) => a + b, 0) / vs.length],
    ['Max', Math.max(...vs)],
    ['Min', Math.min(...vs)],
  ] as const;
  return (
    <div className="grid grid-cols-3 gap-1 text-center">
      {rows.map(([label, v]) => (
        <div key={label} className="rounded bg-paper px-1 py-0.5">
          <div className="text-[9px] uppercase text-ink-400">{tt(label)}</div>
          <div className="text-[11px] font-medium text-ink-700">{fmtValue(v, fmt)}</div>
        </div>
      ))}
    </div>
  );
}

export function LiveTrendsSection({ type, id, accountId, region }: { type: string; id: string; accountId?: string; region?: string }) {
  const { tt } = useI18n();
  const c = useChartColors();
  const [trends, setTrends] = useState<LiveTrendMetric[] | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    setTrends(null); setErr(false);
    const acct = (accountId ? `&account=${encodeURIComponent(accountId)}` : '')
      + (region ? `&region=${encodeURIComponent(region)}` : '');
    fetch(`/api/inventory/${encodeURIComponent(type)}/metrics?id=${encodeURIComponent(id)}&trends=1${acct}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (!alive) return;
        if (d && Array.isArray(d.trends)) setTrends(d.trends as LiveTrendMetric[]);
        else setErr(true); // 200 without trends (old task during a rolling deploy) — never pin loading
      })
      .catch(() => { if (alive) setErr(true); });
    return () => { alive = false; };
  }, [type, id, accountId, region]);

  // The heading renders in EVERY branch — a bare unlabelled bordered card under the
  // live-metrics card would be unreadable (the sibling sections do the same).
  const heading = (
    <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400">{tt('최근 1시간 (5분 단위)')}</div>
  );
  if (err) return <div>{heading}<p className="text-[12px] text-rose-600">{tt('메트릭 추이 조회 실패')}</p></div>;
  if (!trends) return <div>{heading}<p className="text-[12px] text-ink-400">{tt('메트릭 추이 로딩 중…')}</p></div>;
  if (!trends.length) return <div>{heading}<p className="text-[12px] text-ink-300">{tt('데이터 불가')}</p></div>;

  return (
    <div>
      {heading}
      <div className="grid grid-cols-2 gap-2">
        {trends.map((m) => (
          <div key={m.label} className="rounded-md border border-ink-100 bg-paper p-2">
            <div className="mb-1 text-[10px] text-ink-500">{m.label}</div>
            {!m.samples ? (
              <div className="text-[11px] text-ink-300">{tt('데이터 불가')}</div>
            ) : m.samples.length <= 2 ? (
              <AvgMaxMin samples={m.samples} fmt={m.fmt} />
            ) : (
              <div className="h-[44px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={m.samples}>
                    <Line type="monotone" dataKey="v" stroke={c.palette[0]} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
                <div className="mt-0.5 text-right text-[10px] text-ink-500">{fmtValue(m.samples[m.samples.length - 1].v, m.fmt)}</div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
