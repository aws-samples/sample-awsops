export interface TableTrend {
  data: Array<Record<string, string | number | null>>;
  series: { key: string; label: string }[];
  omittedSeries: number;
}
const TIME_HEADER = /^(time(?:stamp)?|date|时[间刻]|時間|時刻|日時|시각|시간|날짜)(?:\s|[([]|$)/i;
const METRIC_HEADER = /\b(?:requests?|errors?|counts?|rates?|latency|duration|p(?:50|90|95|99)|cpu|memory|bytes|throughput)\b|요청|에러|오류|건수|비율|사용률|지연|메모리|请求|错误|延迟|リクエスト|エラー|レイテンシ/i;
const NON_METRIC = /(?:^|[\s_(])id(?:$|[\s_)])|id$|code|코드|代码|コード|graph|sparkline|그래프|图|グラフ/i;
const MISSING = /^(?:—|–|-|n\/a|null|none)?$/i;

function timeLabel(value: string): boolean {
  const clean = value.replace(/\*$/, '');
  if (/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(clean)) return true;
  return /^\d{4}-\d{2}-\d{2}[ T](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(clean)
    && Number.isFinite(Date.parse(clean));
}
function numeric(value: string, header: string): number | null {
  const clean = value.trim();
  if (MISSING.test(clean)) return null;
  if (clean.endsWith('%') && !header.includes('%')) return null;
  const raw = clean.replace(/%$/, '');
  if (/^[+-]?0\d*,/.test(raw)) return null;
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(raw)) return null;
  const parsed = Number(raw.replace(/,/g, ''));
  return Number.isFinite(parsed) && Math.abs(parsed) <= Number.MAX_SAFE_INTEGER ? parsed : null;
}

/** Visualize explicit table samples only; never derive values from prose/text bars. */
export function tableTrends(headers: string[], rows: string[][]): TableTrend | null {
  if (!TIME_HEADER.test(headers[0]?.trim() ?? '') || rows.length < 2 || rows.length > 200
    || rows.some(row => row.length !== headers.length || !timeLabel(row[0].trim()))) return null;
  const labels = rows.map(row => row[0].trim());
  if (new Set(labels.map(label => label.replace(/\*$/, ''))).size !== labels.length) return null;
  const eligible = headers.flatMap((label, i) => {
    if (!i || !METRIC_HEADER.test(label) || NON_METRIC.test(label)) return [];
    const values = rows.map(row => numeric(row[i], label));
    if (values.filter(value => value !== null).length < 2
      || rows.some((row, j) => values[j] === null && !MISSING.test(row[i].trim()))) return [];
    return [{ key: `metric${i - 1}`, label }];
  });
  const series = eligible.slice(0, 4);
  if (!series.length) return null;
  return {
    series,
    omittedSeries: eligible.length - series.length,
    data: rows.map((row, i) => Object.fromEntries([
      ['time', labels[i]],
      ...series.map(s => [s.key, numeric(row[Number(s.key.slice(6)) + 1], s.label)]),
    ])),
  };
}
