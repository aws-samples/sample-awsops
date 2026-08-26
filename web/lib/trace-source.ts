// web/lib/trace-source.ts
// Trace-level topology (class='trace') source abstraction (design: docs/superpowers/specs/
// 2026-06-25-trace-topology-design.md). A `TraceSource` decouples `rebuildTraceGraph` (graph-store.ts)
// from the trace backend. First adapter = ClickHouse otel (`otel_traces`); Datadog APM is a future
// adapter (interface only). The source is read-only and bounded; `available()` is false until the otel
// pipeline lands spans (the dormant "preparation" state — empty trace layer, no code change later).

import { getDatasource, getDefaultDatasource, resolveConnConfig } from '@/lib/datasources';
import { invokeMcpLambdaTool } from '@/lib/mcp-lambda-invoke';

/** One distributed-trace span, normalized across backends. Times are epoch-ms / duration-ms. */
export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  service: string;
  kind: string;
  dbSystem?: string;
  dbName?: string;
  dbHost?: string;
  peerService?: string;
  k8sNamespace?: string;
  k8sPod?: string;
  k8sDeployment?: string;
  k8sCluster?: string;
  startMs: number;
  durationMs: number;
}

/** Pluggable trace backend. `available()` gates the rebuild (false → empty, no-op layer). */
export interface TraceSource {
  available(): Promise<boolean>;
  /** Bounded fetch of recent spans: only the last `windowMins` minutes, at most `cap` rows. */
  recentSpans(windowMins: number, cap: number): Promise<TraceSpan[]>;
}

/** In-memory source for tests — seeded spans + an explicit availability flag. */
export class FakeTraceSource implements TraceSource {
  constructor(private readonly spans: TraceSpan[], private readonly isAvailable: boolean = true) {}
  async available(): Promise<boolean> {
    return this.isAvailable;
  }
  async recentSpans(_windowMins: number, cap: number): Promise<TraceSpan[]> {
    return this.spans.slice(0, cap);
  }
}

// --- ClickHouse otel adapter -------------------------------------------------------------------

/** The OTel ClickHouse exporter's default `otel_traces` table. Attributes live in
 *  `Map(LowCardinality(String), String)` columns (`ResourceAttributes`, `SpanAttributes`), NOT flat
 *  columns; plus top-level `Timestamp`, `Duration` (ns), `TraceId`, `SpanId`, `ParentSpanId`,
 *  `ServiceName`, `SpanKind`. */
const OTEL_TRACES_TABLE = 'otel_traces';

// Pre-registry / dormant-state fallback (no datasource_graph_queries ready row yet — see
// loadGraphSources in graph-sources.ts). Matches graph_catalog.py's otel_v1 template shape exactly
// (literal `{window}`/`{cap}` placeholders) so both paths produce byte-identical SQL when the schema
// happens to be the literal `otel_traces` table.
const DEFAULT_OTEL_SQL_TEMPLATE =
  `SELECT TraceId, SpanId, ParentSpanId, ServiceName, SpanKind, Timestamp, Duration, ` +
  `ResourceAttributes, SpanAttributes FROM ${OTEL_TRACES_TABLE} ` +
  `WHERE Timestamp >= now() - INTERVAL {window} MINUTE ORDER BY Timestamp DESC LIMIT {cap}`;

interface OtelTracesRow {
  TraceId?: string;
  SpanId?: string;
  ParentSpanId?: string;
  ServiceName?: string;
  SpanKind?: string;
  Timestamp?: string; // ISO-ish or epoch; ClickHouse DateTime64
  Duration?: number | string; // nanoseconds
  ResourceAttributes?: Record<string, string>;
  SpanAttributes?: Record<string, string>;
}

/** Map one `otel_traces` row (real nested-map shape) → TraceSpan. Pure; exported for unit testing. */
export function mapOtelRow(row: OtelTracesRow): TraceSpan {
  const res = row.ResourceAttributes ?? {};
  const span = row.SpanAttributes ?? {};
  const service = row.ServiceName || res['service.name'] || 'unknown';
  const durationNs = Number(row.Duration ?? 0);
  const startMs = row.Timestamp ? new Date(row.Timestamp).getTime() : 0;
  const out: TraceSpan = {
    traceId: row.TraceId ?? '',
    spanId: row.SpanId ?? '',
    service,
    kind: row.SpanKind ?? '',
    startMs: Number.isFinite(startMs) ? startMs : 0,
    durationMs: Number.isFinite(durationNs) ? durationNs / 1e6 : 0,
  };
  if (row.ParentSpanId) out.parentSpanId = row.ParentSpanId;
  const dbSystem = span['db.system'];
  if (dbSystem) out.dbSystem = dbSystem;
  const dbName = span['db.name'];
  if (dbName) out.dbName = dbName;
  // host-only attrs ONLY — never span['db.connection_string']: OTel allows a full DSN there
  // (`user:password@host`), and dbHost is persisted to node meta.host + exposed via /api/graph and
  // the get_topology MCP tool → a credential would leak into the topology layer (C2).
  const dbHost = span['server.address'] || span['net.peer.name'];
  if (dbHost) out.dbHost = dbHost;
  const peer = span['peer.service'];
  if (peer) out.peerService = peer;
  const ns = res['k8s.namespace.name'];
  if (ns) out.k8sNamespace = ns;
  const pod = res['k8s.pod.name'];
  if (pod) out.k8sPod = pod;
  const deploy = res['k8s.deployment.name'];
  if (deploy) out.k8sDeployment = deploy;
  const cluster = res['k8s.cluster.name'];
  if (cluster) out.k8sCluster = cluster;
  return out;
}

/** Read-only adapter over the default ClickHouse datasource's `otel_traces` table. Reuses the existing
 *  connector path (`invokeMcpLambdaTool('clickhouse', 'clickhouse_query', …)`) so SSRF/credential reuse
 *  and the read-only SQL guard are inherited. `available()` is false when there is no default ClickHouse
 *  instance (the dormant pre-tracing state). */
export class ClickHouseOtelTraceSource implements TraceSource {
  // sqlTemplate: from datasource_graph_queries (graph_catalog.py, schema-driven table name), with
  // literal `{window}`/`{cap}` placeholders. Omitted → the default literal `otel_traces` query below
  // (the pre-registry / dormant-state fallback — see loadGraphSources in graph-sources.ts).
  constructor(private readonly instanceId?: number, private readonly sqlTemplate?: string) {}

  private async resolve(): Promise<{ id: number; connConfig: Awaited<ReturnType<typeof resolveConnConfig>> } | null> {
    // Explicit-instance path: resolve the row by its integration id (must be a clickhouse instance).
    // Default path (no instanceId): the kind's default datasource — the dormant pre-tracing state has none.
    const row = this.instanceId
      ? await getDatasource(this.instanceId)
      : await getDefaultDatasource('clickhouse');
    if (!row || row.kind !== 'clickhouse') return null;
    const connConfig = await resolveConnConfig(row);
    return { id: row.id, connConfig };
  }

  async available(): Promise<boolean> {
    const r = await this.resolve();
    return r !== null;
  }

  async recentSpans(windowMins: number, cap: number): Promise<TraceSpan[]> {
    const r = await this.resolve();
    if (!r) return [];
    // Read-only SELECT, bounded by window + cap. Times: Timestamp DateTime64, Duration ns.
    // A caller-supplied template (from datasource_graph_queries, built by graph_catalog.py against
    // the instance's ACTUAL table name — never a hardcoded default) wins; falls back to the literal
    // `otel_traces` query for the no-registry-row / dormant-state path (see loadGraphSources).
    const template = this.sqlTemplate ?? DEFAULT_OTEL_SQL_TEMPLATE;
    // replaceAll, not replace: a string search value only replaces the FIRST occurrence in JS —
    // Python's str.replace() (used by graph_querygen.py's own dry-run validation of the same
    // template) replaces ALL occurrences, so a generated template referencing a placeholder twice
    // would pass validation but leave a literal "{window}"/"{cap}" in the SQL sent here (co-agent
    // consensus review finding, 2026-07-08).
    const sql = template
      .replaceAll('{window}', String(Math.max(1, Math.floor(windowMins))))
      .replaceAll('{cap}', String(Math.max(1, Math.floor(cap))));
    let result: unknown;
    try {
      result = await invokeMcpLambdaTool({
        kind: 'clickhouse',
        tool: 'clickhouse_query',
        // Pass max_rows: without it, clickhouse_mcp clamps results to DEFAULT_MAX_ROWS=100, so the
        // SQL `LIMIT ${cap}` was moot (only 100 spans ever returned → severely incomplete graph). The
        // tool hard-caps at MAX_ROWS_CAP=1000, which TRACE_SPAN_CAP is pinned to (M1).
        args: { sql, max_rows: Math.max(1, Math.floor(cap)) },
        connConfig: r.connConfig,
      });
    } catch {
      return []; // otel_traces absent / query failed → treat as no spans (dormant state, never throws)
    }
    const rows = extractRows(result);
    return rows.map(mapOtelRow);
  }
}

/** The connector returns a result envelope; pull out the row array tolerant of a few shapes. */
function extractRows(result: unknown): OtelTracesRow[] {
  if (Array.isArray(result)) return result as OtelTracesRow[];
  const r = result as { rows?: unknown; data?: unknown; result?: { rows?: unknown } } | null;
  if (r && Array.isArray(r.rows)) return r.rows as OtelTracesRow[];
  if (r && Array.isArray(r.data)) return r.data as OtelTracesRow[];
  if (r && r.result && Array.isArray(r.result.rows)) return r.result.rows as OtelTracesRow[];
  return [];
}

// --- Tempo adapter (registry-driven graph sources, 2026-07-08) ---------------------------------
// Tempo has no "list recent spans" endpoint — the only path is search (TraceQL) → per-trace fetch.
// tempo_search returns trace summaries; tempo_get_trace returns the full trace as OTLP-JSON
// (`{batches:[{resource,scopeSpans:[{spans:[...]}]}]}` — Tempo's `/api/traces/{id}` shape).

interface OtlpAttr { key?: string; value?: { stringValue?: string; intValue?: unknown; boolValue?: unknown; doubleValue?: unknown } }
interface OtlpSpan {
  spanId?: string; parentSpanId?: string; kind?: number;
  startTimeUnixNano?: string | number; endTimeUnixNano?: string | number;
  attributes?: OtlpAttr[];
}
interface OtlpScopeSpans { spans?: OtlpSpan[] }
interface OtlpBatch {
  resource?: { attributes?: OtlpAttr[] };
  scopeSpans?: OtlpScopeSpans[];
  instrumentationLibrarySpans?: OtlpScopeSpans[]; // older Tempo/OTLP versions use this key
}

const OTLP_KIND: Record<number, string> = { 0: 'UNSPECIFIED', 1: 'INTERNAL', 2: 'SERVER', 3: 'CLIENT', 4: 'PRODUCER', 5: 'CONSUMER' };

function otlpAttrValue(v: OtlpAttr['value']): string | undefined {
  if (!v) return undefined;
  const s = v.stringValue ?? v.intValue ?? v.boolValue ?? v.doubleValue;
  return s === undefined || s === null ? undefined : String(s);
}

function otlpAttrsToRecord(attrs: OtlpAttr[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of attrs ?? []) {
    if (typeof a?.key !== 'string') continue;
    const v = otlpAttrValue(a.value);
    if (v !== undefined) out[a.key] = v;
  }
  return out;
}

/** Map one `tempo_get_trace` response (OTLP-JSON `{batches:[...]}}`) → TraceSpan[]. Pure; exported
 *  for unit testing. Tolerant of a missing/malformed shape (returns []), never throws. */
export function mapTempoTrace(traceId: string, result: unknown): TraceSpan[] {
  const r = result as { batches?: OtlpBatch[] } | null | undefined;
  const batches = Array.isArray(r?.batches) ? r!.batches! : [];
  const out: TraceSpan[] = [];
  for (const b of batches) {
    const res = otlpAttrsToRecord(b.resource?.attributes);
    const service = res['service.name'] || 'unknown';
    const scopeSpans = b.scopeSpans ?? b.instrumentationLibrarySpans ?? [];
    for (const ss of scopeSpans) {
      for (const s of ss.spans ?? []) {
        const span = otlpAttrsToRecord(s.attributes);
        const startNs = Number(s.startTimeUnixNano ?? 0);
        const endNs = Number(s.endTimeUnixNano ?? 0);
        const item: TraceSpan = {
          traceId, spanId: s.spanId ?? '', service,
          kind: OTLP_KIND[s.kind ?? 0] ?? String(s.kind ?? ''),
          startMs: Number.isFinite(startNs) ? startNs / 1e6 : 0,
          durationMs: Number.isFinite(endNs) && Number.isFinite(startNs) ? Math.max(0, (endNs - startNs) / 1e6) : 0,
        };
        if (s.parentSpanId) item.parentSpanId = s.parentSpanId;
        const dbSystem = span['db.system']; if (dbSystem) item.dbSystem = dbSystem;
        const dbName = span['db.name']; if (dbName) item.dbName = dbName;
        const dbHost = span['server.address'] || span['net.peer.name']; if (dbHost) item.dbHost = dbHost;
        const peer = span['peer.service']; if (peer) item.peerService = peer;
        const ns = res['k8s.namespace.name']; if (ns) item.k8sNamespace = ns;
        const pod = res['k8s.pod.name']; if (pod) item.k8sPod = pod;
        const deploy = res['k8s.deployment.name']; if (deploy) item.k8sDeployment = deploy;
        const cluster = res['k8s.cluster.name']; if (cluster) item.k8sCluster = cluster;
        out.push(item);
      }
    }
  }
  return out;
}

function extractTraceIds(result: unknown): string[] {
  const r = result as { traces?: { traceID?: unknown }[] } | null | undefined;
  if (!r || !Array.isArray(r.traces)) return [];
  return r.traces.map((t) => t?.traceID).filter((id): id is string => typeof id === 'string');
}

/** Read-only adapter over a Tempo instance: search (TraceQL, bounded) → per-trace fetch → map.
 *  `available()` requires the instance to resolve as a `tempo` datasource. */
export class TempoTraceSource implements TraceSource {
  constructor(private readonly instanceId: number) {}

  private async resolve() {
    const row = await getDatasource(this.instanceId);
    if (!row || row.kind !== 'tempo') return null;
    return resolveConnConfig(row);
  }

  async available(): Promise<boolean> {
    return (await this.resolve()) !== null;
  }

  async recentSpans(_windowMins: number, cap: number): Promise<TraceSpan[]> {
    const connConfig = await this.resolve();
    if (!connConfig) return [];
    // ponytail: search limit fixed at 20 (mirrors graph_catalog.py's tempo_v1 args_template) — bounds
    // this adapter to ≤21 Lambda invokes/rebuild/instance (1 search + ≤20 get-trace). Widen both
    // together if a deeper trace sample is needed.
    let traceIds: string[];
    try {
      const searchResult = await invokeMcpLambdaTool({
        kind: 'tempo', tool: 'tempo_search', args: { query: '{}', limit: 20 }, connConfig,
      });
      traceIds = extractTraceIds(searchResult);
    } catch {
      return []; // search failed → treat as no spans, never throw
    }
    const spans: TraceSpan[] = [];
    for (const traceId of traceIds.slice(0, 20)) {
      try {
        const traceResult = await invokeMcpLambdaTool({
          kind: 'tempo', tool: 'tempo_get_trace', args: { trace_id: traceId }, connConfig,
        });
        spans.push(...mapTempoTrace(traceId, traceResult));
      } catch {
        // one bad trace fetch must not drop the rest
      }
    }
    return spans.slice(0, Math.max(1, Math.floor(cap)));
  }
}

// --- Prometheus/Mimir service-graph adapter (registry-driven graph sources, 2026-07-08) --------
// NOT a TraceSource — Prometheus/Mimir metrics carry no span/parent-child data, only aggregate
// call counts (Istio's istio_requests_total or Tempo metrics-generator's
// traces_service_graph_request_total). Contributes `calls` edges only — never `queries`/`runs_on` —
// per the capability-driven design (docs/superpowers/specs/2026-07-08-registry-graph-sources-design.md).

export interface ServiceGraphCall { client: string; server: string; count: number }

/** service→service call-count edges from a pre-built PromQL instant query. `promqlTemplate` contains
 *  a literal `{window}` placeholder (from graph_catalog.py's servicegraph_v1/istio_v1 mapper). */
export class MetricsCallsSource {
  constructor(
    private readonly instanceId: number,
    private readonly kind: 'prometheus' | 'mimir',
    private readonly promqlTemplate: string,
  ) {}

  private async resolve() {
    const row = await getDatasource(this.instanceId);
    if (!row || row.kind !== this.kind) return null;
    return resolveConnConfig(row);
  }

  async available(): Promise<boolean> {
    return (await this.resolve()) !== null;
  }

  async calls(windowMins: number): Promise<ServiceGraphCall[]> {
    const connConfig = await this.resolve();
    if (!connConfig) return [];
    const query = this.promqlTemplate.replaceAll('{window}', String(Math.max(1, Math.floor(windowMins))));
    let result: unknown;
    try {
      result = await invokeMcpLambdaTool({ kind: this.kind, tool: `${this.kind}_query`, args: { query }, connConfig });
    } catch {
      return []; // query failed → contribute no edges, never throw
    }
    return extractServiceGraphCalls(result);
  }
}

/** Pull {client,server,count} out of a Prometheus/Mimir instant-query vector result
 *  (`{resultType:'vector', result:[{metric:{...labels}, value:[ts, "n"]}]}`, the raw `/api/v1/query`
 *  passthrough — see prometheus_mcp.py/mimir_mcp.py). Tolerant of either the servicegraph_v1
 *  (`client`/`server` labels) or istio_v1 (`source_workload`/`destination_workload`) label pairs.
 *  Drops zero/negative/non-numeric counts and malformed rows. Pure; exported for unit testing. */
export function extractServiceGraphCalls(result: unknown): ServiceGraphCall[] {
  const r = result as { result?: { metric?: Record<string, string>; value?: [unknown, unknown] }[] } | null | undefined;
  const rows = Array.isArray(r?.result) ? r!.result! : [];
  const out: ServiceGraphCall[] = [];
  for (const row of rows) {
    const metric = row?.metric ?? {};
    const client = metric.client ?? metric.source_workload;
    const server = metric.server ?? metric.destination_workload;
    const raw = Array.isArray(row?.value) ? row.value[1] : undefined;
    const count = Number(raw);
    if (client && server && Number.isFinite(count) && count > 0) out.push({ client, server, count });
  }
  return out;
}
