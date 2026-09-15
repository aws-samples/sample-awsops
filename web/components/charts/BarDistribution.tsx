'use client';

import type { ReactNode } from 'react';
import HBarList from './HBarList';

export interface BarDistributionProps {
  /** Keep the caller's row order (histograms) instead of the default count-descending sort. */
  preserveOrder?: boolean;
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  data: Array<Record<string, unknown>>;
  xKey: string;
  yKey: string;
  /** Fraction digits for the value labels (default 0) — passed through to HBarList. */
  decimals?: number;
  /** Prefix the value labels (e.g. "$") — passed through to HBarList. */
  valuePrefix?: string;
  className?: string;
}

/**
 * BarDistribution — horizontal ranking bars (design handoff 개선안 ②-A): a
 * vertical bar chart with rotated labels lost small values and was hard to
 * read at 12+ categories. Delegates to HBarList (label / sunken track /
 * tabular value), sorted descending, with the max row highlighted brand-700.
 */
export default function BarDistribution({ title, subtitle, right, data, xKey, yKey, decimals, valuePrefix, className, preserveOrder = false }: BarDistributionProps) {
  // preserveOrder (gap L135): a value-axis histogram (e.g. memory sizes) must keep the
  // caller's numeric order — the default count-descending re-sort is for rankings.
  const sorted = preserveOrder ? data : [...data].sort((a, b) => (Number(b[yKey]) || 0) - (Number(a[yKey]) || 0));
  return (
    <HBarList
      title={title}
      subtitle={subtitle}
      right={right}
      data={sorted}
      labelKey={xKey}
      valueKey={yKey}
      decimals={decimals}
      valuePrefix={valuePrefix}
      highlightMax
      className={className}
    />
  );
}
