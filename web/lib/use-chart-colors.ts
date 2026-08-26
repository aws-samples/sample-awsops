'use client';
import { useEffect, useState } from 'react';
import { THEME_EVENT } from './theme';

export interface ChartColors {
  lead: string;
  leadStrong: string;
  /** 8 unique hues (design handoff 개선안 ②-B) — DonutBreakdown cycles this for its top slices. */
  palette: string[];
  /** "기타" (Top-N rollup) slice color — deliberately muted/neutral, outside the palette cycle. */
  etc: string;
  grid: string;
  axis: string;
  tooltipBg: string;
  tooltipFg: string;
}

// First-paint / SSR fallback = the default (cobalt) theme values.
const FALLBACK: ChartColors = {
  lead: '#528DF8',
  leadStrong: '#1F54C2',
  palette: ['#528DF8', '#01A88D', '#7B26FF', '#F59E0B', '#D13212', '#C925D1', '#39C2B0', '#5A6873'],
  etc: '#AFBAC3',
  grid: '#E7ECEF',
  axis: '#7D8A96',
  tooltipBg: '#16202A',
  tooltipFg: '#F4F6F8',
};

function read(): ChartColors {
  if (typeof window === 'undefined') return FALLBACK;
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fb: string) => s.getPropertyValue(name).trim() || fb;
  return {
    lead: v('--chart-1', FALLBACK.lead),
    leadStrong: v('--brand-700', FALLBACK.leadStrong),
    palette: [
      v('--chart-1', FALLBACK.palette[0]),
      v('--chart-2', FALLBACK.palette[1]),
      v('--chart-3', FALLBACK.palette[2]),
      v('--chart-4', FALLBACK.palette[3]),
      v('--chart-5', FALLBACK.palette[4]),
      v('--chart-6', FALLBACK.palette[5]),
      v('--chart-7', FALLBACK.palette[6]),
      v('--chart-8', FALLBACK.palette[7]),
    ],
    etc: v('--chart-etc', FALLBACK.etc),
    grid: v('--chart-grid', FALLBACK.grid),
    axis: v('--chart-axis', FALLBACK.axis),
    tooltipBg: v('--chart-tooltip-bg', FALLBACK.tooltipBg),
    tooltipFg: v('--chart-tooltip-fg', FALLBACK.tooltipFg),
  };
}

/** Resolved chart series colors that react to runtime theme changes. */
export function useChartColors(): ChartColors {
  const [colors, setColors] = useState<ChartColors>(FALLBACK);
  useEffect(() => {
    setColors(read());
    const handler = () => setColors(read());
    window.addEventListener(THEME_EVENT, handler);
    return () => window.removeEventListener(THEME_EVENT, handler);
  }, []);
  return colors;
}
