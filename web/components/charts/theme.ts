/**
 * Chart theme helpers. recharts renders colors as SVG/DOM-style props, which
 * don't accept CSS var(), so the active theme's colors are resolved at runtime
 * by useChartColors (getComputedStyle on the --chart-* vars) and passed in here.
 * That keeps charts reactive across the Cobalt / Teal / Dark themes.
 */
import type { ChartColors } from '@/lib/use-chart-colors';

/** Axis tick style built from the active theme's resolved chart colors. */
export function axisTick(c: ChartColors) {
  return { fill: c.axis, fontSize: 11 } as const;
}

/**
 * recharts <Tooltip> style props — a dark inverse panel on the light themes,
 * an elevated dark panel on the dark theme. Colors come from the theme.
 */
export function tooltipStyles(c: ChartColors) {
  return {
    contentStyle: {
      background: c.tooltipBg,
      border: 'none',
      borderRadius: 8,
      boxShadow: '0 6px 24px rgba(0,0,0,.25)',
      padding: '8px 10px',
    },
    labelStyle: { color: c.tooltipFg, fontSize: 11, marginBottom: 2 },
    itemStyle: { color: c.tooltipFg, fontSize: 12 },
  } as const;
}
