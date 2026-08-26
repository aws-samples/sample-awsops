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
import Card from '@/components/ui/Card';
import { useChartColors } from '@/lib/use-chart-colors';
import { axisTick, tooltipStyles } from './theme';

export interface MultiLineTrendProps {
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
export default function MultiLineTrend({ title, right, data, xKey, series, height = 260, variant = 'line' }: MultiLineTrendProps) {
  const c = useChartColors();
  const colorFor = (i: number) => c.palette[i % c.palette.length];
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
              {series.map((s, i) => (
                <Bar key={s.key} dataKey={s.key} name={s.label ?? s.key} fill={colorFor(i)} isAnimationActive={false} />
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
              {series.map((s, i) => (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.label ?? s.key}
                  stroke={colorFor(i)}
                  strokeWidth={1.8}
                  dot={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {series.map((s, i) => (
          <span key={s.key} className="inline-flex items-center gap-1.5 text-[11px] text-ink-500">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: colorFor(i) }} />
            {s.label ?? s.key}
          </span>
        ))}
      </div>
    </Card>
  );
}
