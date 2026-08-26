'use client';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { useI18n } from '@/components/shell/LanguageProvider';

/**
 * SectionLabel — uppercase eyebrow heading above a KPI group / section.
 * 11px, tracking 0.04em, ink-400, semibold. Optional leading color dot
 * (design handoff 개선안 ①: "● 요주의 · 즉시 확인") and a trailing slot for a
 * status pill.
 */
export default function SectionLabel({
  children,
  dot,
  right,
  className,
}: {
  children?: ReactNode;
  dot?: string;
  right?: ReactNode;
  className?: string;
}) {
  const { tt } = useI18n();
  return (
    <div
      className={cn(
        'flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400',
        className,
      )}
    >
      {dot && <span className="inline-block h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: dot }} />}
      {typeof children === 'string' ? tt(children) : children}
      {right && <span className="ml-1 normal-case">{right}</span>}
    </div>
  );
}
