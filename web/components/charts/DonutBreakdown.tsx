'use client';

import type { ReactNode } from 'react';
import { Cell, Pie, PieChart, Tooltip } from 'recharts';
import Card from '@/components/ui/Card';
import { useI18n } from '@/components/shell/LanguageProvider';
import { useChartColors } from '@/lib/use-chart-colors';
import { tooltipStyles } from './theme';

export interface DonutBreakdownProps {
  title: ReactNode;
  right?: ReactNode;
  data: Array<Record<string, unknown>>;
  nameKey: string;
  valueKey: string;
  /** Prefix legend/center values (e.g. "$"). */
  valuePrefix?: string;
  /** Top-N slices kept individually; the remainder rolls up into one "기타" slice
   *  (design handoff 개선안 ②-B: an 8+ slice breakdown otherwise repeats palette colors
   *  and leaves 2–3% slivers unreadable). Default 8 — matches the 8-color palette. */
  maxSlices?: number;
  /** Semantic per-slice colors keyed by the slice's name (e.g. severity → fixed color).
   *  Unmapped names fall back to the positional palette. */
  colors?: Record<string, string>;
  className?: string;
}

/**
 * DonutBreakdown — PieChart innerRadius 55 / outerRadius 80, an 8-color unique
 * palette (a Top-N rollup keeps 9+ slices legible), a center total label, and
 * a side legend list with a percentage of total. DESIGN.md §Charts.
 */
export default function DonutBreakdown({
  title,
  right,
  data,
  nameKey,
  valueKey,
  valuePrefix = '',
  maxSlices = 8,
  colors,
  className,
}: DonutBreakdownProps) {
  const { tt } = useI18n();
  const c = useChartColors();
  const total = data.reduce((s, d) => s + (Number(d[valueKey]) || 0), 0);
  const fmtTotal =
    valuePrefix === '$'
      ? `$${Math.round(total).toLocaleString()}`
      : total.toLocaleString();

  // Sort descending so the rollup drops the smallest tail, then fold anything past
  // maxSlices-1 into one "기타" slice (keeps one slot for it within maxSlices total).
  const sorted = [...data].sort((a, b) => (Number(b[valueKey]) || 0) - (Number(a[valueKey]) || 0));
  const keep = maxSlices > 0 ? maxSlices - 1 : sorted.length;
  const shown = sorted.length > maxSlices ? sorted.slice(0, keep) : sorted;
  const etcValue = sorted.length > maxSlices
    ? sorted.slice(keep).reduce((s, d) => s + (Number(d[valueKey]) || 0), 0)
    : 0;
  const rows: Array<Record<string, unknown>> =
    etcValue > 0 ? [...shown, { [nameKey]: tt('기타'), [valueKey]: etcValue }] : shown;
  const colorFor = (i: number) => {
    const pinned = colors?.[String(rows[i]?.[nameKey])];
    if (pinned) return pinned;
    return etcValue > 0 && i === rows.length - 1 ? c.etc : c.palette[i % c.palette.length];
  };
  const pct = (v: unknown) => (total > 0 ? `${((Number(v) / total) * 100).toFixed(1)}%` : '0%');

  return (
    <Card title={title} right={right} className={className}>
      <div className="flex items-center gap-4">
        {/* Fixed-size PieChart (the wrapper is a fixed 170 square) — NOT ResponsiveContainer,
            which measured the parent as width(-1)/height(-1) on narrow/SSR layout passes and
            made the donut vanish. Fixed dims always render. */}
        <div className="relative shrink-0" style={{ width: 170, height: 170 }}>
          <PieChart width={170} height={170}>
            <Pie
              data={rows}
              dataKey={valueKey}
              nameKey={nameKey}
              innerRadius={55}
              outerRadius={80}
              paddingAngle={2}
              stroke="none"
            >
              {rows.map((_, i) => (
                <Cell key={i} fill={colorFor(i)} />
              ))}
            </Pie>
            <Tooltip
              {...tooltipStyles(c)}
              formatter={(v, n) =>
                [
                  valuePrefix === '$'
                    ? `$${Math.round(Number(v)).toLocaleString()}`
                    : Number(v).toLocaleString(),
                  n as string,
                ] as [string, string]
              }
            />
          </PieChart>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <div className="tabular text-[20px] font-semibold leading-none text-ink-800">
              {fmtTotal}
            </div>
            <div className="text-[10px] uppercase tracking-[0.04em] text-ink-400 mt-1">{tt('합계')}</div>
          </div>
        </div>
        <ul className="min-w-0 flex-1 space-y-1.5">
          {rows.map((d, i) => (
            <li key={i} className="flex items-center gap-2 text-[12px]">
              <span
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: colorFor(i) }}
              />
              <span className="min-w-0 flex-1 truncate text-ink-600">{String(d[nameKey])}</span>
              <span className="shrink-0 text-ink-400">{pct(d[valueKey])}</span>
              <span className="tabular shrink-0 font-medium text-ink-800">
                {valuePrefix === '$'
                  ? `$${Math.round(Number(d[valueKey])).toLocaleString()}`
                  : Number(d[valueKey]).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
