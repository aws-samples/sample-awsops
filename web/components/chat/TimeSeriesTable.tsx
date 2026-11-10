'use client';

import { useMemo, useState, type ReactNode } from 'react';
import type { Element, ElementContent } from 'hast';
import MultiLineTrend from '@/components/charts/MultiLineTrend';
import { tableTrends } from '@/lib/table-trends';
import { useI18n } from '@/components/shell/LanguageProvider';

const text = (node: ElementContent): string => node.type === 'text' ? node.value
  : node.type === 'element' ? node.children.map(text).join('') : '';
function cells(node?: Element): string[][] {
  const rows: string[][] = [];
  const visit = (element: Element) => {
    if (element.tagName === 'tr') {
      rows.push(element.children.filter((child): child is Element => child.type === 'element'
        && ['th', 'td'].includes(child.tagName)).map(child => text(child).trim()));
    } else element.children.forEach(child => { if (child.type === 'element') visit(child); });
  };
  if (node) visit(node);
  return rows;
}

export default function TimeSeriesTable({ node, enabled, children }: {
  node?: Element; enabled: boolean; children: ReactNode;
}) {
  const { tt } = useI18n();
  const [view, setView] = useState<'line' | 'bar' | 'table'>('line');
  const trend = useMemo(() => {
    if (!enabled) return null;
    const [headers, ...rows] = cells(node);
    return headers ? tableTrends(headers, rows) : null;
  }, [enabled, node]);
  const table = <div className="my-2 max-w-full overflow-x-auto rounded-md border border-ink-100">
    <table className="w-full border-collapse text-[12px]">{children}</table>
  </div>;
  if (!trend) return table;
  return <div className="my-3 min-w-0" data-testid="assistant-table-trends">
    <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
      <span className="font-medium text-ink-700">{tt('시계열')}</span>
      <div className="ml-auto flex rounded-md border border-ink-200">
        {(['line', 'bar', 'table'] as const).map(value => <button key={value} type="button"
          aria-pressed={view === value} onClick={() => setView(value)}
          className={`px-2 py-1 ${view === value ? 'bg-brand-50 text-brand-700' : 'text-ink-500'}`}>
          {tt(value === 'line' ? '선 그래프' : value === 'bar' ? '막대 그래프' : '표')}
        </button>)}
      </div>
    </div>
    {view !== 'table' && <div className="grid min-w-0 gap-3 lg:grid-cols-2">
      {trend.series.map(series => <MultiLineTrend key={series.key} title={series.label} data={trend.data}
        xKey="time" series={[{ ...series, label: series.label }]} height={180}
        variant={view} allowDecimals lineType="linear" />)}
    </div>}
    {view !== 'table' && <p className="my-2 text-[11px] text-ink-500">
      {tt('표에 있는 숫자를 지표별로 표시합니다. 단위·빈 값·부분 구간 표시는 원본 표를 확인하세요.')}
    </p>}
    {view !== 'table' && trend.omittedSeries > 0 && <p className="my-2 text-xs text-ink-600" role="status">
      {tt('차트 표시 한도로 생략된 지표')}: {trend.omittedSeries}. {tt('나머지 지표는 원본 표에서 확인하세요.')}
    </p>}
    {view === 'table' ? table : <details>
      <summary className="cursor-pointer text-xs text-ink-600">{tt('원본 표 보기')}</summary>{table}
    </details>}
  </div>;
}
