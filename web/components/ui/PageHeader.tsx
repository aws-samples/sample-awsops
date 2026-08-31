'use client';
import type { ReactNode } from 'react';
import Badge from './Badge';
import { cn } from '@/lib/cn';
import { useI18n } from '@/components/shell/LanguageProvider';

/**
 * PageHeader — shared page header. Title (xl/600) + optional `live` dot Badge
 * ("실시간", positive) + subtitle (base/secondary, max 680px) + right slot.
 * Bottom hairline. Padding 26px 32px 20px (per DESIGN §3).
 */
export default function PageHeader({
  title,
  subtitle,
  live = false,
  right,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /**
   * Decorative "실시간" dot badge. Use only for genuinely streaming/polling
   * surfaces — not for one-shot fetch pages (those should show a RefreshButton
   * staleness stamp in the `right` slot instead).
   */
  live?: boolean;
  right?: ReactNode;
  className?: string;
}) {
  const { tt } = useI18n();
  const tTitle = typeof title === 'string' ? tt(title) : title;
  const tSubtitle = typeof subtitle === 'string' ? tt(subtitle) : subtitle;
  return (
    <header className={cn('flex flex-col gap-3 px-8 pt-[26px] pb-5 bg-chrome border-b border-chrome-border lg:flex-row lg:items-start lg:justify-between lg:gap-4', className)}>
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          <h1 className="text-[24px] font-semibold tracking-[-0.01em] text-chrome-fg leading-tight">{tTitle}</h1>
          {live && (
            <Badge tone="positive" variant="soft" dot>
              {tt('실시간')}
            </Badge>
          )}
        </div>
        {subtitle != null && <p className="text-[14px] text-chrome-fg-muted mt-1.5 max-w-[680px]">{tSubtitle}</p>}
      </div>
      {right != null && <div className="flex items-center gap-3 shrink-0">{right}</div>}
    </header>
  );
}
