'use client';
import { useCallback, useEffect, useState } from 'react';
import DiagSignalChips from './DiagSignalChips';
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
  clickhouse: 'SQL… 예: SELECT count() FROM system.tables',
  jaeger: '트레이스 검색… 예: service=frontend&limit=20 (또는 서비스명만)',
  dynatrace: 'metricSelector… 예: builtin:host.cpu.usage:avg',
  datadog: '메트릭 쿼리… 예: avg:system.cpu.user{*}',
};
const RANGE_KINDS = new Set(['prometheus', 'mimir', 'loki']); // kinds with a *_query_range tool
const selectCls = 'rounded-md border border-ink-200 bg-card px-2.5 py-1.5 text-[13px] text-ink-700';

// Explore range presets: label → window seconds (0 = instant snapshot). Step auto-derived for ~250 points.
const RANGE_PRESETS: ReadonlyArray<readonly [string, number]> = [
  ['즉시', 0], ['5m', 300], ['15m', 900], ['1h', 3600], ['6h', 21600], ['24h', 86400],
];
const autoStep = (w: number) => Math.max(1, Math.round(w / 250));

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

  const ds = list.find((d) => d.id === selId) ?? null;
  const canRange = ds ? RANGE_KINDS.has(ds.kind) : false;
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
    const range = canRange && w > 0 ? { window: w, step: autoStep(w) } : false;
    const queriedKind = list.find((d) => d.id === selId)?.kind; // bind kind to THIS query, not the live selection
    setBusy(true); setErr(''); setResult(null);
    try {
      const r = await fetch('/api/datasources/query', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: selId, query: q, range }),
      });
      const b = await r.json();
      if (!r.ok) throw new Error(b.error || tt(`오류 ${r.status}`));
      setResultKind(queriedKind);
      setResult(b.result as NormalizedResult);
    } catch (e) {
      setErr(e instanceof Error ? e.message : tt('쿼리 실패'));
    } finally { setBusy(false); }
  }, [selId, query, rangeWindow, canRange, list, tt]);

  // NL → query (AI drafts, user reviews, then runs). Never auto-runs.
  const generate = useCallback(async () => {
    if (selId === '' || !nl.trim()) return;
    setGenBusy(true); setErr('');
    try {
      const r = await fetch('/api/datasources/generate', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: selId, nl }),
      });
      const b = await r.json();
      if (!r.ok) throw new Error(b.error || tt(`오류 ${r.status}`));
      if (b.query) setQuery(b.query);
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
            <select aria-label={tt('데이터소스')} className={selectCls} value={selId} disabled={busy} onChange={(e) => { setSelId(e.target.value ? Number(e.target.value) : ''); setResult(null); setErr(''); }}>
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
                {RANGE_PRESETS.map(([label, sec]) => (
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
        <div className="relative w-full">
          <span className="pointer-events-none absolute left-2.5 top-2.5 inline-flex text-ink-400">
            <Search size={14} />
          </span>
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
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
        <DiagSignalChips
          instanceId={selId === '' ? undefined : selId}
          kind={ds?.kind}
          onPick={(expr) => { setQuery(expr); run(undefined, expr); }}
        />
        <div className="flex items-center gap-2">
          <Button onClick={() => run()} disabled={busy || !ds || !query.trim()}>{busy ? tt('실행 중…') : tt('실행')}</Button>
          {list.length === 0 && (
            <span className="text-[12px] text-ink-400">{tt('설정된 데이터소스가 없습니다 — Datasources 탭에서 추가하세요.')}</span>
          )}
        </div>
        {err && <p className="text-[13px] text-rose-600">{err}</p>}
      </Card>
      {result && <ResultView result={result} kind={resultKind} />}
    </div>
  );
}

function ResultView({ result, kind }: { result: NormalizedResult; kind?: string }) {
  const { tt } = useI18n();
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
      {result.truncated && (
        <p className="text-[12px] text-amber-700">{tt('결과가 잘렸습니다(상한 도달) — 쿼리를 좁혀 다시 시도하세요.')}</p>
      )}
      {result.shape === 'empty' && (
        <Card className="p-6 text-center text-[13px] text-ink-400">{result.note || tt('결과 없음')}</Card>
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
        <p className="text-[12px] text-ink-400">{result.note}</p>
      )}
      {result.shape === 'series' && result.rows && result.columns && (
        <DataTable columns={result.columns} rows={result.rows} />
      )}
      {barRows && (
        <HBarList title={tt('상위 결과')} data={barRows} labelKey="metric" valueKey="value" />
      )}
      {(result.shape === 'table' || result.shape === 'logs' || result.shape === 'traces') && result.columns && result.rows && (
        <DataTable columns={result.columns} rows={result.rows} />
      )}
    </div>
  );
}
