'use client';
import { useEffect, useState } from 'react';
import Card from '@/components/ui/Card';
import AreaTrend from '@/components/charts/AreaTrend';
import MultiLineTrend from '@/components/charts/MultiLineTrend';
import type { NormalizedResult } from '@/lib/datasource-render';
import type { ReadyCard, UnavailableCard } from '@/lib/dashboard-cards';
import { useI18n } from '@/components/shell/LanguageProvider';

// Pre-built dashboard cards for one datasource instance: the card set (and each card's query)
// was derived from the cached schema at registration/index time (datasource_dashboard_cards);
// this component executes the STORED queries live at view time through the existing read-only
// POST /api/datasources/query (which normalizes results server-side). Failed cards degrade to an
// inline error — never hidden, never a silent zero. Unavailable cards render dimmed with what's
// missing (same UX as the diag-signal chips).

interface CardState { result?: NormalizedResult; error?: string }

const QUERY_CONCURRENCY = 3; // sequential batches — don't hammer the connector

/** Finite number from a numeric cell — ClickHouse serializes 64-bit ints as JSON STRINGS (the
 * connector deliberately KEEPS default quoting: forcing JSON numbers would silently round UInt64
 * above 2^53 for every consumer), so this string coercion is load-bearing, not legacy tolerance.
 * A numeric string counts; anything else (including '') is null, never NaN. Values above 2^53
 * lose display precision here — acceptable for dashboard counts, do not reuse for identifiers. */
function finiteCell(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** First numeric value in a normalized result — table value column or last point of the first series. */
function statValue(r: NormalizedResult): number | null {
  if (r.shape === 'table') {
    // Prometheus/Loki instant results carry a `value` column, but ClickHouse keeps the original
    // column names (e.g. `count()`), so fall back to the first finite numeric cell of row 0.
    const row = r.rows?.[0];
    if (!row) return null;
    const direct = finiteCell(row.value);
    if (direct !== null) return direct;
    for (const col of r.columns ?? []) {
      const v = finiteCell(row[col.key]);
      if (v !== null) return v;
    }
    return null;
  }
  if (r.shape === 'series' && r.series?.length) {
    const last = r.series[r.series.length - 1];
    const key = r.seriesKeys?.[0] ?? r.seriesYKey ?? 'value';
    return finiteCell(last[key]);
  }
  return null;
}

export default function CardDashboard({ instanceId }: { instanceId: number }) {
  const { tt } = useI18n();
  const [ready, setReady] = useState<ReadyCard[]>([]);
  const [unavailable, setUnavailable] = useState<UnavailableCard[]>([]);
  const [states, setStates] = useState<Record<string, CardState>>({});

  useEffect(() => {
    let live = true;
    setReady([]); setUnavailable([]); setStates({});
    (async () => {
      try {
        const r = await fetch(`/api/datasources/${instanceId}/cards`);
        if (!r.ok) return; // no cards section on read failure — Explore below still works
        const d: { ready?: ReadyCard[]; unavailable?: UnavailableCard[] } = await r.json();
        if (!live) return;
        const rd = d.ready ?? [];
        setReady(rd);
        setUnavailable(d.unavailable ?? []);
        // Execute stored queries in small sequential batches.
        for (let i = 0; i < rd.length; i += QUERY_CONCURRENCY) {
          const batch = rd.slice(i, i + QUERY_CONCURRENCY);
          await Promise.all(batch.map(async (c) => {
            try {
              const q = await fetch('/api/datasources/query', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id: instanceId, query: c.query.expr, ...(c.query.range ? { range: c.query.range } : {}) }),
              });
              const b = await q.json();
              if (!q.ok) throw new Error(String(b?.error ?? q.status));
              if (live) setStates((s) => ({ ...s, [c.cardKey]: { result: b.result as NormalizedResult } }));
            } catch (e) {
              if (live) setStates((s) => ({ ...s, [c.cardKey]: { error: e instanceof Error ? e.message : String(e) } }));
            }
          }));
          if (!live) return;
        }
      } catch { /* cards fetch failed — render nothing */ }
    })();
    return () => { live = false; };
  }, [instanceId]);

  if (ready.length === 0 && unavailable.length === 0) return null;

  return (
    <div className="mb-6">
      <div className="mb-2 text-[13px] font-semibold text-ink-700">{tt('대시보드')}</div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {ready.map((c) => {
          const st = states[c.cardKey];
          const r = st?.result;
          const stat = r ? statValue(r) : null;
          // Chart components render their own Card (title/right slots) — don't double-wrap them.
          if (r && c.viz === 'timeseries' && r.shape === 'series' && r.series) {
            const keys = r.seriesKeys?.length ? r.seriesKeys : [r.seriesYKey || 'value'];
            return keys.length > 1 ? (
              <MultiLineTrend key={c.cardKey} title={tt(c.title)} data={r.series} xKey={r.seriesXKey || 't'} series={keys.map((k) => ({ key: k }))} height={180} />
            ) : (
              <AreaTrend key={c.cardKey} title={tt(c.title)} data={r.series} xKey={r.seriesXKey || 't'} yKey={keys[0]} />
            );
          }
          return (
            <Card key={c.cardKey}>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[12px] font-semibold text-ink-700">{tt(c.title)}</span>
              </div>
              {!st && <div className="h-10 animate-pulse rounded bg-ink-100" />}
              {st?.error && (
                <span className="text-[12px] text-red-600">{tt('카드 쿼리 실패:')} {st.error}</span>
              )}
              {/* A successful-but-empty result must say so — a bare <table> with no rows renders a blank body. */}
              {r && c.viz === 'table' && r.shape !== 'series' && (r.shape === 'empty' || (r.rows ?? []).length === 0) && (
                <span className="text-[12px] text-ink-500">{r.note ? tt(r.note) : tt('결과 없음')}</span>
              )}
              {r && c.viz === 'table' && r.shape !== 'series' && r.shape !== 'empty' && (r.rows ?? []).length > 0 && (
                <div className="max-h-40 overflow-auto text-[11px]">
                  <table className="w-full">
                    <tbody>
                      {(r.rows ?? []).slice(0, 5).map((row, i) => (
                        <tr key={i} className="border-b border-ink-100">
                          {(r.columns ?? []).slice(0, 3).map((col) => (
                            <td key={col.key} className="truncate px-1 py-0.5" title={String(row[col.key] ?? '')}>{String(row[col.key] ?? '')}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {r && c.viz === 'stat' && (
                stat !== null
                  ? <div className="text-2xl font-semibold">{stat.toLocaleString()}{c.unit ? <span className="ml-1 text-[12px] font-normal text-ink-500">{c.unit}</span> : null}</div>
                  : <span className="text-[12px] text-ink-500">{tt('값 없음')}</span>
              )}
              {r && c.viz === 'timeseries' && r.shape !== 'series' && (
                <span className="text-[12px] text-ink-500">{r.note ? tt(r.note) : tt('시계열 데이터 없음')}</span>
              )}
              {r && c.viz === 'table' && r.shape === 'series' && (
                <span className="text-[12px] text-ink-500">{tt('표 형태가 아닌 응답')}</span>
              )}
            </Card>
          );
        })}
        {unavailable.map((c) => (
          <Card key={c.cardKey}>
            <div className="opacity-45" title={`${c.indeterminate ? tt('미확정:') : tt('누락:')} ${c.missing.join(', ')}`}>
              <span className="text-[12px] font-semibold text-ink-700">{tt(c.title)}</span>
              <div className="text-[11px] text-ink-500">{c.indeterminate ? tt('스키마 캐시가 잘려 존재 여부 미확정') : tt('스키마에 필요한 항목이 없어 비활성')}</div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
