'use client';
import { useEffect, useState } from 'react';

// Explore "자주 쓰는 쿼리" — pre-built diagnostic signals (datasource_index) surfaced as clickable
// chips. Ready signals fill+run their query via onPick; unavailable signals render disabled with a
// "metric X 없음 — Refresh schema" tooltip. Prom/Mimir only (others have no pre-built signals).
interface ReadySignal { signalKey: string; title: string; query: { tool: string; queries: { label: string; expr: string }[] } }
interface UnavailableSignal { signalKey: string; title: string; missingMetrics: string[] }
interface Props {
  instanceId?: number;
  kind?: string;
  onPick: (expr: string) => void;
}

const chip = 'rounded-full border px-2.5 py-1 text-[12px] transition-colors';

export default function DiagSignalChips({ instanceId, kind, onPick }: Props) {
  const [ready, setReady] = useState<ReadySignal[]>([]);
  const [unavailable, setUnavailable] = useState<UnavailableSignal[]>([]);
  const enabled = !!instanceId && (kind === 'prometheus' || kind === 'mimir');

  useEffect(() => {
    if (!enabled) { setReady([]); setUnavailable([]); return; }
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
      <span className="text-[12px] text-ink-500">자주 쓰는 쿼리:</span>
      {ready.map((s) => (
        <button
          key={s.signalKey}
          type="button"
          className={`${chip} border-brand-200 bg-brand-50 text-brand-700 hover:bg-brand-100`}
          title={s.query.queries.map((q) => q.expr).join('\n')}
          onClick={() => { const q = s.query.queries[0]?.expr; if (q) onPick(q); }}
        >
          {s.title}
        </button>
      ))}
      {unavailable.map((s) => (
        <span
          key={s.signalKey}
          className={`${chip} cursor-not-allowed border-ink-200 bg-ink-50 text-ink-400`}
          title={`metric ${s.missingMetrics.join(', ')} 없음 — Refresh schema`}
          data-testid="diag-chip-unavailable"
        >
          {s.title}
        </span>
      ))}
    </div>
  );
}
