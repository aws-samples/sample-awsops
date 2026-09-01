'use client';
import Card from '@/components/ui/Card';
import { useI18n } from '@/components/shell/LanguageProvider';

// Purpose-built Loki log-stream pane (gap-audit L85, v1 parity): per-line mono timestamp,
// up to 3 colored label badges parsed from the normalized labels string, alternating row
// shading, 500px scrollable container, line-count header. Metric-LogQL results never reach
// this component (the normalizer routes them through the prom renderer as series/table).

export interface LabelPair { key: string; value: string }
// `_labelPairs` carries the normalizer's structured stream labels ({ key, value }[]). Declared
// `unknown` (narrowed at use) so a NormalizedResult.rows list (Record<string, unknown>[]) stays
// assignable to LogRow[] — a concrete optional type would fail that index-signature check.
export interface LogRow { timestamp?: unknown; line?: unknown; labels?: unknown; _labelPairs?: unknown }

/** Parse the normalizer's labelStr output (`{k="v", k2="v2"}`) into pairs. Malformed → []. */
export function parseLokiLabels(labels: string): { key: string; value: string }[] {
  if (!labels || !labels.includes('{')) return [];
  const out: { key: string; value: string }[] = [];
  // key="value" pairs — value is anything up to the closing unescaped quote (commas allowed inside).
  const re = /([A-Za-z_][A-Za-z0-9_]*)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(labels)) !== null) out.push({ key: m[1], value: m[2] });
  return out;
}

const BADGE_COLORS = [
  'bg-brand-50 text-brand-700 border-brand-200',
  'bg-emerald-50 text-emerald-700 border-emerald-200',
  'bg-amber-50 text-amber-700 border-amber-200',
];

const MAX_BADGES = 3;

export default function LogStreamView({ rows }: { rows: LogRow[] }) {
  const { tt } = useI18n();
  if (!rows.length) return null;
  // The normalizer flattens Loki streams block-by-block (no cross-stream order) — sort here so
  // the "최신순" header is actually true. ISO timestamps compare lexically; blanks sort last.
  const sorted = [...rows].sort((a, b) => String(b.timestamp ?? '').localeCompare(String(a.timestamp ?? '')));
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-ink-100 px-3 py-2 text-[12px] text-ink-500">
        {/* the connector/normalizer may truncate upstream — the count is what is DISPLAYED */}
        {tt(`로그 ${rows.length.toLocaleString()}줄 — 최신순, 표시 상한 적용 가능`)}
      </div>
      <div className="max-h-[500px] overflow-auto">
        {sorted.map((r, i) => {
          // Structured pairs when the normalizer supplied them; the string parse is the fallback
          // for callers without them (quote-containing values only survive the structured path).
          const pairs = r._labelPairs;
          const labels = Array.isArray(pairs) && pairs.length ? (pairs as LabelPair[]) : parseLokiLabels(String(r.labels ?? ''));
          const shown = labels.slice(0, MAX_BADGES);
          const overflow = labels.length - shown.length;
          return (
            <div key={i} className={`flex items-start gap-2 px-3 py-1 ${i % 2 === 1 ? 'bg-ink-50/50' : ''}`}>
              <span className="shrink-0 font-mono text-[11px] text-ink-400">{String(r.timestamp ?? '')}</span>
              <span className="flex shrink-0 flex-wrap gap-1">
                {shown.map((l, j) => (
                  <span key={l.key} className={`rounded border px-1 text-[10px] ${BADGE_COLORS[j % BADGE_COLORS.length]}`}>
                    {l.key}={l.value}
                  </span>
                ))}
                {overflow > 0 && (
                  <span className="rounded border border-ink-200 px-1 text-[10px] text-ink-500" title={labels.slice(MAX_BADGES).map((l) => `${l.key}=${l.value}`).join(', ')}>
                    +{overflow}
                  </span>
                )}
              </span>
              <span className="min-w-0 break-all font-mono text-[12px] text-ink-800">{String(r.line ?? '')}</span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
