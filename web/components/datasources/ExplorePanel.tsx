'use client';
import { useCallback, useEffect, useState } from 'react';
import DiagSignalChips from './DiagSignalChips';
import LogStreamView from './LogStreamView';
import { EXAMPLE_QUERIES, AI_EXAMPLES, QUERY_LANGUAGE } from '@/lib/example-queries';
import { Search } from 'lucide-react';
import Card from '@/components/ui/Card';
import Input from '@/components/ui/Input';
import Button from '@/components/ui/Button';
import DataTable from '@/components/ui/DataTable';
import AreaTrend from '@/components/charts/AreaTrend';
import MultiLineTrend from '@/components/charts/MultiLineTrend';
import SegmentedControl from '@/components/ui/SegmentedControl';
import HBarList from '@/components/charts/HBarList';
import type { NormalizedResult } from '@/lib/datasource-render';
import { cn } from '@/lib/cn';
import { useI18n } from '@/components/shell/LanguageProvider';

// A datasource INSTANCE (the hub model): identified by bigint id, with a user-given name.
export interface DatasourceInstance {
  id: number;
  name: string;
  kind: string;
  authType?: string | null;
  isDefault?: boolean;
  connected?: boolean;
}

const PH: Record<string, string> = {
  prometheus: 'PromQL… 예: rate(node_cpu_seconds_total[5m])',
  mimir: 'PromQL… 예: up',
  loki: 'LogQL… 예: {job="varlogs"} |= "error"',
  tempo: 'TraceQL… 예: { duration > 500ms }',
  clickhouse: 'SQL… 예: SHOW TABLES', // system.*는 커넥터가 사용자 쿼리에서 차단 — 예시로 제안하지 않는다
  jaeger: '트레이스 검색… 예: service=frontend&limit=20 (또는 서비스명만)',
  dynatrace: 'metricSelector… 예: builtin:host.cpu.usage:avg',
  datadog: '메트릭 쿼리… 예: avg:system.cpu.user{*}',
};
const RANGE_KINDS = new Set(['prometheus', 'mimir', 'loki']); // kinds with a *_query_range tool
const selectCls = 'rounded-md border border-ink-200 bg-card px-2.5 py-1.5 text-[13px] text-ink-700';

// Explore range presets: label → window seconds (0 = instant snapshot). Step auto-derived for ~250 points.
const RANGE_PRESETS: ReadonlyArray<readonly [string, number]> = [
  ['즉시', 0], ['5m', 300], ['15m', 900], ['1h', 3600], ['6h', 21600], ['24h', 86400],
  // gap-audit L86 (v1 parity): multi-day trend exploration — autoStep keeps ~250 points for
  // prom/mimir (7d→2419s, 30d→10368s) and ≤180 for loki (its connector keeps only the oldest
  // 200 samples/series), inside the API's 5000-point density cap.
  ['7d', 604800], ['30d', 2592000],
];
// ~250 points for prom/mimir; Loki's connector caps each matrix series at 200 samples and
// keeps the OLDEST ones, so target ≤180 points there — otherwise a 7d metric-LogQL chart
// silently loses its newest ~1.4 days behind a generic truncation banner.
const autoStep = (w: number, kind?: string) =>
  Math.max(1, kind === 'loki' ? Math.ceil(w / 180) : Math.round(w / 250)); // ceil ONLY for loki — round is the long-standing prom/mimir behavior

/** Query console for a datasource instance (PromQL/LogQL/TraceQL/SQL) + an AI NL→query assist.
 *  Read-only. When `instanceId` is given (the per-instance route) the picker is hidden. */
export default function ExplorePanel({ instanceId }: { instanceId?: number }) {
  const { tt } = useI18n();
  const [list, setList] = useState<DatasourceInstance[]>([]);
  const [selId, setSelId] = useState<number | ''>(instanceId ?? '');
  const [query, setQuery] = useState('');
  const [rangeWindow, setRangeWindow] = useState(0); // 0 = instant; else range window in seconds
  const [result, setResult] = useState<NormalizedResult | null>(null);
  const [resultKind, setResultKind] = useState<string | undefined>(undefined); // kind captured AT QUERY TIME (stale-response guard)
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [nl, setNl] = useState('');
  const [genBusy, setGenBusy] = useState(false);
  const [genWarn, setGenWarn] = useState('');
  // gap-audit L88: connector execution time from the query API (additive metadata field).
  const [execMs, setExecMs] = useState<number | null>(null);
  // gap-audit L200: what the last successful AI generation was drafted from (null = no banner).
  const [genFrom, setGenFrom] = useState<string | null>(null);

  const ds = list.find((d) => d.id === selId) ?? null;
  const canRange = ds ? RANGE_KINDS.has(ds.kind) : false;
  // Loki has no per-request upstream timeout — the API caps it at 7d, so don't offer 30d.
  const presets = ds?.kind === 'loki' ? RANGE_PRESETS.filter(([, s]) => s <= 604800) : RANGE_PRESETS;
  const queryIsMultiline = ds?.kind === 'clickhouse';

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/datasources');
        if (r.ok) {
          const items: DatasourceInstance[] = (await r.json()).datasources ?? [];
          setList(items);
          // preselect: the pinned instance, else the only one
          if (instanceId && items.some((d) => d.id === instanceId)) setSelId(instanceId);
          else if (!instanceId && items.length === 1) setSelId(items[0].id);
        }
      } catch { /* leave empty; the panel still renders */ }
    })();
  }, [instanceId]);

  // `windowOverride` lets the range dropdown re-run immediately with its new value (state is async).
  const run = useCallback(async (windowOverride?: number, queryOverride?: string) => {
    const q = queryOverride ?? query;  // a quick-query chip can run its expr without waiting on setQuery
    if (selId === '' || !q.trim()) return;
    const w = windowOverride ?? rangeWindow;
    const kindNow = list.find((d) => d.id === selId)?.kind; // bind kind to THIS query, not the live selection
    const range = canRange && w > 0 ? { window: w, step: autoStep(w, kindNow) } : false;
    const queriedKind = kindNow;
    setBusy(true); setErr(''); setResult(null); setExecMs(null);
    try {
      const r = await fetch('/api/datasources/query', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: selId, query: q, range }),
      });
      const b = await r.json();
      if (!r.ok) throw new Error(b.error || tt(`오류 ${r.status}`));
      setResultKind(queriedKind);
      setResult(b.result as NormalizedResult);
      setExecMs(typeof b.metadata?.executionTimeMs === 'number' ? b.metadata.executionTimeMs : null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : tt('쿼리 실패'));
    } finally { setBusy(false); }
  }, [selId, query, rangeWindow, canRange, list, tt]);

  // NL → query (AI drafts, user reviews, then runs). Never auto-runs.
  const generate = useCallback(async () => {
    if (selId === '' || !nl.trim()) return;
    setGenBusy(true); setErr(''); setGenWarn('');
    try {
      const r = await fetch('/api/datasources/generate', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: selId, nl }),
      });
      const b = await r.json();
      if (!r.ok) throw new Error(b.error || tt(`오류 ${r.status}`));
      if (b.query) {
        setQuery(b.query); setGenFrom(nl);
        // advisory vocabulary warning from the generator — shown, never blocking
        setGenWarn(typeof b.warning === 'string' ? b.warning : '');
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : tt('AI 생성 실패'));
    } finally { setGenBusy(false); }
  }, [selId, nl, tt]);

  return (
    <div className="space-y-4">
      <Card className="p-4 space-y-3">
        {/* Always show the picker (preselected to the scoped instance) — never a dead-end if the
            scoped id isn't in the list yet. */}
        {(
          <div className="flex flex-wrap items-center gap-2">
            {/* switching instances resets the range to 즉시 — a 30d window carried onto Loki would 400 (per-kind 7d cap) */}
            <select aria-label={tt('데이터소스')} className={selectCls} value={selId} disabled={busy || genBusy} onChange={(e) => { setSelId(e.target.value ? Number(e.target.value) : ''); setResult(null); setErr(''); setGenFrom(null); setExecMs(null); setRangeWindow(0); }}>
              <option value="">{tt('데이터소스 선택…')}</option>
              {list.map((d) => (
                <option key={d.id} value={d.id}>{d.name} ({d.kind}){d.isDefault ? ` ${tt('· 기본')}` : ''}</option>
              ))}
            </select>
            {canRange && (
              <select
                aria-label={tt('범위')}
                className={selectCls}
                value={String(rangeWindow)}
                disabled={busy}
                onChange={(e) => { const w = Number(e.target.value); setRangeWindow(w); run(w); }}
              >
                {presets.map(([label, sec]) => (
                  <option key={sec} value={sec}>{tt(label)}</option>
                ))}
              </select>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={nl}
            onChange={(e) => setNl(e.target.value)}
            placeholder={ds ? tt('자연어로 설명… 예: "모든 노드의 CPU 사용률"') : tt('먼저 데이터소스를 선택하세요')}
            onKeyDown={(e) => { if (e.key === 'Enter') generate(); }}
            disabled={!ds}
          />
          <Button variant="secondary" onClick={generate} disabled={genBusy || !ds || !nl.trim()}>
            {genBusy ? tt('생성 중…') : tt('AI로 생성')}
          </Button>
        </div>
        {genWarn && (
          <div className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-1.5 text-[12px] text-amber-800 dark:border-amber-700/50 dark:bg-amber-950/40 dark:text-amber-200">
            {tt('스키마 어휘 경고')}: {genWarn}
          </div>
        )}
        {ds && (AI_EXAMPLES[ds.kind] ?? []).length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {(AI_EXAMPLES[ds.kind] ?? []).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setNl(p)}
                disabled={busy}
                className="rounded-full border border-dashed border-ink-200 px-2.5 py-1 text-[12px] text-ink-500 hover:border-brand-400 hover:text-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {tt(p)}
              </button>
            ))}
          </div>
        )}
        {genFrom && (
          <div className="flex items-center justify-between rounded-md border border-purple-200 bg-purple-50 px-3 py-1.5 text-[12px] text-purple-800">
            <span>{tt(`AI 생성됨 — "${genFrom}"에서 ${QUERY_LANGUAGE[ds?.kind ?? ''] ?? '쿼리'}를 생성했습니다. 실행 전 검토하세요.`)}</span>
            <button type="button" className="ml-2 shrink-0 text-purple-500 hover:text-purple-800" onClick={() => setGenFrom(null)} aria-label={tt('닫기')}>×</button>
          </div>
        )}
        <div className="relative w-full">
          <span className="pointer-events-none absolute left-2.5 top-2.5 inline-flex text-ink-400">
            <Search size={14} />
          </span>
          <textarea
            value={query}
            onChange={(e) => { setQuery(e.target.value); setGenFrom(null); }}
            placeholder={ds ? tt(PH[ds.kind] ?? '쿼리를 입력하세요') : tt('먼저 데이터소스를 선택하세요')}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                run();
                return;
              }
              if (!queryIsMultiline && e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                run();
              }
            }}
            disabled={!ds}
            rows={queryIsMultiline ? 4 : 2}
            className={cn(
              'min-h-[54px] w-full resize-y rounded-md border border-ink-100 bg-card py-2 pl-8 pr-3',
              'font-mono text-[13px] leading-relaxed text-ink-800 placeholder:text-ink-400',
              'outline-none transition-colors duration-[120ms] focus:border-brand-500 focus:shadow-focus',
              'disabled:cursor-not-allowed disabled:opacity-60',
            )}
          />
        </div>
        {ds && (EXAMPLE_QUERIES[ds.kind] ?? []).length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-ink-400">{tt('예제:')}</span>
            {(EXAMPLE_QUERIES[ds.kind] ?? []).map((e) => (
              <button
                key={e.label}
                type="button"
                title={e.expr}
                onClick={() => { setQuery(e.expr); setGenFrom(null); run(undefined, e.expr); }}
                disabled={busy}
                className="rounded-full border border-ink-200 px-2.5 py-1 text-[12px] text-ink-600 hover:border-brand-400 hover:text-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {tt(e.label)}
              </button>
            ))}
          </div>
        )}
        <DiagSignalChips
          instanceId={selId === '' ? undefined : selId}
          kind={ds?.kind}
          onPick={(expr) => { setQuery(expr); setGenFrom(null); run(undefined, expr); }}
        />
        <div className="flex items-center gap-2">
          <Button onClick={() => run()} disabled={busy || !ds || !query.trim()}>{busy ? tt('실행 중…') : tt('실행')}</Button>
          {list.length === 0 && (
            <span className="text-[12px] text-ink-400">{tt('설정된 데이터소스가 없습니다 — Datasources 탭에서 추가하세요.')}</span>
          )}
        </div>
        {err && <p className="text-[13px] text-rose-600">{err}</p>}
      </Card>
      {result && <ResultView result={result} kind={resultKind} execMs={execMs} />}
    </div>
  );
}

function ResultView({ result, kind, execMs }: { result: NormalizedResult; kind?: string; execMs?: number | null }) {
  const { tt } = useI18n();
  // gap-audit L88: result metadata strip — rows/series count · execution time · language · shape.
  // series: `rows` carries one row per series (uncapped) — seriesKeys is capped at 8 for the chart,
  // so counting keys would understate the real series count.
  const rowCount = result.shape === 'series'
    ? (result.rows?.length ?? result.seriesKeys?.length ?? (result.series ? 1 : 0))
    : (result.rows?.length ?? 0);
  const countLabel = result.shape === 'series' ? tt(`${rowCount}개 시리즈`) : tt(`${rowCount}개 행`);
  // Line/Bar toggle for multi-series range results (v1 parity).
  const [chartType, setChartType] = useState<'line' | 'bar'>('line');
  // Instant prom/mimir vector (metric/value rows) → a ranked bar above the table. Gated by kind so
  // an arbitrary ClickHouse table with a `value` column doesn't render a spurious bar (panel finding).
  const barRows =
    result.shape === 'table' &&
    (kind === 'prometheus' || kind === 'mimir') &&
    result.rows && result.rows.length > 0 && result.rows.length <= 30 &&
    // normalizer coerces values to numbers (non-numeric → 0); require finite AND non-negative
    // (HBarList is positive-only — a negative series would render a misleading ~2% bar).
    result.rows.every((r) => { const v = (r as Record<string, unknown>).value; return typeof v === 'number' && Number.isFinite(v) && v >= 0; })
      ? [...result.rows].sort((a, b) => Number((b as Record<string, unknown>).value) - Number((a as Record<string, unknown>).value))
      : null;
  return (
    <div className="space-y-3">
      <p className="text-[12px] text-ink-400">
        {countLabel}
        {/* BFF→connector round trip, not pure engine time. */}
        {typeof execMs === 'number' && <> · {tt('왕복')} {execMs.toLocaleString()}ms</>}
        {kind && QUERY_LANGUAGE[kind] && <> · {QUERY_LANGUAGE[kind]}</>}
        <> · {result.shape}</>
      </p>
      {result.truncated && (
        <p className="text-[12px] text-amber-700">{tt('결과가 잘렸습니다(상한 도달) — 쿼리를 좁혀 다시 시도하세요.')}</p>
      )}
      {result.shape === 'empty' && (
        <Card className="p-6 text-center text-[13px] text-ink-400">{result.note ? tt(result.note) : tt('결과 없음')}</Card>
      )}
      {result.shape === 'series' && result.series && (
        result.seriesKeys && result.seriesKeys.length > 0 ? (
          <MultiLineTrend
            title={tt(`시계열 (${result.seriesKeys.length}개 시리즈)`)}
            right={
              <SegmentedControl
                options={[{ value: 'line', label: 'Line' }, { value: 'bar', label: 'Bar' }]}
                value={chartType}
                onChange={(v) => setChartType(v as 'line' | 'bar')}
              />
            }
            data={result.series}
            xKey={result.seriesXKey || 't'}
            series={result.seriesKeys.map((k) => ({ key: k }))}
            variant={chartType}
          />
        ) : (
          <AreaTrend title={tt('시계열')} data={result.series} xKey={result.seriesXKey || 't'} yKey={result.seriesYKey || 'value'} />
        )
      )}
      {result.shape === 'series' && result.note && (
        <p className="text-[12px] text-ink-400">{tt(result.note)}</p>
      )}
      {result.shape === 'series' && result.rows && result.columns && (
        <DataTable columns={result.columns} rows={result.rows} />
      )}
      {barRows && (
        <HBarList title={tt('상위 결과')} data={barRows} labelKey="metric" valueKey="value" />
      )}
      {result.shape === 'logs' && result.rows && (
        <LogStreamView rows={result.rows} />
      )}
      {result.shape === 'traces' && result.rows && result.columns && (
        <TraceTable rows={result.rows} columns={result.columns} />
      )}
      {result.shape === 'table' && result.columns && result.rows && (
        <DataTable columns={result.columns} rows={result.rows} />
      )}
    </div>
  );
}

/** Tempo/Jaeger trace rows rendered from the normalizer's own columns, with a proportional
 *  duration bar on the durationMs cell (gap-audit L205, v1 parity). An empty/non-numeric raw
 *  duration renders as plain text — the bar requires a NON-EMPTY numeric value (Number('') is 0,
 *  which must not paint a measured-looking bar). */
function TraceTable({ rows, columns }: { rows: Record<string, unknown>[]; columns: { key: string; label: string }[] }) {
  const durs = rows
    .map((r) => r.durationMs)
    .filter((v) => v !== '' && v != null && Number.isFinite(Number(v)))
    .map(Number)
    .filter((n) => n >= 0);
  const max = durs.length ? Math.max(...durs) : 0;
  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-ink-100 text-left text-[11px] uppercase tracking-wide text-ink-400">
              {columns.map((c) => <th key={c.key} className="px-3 py-2">{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-ink-50">
                {columns.map((c) => {
                  const raw = r[c.key];
                  if (c.key === 'durationMs') {
                    const nonEmpty = raw !== '' && raw != null;
                    const d = Number(raw);
                    const ok = nonEmpty && Number.isFinite(d) && d > 0 && max > 0; // d === 0 must not paint a measured-looking 2% bar
                    return (
                      <td key={c.key} className="px-3 py-1.5">
                        <span className="flex items-center gap-2">
                          <span className="w-16 shrink-0 text-right font-mono text-[12px] text-ink-800">{String(raw ?? '')}</span>
                          {ok && (
                            <span className="h-2 w-24 shrink-0 rounded bg-ink-100">
                              <span className="block h-2 rounded bg-brand-400" style={{ width: `${Math.max(2, Math.round((d / max) * 100))}%` }} />
                            </span>
                          )}
                        </span>
                      </td>
                    );
                  }
                  return (
                    <td key={c.key} className={`px-3 py-1.5 ${c.key === 'traceID' ? 'font-mono text-[11px] text-ink-500' : 'text-ink-700'}`}>
                      {String(raw ?? '')}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
