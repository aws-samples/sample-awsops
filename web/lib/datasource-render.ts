// Pure normalizer: connector-Lambda query bodies → a render-ready shape for the Explore page.
// No I/O. Invalid metric/log entries are counted and omitted; valid siblings survive.
// Wholly unusable or unsupported input degrades to { shape: 'empty', note }.
// Connector return contracts (unwrapped by invokeConnectorTool from { statusCode, body }):
//   prometheus/mimir : { truncated?, resultType: 'matrix'|'vector'|'scalar'|'string', result: [...] }
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
  collectionStatus?: 'ok' | 'empty' | 'partial' | 'unknown' | 'error';
  collectionNote?: string;
  /** Invalid series, samples or log entries encountered and omitted during normalization. */
  droppedEntries?: number;
}

const cols = (keys: string[]): Column[] => keys.map((k) => ({ key: k, label: k }));
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const isLabelMap = (x: unknown): x is Record<string, string> =>
  isObj(x) && Object.values(x).every(value => typeof value === 'string');
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
// Like `num` but PRESERVES non-finite samples as null (Prometheus "NaN"/"+Inf"/malformed). The instant
// table uses this for the value so a non-numeric sample stays distinguishable downstream (the Explore
// ranked-bar gate fail-closes on a non-number), instead of being silently coerced to a misleading 0.
const finiteOrNull = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) ? n : null; };
function epochMs(value: unknown, unit: 'seconds' | 'nanoseconds'): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const ms = unit === 'seconds' ? Number(value) * 1000 : Number(value) / 1e6;
  return Number.isFinite(ms) && Math.abs(ms) <= 8640000000000000 ? ms : null;
}
function metricPoint(value: unknown): { ms: number; value: number | null } | null {
  if (!Array.isArray(value) || value.length < 2
      || !['number', 'string'].includes(typeof value[1])) return null;
  const ms = epochMs(value[0], 'seconds');
  return ms === null ? null : { ms, value: finiteOrNull(value[1]) };
}
const withDrops = (result: NormalizedResult, droppedEntries: number): NormalizedResult =>
  droppedEntries ? { ...result, droppedEntries } : result;

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
  if (body.resultType === 'scalar' || body.resultType === 'string') {
    const ms = epochMs(result[0], 'seconds');
    if (result.length !== 2 || typeof result[0] !== 'number' || ms === null
        || typeof result[1] !== 'string') return withDrops({ shape: 'empty', truncated, note: '응답 형식 오류' }, 1);
    return { shape: 'table', truncated, columns: cols(['value', 'timestamp']), rows: [{
      value: body.resultType === 'scalar' ? finiteOrNull(result[1]) : result[1],
      timestamp: new Date(ms).toISOString(),
    }] };
  }
  if (!result.length) return { shape: 'empty', truncated, note: '결과 없음' };
  const objects = result.filter(isObj);
  let dropped = result.length - objects.length;

  if (body.resultType === 'matrix') {
    // v1 parity: up to 8 series merged on the timestamp axis → multi-line chart; all series →
    // a summary table. (Previously only the FIRST series was charted.)
    const MAX_SERIES = 8;
    const usable = objects.flatMap(so => {
      if (!isLabelMap(so.metric) || !Array.isArray(so.values)) { dropped++; return []; }
      const points = so.values.flatMap(value => {
        const point = metricPoint(value);
        if (!point) { dropped++; return []; }
        return [point];
      });
      return [{ metric: so.metric, points }];
    });
    const charted = usable.slice(0, MAX_SERIES);
    const keys: string[] = charted.map((so, i) => {
      const raw = labelStr(so.metric) || `series ${i + 1}`;
      return raw.length > 60 ? `${raw.slice(0, 57)}…#${i + 1}` : raw;
    });
    // Keyed and SORTED by the epoch, not the display label — the label drops the year
    // (`12-31 23:00` / `01-01 00:00`), so a lexical sort corrupts any window crossing Jan 1
    // (review: exposed by the new 7d/30d presets). `_ts` rides along as chart-invisible metadata.
    const byT = new Map<number, Record<string, unknown>>();
    charted.forEach((so, i) => {
      for (const pnt of so.points) {
        const ms = pnt.ms;
        const row = byT.get(ms) ?? { t: new Date(ms).toISOString().slice(5, 16).replace('T', ' '), _ts: ms };
        row[keys[i]] = pnt.value;
        byT.set(ms, row);
      }
    });
    const series = [...byT.values()].sort((a, b) => Number(a._ts) - Number(b._ts));
    const rows = usable.map(so => ({ metric: labelStr(so.metric), points: so.points.length }));
    if (!series.length) return withDrops({ shape: 'empty', truncated,
      note: dropped ? '응답 형식 오류' : '시계열 포인트 없음' }, dropped);
    return withDrops({
      shape: 'series', series, seriesXKey: 't', seriesKeys: keys,
      rows, columns: cols(['metric', 'points']), truncated,
      note: usable.length > MAX_SERIES ? `상위 ${MAX_SERIES}개 시리즈만 차트에 표시 (총 ${usable.length})` : undefined,
    }, dropped);
  }
  // vector (instant)
  const rows = objects.flatMap(eo => {
    const point = metricPoint(eo.value);
    if (!isLabelMap(eo.metric) || !point) { dropped++; return []; }
    return [{ metric: labelStr(eo.metric), value: point.value, timestamp: new Date(point.ms).toISOString() }];
  });
  if (!rows.length) return withDrops({ shape: 'empty', truncated, note: '응답 형식 오류' }, dropped);
  return withDrops({ shape: 'table', rows, columns: cols(['metric', 'value', 'timestamp']), truncated }, dropped);
}

function loki(body: Record<string, unknown>): NormalizedResult {
  const result = Array.isArray(body.result) ? body.result : [];
  const truncated = body.truncated === true;
  // Metric LogQL (`sum by(job)(count_over_time(…))`) comes back as resultType 'matrix'/'vector' with
  // {metric, values|value} — NOT {stream, values:[[ns, line]]}. The diag-signal chips added in this PR are
  // exactly those aggregate queries, and the stream path would have read a numeric sample as a log line
  // (review MAJOR). Prometheus' renderer already handles both matrix and vector, and Loki's metric
  // response has the same shape, so reuse it.
  if (body.resultType === 'matrix' || body.resultType === 'vector'
      || result.some((r) => r && typeof r === 'object' && 'metric' in (r as object))) {
    return prom(body);
  }
  const rows: Record<string, unknown>[] = [];
  let dropped = 0;
  for (const stream of result) {
    if (!isObj(stream) || !isLabelMap(stream.stream) || !Array.isArray(stream.values)) { dropped++; continue; }
    const so = stream;
    const labels = labelStr(so.stream);
    const values = Array.isArray(so.values) ? (so.values as unknown[][]) : [];
    for (const pair of values) {
      if (!Array.isArray(pair) || pair.length < 2 || typeof pair[1] !== 'string') { dropped++; continue; }
      const ms = epochMs(pair[0], 'nanoseconds');
      if (ms === null) { dropped++; continue; }
      // `_labelPairs` is additive display metadata (structured stream labels — quote-containing
      // values survive it, unlike the flat `labels` string the generic table path still shows).
      // The DataTable renders only `columns`, so it ignores this field.
      rows.push({
        timestamp: new Date(ms).toISOString(),
        line: String(pair[1] ?? ''),
        labels,
        _labelPairs: isObj(so.stream) ? Object.entries(so.stream as Record<string, unknown>).map(([k, v]) => ({ key: k, value: String(v) })) : [],
      });
    }
  }
  if (!rows.length) return withDrops({ shape: 'empty', truncated, note: dropped ? '응답 형식 오류' : '로그 없음' }, dropped);
  return withDrops({ shape: 'logs', rows, columns: cols(['timestamp', 'line', 'labels']), truncated }, dropped);
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
  // Epoch-keyed/sorted for the same year-boundary reason as the prom matrix path above.
  const byT = new Map<number, Record<string, unknown>>();
  charted.forEach((e, i) => {
    for (const [ms, v] of e.points) {
      if (v == null) continue;
      const row = byT.get(ms) ?? { t: new Date(ms).toISOString().slice(5, 16).replace('T', ' '), _ts: ms };
      row[keys[i]] = v;
      byT.set(ms, row);
    }
  });
  const series = [...byT.values()].sort((a, b) => Number(a._ts) - Number(b._ts));
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

function normalizeBody(kind: string, _tool: string, body: unknown): NormalizedResult {
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

const COLLECTION_STATES = new Set(['ok', 'empty', 'partial', 'unknown', 'error']);
const EMPTY_NOTES = new Set(['결과 없음', '행 없음', '트레이스 없음', '로그 없음', '시계열 포인트 없음']);

export function normalizeResult(kind: string, tool: string, body: unknown): NormalizedResult {
  const result = normalizeBody(kind, tool, body);
  if (!isObj(body)) return result;
  let status: NormalizedResult['collectionStatus'];
  if (Object.prototype.hasOwnProperty.call(body, 'collectionStatus')) {
    status = typeof body.collectionStatus === 'string' && COLLECTION_STATES.has(body.collectionStatus)
      ? body.collectionStatus as NonNullable<NormalizedResult['collectionStatus']> : 'unknown';
  }
  const truncated = result.truncated === true || body.truncated === true;
  if ('truncated' in body && typeof body.truncated !== 'boolean' && status !== 'error') status = 'unknown';
  if (truncated && status !== 'error' && status !== 'unknown') status = 'partial';
  if (result.droppedEntries && status !== 'error') status = 'unknown';
  if (!status) return result;
  const collectionNote = status === 'error' ? '조회 실패 — 확인 불가'
    : status === 'unknown' ? '수집 완료 여부 미확인 — 빈 결과를 확정할 수 없습니다.'
    : status === 'partial' ? '부분 결과 — 전체 범위를 확인할 수 없습니다.' : undefined;
  return {
    ...result, collectionStatus: status, ...(truncated ? { truncated: true } : {}),
    ...(collectionNote ? { collectionNote } : {}),
    ...(collectionNote && result.shape === 'empty' && (!result.note || EMPTY_NOTES.has(result.note))
      ? { note: collectionNote } : {}),
  };
}
