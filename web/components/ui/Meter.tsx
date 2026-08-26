import { cn } from '@/lib/cn';

/**
 * Meter — 56px-wide track (bg-ink-100, radius-full) + threshold-colored fill
 * + a right-aligned % label. Fill color: ≥75 rose, ≥50 brand, else emerald.
 * Value is clamped to 0–100.
 */
function fillColor(v: number): string {
  if (v >= 75) return 'bg-rose-500';
  if (v >= 50) return 'bg-brand-500';
  return 'bg-emerald-500';
}

export default function Meter({ value, className }: { value: number; className?: string }) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  return (
    <div className={cn('inline-flex items-center gap-2', className)}>
      <div className="h-1.5 w-[56px] rounded-full bg-ink-100 overflow-hidden">
        <div
          className={cn('h-full rounded-full', fillColor(clamped))}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span className="tabular text-[11px] text-ink-500 w-9 text-right">{Math.round(clamped)}%</span>
    </div>
  );
}
