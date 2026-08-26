'use client';

import type { ReactNode } from 'react';
import Card from '@/components/ui/Card';

export interface HBarListProps {
  title: ReactNode;
  right?: ReactNode;
  data: Array<Record<string, unknown>>;
  labelKey: string;
  valueKey: string;
  /** Prefix the right-aligned amount (e.g. "$"). */
  valuePrefix?: string;
  /** Give the row(s) at the max value a stronger fill (brand-700) — mirrors the
   *  BarDistribution "max bar" highlight rule (design handoff 개선안 ②-A). */
  highlightMax?: boolean;
  className?: string;
}

/**
 * HBarList — NOT recharts. A simple flex list: label / a sunken track with a
 * proportional brand-500 fill / a right-aligned tabular amount. Matches
 * DESIGN.md §6 "서비스별 비용".
 */
export default function HBarList({
  title,
  right,
  data,
  labelKey,
  valueKey,
  valuePrefix = '',
  highlightMax = false,
  className,
}: HBarListProps) {
  const max = data.reduce((m, d) => {
    const n = Number(d[valueKey]);
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);

  const fmt = (v: unknown) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    const rounded = valuePrefix === '$' ? Math.round(n * 100) / 100 : n;
    return `${valuePrefix}${rounded.toLocaleString(undefined, {
      minimumFractionDigits: valuePrefix === '$' ? 2 : 0,
      maximumFractionDigits: valuePrefix === '$' ? 2 : 0,
    })}`;
  };

  return (
    <Card title={title} right={right} className={className}>
      <ul className="space-y-2.5">
        {data.map((d, i) => {
          const n = Number(d[valueKey]) || 0;
          const pct = max > 0 ? Math.max(2, (n / max) * 100) : 0;
          const isMax = highlightMax && max > 0 && n === max;
          return (
            <li key={i} className="flex items-center gap-3">
              <span className="w-32 shrink-0 truncate text-[12px] text-ink-600" title={String(d[labelKey])}>
                {String(d[labelKey])}
              </span>
              <span className="h-2 flex-1 overflow-hidden rounded-full bg-paper-muted">
                <span
                  className={isMax ? 'block h-full rounded-full bg-brand-700' : 'block h-full rounded-full bg-brand-500'}
                  style={{ width: `${pct}%` }}
                />
              </span>
              <span className="tabular w-20 shrink-0 text-right text-[12px] font-medium text-ink-800">
                {fmt(n)}
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
