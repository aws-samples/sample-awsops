'use client';
import { isValidElement, useMemo, useState } from 'react';
import Card from './Card';
import Badge from './Badge';
import StatePill from './StatePill';
import { isDeprecatedRuntime } from '@/lib/inventory-types';
import { useI18n } from '@/components/shell/LanguageProvider';

export interface Column {
  key: string;
  label: string;
}

// Keys whose cells render as a StatePill (resource state/status).
const STATE_KEYS = new Set(['state', 'status', 'instance_state', 'cache_cluster_status', 'state_value', 'table_status', 'last_status', 'state_code']);

function renderCell(key: string, value: unknown) {
  // Pre-rendered cell (e.g. a drill-in <Link>) — render as-is, don't stringify.
  if (isValidElement(value)) return value;
  if (typeof value === 'boolean') {
    return (
      <Badge tone={value ? 'positive' : 'neutral'} variant="soft">
        {value ? 'true' : 'false'}
      </Badge>
    );
  }
  const s = value == null ? '' : String(value);
  if (STATE_KEYS.has(key) && s !== '') {
    return <StatePill value={s} />;
  }
  // Lambda runtime cell: flag end-of-support runtimes with an EOL badge.
  if (key === 'runtime' && isDeprecatedRuntime(value)) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="max-w-[200px] truncate" title={s}>{s}</span>
        <Badge tone="negative" variant="soft">EOL</Badge>
      </span>
    );
  }
  return (
    <span className="block max-w-[280px] truncate" title={s}>
      {s}
    </span>
  );
}

type Dir = 'asc' | 'desc';

// Natural/numeric-aware compare: "123" > "23" (numeric:true), and plain strings
// still sort sensibly. Booleans/null coerce to string. Empty values sort last.
export function compareValues(a: unknown, b: unknown, dir: Dir): number {
  const ea = a == null || a === '';
  const eb = b == null || b === '';
  if (ea && eb) return 0;
  if (ea) return 1; // empties always last, regardless of dir
  if (eb) return -1;
  const cmp = String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  return dir === 'asc' ? cmp : -cmp;
}

// Mobile card: same column defs / render fns as the table (no forked logic).
// Layout per card: first column = title (link preserved), the state/status
// column shown prominently, then the next few columns as label:value rows.
function MobileCards({
  columns,
  rows,
  onRowClick,
  titleKey,
  fieldColumns,
  statusColumn,
}: {
  columns: Column[];
  rows: Record<string, unknown>[];
  onRowClick?: (row: Record<string, unknown>) => void;
  titleKey: string;
  fieldColumns: Column[];
  statusColumn?: Column;
}) {
  const { tt } = useI18n();
  const titleCol = columns.find((c) => c.key === titleKey) ?? columns[0];
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 lg:hidden">
      {rows.map((row, i) => (
        <div
          key={i}
          onClick={onRowClick ? () => onRowClick(row) : undefined}
          className={`rounded-lg border border-ink-100 bg-card p-3 shadow-card${onRowClick ? ' cursor-pointer hover:bg-ink-50' : ''}`}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 text-[14px] font-semibold text-ink-800">
              {renderCell(titleCol.key, row[titleCol.key])}
            </div>
            {statusColumn && (
              <div className="shrink-0">{renderCell(statusColumn.key, row[statusColumn.key])}</div>
            )}
          </div>
          {fieldColumns.length > 0 && (
            <dl className="mt-2 space-y-1">
              {fieldColumns.map((c) => (
                <div key={c.key} className="flex items-baseline justify-between gap-3 text-[13px]">
                  <dt className="shrink-0 text-[11px] uppercase tracking-[0.04em] text-ink-400">{tt(c.label)}</dt>
                  <dd className="min-w-0 text-ink-800 text-right">{renderCell(c.key, row[c.key])}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      ))}
    </div>
  );
}

export default function DataTable({
  columns,
  rows,
  onRowClick,
  mobileColumns,
  cardTitleKey,
}: {
  columns: Column[];
  rows: Record<string, unknown>[];
  onRowClick?: (row: Record<string, unknown>) => void;
  /** Keys to surface as label:value rows in the mobile card. Default: first ~4 columns. */
  mobileColumns?: string[];
  /** Column key used as the card title/heading. Default: first column. */
  cardTitleKey?: string;
}) {
  const { tt } = useI18n();
  const [sort, setSort] = useState<{ key: string; dir: Dir } | null>(null);

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    return [...rows].sort((ra, rb) => compareValues(ra[sort.key], rb[sort.key], sort.dir));
  }, [rows, sort]);

  const toggleSort = (key: string) =>
    setSort((prev) => (prev?.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  // Mobile card column selection (computed once per column set).
  const { titleKey, statusColumn, fieldColumns } = useMemo(() => {
    const titleKey = cardTitleKey && columns.some((c) => c.key === cardTitleKey) ? cardTitleKey : columns[0]?.key;
    const statusColumn = columns.find((c) => c.key !== titleKey && STATE_KEYS.has(c.key));
    // Candidate label:value fields: explicit mobileColumns, else first ~4 columns.
    const pool = mobileColumns
      ? (mobileColumns.map((k) => columns.find((c) => c.key === k)).filter(Boolean) as Column[])
      : columns.slice(0, 4);
    const fieldColumns = pool.filter((c) => c.key !== titleKey && c.key !== statusColumn?.key);
    return { titleKey, statusColumn, fieldColumns };
  }, [columns, mobileColumns, cardTitleKey]);

  if (rows.length === 0) {
    return (
      <Card padded={false}>
        <div className="py-6 px-3 text-center text-[14px] text-ink-400">데이터 없음</div>
      </Card>
    );
  }
  return (
    <>
      {/* Mobile (<lg): card list. Reuses the same column defs + renderCell. */}
      <MobileCards
        columns={columns}
        rows={sortedRows}
        onRowClick={onRowClick}
        titleKey={titleKey}
        statusColumn={statusColumn}
        fieldColumns={fieldColumns}
      />
      {/* Desktop (lg+): the existing table, unchanged. */}
      <Card padded={false} className="hidden lg:block">
        <div className="overflow-x-auto">
          <table className="w-full text-[14px]">
            <thead className="sticky top-0 z-10 bg-card">
              <tr>
                {columns.map((c) => {
                  const active = sort?.key === c.key;
                  return (
                    <th
                      key={c.key}
                      onClick={() => toggleSort(c.key)}
                      aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                      className={`text-left text-[11px] uppercase tracking-[0.04em] font-medium py-2.5 px-3 border-b border-ink-100 cursor-pointer select-none hover:text-ink-600 ${active ? 'text-brand-700' : 'text-ink-400'}`}
                    >
                      <span className="inline-flex items-center gap-1">
                        {tt(c.label)}
                        <span className="text-[9px] leading-none">{active ? (sort!.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row, i) => (
                <tr
                  key={i}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={`border-t border-ink-100 hover:bg-ink-50${onRowClick ? ' cursor-pointer' : ''}`}
                >
                  {columns.map((c) => (
                    <td key={c.key} className="py-2.5 px-3 text-ink-800 align-top">
                      {renderCell(c.key, row[c.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
