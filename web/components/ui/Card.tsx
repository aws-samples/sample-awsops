'use client';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { useI18n } from '@/components/shell/LanguageProvider';

/**
 * Card — white surface, ink-100 hairline border, radius 12, shadow-card.
 * Optional header (title/subtitle + right slot). Set `padded={false}` for
 * tables and other full-bleed bodies.
 */
export default function Card({
  children,
  title,
  subtitle,
  right,
  padded = true,
  className,
}: {
  children?: ReactNode;
  title?: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  padded?: boolean;
  className?: string;
}) {
  const { tt } = useI18n();
  const tTitle = typeof title === 'string' ? tt(title) : title;
  const tSubtitle = typeof subtitle === 'string' ? tt(subtitle) : subtitle;
  const hasHeader = title != null || subtitle != null || right != null;
  return (
    <div className={cn('bg-card border border-ink-100 rounded-lg shadow-card overflow-hidden', className)}>
      {hasHeader && (
        <div className="flex items-start justify-between gap-4 px-4 pt-4 pb-3 border-b border-ink-100">
          <div className="min-w-0">
            {title != null && <div className="text-[14px] font-semibold text-ink-800 truncate">{tTitle}</div>}
            {subtitle != null && <div className="text-[12px] text-ink-500 mt-0.5">{tSubtitle}</div>}
          </div>
          {right != null && <div className="shrink-0">{right}</div>}
        </div>
      )}
      <div className={cn(padded && 'p-4')}>{children}</div>
    </div>
  );
}
