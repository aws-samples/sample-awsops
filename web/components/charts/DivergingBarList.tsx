'use client';

import type { ReactNode } from 'react';
import Card from '@/components/ui/Card';

export interface DivergingRow {
  label: string;
  /** Signed value — the bar grows right of the shared zero axis when positive, left when
   *  negative. 0 renders NO bar (a zero has no direction to fabricate). */
  value: number;
  /** Optional secondary figure rendered muted beside the value (e.g. the count delta). */
  sub?: string;
}

export interface DivergingBarListProps {
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  rows: DivergingRow[];
  /** Prefix on the |value| (e.g. "$"); the sign renders outside the prefix: +$12 / -$3. */
  valuePrefix?: string;
  /** Suffix after the value (e.g. "/mo est."). */
  valueSuffix?: string;
  className?: string;
}

/**
 * DivergingBarList — the POLARITY form (dataviz: above/below a baseline → diverging bar).
 * Signed horizontal bars share one zero axis: positive grows right in the WARM pole
 * (`negative` status token — increase/adverse semantics; NOT brand, which equals the
 * positive teal in the default theme and would collapse the two poles into one hue),
 * negative grows left in the cool `positive` pole, and a neutral hairline marks zero.
 * Pair validated (dataviz validate_palette): light #D13212↔#01A88D CVD ΔE 13.9, dark
 * #F26B4D↔#2CC9AE ΔE 12.2 — both ≥ the 8 target; every row carries a visible signed label. Pure HTML/flex like HBarList — no
 * recharts, one axis by construction (never dual-scale). Scaling is symmetric on max|value|
 * so equal magnitudes read as equal lengths regardless of sign.
 */
export default function DivergingBarList({
  title,
  subtitle,
  right,
  rows,
  valuePrefix = '',
  valueSuffix = '',
  className,
}: DivergingBarListProps) {
  const maxAbs = rows.reduce((m, r) => {
    const a = Math.abs(Number(r.value));
    return Number.isFinite(a) && a > m ? a : m;
  }, 0);
  // one finite-guard for BOTH the scale and the row (maxAbs filters Infinity). A non-finite
  // row renders '—' with NO bar — never a confident $0 (the repo's no-fabricated-zero posture).
  const num = (v: number): number | null => (Number.isFinite(Number(v)) ? Number(v) : null);
  const fmt = (v: number) =>
    `${v > 0 ? '+' : v < 0 ? '-' : ''}${valuePrefix}${Math.abs(v).toLocaleString()}${valueSuffix}`;
  return (
    <Card title={title} subtitle={subtitle} right={right} className={className}>
      <ul className="flex flex-col gap-2">
        {rows.map((r) => {
          const v = num(r.value);
          if (v == null) {
            return (
              <li key={r.label} className="flex items-center gap-2 sm:gap-3 text-[12.5px]">
                <span className="w-24 sm:w-36 shrink-0 truncate text-ink-600" title={r.label}>{r.label}</span>
                <span className="h-2.5 flex-1 rounded-full bg-paper-muted" aria-hidden />
                <span className="tabular w-28 sm:w-40 shrink-0 text-right text-ink-400">—</span>
              </li>
            );
          }
          // 2% visibility floor for NONZERO values only — zero stays an empty track
          const pct = maxAbs > 0 && v !== 0 ? Math.max(2, (Math.abs(v) / maxAbs) * 100) : 0;
          return (
            // stable identity key (rows re-sort upstream); responsive fixed columns — at
            // mobile widths (~310px content box under Card's overflow-hidden) the previous
            // w-36 + w-40 columns left the flex-1 track ~0px and clipped the signed label
            <li key={r.label} className="flex items-center gap-2 sm:gap-3 text-[12.5px]">
              <span className="w-24 sm:w-36 shrink-0 truncate text-ink-600" title={r.label}>{r.label}</span>
              {/* two half-tracks around a shared hairline zero axis — one scale, two poles */}
              <span className="relative flex h-2.5 flex-1 items-center" aria-hidden>
                <span className="flex h-full w-1/2 justify-end overflow-hidden rounded-l-full bg-paper-muted">
                  {v < 0 && (
                    <span className="block h-full rounded-l-full bg-positive" style={{ width: `${pct}%` }} />
                  )}
                </span>
                <span className="absolute left-1/2 top-[-2px] h-[calc(100%+4px)] w-px -translate-x-1/2 bg-ink-200" />
                <span className="flex h-full w-1/2 overflow-hidden rounded-r-full bg-paper-muted">
                  {v > 0 && (
                    <span className="block h-full rounded-r-full bg-negative" style={{ width: `${pct}%` }} />
                  )}
                </span>
              </span>
              {/* below sm the sub figure moves to a VISIBLE second line — a title attribute
                  never surfaces on touch devices, so it is not a mobile fallback */}
              <span className="flex w-28 sm:w-40 shrink-0 flex-col items-end sm:flex-row sm:items-center sm:justify-end gap-0 sm:gap-2">
                {r.sub != null && <span className="tabular hidden sm:inline text-[11px] text-ink-400">{r.sub}</span>}
                <span className={`tabular font-semibold ${v > 0 ? 'text-negative-text' : v < 0 ? 'text-positive-text' : 'text-ink-400'}`}>
                  {fmt(v)}
                </span>
                {r.sub != null && <span className="tabular sm:hidden text-[10px] leading-tight text-ink-400">{r.sub}</span>}
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
