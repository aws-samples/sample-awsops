'use client';
import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Search } from 'lucide-react';
import { useI18n } from '@/components/shell/LanguageProvider';
import { TH, TD, MONO, DANGER, dash } from './shared';

// Generic diagnostic metric table (owner 요청: 기간별 조회 + 정렬 + 다양한 필터).
// Declarative column model — every service table describes {value, render?, danger?} per column
// and gets FOR FREE: header-click sort (숫자/문자, asc→desc→none, null은 항상 마지막),
// global text search, string-column facet selects, and a '문제만' (danger-rows-only) toggle.

export interface MetricCol<T> {
  key: string;
  label: string;
  /** hover explanation (진단 의미) — applied to the header and every cell. */
  title?: string;
  /** sort semantics: 'num' compares numbers, 'str' localeCompare (default 'str'). */
  type?: 'num' | 'str';
  /** string columns with few distinct values get a value-select filter. */
  facet?: boolean;
  /** sort/filter/search value. null = missing ('—', sorts last). */
  value: (item: T) => number | string | null;
  /** display override (meters/badges); default renders the value ('—' for null). */
  render?: (item: T) => ReactNode;
  /** cell-level danger — rose text + the row counts for the '문제만' toggle. */
  danger?: (item: T) => boolean;
  /** multi-value facet: 옵션 = 원소들의 합집합, 필터 = 행의 배열이 선택값을 포함 (joined 표시값에 exact-match하면 복합값 행이 누락됨). */
  facetValues?: (item: T) => string[];
  mono?: boolean;
}

type Dir = 'asc' | 'desc' | null;

export default function MetricTable<T>({
  columns, items, rowKey, defaultSortKey, emptyText = '데이터 없음', onRowClick, maxRender, capKeep, rowClass,
}: {
  columns: MetricCol<T>[];
  items: T[];
  rowKey: (item: T, index: number) => string;
  defaultSortKey?: string;
  emptyText?: string;
  /** optional row drilldown — rows get pointer + hover affordance when set. */
  onRowClick?: (item: T) => void;
  /** DOM 안전 상한 — 렌더 단계에서만 컷. 검색·facet·정렬·카운터는 전체 items에서 동작한다 (데이터 단계 컷은 정확 검색을 조용히 0건으로 만듦). */
  maxRender?: number;
  /** maxRender 컷에서도 보존할 행 (예: 매칭 0 설정 룰). */
  capKeep?: (item: T) => boolean;
  /** per-row class hook (예: idle 행 디밍). */
  rowClass?: (item: T) => string;
}) {
  const { tt } = useI18n();
  const [sortKey, setSortKey] = useState<string | null>(defaultSortKey ?? null);
  const [dir, setDir] = useState<Dir>(defaultSortKey ? 'desc' : null);
  const [q, setQ] = useState('');
  const [dangerOnly, setDangerOnly] = useState(false);
  const [facets, setFacets] = useState<Record<string, string>>({});

  const hasDanger = columns.some((c) => c.danger);
  const facetCols = columns.filter((c) => c.facet);

  const facetValues = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const c of facetCols) {
      out[c.key] = [...new Set(items.flatMap((it) => c.facetValues ? c.facetValues(it) : [String(c.value(it) ?? '—')]))].sort();
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, columns]);

  const shown = useMemo(() => {
    let rows = items;
    const needle = q.trim().toLowerCase();
    if (needle) {
      rows = rows.filter((it) =>
        columns.some((c) => String(c.value(it) ?? '').toLowerCase().includes(needle)));
    }
    for (const [k, v] of Object.entries(facets)) {
      if (!v) continue;
      const col = columns.find((c) => c.key === k);
      if (col) rows = rows.filter((it) => col.facetValues ? col.facetValues(it).includes(v) : String(col.value(it) ?? '—') === v);
    }
    if (dangerOnly && hasDanger) {
      rows = rows.filter((it) => columns.some((c) => c.danger?.(it)));
    }
    if (sortKey && dir) {
      const col = columns.find((c) => c.key === sortKey);
      if (col) {
        const mul = dir === 'asc' ? 1 : -1;
        rows = [...rows].sort((a, b) => {
          const va = col.value(a); const vb = col.value(b);
          if (va == null && vb == null) return 0;
          if (va == null) return 1;  // null은 정렬 방향과 무관하게 마지막
          if (vb == null) return -1;
          if (col.type === 'num') return (Number(va) - Number(vb)) * mul;
          return String(va).localeCompare(String(vb), undefined, { numeric: true }) * mul;
        });
      }
    }
    return rows;
  }, [items, columns, q, facets, dangerOnly, hasDanger, sortKey, dir]);

  const rendered = maxRender != null && shown.length > maxRender
    ? shown.filter((it, i) => i < maxRender || (capKeep?.(it) ?? false))
    : shown;

  const cycle = (key: string) => {
    if (sortKey !== key) { setSortKey(key); setDir('asc'); return; }
    if (dir === 'asc') { setDir('desc'); return; }
    setSortKey(null); setDir(null);
  };

  return (
    <div>
      {/* 필터 바: 검색 + facet 선택 + 문제만 토글 + 표시 건수 */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-2">
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-300" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={tt('검색…')}
            className="w-44 rounded-md border border-ink-200 bg-card py-1 pl-6 pr-2 text-[12px]"
          />
        </div>
        {facetCols.map((c) => (
          <select
            key={c.key}
            value={facets[c.key] ?? ''}
            onChange={(e) => setFacets((prev) => ({ ...prev, [c.key]: e.target.value }))}
            className="rounded-md border border-ink-200 bg-card px-2 py-1 text-[12px] text-ink-600"
            aria-label={`${c.label} ${tt('필터')}`}
          >
            <option value="">{c.label}: {tt('전체')}</option>
            {(facetValues[c.key] ?? []).map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        ))}
        {hasDanger && (
          <button
            type="button"
            onClick={() => setDangerOnly((v) => !v)}
            className={`rounded-md border px-2 py-1 text-[12px] ${dangerOnly ? 'border-rose-300 bg-rose-500/10 text-rose-700 font-medium' : 'border-ink-200 text-ink-500 hover:bg-ink-50'}`}
          >
            {tt('문제만')}
          </button>
        )}
        <span className="ml-auto text-[11.5px] text-ink-400">{shown.length} / {items.length}</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead><tr className="border-b border-ink-100">
            {columns.map((c) => (
              <th key={c.key} className={`${TH} cursor-pointer select-none hover:text-ink-600`} title={c.title} onClick={() => cycle(c.key)}>
                <span className="inline-flex items-center gap-1">
                  {c.label}
                  {sortKey === c.key && dir === 'asc' && <ArrowUp size={11} />}
                  {sortKey === c.key && dir === 'desc' && <ArrowDown size={11} />}
                  {sortKey !== c.key && <ArrowUpDown size={11} className="opacity-30" />}
                </span>
              </th>
            ))}
          </tr></thead>
          <tbody>
            {rendered.map((it, i) => (
              <tr
                key={rowKey(it, i)}
                onClick={onRowClick ? () => onRowClick(it) : undefined}
                className={`border-b border-ink-50 last:border-0 ${onRowClick ? 'cursor-pointer hover:bg-ink-50' : ''} ${rowClass?.(it) ?? ''}`}
              >
                {columns.map((c) => {
                  const hot = c.danger?.(it) ?? false;
                  const base = c.mono ? MONO : TD;
                  const v = c.value(it);
                  return (
                    <td key={c.key} className={`${base} ${hot ? DANGER : ''}`} title={c.title}>
                      {c.render ? c.render(it) : v == null ? dash : String(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
            {shown.length === 0 && (
              <tr><td className={TD} colSpan={columns.length}><span className="text-ink-400">{tt(emptyText)}</span></td></tr>
            )}
          </tbody>
        </table>
        {rendered.length < shown.length && (
          <div className="px-4 py-2 text-[12px] text-ink-400">
            {tt('일부 행 생략 — 검색·정렬은 전체 행에서 동작합니다')} ({(shown.length - rendered.length).toLocaleString()})
          </div>
        )}
      </div>
    </div>
  );
}
