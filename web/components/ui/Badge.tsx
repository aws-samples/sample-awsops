import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type BadgeTone = 'neutral' | 'brand' | 'positive' | 'negative' | 'inverse';
export type BadgeVariant = 'soft' | 'solid' | 'outline';

/**
 * Badge — pill, 10px/600, radius-full. Tone × variant matrix, optional
 * leading status dot, optional mono (for event-type chips).
 */
const SOFT: Record<BadgeTone, string> = {
  neutral: 'bg-ink-100 text-ink-600',
  brand: 'bg-brand-50 text-brand-700',
  positive: 'bg-emerald-50 text-emerald-700',
  negative: 'bg-rose-50 text-rose-700',
  inverse: 'bg-ink-800 text-paper',
};

const SOLID: Record<BadgeTone, string> = {
  neutral: 'bg-ink-200 text-ink-800',
  brand: 'bg-brand-500 text-white',
  positive: 'bg-emerald-500 text-white',
  negative: 'bg-rose-500 text-white',
  inverse: 'bg-ink-800 text-paper',
};

const OUTLINE: Record<BadgeTone, string> = {
  neutral: 'border border-ink-200 text-ink-600',
  brand: 'border border-brand-200 text-brand-700',
  positive: 'border border-emerald-200 text-emerald-700',
  negative: 'border border-rose-200 text-rose-700',
  inverse: 'border border-ink-600 text-ink-800',
};

const DOT: Record<BadgeTone, string> = {
  neutral: 'bg-ink-400',
  brand: 'bg-brand-500',
  positive: 'bg-emerald-500',
  negative: 'bg-rose-500',
  inverse: 'bg-paper',
};

export default function Badge({
  children,
  tone = 'neutral',
  variant = 'soft',
  dot = false,
  mono = false,
  className,
}: {
  children?: ReactNode;
  tone?: BadgeTone;
  variant?: BadgeVariant;
  dot?: boolean;
  mono?: boolean;
  className?: string;
}) {
  const variantMap = variant === 'solid' ? SOLID : variant === 'outline' ? OUTLINE : SOFT;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none whitespace-nowrap',
        mono && 'font-mono',
        variantMap[tone],
        className,
      )}
    >
      {dot && <span className={cn('h-1.5 w-1.5 rounded-full', DOT[tone])} />}
      {children}
    </span>
  );
}
