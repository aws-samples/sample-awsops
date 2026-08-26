// Pure normalizer: connector-Lambda query bodies → a render-ready shape for the Explore page.
// No I/O. Never throws — malformed input degrades to { shape: 'empty', note }.
// Connector return contracts (unwrapped by invokeConnectorTool from { statusCode, body }):
//   prometheus/mimir : { truncated?, resultType: 'matrix'|'vector', result: [...] }
//   loki             : { truncated?, resultType: 'streams', result: [{ stream, values:[[ns,line]] }] }
//   tempo            : { truncated?, traces: [{ traceID, rootServiceName, rootTraceName, durationMs }] }
//   jaeger           : { truncated?, traces: [{ traceID, rootServiceName, rootTraceName, spanCount, durationMs }] }
//   dynatrace        : { truncated?, result: [{ metricId, data: [{ dimensions, timestamps, values }] }] }
//   datadog          : { truncated?, series: [{ metric, scope, pointlist: [[ms, val]] }] }
//   clickhouse       : { rowCount, rows: [{col:val}], meta: [{name,type}] }

export interface Column { key: string; label: string }
export interface NormalizedResult {
  shape: 'series' | 'table' | 'logs' | 'traces' | 'empty';
  columns?: Column[];
  rows?: Record<string, unknown>[];
  series?: Record<string, unknown>[];
  seriesXKey?: string;
  seriesYKey?: string;
  /** Multi-series (prom matrix): one key per series, merged on the shared timestamp axis. */
  seriesKeys?: string[];
  truncated?: boolean;
  note?: string;
}

const cols = (keys: string[]): Column[] => keys.map((k) => ({ key: k, label: k }));
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
// Like `num` but PRESERVES non-finite samples as null (Prometheus "NaN"/"+Inf"/malformed). The instant
// table uses this for the value so a non-numeric sample stays distinguishable downstream (the Explore
// ranked-bar gate fail-closes on a non-number), instead of being silently coerced to a misleading 0.
const finiteOrNull = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/** Prometheus metric object → "name{label="v",...}" for display. */
function labelStr(metric: unknown): string {
  if (!isObj(metric)) return '';
  const name = typeof metric.__name__ === 'string' ? metric.__name__ : '';
  const rest = Object.entries(metric)
    .filter(([k]) => k !== '__name__')
    .map(([k, v]) => `${k}="${String(v)}"`)
    .join(',');
  return rest ? `${name}{${rest}}` : name;
}

function prom(body: Record<string, unknown>): NormalizedResult {
  const result = Array.isArray(body.result) ? body.result : [];
  const truncated = body.truncated === true;
  if (!result.length) return { shape: 'empty', truncated, note: '결과 없음' };

  if (body.resultType === 'matrix') {
    // v1 parity: up to 8 series merged on the timestamp axis → multi-line chart; all series →
    // a summary table. (Previously only the FIRST series was charted.)
    const MAX_SERIES = 8;
    const charted = result.slice(0, MAX_SERIES) as Record<string, unknown>[];
    const keys: string[] = charted.map((so, i) => {
      const raw = labelStr(so.metric) || `series ${i + 1}`;
      return raw.length > 60 ? `${raw.slice(0, 57)}…#${i + 1}` : raw;
    });
    const byT = new Map<string, Record<string, unknown>>();
    charted.forEach((so, i) => {
      const values = Array.isArray(so.values) ? (so.values as unknown[][]) : [];
      for (const pnt of values) {
        const t = new Date(num(pnt[0]) * 1000).toISOString().slice(5, 16).replace('T', ' ');
        const row = byT.get(t) ?? { t };
        row[keys[i]] = num(pnt[1]);
        byT.set(t, row);
      }
    });
    const series = [...byT.values()].sort((a, b) => String(a.t).localeCompare(String(b.t)));
    const rows = result.map((s) => {
      const so = s as Record<string, unknown>;
      const pts = Array.isArray(so.values) ? (so.values as unknown[]).length : 0;
      return { metric: labelStr(so.metric), points: pts };
    });
    if (!series.length) return { shape: 'empty', truncated, note: '시계열 포인트 없음' };
    return {
      shape: 'series', series, seriesXKey: 't', seriesKeys: keys,
      rows, columns: cols(['metric', 'points']), truncated,
      note: result.length > MAX_SERIES ? `상위 ${MAX_SERIES}개 시리즈만 차트에 표시 (총 ${result.length})` : undefined,
    };
  }
  // vector (instant)
  const rows = result.map((e) => {
    const eo = e as Record<string, unknown>;
    const val = Array.isArray(eo.value) ? (eo.value as unknown[]) : [];
    return { metric: labelStr(eo.metric), value: finiteOrNull(val[1]), timestamp: new Date(num(val[0]) * 1000).toISOString() };
  });
  return { shape: 'table', rows, columns: cols(['metric', 'value', 'timestamp']), truncated };
}

function loki(body: Record<string, unknown>): NormalizedResult {
  const result = Array.isArray(body.result) ? body.result : [];
  const truncated = body.truncated === true;
  const rows: Record<string, unknown>[] = [];
  for (const stream of result) {
    const so = stream as Record<string, unknown>;
    const labels = labelStr(so.stream);
    const values = Array.isArray(so.values) ? (so.values as unknown[][]) : [];
    for (const pair of values) {
      const ns = num(pair[0]);
      rows.push({ timestamp: new Date(ns / 1e6).toISOString(), line: String(pair[1] ?? ''), labels });
    }
  }
  if (!rows.length) return { shape: 'empty', truncated, note: '로그 없음' };
  return { shape: 'logs', rows, columns: cols(['timestamp', 'line', 'labels']), truncated };
}

function tempo(body: Record<string, unknown>): NormalizedResult {
  const traces = Array.isArray(body.traces) ? body.traces : [];
  const truncated = body.truncated === true;
  if (!traces.length) return { shape: 'empty', truncated, note: '트레이스 없음' };
  const rows = traces.map((t) => {
    const to = t as Record<string, unknown>;
    return {
      traceID: to.traceID ?? to.traceId ?? '',
      rootServiceName: to.rootServiceName ?? '',
      rootTraceName: to.rootTraceName ?? '',
      durationMs: to.durationMs ?? to.durationMms ?? '',
    };
  });
  return { shape: 'traces', rows, columns: cols(['traceID', 'rootServiceName', 'rootTraceName', 'durationMs']), truncated };
}

function jaeger(body: Record<string, unknown>): NormalizedResult {
  const traces = Array.isArray(body.traces) ? body.traces : [];
  const truncated = body.truncated === true;
  if (!traces.length) return { shape: 'empty', truncated, note: '트레이스 없음' };
  const rows = traces.map((t) => {
    const to = t as Record<string, unknown>;
    return {
      traceID: to.traceID ?? '',
      rootServiceName: to.rootServiceName ?? '',
      rootTraceName: to.rootTraceName ?? '',
      spanCount: to.spanCount ?? '',
      durationMs: to.durationMs ?? '',
    };
  });
  return { shape: 'traces', rows, columns: cols(['traceID', 'rootServiceName', 'rootTraceName', 'spanCount', 'durationMs']), truncated };
}

// Shared multi-series merger for timestamped series → { shape:'series' } (same contract as prom matrix).
function mergeSeries(
  entries: Array<{ key: string; points: Array<[number, number | null]> }>,
  truncated: boolean,
  totalCount: number,
): NormalizedResult {
  const MAX_SERIES = 8;
  const charted = entries.slice(0, MAX_SERIES);
  const keys = charted.map((e, i) => (e.key.length > 60 ? `${e.key.slice(0, 57)}…#${i + 1}` : e.key || `series ${i + 1}`));
  const byT = new Map<string, Record<string, unknown>>();
  charted.forEach((e, i) => {
    for (const [ms, v] of e.points) {
      if (v == null) continue;
      const t = new Date(ms).toISOString().slice(5, 16).replace('T', ' ');
      const row = byT.get(t) ?? { t };
      row[keys[i]] = v;
      byT.set(t, row);
    }
  });
  const series = [...byT.values()].sort((a, b) => String(a.t).localeCompare(String(b.t)));
  if (!series.length) return { shape: 'empty', truncated, note: '시계열 포인트 없음' };
  const rows = entries.map((e) => ({ metric: e.key, points: e.points.length }));
  return {
    shape: 'series', series, seriesXKey: 't', seriesKeys: keys,
    rows, columns: cols(['metric', 'points']), truncated,
    note: totalCount > MAX_SERIES ? `상위 ${MAX_SERIES}개 시리즈만 차트에 표시 (총 ${totalCount})` : undefined,
  };
}

function dynatrace(body: Record<string, unknown>): NormalizedResult {
  const result = Array.isArray(body.result) ? body.result : [];
  const truncated = body.truncated === true;
  const entries: Array<{ key: string; points: Array<[number, number | null]> }> = [];
  for (const metric of result) {
    if (!isObj(metric)) continue;
    const mid = String(metric.metricId ?? '');
    for (const d of Array.isArray(metric.data) ? metric.data : []) {
      if (!isObj(d)) continue;
      const dims = Array.isArray(d.dimensions) ? (d.dimensions as unknown[]).join(',') : '';
      const ts = Array.isArray(d.timestamps) ? (d.timestamps as unknown[]) : [];
      const vals = Array.isArray(d.values) ? (d.values as unknown[]) : [];
      entries.push({
        key: dims ? `${mid}{${dims}}` : mid,
        points: ts.map((t, i) => [num(t), finiteOrNull(vals[i])] as [number, number | null]),
      });
    }
  }
  if (!entries.length) return { shape: 'empty', truncated, note: '결과 없음' };
  return mergeSeries(entries, truncated, entries.length);
}

function datadog(body: Record<string, unknown>): NormalizedResult {
  const series = Array.isArray(body.series) ? body.series : [];
  const truncated = body.truncated === true;
  const entries = series.filter(isObj).map((s) => ({
    key: [String(s.metric ?? ''), String(s.scope ?? '')].filter(Boolean).join(' '),
    points: (Array.isArray(s.pointlist) ? (s.pointlist as unknown[][]) : []).map(
      (p) => [num(p[0]), finiteOrNull(p[1])] as [number, number | null],
    ),
  }));
  if (!entries.length) return { shape: 'empty', truncated, note: '결과 없음' };
  return mergeSeries(entries, truncated, series.length);
}

function clickhouse(body: Record<string, unknown>): NormalizedResult {
  const rows = Array.isArray(body.rows) ? (body.rows as Record<string, unknown>[]) : [];
  const truncated = body.truncated === true;
  if (!rows.length) return { shape: 'empty', truncated, note: '행 없음' };
  const meta = Array.isArray(body.meta) ? body.meta : [];
  const keys = meta.length
    ? meta.map((m) => String((m as Record<string, unknown>).name))
    : Object.keys(rows[0] ?? {});
  return { shape: 'table', rows, columns: cols(keys), truncated };
}

export function normalizeResult(kind: string, _tool: string, body: unknown): NormalizedResult {
  if (!isObj(body)) return { shape: 'empty', note: '응답 없음' };
  try {
    switch (kind) {
      case 'prometheus':
      case 'mimir':
        return prom(body);
      case 'loki':
        return loki(body);
      case 'tempo':
        return tempo(body);
      case 'jaeger':
        return jaeger(body);
      case 'dynatrace':
        return dynatrace(body);
      case 'datadog':
        return datadog(body);
      case 'clickhouse':
        return clickhouse(body);
      default:
        return { shape: 'empty', note: `지원하지 않는 데이터소스: ${kind}` };
    }
  } catch (e) {
    return { shape: 'empty', note: `결과 파싱 실패: ${e instanceof Error ? e.message : 'unknown'}` };
  }
}
