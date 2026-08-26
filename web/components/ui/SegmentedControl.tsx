'use client';
import { cn } from '@/lib/cn';
import { useI18n } from '@/components/shell/LanguageProvider';

export type SegOption = string | { value: string; label: string };

function normalize(o: SegOption): { value: string; label: string } {
  return typeof o === 'string' ? { value: o, label: o } : o;
}

/**
 * SegmentedControl — pill group on a white track + ink-100 hairline,
 * radius-md, 2px padding. Active segment = solid brand + white + shadow-sm.
 * Options can be plain strings or { value, label }.
 */
export default function SegmentedControl({
  options,
  value,
  onChange,
  className,
}: {
  options: SegOption[];
  value: string;
  onChange?: (value: string) => void;
  className?: string;
}) {
  const { tt } = useI18n();
  return (
    <div
      role="tablist"
      className={cn('inline-flex items-center gap-0.5 bg-card border border-ink-100 rounded-md p-0.5', className)}
    >
      {options.map((o) => {
        const { value: v, label } = normalize(o);
        const active = v === value;
        return (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange?.(v)}
            className={cn(
              'h-[26px] px-3 rounded-[6px] text-[12px] font-medium whitespace-nowrap',
              'transition-colors duration-[120ms] cursor-pointer',
              active ? 'bg-brand-500 text-white shadow-sm' : 'text-ink-500 hover:text-ink-800',
            )}
          >
            {tt(label)}
          </button>
        );
      })}
    </div>
  );
}
