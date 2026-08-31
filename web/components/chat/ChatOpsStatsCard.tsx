'use client';
import { useEffect, useState } from 'react';
import { sectionByKey } from '@/lib/sections';
import type { ChatInvokeStats } from '@/lib/trace';
import { useI18n } from '@/components/shell/LanguageProvider';

// v1-parity AI-call ops stats (v1 /agentcore page): call volume / success rate / avg latency per
// gateway + recent calls, from /api/chat/stats. Self-contained card for the Bedrock usage page.
export default function ChatOpsStatsCard() {
  const { tt } = useI18n();
  const [s, setS] = useState<ChatInvokeStats | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/chat/stats?days=7');
        if (res.ok && alive) setS(await res.json());
      } catch { /* degrade: card hides */ } finally { if (alive) setLoaded(true); }
    })();
    return () => { alive = false; };
  }, []);

  if (!loaded) return null;
  if (!s || s.totalCalls === 0) return null; // nothing recorded yet → no empty card

  const rate = s.successRate;
  const rateColor = rate === null ? 'text-ink-500'
    : rate >= 0.9 ? 'text-positive-text' : rate >= 0.6 ? 'text-warning-text' : 'text-negative-text';

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[13px] font-semibold text-ink-800">{tt('AI 어시스턴트 호출 통계')} <span className="font-normal text-ink-400">({tt('최근 7일')})</span></h2>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <div className="rounded-lg border border-ink-100 bg-card p-4">
          <div className="text-[11px] text-ink-400">{tt('총 호출')}</div>
          <div className="mt-1 text-[20px] font-semibold tabular-nums text-ink-800">{s.totalCalls.toLocaleString()}</div>
        </div>
        <div className="rounded-lg border border-ink-100 bg-card p-4">
          <div className="text-[11px] text-ink-400">{tt('성공률')}</div>
          <div className={`mt-1 text-[20px] font-semibold tabular-nums ${rateColor}`}>{rate === null ? '—' : `${Math.round(rate * 100)}%`}</div>
        </div>
        <div className="rounded-lg border border-ink-100 bg-card p-4">
          <div className="text-[11px] text-ink-400">{tt('평균 응답')}</div>
          <div className="mt-1 text-[20px] font-semibold tabular-nums text-ink-800">{s.avgElapsedMs === null ? '—' : `${(s.avgElapsedMs / 1000).toFixed(1)}s`}</div>
        </div>
      </div>

      {s.byGateway.length > 0 && (
        <div className="rounded-lg border border-ink-100 bg-card p-4">
          <div className="mb-2 text-[11px] font-medium text-ink-500">{tt('섹션별 분포')}</div>
          <div className="flex flex-col gap-1.5">
            {s.byGateway.map((g) => {
              const sec = sectionByKey(g.gateway);
              const pct = s.totalCalls ? Math.round((g.calls / s.totalCalls) * 100) : 0;
              return (
                <div key={g.gateway} className="flex items-center gap-2 text-[12px]">
                  <span className="inline-block h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: sec?.color ?? 'var(--ink-300)' }} />
                  <span className="w-28 shrink-0 truncate text-ink-700">{sec?.label ?? g.gateway}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-paper-muted">
                    <div className="h-full rounded-full" style={{ width: `${pct}%`, background: sec?.color ?? 'var(--ink-300)' }} />
                  </div>
                  <span className="w-24 shrink-0 text-right tabular-nums text-ink-400">
                    {tt(`${g.calls}건 · ${(g.avgElapsedMs / 1000).toFixed(1)}s`)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
