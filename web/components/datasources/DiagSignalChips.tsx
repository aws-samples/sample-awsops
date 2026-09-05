'use client';
import { useEffect, useState } from 'react';
import { useI18n } from '@/components/shell/LanguageProvider';

// Explore "자주 쓰는 쿼리" — pre-built diagnostic signals (datasource_index) surfaced as clickable
// chips. Ready signals fill+run their query via onPick; unavailable signals render disabled with a
// "metric X 없음 — Refresh schema" tooltip. Kind-scoped catalog entries exist for
// prometheus/mimir/loki/tempo; clickhouse has none deterministically and depends on the flag-gated LLM
// fallback, and jaeger/dynatrace/datadog are not wired into the index pipeline yet (DIAG_SIGNAL_KINDS,
// the daily dispatcher's _LIST_SQL and the worker's ds_connector_arns are all 5-kind) — the fetch is
// harmless for those, it just returns nothing. Review MAJOR: the comment used to claim all kinds
// entries (see signal_catalog.py).
interface ReadySignal { signalKey: string; title: string; query: { tool: string; queries: { label: string; expr: string }[] } }
interface UnavailableSignal { signalKey: string; title: string; missingMetrics: string[] }
interface Props {
  instanceId?: number;
  kind?: string;
  onPick: (expr: string) => void;
}

const chip = 'rounded-full border px-2.5 py-1 text-[12px] transition-colors';

export default function DiagSignalChips({ instanceId, kind, onPick }: Props) {
  const { tt } = useI18n();
  const [ready, setReady] = useState<ReadySignal[]>([]);
  const [unavailable, setUnavailable] = useState<UnavailableSignal[]>([]);
  const enabled = !!instanceId;

  useEffect(() => {
    // Clear FIRST, on every instance change. Before the kind gate was removed, switching to a
    // non-prom kind hit the `!enabled` branch and cleared; now `enabled = !!instanceId`, so a switch
    // whose fetch fails (`!r.ok` returns early) left the PREVIOUS instance's chips on screen — and
    // clicking a loki chip while a clickhouse instance is selected sends LogQL to the clickhouse
    // connector (the connector guard rejects it, so this is UX, not a mutation risk). Review MAJOR.
    setReady([]); setUnavailable([]);
    if (!enabled) return;
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`/api/datasources/${instanceId}/diag-signals`);
        if (!r.ok) return;
        const d = await r.json();
        if (!alive) return;
        setReady(Array.isArray(d.ready) ? d.ready : []);
        setUnavailable(Array.isArray(d.unavailable) ? d.unavailable : []);
      } catch { /* best-effort — chips are an enhancement */ }
    })();
    return () => { alive = false; };
  }, [instanceId, kind, enabled]);

  if (!enabled || (ready.length === 0 && unavailable.length === 0)) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="diag-signal-chips">
      <span className="text-[12px] text-ink-500">{tt('자주 쓰는 쿼리:')}</span>
      {ready.map((s) => (
        <button
          key={s.signalKey}
          type="button"
          className={`${chip} border-brand-200 bg-brand-50 text-brand-700 hover:bg-brand-100`}
          title={s.query.queries.map((q) => q.expr).join('\n')}
          onClick={() => { const q = s.query.queries[0]?.expr; if (q) onPick(q); }}
        >
          {tt(s.title)}
        </button>
      ))}
      {unavailable.map((s) => (
        <span
          key={s.signalKey}
          className={`${chip} cursor-not-allowed border-ink-200 bg-ink-50 text-ink-400`}
          title={tt(`metric ${s.missingMetrics.join(', ')} 없음 — Refresh schema`)}
          data-testid="diag-chip-unavailable"
        >
          {tt(s.title)}
        </span>
      ))}
    </div>
  );
}
