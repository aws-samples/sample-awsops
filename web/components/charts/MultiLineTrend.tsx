'use client';

import type { ReactNode } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useState } from 'react';
import Card from '@/components/ui/Card';
import { useChartColors } from '@/lib/use-chart-colors';
import { axisTick, tooltipStyles } from './theme';

export interface MultiLineTrendProps {
  /** Interactive legend (gap L126, v1 parity): chips toggle per-series visibility, optionally
   *  grouped into rows (Core/Other). Colors stay pinned to each series' ORIGINAL index so
   *  toggling never recolors the remaining lines. `defaultHidden` is read at MOUNT only — a
   *  caller whose series set can change (e.g. a period toggle re-ranking types) must `key=`
   *  the chart on the series signature so the hidden state resets with it. */
  interactiveLegend?: boolean;
  legendGroups?: { label: string; keys: string[] }[];
  defaultHidden?: string[];
  title: ReactNode;
  /** Right slot in the Card header (e.g. a SegmentedControl period toggle). */
  right?: ReactNode;
  data: Array<Record<string, unknown>>;
  xKey: string;
  /** Series keys, one line each; label defaults to the key. */
  series: { key: string; label?: string }[];
  height?: number;
  /** 'bar' renders grouped bars instead of lines (Explore Line/Bar toggle). */
  variant?: 'line' | 'bar';
}

/**
 * MultiLineTrend — N overlaid lines with the shared palette (v1 parity: per-resource-type
 * inventory history). Tooltip rows are sorted by value desc; the legend wraps under the chart.
 */
export default function MultiLineTrend({ title, right, data, xKey, series, height = 260, variant = 'line', interactiveLegend = false, legendGroups, defaultHidden }: MultiLineTrendProps) {
  const c = useChartColors();
  const colorFor = (i: number) => c.palette[i % c.palette.length];
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(defaultHidden ?? []));
  const toggle = (key: string) => setHidden((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const indexOf = new Map(series.map((s, i) => [s.key, i]));
  const isVisible = (key: string) => !interactiveLegend || !hidden.has(key);
  return (
    <Card title={title} right={right}>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          {variant === 'bar' ? (
            <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={c.grid} vertical={false} />
              <XAxis dataKey={xKey} tick={axisTick(c)} tickLine={false} axisLine={false} />
              <YAxis tick={axisTick(c)} tickLine={false} axisLine={false} allowDecimals={false} />
              <Tooltip {...tooltipStyles(c)} itemSorter={(item) => -(Number(item.value) || 0)} />
              {series.filter((s) => isVisible(s.key)).map((s) => (
                <Bar key={s.key} dataKey={s.key} name={s.label ?? s.key} fill={colorFor(indexOf.get(s.key)!)} isAnimationActive={false} />
              ))}
            </BarChart>
          ) : (
            <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={c.grid} vertical={false} />
              <XAxis dataKey={xKey} tick={axisTick(c)} tickLine={false} axisLine={false} />
              <YAxis tick={axisTick(c)} tickLine={false} axisLine={false} allowDecimals={false} />
              <Tooltip
                {...tooltipStyles(c)}
                itemSorter={(item) => -(Number(item.value) || 0)}
              />
              {series.filter((s) => isVisible(s.key)).map((s) => (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.label ?? s.key}
                  stroke={colorFor(indexOf.get(s.key)!)}
                  strokeWidth={1.8}
                  dot={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
      {!interactiveLegend && (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
          {series.map((s, i) => (
            <span key={s.key} className="inline-flex items-center gap-1.5 text-[11px] text-ink-500">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: colorFor(i) }} />
              {s.label ?? s.key}
            </span>
          ))}
        </div>
      )}
      {interactiveLegend && (
        <div className="mt-2 space-y-1">
          {(() => {
            const groups = legendGroups ?? [{ label: '', keys: series.map((s) => s.key) }];
            // A series key covered by no group would be un-toggleable (and unrecoverable if
            // also defaultHidden) — surface leftovers in an extra unlabeled row.
            const covered = new Set<string>();
            // Dedupe across groups — a key listed twice would render two chips for one series.
            const deduped = groups.map((g) => ({
              label: g.label,
              keys: g.keys.filter((k) => !covered.has(k) && (covered.add(k), true)),
            }));
            const leftover = series.map((s) => s.key).filter((k) => !covered.has(k));
            return leftover.length ? [...deduped, { label: '', keys: leftover }] : deduped;
          })().map((g, gi) => (
            <div key={`${gi}-${g.label}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {g.label && <span className="text-[10px] font-semibold uppercase tracking-[0.04em] text-ink-400">{g.label}</span>}
              {g.keys.map((key) => {
                const s = series.find((x) => x.key === key);
                if (!s) return null;
                const off = hidden.has(key);
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => toggle(key)}
                    aria-pressed={!off}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] ${off ? 'border-ink-100 text-ink-300' : 'border-ink-200 text-ink-600'}`}
                  >
                    <span className="inline-block h-2 w-2 rounded-full" style={{ background: off ? 'var(--ink-200, #d5dbe3)' : colorFor(indexOf.get(key)!) }} />
                    <span className={off ? 'line-through' : ''}>{s.label ?? s.key}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
