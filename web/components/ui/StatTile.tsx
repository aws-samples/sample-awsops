import type { ReactNode } from 'react';
import Link from 'next/link';
import AwsopsMark from './AwsopsMark';
import { cn } from '@/lib/cn';
import { useI18n } from '@/components/shell/LanguageProvider';

export type StatTileVariant = 'default' | 'accent' | 'danger' | 'warn';

/** Maps a 0-100 pass rate to a StatTile variant (shared by /compliance and the dashboard tile). */
export function passVariant(rate: number): StatTileVariant {
  if (rate >= 80) return 'accent';
  if (rate >= 50) return 'warn';
  return 'danger';
}

export interface StatTileProps {
  /** Eyebrow label (uppercase/muted). The legacy `label` prop is an alias. */
  label: string;
  value: string | number;
  /**
   * Legacy StatCard accent (a hex color string). Retained for prop
   * compatibility with existing call sites; no longer drives styling —
   * use `variant` instead.
   */
  accent?: string;
  /** Optional override eyebrow (defaults to `label`). */
  eyebrow?: string;
  /** Optional trend pill, e.g. "↑4.2%" or "↓2.3%". */
  trend?: string;
  /** Optional hint line under the value. */
  hint?: ReactNode;
  variant?: StatTileVariant;
  /** 'compact' — smaller value/padding, sunken background, no hint/trend/watermark
   *  (design handoff 개선안 ①: quiet "still healthy" resource tiles). */
  size?: 'default' | 'compact';
  className?: string;
  /** When set, the tile becomes a navigation link (v1-parity: click a KPI → its page). */
  href?: string;
  /** v1-parity accent glyph — a small icon (lucide) shown in a rounded translucent box at the
   *  TOP-RIGHT of the tile (replaces the faint AwsopsMark watermark when provided). */
  icon?: ReactNode;
}

// Variant → translucent top-right icon box (v1 StatsCard style: `bg-accent-*/10` + colored icon —
// the box tint is a 10%-alpha wash of the icon color, so it reads as a transparent icon chip).
const ICON_BOX: Record<StatTileVariant, string> = {
  default: 'bg-ink-500/10 text-ink-500',
  accent: 'bg-brand-500/10 text-brand-600',
  warn: 'bg-brand-500/10 text-brand-700',
  danger: 'bg-rose-500/10 text-rose-600',
};

function trendTone(trend: string): string {
  const t = trend.trim();
  if (t.startsWith('↑') || t.startsWith('+')) return 'bg-emerald-50 text-emerald-700';
  if (t.startsWith('↓') || t.startsWith('-') || t.startsWith('−')) return 'bg-rose-50 text-rose-700';
  return 'bg-ink-100 text-ink-600';
}

/**
 * StatTile (KPI) — white card, radius 12, shadow-card.
 * Eyebrow (xs/uppercase/muted) → value (2xl/600/tabular) → optional trend
 * pill + hint. Variants: accent (brand border + faint AwsopsMark watermark),
 * danger (rose border + rose value), warn (brand-700 value).
 *
 * Prop-compatible with the legacy StatCard: `{ label, value, accent? }`.
 */
export default function StatTile({
  label,
  value,
  eyebrow,
  trend,
  hint,
  variant = 'default',
  size = 'default',
  className,
  href,
  icon,
}: StatTileProps) {
  const { tt } = useI18n();
  const compact = size === 'compact';
  // A full-size tile carrying a glyph chip is a KPI card — informational (default/warn) ones
  // adopt the accent outline + brand chip so the row reads uniformly; only danger stays rose.
  const emphasized = !compact && icon != null;
  const border =
    variant === 'accent' || (emphasized && variant !== 'danger')
      ? 'border-brand-200'
      : variant === 'danger'
        ? 'border-rose-200'
        : 'border-ink-100';
  const chipStyle = emphasized && variant === 'default' ? ICON_BOX.accent : ICON_BOX[variant];

  const valueColor =
    variant === 'danger' ? 'text-rose-700' : variant === 'warn' ? 'text-brand-700' : 'text-ink-800';

  const inner = (
    <div
      className={cn(
        'relative overflow-hidden border rounded-lg',
        compact ? 'bg-paper-muted p-3' : 'bg-card shadow-card p-4',
        border,
        href && 'h-full transition hover:shadow-md hover:border-brand-300',
        className,
      )}
    >
      {/* v1-parity: an emoji/icon in a rounded tinted box, top-right. Falls back to the faint
          AwsopsMark watermark on accent tiles when no icon is supplied. */}
      {icon != null ? (
        <div
          className={cn(
            'absolute flex items-center justify-center leading-none',
            compact ? 'top-2.5 right-2.5 h-6 w-6 rounded-md text-[12px]' : 'top-3 right-3 h-8 w-8 rounded-lg text-[15px]',
            chipStyle,
          )}
        >
          {icon}
        </div>
      ) : variant === 'accent' && !compact ? (
        <div className="pointer-events-none absolute -top-1 -right-1 opacity-[0.07]">
          <AwsopsMark size={56} />
        </div>
      ) : null}
      <div className={cn('text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400', icon != null && (compact ? 'pr-7' : 'pr-10'))}>
        {tt(eyebrow ?? label)}
      </div>
      <div
        className={cn(
          'tabular font-semibold leading-tight mt-1',
          compact ? 'text-[19px]' : 'text-[26px]',
          valueColor,
        )}
      >
        {value}
      </div>
      {!compact && (trend || hint != null) && (
        <div className="flex items-center gap-2 mt-1.5">
          {trend && (
            <span
              className={cn(
                'inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none tabular',
                trendTone(trend),
              )}
            >
              {trend}
            </span>
          )}
          {hint != null && <span className="text-[11px] text-ink-400 truncate">{typeof hint === 'string' ? tt(hint) : hint}</span>}
        </div>
      )}
    </div>
  );

  if (href) {
    return (
      <Link
        href={href}
        aria-label={`${tt(eyebrow ?? label)}`}
        className="block h-full rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
      >
        {inner}
      </Link>
    );
  }
  return inner;
}
