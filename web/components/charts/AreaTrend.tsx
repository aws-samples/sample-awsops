'use client';

import type { ReactNode } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import Card from '@/components/ui/Card';
import { useChartColors } from '@/lib/use-chart-colors';
import { axisTick, tooltipStyles } from './theme';

export interface AreaTrendProps {
  title: ReactNode;
  /** Right slot in the Card header (e.g. a SegmentedControl). */
  right?: ReactNode;
  data: Array<Record<string, unknown>>;
  xKey: string;
  yKey: string;
  /** Prefix the y values/tooltip with this (e.g. "$"). */
  valuePrefix?: string;
  /** Optional secondary series — a plain ink stroke line (no fill), e.g. an EC2 count
   *  overlaid on a total-resources area (DESIGN.md §3 "리소스 추세": lead area + ink line).
   *  Rendering a 2-series legend (areaLabel/lineLabel) requires both to be set. */
  lineKey?: string;
  areaLabel?: string;
  lineLabel?: string;
  className?: string;
}

/**
 * AreaTrend — gradient area over a dotted grid, lead series = theme
 * --chart-1 (teal by default, cobalt/dark re-tune it — see use-chart-colors),
 * fill = vertical gradient 0.30 → 0.02, axes/labels ink-400, dark inverse tooltip.
 */
export default function AreaTrend({
  title,
  right,
  data,
  xKey,
  yKey,
  valuePrefix = '',
  lineKey,
  areaLabel,
  lineLabel,
  className,
}: AreaTrendProps) {
  const c = useChartColors();
  const fmt = (v: number | string) => {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return String(v);
    const rounded = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100;
    return `${valuePrefix}${rounded.toLocaleString()}`;
  };
  const gid = `area-${yKey}`;

  return (
    <Card title={title} right={right} className={className}>
      <ResponsiveContainer width="100%" height={240}>
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={c.lead} stopOpacity={0.3} />
              <stop offset="100%" stopColor={c.lead} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="2 4" stroke={c.grid} vertical={false} />
          <XAxis
            dataKey={xKey}
            tick={axisTick(c)}
            tickLine={false}
            axisLine={{ stroke: c.grid }}
            minTickGap={24}
          />
          <YAxis
            tick={axisTick(c)}
            tickLine={false}
            axisLine={false}
            width={56}
            tickFormatter={(v) => fmt(v as number)}
          />
          <Tooltip
            {...tooltipStyles(c)}
            formatter={(v, name) => [fmt(v as number), name === lineKey ? lineLabel ?? String(name) : ''] as [string, string]}
          />
          <Area
            type="monotone"
            dataKey={yKey}
            stroke={c.lead}
            strokeWidth={2}
            fill={`url(#${gid})`}
            dot={false}
            activeDot={{ r: 4, fill: c.lead, strokeWidth: 0 }}
          />
          {lineKey && (
            <Line
              type="monotone"
              dataKey={lineKey}
              stroke={c.axis}
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 3, fill: c.axis, strokeWidth: 0 }}
            />
          )}
        </AreaChart>
      </ResponsiveContainer>
      {lineKey && areaLabel && lineLabel && (
        <div className="mt-2 flex items-center gap-4 text-[11px] text-ink-500">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: c.lead }} />
            {areaLabel}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: c.axis }} />
            {lineLabel}
          </span>
        </div>
      )}
    </Card>
  );
}
