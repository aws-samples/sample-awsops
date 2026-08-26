'use client';
import Card from '@/components/ui/Card';
import { cn } from '@/lib/cn';
import type { HighlightCard } from '@/lib/inventory-types';
import { highlightIcon } from '@/lib/type-icons';
import { useI18n } from '@/components/shell/LanguageProvider';

/**
 * RiskHero — the lead band for security-posture inventory types (IAM users,
 * S3 public access, CloudTrail). A left accent bar + a verdict + the highlight
 * counts as larger cards, danger ones tinted rose. Replaces the generic KPI row
 * for `risk` archetype pages so the security story leads.
 *
 * `capped` = the row fetch hit its limit, so the set may be partial. An all-clear
 * ("정상") is only asserted when the FULL set was seen; a clean *sample* shows the
 * neutral "표본 검사" instead (never a false account-wide safety claim), and issue
 * counts are shown as a lower bound ("주의 N건+").
 */
export default function RiskHero({ label, total, cards, capped = false }: { label: string; total: number; cards: HighlightCard[]; capped?: boolean }) {
  const { tt } = useI18n();
  const issues = cards
    .filter((c) => c.variant === 'danger' && typeof c.value === 'number')
    .reduce((s, c) => s + (c.value as number), 0);
  const hasIssues = issues > 0;
  const verdict = hasIssues ? `주의 ${issues.toLocaleString()}건${capped ? '+' : ''}` : capped ? '표본 검사' : '정상';
  const accentBar = hasIssues ? 'border-l-rose-400' : capped ? 'border-l-amber-400' : 'border-l-emerald-400';
  const verdictColor = hasIssues ? 'text-rose-600' : capped ? 'text-amber-600' : 'text-emerald-600';
  const sub = hasIssues
    ? '아래 위험 항목 확인'
    : capped
      ? `표본 ${total.toLocaleString()}건 기준 · 전체가 아닐 수 있어요`
      : '위험 신호 없음';

  return (
    <Card className={cn('border-l-4', accentBar)}>
      <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="shrink-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400">{tt(label)} · {tt('보안 상태')}</div>
          <div className={cn('mt-1 text-[24px] font-semibold leading-none', verdictColor)}>{tt(verdict)}</div>
          <div className="mt-1.5 text-[12px] text-ink-400">
            {tt('총')} {total.toLocaleString()}{capped ? '+' : ''} · {tt(sub)}
          </div>
        </div>
        <div className="grid min-w-0 flex-1 grid-cols-2 gap-3 sm:grid-cols-3 lg:max-w-2xl lg:grid-cols-4">
          {cards.map((c) => {
            const hot = c.variant === 'danger' && c.value !== 0;
            const Icon = highlightIcon(c.label, c.variant);
            return (
              <div key={c.label} className={cn('relative rounded-lg border px-3 py-2.5', hot ? 'border-rose-200 bg-rose-50' : 'border-brand-200 bg-card')}>
                {/* v1-parity translucent glyph chip, top-right (matches StatTile: brand unless danger) */}
                <span
                  className={cn(
                    'absolute top-2 right-2 flex h-6 w-6 items-center justify-center rounded-md',
                    hot ? 'bg-rose-500/10 text-rose-600' : 'bg-brand-500/10 text-brand-600',
                  )}
                >
                  <Icon size={13} />
                </span>
                <div className="truncate pr-7 text-[11px] text-ink-400">{tt(c.label)}</div>
                <div className={cn('tabular mt-0.5 text-[20px] font-semibold leading-none', hot ? 'text-rose-700' : c.variant === 'accent' ? 'text-brand-700' : 'text-ink-800')}>
                  {c.value}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}
