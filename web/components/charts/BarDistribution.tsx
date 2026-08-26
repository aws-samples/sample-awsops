'use client';

import type { ReactNode } from 'react';
import HBarList from './HBarList';

export interface BarDistributionProps {
  title: ReactNode;
  right?: ReactNode;
  data: Array<Record<string, unknown>>;
  xKey: string;
  yKey: string;
  className?: string;
}

/**
 * BarDistribution — horizontal ranking bars (design handoff 개선안 ②-A): a
 * vertical bar chart with rotated labels lost small values and was hard to
 * read at 12+ categories. Delegates to HBarList (label / sunken track /
 * tabular value), sorted descending, with the max row highlighted brand-700.
 */
export default function BarDistribution({ title, right, data, xKey, yKey, className }: BarDistributionProps) {
  const sorted = [...data].sort((a, b) => (Number(b[yKey]) || 0) - (Number(a[yKey]) || 0));
  return (
    <HBarList
      title={title}
      right={right}
      data={sorted}
      labelKey={xKey}
      valueKey={yKey}
      highlightMax
      className={className}
    />
  );
}
