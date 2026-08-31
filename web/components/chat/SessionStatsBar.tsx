'use client';
import { sectionByKey } from '@/lib/sections';
import type { SessionStats } from './useChat';
import { useI18n } from '@/components/shell/LanguageProvider';

// v1-parity session stats bar (v1 src/app/ai/page.tsx:483-493): a thin summary of THIS session's
// activity — query count, avg latency, success rate (color-coded), and the top gateways used.
// Hidden until at least one answer exists, so an empty chat looks unchanged.
export default function SessionStatsBar({ stats }: { stats: SessionStats }) {
  const { tt } = useI18n();
  if (stats.count === 0) return null;
  const rate = stats.successRate;
  const rateColor = rate === null ? 'text-ink-400'
    : rate >= 0.9 ? 'text-positive-text' : rate >= 0.6 ? 'text-warning-text' : 'text-negative-text';
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-ink-100 px-4 py-1.5 text-[11px] text-ink-500">
      <span>{tt(`이 세션 ${stats.count}개 질의`)}</span>
      {stats.avgMs !== null && (
        <span>{tt('평균')} <span className="font-semibold text-ink-700 tabular-nums">{(stats.avgMs / 1000).toFixed(1)}s</span></span>
      )}
      {rate !== null && (
        <span>{tt('성공률')} <span className={`font-semibold tabular-nums ${rateColor}`}>{Math.round(rate * 100)}%</span></span>
      )}
      {stats.topGateways.length > 0 && (
        <span className="flex items-center gap-1.5">
          {stats.topGateways.map(({ gateway, count }) => {
            const s = sectionByKey(gateway);
            return (
              <span key={gateway} className="flex items-center gap-1">
                <span className="inline-block h-[6px] w-[6px] rounded-full" style={{ background: s?.color ?? 'var(--ink-300)' }} />
                {s?.label ?? gateway}<span className="tabular-nums text-ink-400">·{count}</span>
              </span>
            );
          })}
        </span>
      )}
    </div>
  );
}
