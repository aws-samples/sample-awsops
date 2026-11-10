// Read-only, bounded topology sources. Only normalized, allowlisted fields leave this boundary.
import { getDatasource, getDefaultDatasource, resolveConnConfig } from '@/lib/datasources';
import { invokeMcpLambdaTool } from '@/lib/mcp-lambda-invoke';

export interface SourceRead<T> {
  items: T[];
  status: 'ok' | 'partial' | 'unavailable' | 'error';
  sourceId: string;
  reasons: string[];
  windowStartMs: number;
  windowEndMs: number;
  /** Missing data/unproven empty reads retain the prior snapshot despite useful siblings. */
  canSweep?: false;
}

export interface TraceIdentity {
  sourceId?: string;
  accountId?: string;
  region?: string;
  environment?: string;
  serviceNamespace?: string;
  k8sNamespace?: string;
  k8sCluster?: string;
}

/** One distributed-trace span. Times are epoch-ms / duration-ms. Absent scope stays unknown. */
export interface TraceSpan extends TraceIdentity {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  service: string;
  kind: string;
  name?: string;
  status?: 'ok' | 'error' | 'unset';
  links?: { traceId: string; spanId: string }[];
  serviceVersion?: string;
  /** Allowlisted telemetry claims; inventory validation is required before EC2 attribution. */
  cloudResourceId?: string;
  hostId?: string;
  serviceInstanceId?: string;
  messagingSystem?: string;
  messagingDestination?: string;
  messagingBroker?: string;
  dbSystem?: string;
  dbName?: string;
  dbHost?: string;
  peerService?: string;
  k8sPod?: string;
  k8sDeployment?: string;
  startMs: number;
  durationMs: number;
  /** Aggregate rows only: the number of spans this row stands for (absent = one span). Its
   *  durationMs is then the summed duration, startMs the latest start and firstStartMs the earliest. */
  weight?: number;
  firstStartMs?: number;
  /** Aggregate rows only: bounded distinct pod names behind the row. */
  k8sPods?: string[];
}

export interface TraceSource {
  available(): Promise<boolean>;
  recentSpans(windowMins: number, cap: number, endMs?: number): Promise<TraceRead>;
}

export interface ServiceGraphCall {
  client: string;
  server: string;
  count: number;
  clientIdentity?: TraceIdentity;
  serverIdentity?: TraceIdentity;
  /** 'trace': counted from parent/child (or link) span pairs, so count is a span count.
   *  Absent: a service-graph metric increase. */
  evidence?: 'trace';
  rel?: 'calls' | 'linked';
  /** Tempo service-graph connection_type label (database, messaging_system, virtual_node). */
  connectionType?: string;
}

/** Trace sources may also return span-pair edges they already aggregated at the source. */
export interface TraceRead extends SourceRead<TraceSpan> {
  calls?: ServiceGraphCall[];
}

// Never use backend exceptions, status messages, SQL, previews or credentials as reasons.
type Reason = 'missing_configuration' | 'configuration_failed' | 'query_failed' |
  'malformed_payload' | 'malformed_rows' | 'payload_truncated' | 'trace_fetch_failed' |
  'cap_reached' | 'invalid_request' | 'incomplete_collection' | 'empty_not_confirmed' | 'count_not_confirmed';
type ReadWindow = Pick<SourceRead<never>, 'windowStartMs' | 'windowEndMs'>;
type Obj = Record<string, unknown>;

function object(value: unknown): Obj | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
function numeric(value: unknown): number | undefined {
  if (typeof value !== 'number' && !text(value)) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
function readWindow(windowMins: number, endMs: number): ReadWindow {
  return { windowStartMs: endMs - Math.max(1, Math.floor(windowMins)) * 60_000, windowEndMs: endMs };
}
function validWindow(window: ReadWindow): boolean {
  return Number.isSafeInteger(window.windowStartMs) && Number.isSafeInteger(window.windowEndMs);
}
function readResult<T>(
  sourceId: string, window: ReadWindow, items: T[] = [], reasons: Reason[] = [],
  status?: SourceRead<T>['status'],
): SourceRead<T> {
  const unique = [...new Set(reasons)];
  const boundedReason = (r: Reason) => [
    'cap_reached', 'payload_truncated', 'incomplete_collection', 'empty_not_confirmed', 'count_not_confirmed',
  ].includes(r);
  const outcome = status ?? (unique.length === 0 ? 'ok' :
    items.length > 0 || unique.every(boundedReason) ? 'partial' : 'error');
  // Bounds and completion caveats do not freeze valid nonempty snapshots. Missing or
  // malformed data still forbids replacement; Tempo adds its mixed-child guard below.
  const lostData = unique.some(r => !boundedReason(r));
  const retain = lostData || outcome === 'error' || outcome === 'unavailable'
    || (outcome !== 'ok' && items.length === 0);
  return {
    items, sourceId, ...window, reasons: unique,
    ...(retain ? { canSweep: false as const } : {}),
    status: outcome,
  };
}
function envelopeReasons(value: unknown): Reason[] {
  const r = object(value);
  const reasons: Reason[] = [];
  if (r?.error !== undefined || r?.status === 'error') reasons.push('query_failed');
  if (r?.truncated === true) reasons.push('payload_truncated');
  if (r && 'truncated' in r && typeof r.truncated !== 'boolean') reasons.push('incomplete_collection');
  if (r && Object.prototype.hasOwnProperty.call(r, 'collectionStatus')) {
    if (r.collectionStatus === 'error') reasons.push('query_failed');
    else if (r.collectionStatus === 'partial') reasons.push('incomplete_collection');
    else if (r.collectionStatus === 'unknown') reasons.push('incomplete_collection');
    else if (r.collectionStatus !== 'ok' && r.collectionStatus !== 'empty') reasons.push('malformed_payload');
  }
  if (r?.collectionReason === 'count_not_confirmed' || r?.completionReason === 'search_response_unverified') {
    const generic = reasons.indexOf('incomplete_collection');
    if (r.collectionStatus === 'unknown' && generic !== -1) reasons.splice(generic, 1);
    reasons.push('count_not_confirmed');
  }
  return reasons;
}
function requireEmptyProof(value: unknown, items: unknown[], reasons: Reason[]): void {
  if (items.length || reasons.length) return;
  const outer = object(value), inner = object(outer?.result);
  const status = outer?.collectionStatus ?? inner?.collectionStatus;
  // Legacy delivery success is not evidence that the source query completed.
  if (status !== 'ok' && status !== 'empty') reasons.push('empty_not_confirmed');
}
function inWindow(span: TraceSpan, window: ReadWindow): boolean {
  return span.startMs >= window.windowStartMs && span.startMs <= window.windowEndMs;
}

type ConnConfig = Awaited<ReturnType<typeof resolveConnConfig>>;
interface ResolvedSource { sourceId: string; connConfig?: ConnConfig; reason?: Reason }

/** Resolve identity before credentials, so even a secret lookup failure identifies the actual row. */
async function resolveSource(kind: 'clickhouse' | 'tempo' | 'prometheus' | 'mimir', instanceId?: number): Promise<ResolvedSource> {
  let sourceId = `${kind}:${instanceId ?? 'default'}`;
  try {
    const row = instanceId !== undefined ? await getDatasource(instanceId) : await getDefaultDatasource(kind);
    if (!row || row.kind !== kind) return { sourceId, reason: 'missing_configuration' };
    sourceId = `${kind}:${row.id}`;
    const connConfig = await resolveConnConfig(row);
    return connConfig ? { sourceId, connConfig } : { sourceId, reason: 'missing_configuration' };
  } catch {
    return { sourceId, reason: 'configuration_failed' };
  }
}

/** Seeded spans are already the test's selected window; no wall-clock filtering of fixtures. */
export class FakeTraceSource implements TraceSource {
  constructor(
    private readonly spans: TraceSpan[], private readonly isAvailable: boolean = true,
    private readonly sourceId: string = 'fake:default',
  ) {}
  async available(): Promise<boolean> { return this.isAvailable; }
  async recentSpans(windowMins: number, cap: number, endMs = Date.now()): Promise<SourceRead<TraceSpan>> {
    const window = readWindow(windowMins, endMs);
    if (!validWindow(window) || !Number.isFinite(cap)) return readResult(this.sourceId, window, [], ['invalid_request']);
    if (!this.isAvailable) return readResult(this.sourceId, window, [], ['missing_configuration'], 'unavailable');
    const limit = Math.max(0, Math.floor(cap));
    return readResult(this.sourceId, window,
      this.spans.slice(0, limit).map((s) => ({ ...s, sourceId: this.sourceId })),
      this.spans.length > limit || limit === 0 ? ['cap_reached'] : []);
  }
}

// --- Shared allowlisted OTel metadata ---------------------------------------------------------

function identityClaim(value: unknown): string | undefined {
  const claim = text(value);
  return claim && claim.length <= 512 && !/[\u0000-\u001f\u007f]/.test(claim)
    ? claim.trim() : undefined;
}

function spanMetadata(out: TraceSpan, resource: Obj, span: Obj): void {
  const fields: Partial<Record<keyof TraceSpan, string | undefined>> = {
    accountId: text(resource['cloud.account.id']),
    region: text(resource['cloud.region']),
    environment: text(resource['deployment.environment.name']) ?? text(resource['deployment.environment']),
    serviceNamespace: text(resource['service.namespace']),
    serviceVersion: text(resource['service.version']),
    cloudResourceId: identityClaim(resource['cloud.resource_id']),
    hostId: identityClaim(resource['host.id']),
    serviceInstanceId: identityClaim(resource['service.instance.id']),
    k8sNamespace: text(resource['k8s.namespace.name']), k8sCluster: text(resource['k8s.cluster.name']),
    k8sPod: text(resource['k8s.pod.name']), k8sDeployment: text(resource['k8s.deployment.name']),
    dbSystem: text(span['db.system']), dbName: text(span['db.name']),
    // Never copy db.connection_string (may contain a credential-bearing DSN).
    dbHost: text(span['server.address']) ?? text(span['net.peer.name']),
    peerService: text(span['peer.service']),
    messagingSystem: text(span['messaging.system']),
    messagingDestination: text(span['messaging.destination.name']) ?? text(span['messaging.destination']),
  };
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) Object.assign(out, { [key]: value });
  const address = text(span['server.address']) ?? text(span['net.peer.name']);
  const port = numeric(span['server.port']) ?? numeric(span['net.peer.port']);
  if (out.messagingSystem && address && port !== undefined
    && Number.isInteger(port) && port > 0 && port <= 65535) {
    out.messagingBroker = `${address.trim().toLowerCase()}:${port}`;
  }
}

function spanStatus(value: unknown): TraceSpan['status'] {
  switch (String(value ?? '').toUpperCase().replace(/^STATUS_CODE_/, '')) {
    case '0': case 'UNSET': return 'unset';
    case '1': case 'OK': return 'ok';
    case '2': case 'ERROR': return 'error';
    default: return undefined;
  }
}

const SPAN_KINDS = ['UNSPECIFIED', 'INTERNAL', 'SERVER', 'CLIENT', 'PRODUCER', 'CONSUMER'];
function spanKind(value: unknown): string {
  const normalized = String(value ?? '').toUpperCase().replace(/^SPAN_KIND_/, '');
  if (/^[0-5]$/.test(normalized)) return SPAN_KINDS[Number(normalized)];
  return SPAN_KINDS.includes(normalized) ? normalized : 'UNSPECIFIED';
}

function mapLinks(value: unknown): NonNullable<TraceSpan['links']> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => {
    const r = object(v);
    const traceId = text(r?.traceId) ?? text(r?.TraceId);
    const spanId = text(r?.spanId) ?? text(r?.SpanId);
    return traceId && spanId ? [{ traceId, spanId }] : [];
  });
}

/** Tempo's TraceIDToHexString trims leading zeros, including 64-bit IDs. Mirror
 * HexStringToTraceID's padding for trace hex only; spans and protobuf JSON base64 still need
 * full bytes and canonical encoding. Opaque nonhex legacy IDs remain exact strings. */
function normalizeTempoId(value: unknown, bytes: 8 | 16, allowZero = false): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  let decoded: Buffer | undefined;
  if (/^[0-9a-f]+$/i.test(raw)) {
    if (raw.length > bytes * 2 || (bytes === 8 && raw.length !== 16)) return undefined;
    decoded = Buffer.from(raw.padStart(bytes * 2, '0'), 'hex');
  } else if (raw.length === Math.ceil(bytes / 3) * 4 && /^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    const candidate = Buffer.from(raw, 'base64');
    if (candidate.length === bytes && candidate.toString('base64') === raw) decoded = candidate;
  }
  // All-zero trace/span IDs are invalid, not shared placeholder identities.
  return decoded ? (allowZero || decoded.some(byte => byte !== 0) ? decoded.toString('hex') : undefined) : raw;
}

function otelLinks(row: Obj): unknown[] | undefined {
  if (Array.isArray(row.Links)) return row.Links;
  const nested = object(row.Links);
  const traceIds = row['Links.TraceId'] ?? nested?.TraceId;
  const spanIds = row['Links.SpanId'] ?? nested?.SpanId;
  if (traceIds === undefined && spanIds === undefined) return row.Links === undefined ? undefined : [null];
  if (!Array.isArray(traceIds) || !Array.isArray(spanIds)) return [null];
  return Array.from({ length: Math.max(traceIds.length, spanIds.length) },
    (_, i) => ({ traceId: traceIds[i], spanId: spanIds[i] }));
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === 'number') return numeric(value);
  if (!text(value)) return undefined;
  const n = Date.parse(value as string);
  return Number.isFinite(n) ? n : undefined;
}

/** Pure tolerant mapper; adapters validate required fields before accepting a row. */
export function mapOtelRow(value: unknown): TraceSpan {
  const row = object(value) ?? {};
  const resource = object(row.ResourceAttributes) ?? {};
  const span = object(row.SpanAttributes) ?? {};
  const out: TraceSpan = {
    traceId: text(row.TraceId) ?? '', spanId: text(row.SpanId) ?? '',
    service: text(row.ServiceName) ?? text(resource['service.name']) ?? 'unknown',
    kind: spanKind(row.SpanKind), startMs: timestamp(row.Timestamp) ?? 0,
    durationMs: (numeric(row.Duration) ?? 0) / 1e6,
  };
  if (text(row.ParentSpanId)) out.parentSpanId = row.ParentSpanId as string;
  if (text(row.SpanName)) out.name = row.SpanName as string;
  const status = spanStatus(row.StatusCode);
  if (status) out.status = status;
  const links = otelLinks(row);
  if (links) out.links = mapLinks(links);
  spanMetadata(out, resource, span);
  return out;
}

// --- ClickHouse ---------------------------------------------------------------------------

// Standard exporter schema; the registry selects optional columns only when introspected.
const DEFAULT_OTEL_SQL_TEMPLATE =
  'SELECT TraceId, SpanId, ParentSpanId, ServiceName, SpanKind, SpanName, StatusCode, ' +
  '`Links.TraceId`, `Links.SpanId`, Timestamp, Duration, ResourceAttributes, SpanAttributes FROM otel_traces ' +
  'WHERE Timestamp >= now() - INTERVAL {window} MINUTE AND Timestamp <= now() ORDER BY Timestamp DESC LIMIT {cap}';
const CLICKHOUSE_ROW_CAP = 1000; // clickhouse_mcp.MAX_ROWS_CAP

function clickhouseRows(result: unknown): { rows?: unknown[]; reasons: Reason[] } {
  if (Array.isArray(result)) return { rows: result, reasons: [] };
  const r = object(result);
  const inner = object(r?.result);
  const reasons = [...envelopeReasons(r), ...envelopeReasons(inner)];
  if (reasons.includes('query_failed')) return { reasons };
  // A present but malformed primary field must not be rescued by an unrelated empty fallback.
  const rows = r && 'rows' in r ? r.rows : r && 'data' in r ? r.data : inner?.rows;
  if (Array.isArray(rows)) return { rows, reasons };
  return { reasons: [...reasons, 'malformed_payload'] };
}

export class ClickHouseOtelTraceSource implements TraceSource {
  constructor(private readonly instanceId?: number, private readonly sqlTemplate?: string) {}
  async available(): Promise<boolean> { return !(await resolveSource('clickhouse', this.instanceId)).reason; }

  async recentSpans(windowMins: number, cap: number, endMs = Date.now()): Promise<SourceRead<TraceSpan>> {
    const window = readWindow(windowMins, endMs);
    const { sourceId, connConfig, reason } = await resolveSource('clickhouse', this.instanceId);
    if (reason) return readResult(sourceId, window, [], [reason], reason === 'missing_configuration' ? 'unavailable' : 'error');
    if (!validWindow(window) || !Number.isFinite(cap)) return readResult(sourceId, window, [], ['invalid_request']);
    const limit = Math.min(CLICKHOUSE_ROW_CAP, Math.max(0, Math.floor(cap)));
    if (!limit) return readResult(sourceId, window, [], ['cap_reached']);
    // Keep {window}/{cap} registry compatibility, including older cached templates. Freeze their
    // now() anchor to the caller's end, and filter mapped spans locally as a second bound.
    const sql = (this.sqlTemplate ?? DEFAULT_OTEL_SQL_TEMPLATE)
      .replaceAll('{window}', String(Math.max(1, Math.floor(windowMins))))
      .replaceAll('{cap}', String(limit))
      .replace(/\bnow\(\)/gi, `fromUnixTimestamp64Milli(${endMs})`);
    let payload: unknown;
    try {
      payload = await invokeMcpLambdaTool({
        kind: 'clickhouse', tool: 'clickhouse_query', args: { sql, max_rows: limit }, connConfig,
      });
    } catch {
      return readResult(sourceId, window, [], ['query_failed']);
    }
    const { rows, reasons } = clickhouseRows(payload);
    if (!rows) return readResult(sourceId, window, [], reasons);
    // A saturated SQL/connector limit cannot prove completeness, even without a truncated marker.
    if (rows.length >= limit) reasons.push('cap_reached');
    const items: TraceSpan[] = [];
    for (const value of rows.slice(0, limit)) {
      const row = object(value);
      if (!row || !text(row.TraceId) || !text(row.SpanId) || timestamp(row.Timestamp) === undefined ||
          numeric(row.Duration) === undefined || Number(row.Duration) < 0) {
        reasons.push('malformed_rows');
        continue;
      }
      const item = mapOtelRow(row);
      const links = otelLinks(row);
      if ((row.ResourceAttributes !== undefined && !object(row.ResourceAttributes)) ||
          (row.SpanAttributes !== undefined && !object(row.SpanAttributes)) ||
          (row.StatusCode !== undefined && !item.status) ||
          (links && item.links?.length !== links.length)) reasons.push('malformed_rows');
      if (inWindow(item, window)) items.push({ ...item, sourceId });
    }
    requireEmptyProof(payload, items, reasons);
    return readResult(sourceId, window, items, reasons);
  }
}

// --- ClickHouse aggregate (edges counted in ClickHouse over the whole window) ----------------

/** Which optional columns the catalog found; the aggregate reads the same table it introspected. */
export interface OtelAggregateShape { table: string; spanKind: boolean; statusCode: boolean; links: boolean }

const DEFAULT_OTEL_SHAPE: OtelAggregateShape = { table: 'otel_traces', spanKind: true, statusCode: true, links: true };
const IDENT = '(?:`(?:[^`]|``)+`|[A-Za-z_][A-Za-z0-9_]*)';
// Only graph_catalog.py's deterministic otel_v1 template qualifies; generated or custom SQL keeps
// the span reader, because its columns are not known to follow the exporter schema.
const CATALOG_OTEL_TEMPLATE = new RegExp(
  `^SELECT (TraceId, SpanId, ParentSpanId, ServiceName[^;]*?) FROM (${IDENT}(?:\\.${IDENT})?) ` +
  'WHERE Timestamp >= now\\(\\) - INTERVAL \\{window\\} MINUTE AND Timestamp <= now\\(\\) ' +
  'ORDER BY Timestamp DESC LIMIT \\{cap\\}$');

// Exactly the bare exporter columns graph_catalog.py can select. Generated templates share the
// otel_v1 mapper but alias other columns (`attrs AS ResourceAttributes`); those are not proof of
// exporter Map columns, so any alias, expression or unknown column keeps the span reader.
const EXPORTER_COLUMNS = new Set([
  'TraceId', 'SpanId', 'ParentSpanId', 'ServiceName', 'SpanKind', 'SpanName', 'StatusCode',
  '`Links.TraceId`', '`Links.SpanId`', 'Timestamp', 'Duration', 'ResourceAttributes', 'SpanAttributes',
]);
const REQUIRED_EXPORTER_COLUMNS = ['TraceId', 'SpanId', 'ParentSpanId', 'ServiceName', 'Timestamp',
  'Duration', 'ResourceAttributes', 'SpanAttributes'];

/** The aggregate shape for a registry template, or undefined when it is not the catalog's. */
export function otelAggregateShape(sqlTemplate?: string): OtelAggregateShape | undefined {
  if (sqlTemplate === undefined) return DEFAULT_OTEL_SHAPE;
  const match = CATALOG_OTEL_TEMPLATE.exec(sqlTemplate);
  if (!match) return undefined;
  const columns = match[1].split(',').map((c) => c.trim());
  if (new Set(columns).size !== columns.length || columns.some((c) => !EXPORTER_COLUMNS.has(c))
      || REQUIRED_EXPORTER_COLUMNS.some((c) => !columns.includes(c))) return undefined;
  return {
    table: match[2], spanKind: columns.includes('SpanKind'), statusCode: columns.includes('StatusCode'),
    links: columns.includes('`Links.TraceId`') && columns.includes('`Links.SpanId`'),
  };
}

const list = (keys: readonly string[]) => `[${keys.map((k) => `'${k}'`).join(', ')}]`;
// Only the attributes spanMetadata reads are grouped. Pod names and per-host/per-process claims
// would multiply rows, so pods are collected as a bounded array and the three EC2 claim keys are
// reduced to what claimedInstance (trace-graph.ts) can act on: bare EC2 IDs bind and ARNs bind or
// veto, both kept verbatim. Other host.id/service.instance.id values are ignored by that check and
// dropped. Any other cloud.resource_id value vetoes binding, so it becomes one fixed 'unbindable'
// value: the veto survives while host UUIDs stop splitting groups.
const AGG_RESOURCE_KEYS = [
  'service.name', 'cloud.account.id', 'cloud.region', 'deployment.environment.name',
  'deployment.environment', 'service.namespace', 'service.version', 'cloud.resource_id', 'host.id',
  'service.instance.id', 'k8s.namespace.name', 'k8s.cluster.name', 'k8s.deployment.name',
] as const;
const AGG_SPAN_KEYS = [
  'db.system', 'db.name', 'server.address', 'net.peer.name', 'server.port', 'net.peer.port',
  'peer.service', 'messaging.system', 'messaging.destination.name', 'messaging.destination',
] as const;
// Node scope only (trace-graph.ts scope()); edge endpoints must land on the same service nodes.
const AGG_IDENTITY_KEYS = [
  'service.name', 'cloud.account.id', 'cloud.region', 'deployment.environment.name',
  'deployment.environment', 'service.namespace', 'k8s.namespace.name', 'k8s.cluster.name',
] as const;
const AGG_POD_CAP = 20;
const EC2_CLAIM = "match(v, '^i-[0-9a-f]{8}([0-9a-f]{9})?$') OR startsWith(v, 'arn:')";

function aggregateSql(shape: OtelAggregateShape, windowMins: number, endMs: number, limit: number) {
  const window = `Timestamp >= fromUnixTimestamp64Milli(${endMs}) - INTERVAL ${windowMins} MINUTE ` +
    `AND Timestamp <= fromUnixTimestamp64Milli(${endMs})`;
  const kind = shape.spanKind ? 'SpanKind' : "'' AS SpanKind";
  const status = shape.statusCode ? 'StatusCode' : "'' AS StatusCode";
  // Non-db/messaging spans drop their peer attributes so HTTP peers do not multiply groups.
  const groups = 'SELECT ServiceName, SpanKind, StatusCode, RA AS ResourceAttributes, SA AS SpanAttributes, ' +
    'count() AS Weight, intDiv(sum(Duration), 1000000) AS DurationMsSum, toUnixTimestamp64Milli(max(Timestamp)) AS LastTimestamp, ' +
    'toUnixTimestamp64Milli(min(Timestamp)) AS FirstTimestamp, any(TraceId) AS SampleTraceId, ' +
    `any(SpanId) AS SampleSpanId, groupUniqArray(${AGG_POD_CAP})(Pod) AS Pods FROM (` +
    `SELECT ServiceName, ${kind}, ${status}, Duration, Timestamp, TraceId, SpanId, ` +
    "ResourceAttributes['k8s.pod.name'] AS Pod, " +
    `mapSort(mapApply((k, v) -> (k, if(k = 'cloud.resource_id' AND NOT (${EC2_CLAIM}), 'unbindable', v)), ` +
    `mapFilter((k, v) -> has(${list(AGG_RESOURCE_KEYS)}, k) AND (k NOT IN ('host.id', 'service.instance.id') ` +
    `OR ${EC2_CLAIM}), ResourceAttributes))) AS RA, ` +
    "if(SpanAttributes['db.system'] != '' OR SpanAttributes['messaging.system'] != '', " +
    `mapSort(mapFilter((k, v) -> has(${list(AGG_SPAN_KEYS)}, k), SpanAttributes)), ` +
    'mapFilter((k, v) -> false, SpanAttributes)) AS SA ' +
    `FROM ${shape.table} WHERE ${window}) ` +
    `GROUP BY ServiceName, SpanKind, StatusCode, RA, SA ORDER BY Weight DESC LIMIT ${limit}`;
  // Both join sides carry only the sorted identity map, so the hash build holds one small row per
  // span rather than every span's raw attribute map, and equal identities compare equal.
  const identity = `mapSort(mapFilter((k, v) -> has(${list(AGG_IDENTITY_KEYS)}, k), ResourceAttributes)) AS R`;
  const pairs = (child: string, on: string) =>
    'SELECT p.ServiceName AS ClientService, p.R AS ClientResource, c.ServiceName AS ServerService, ' +
    `c.R AS ServerResource, count() AS Weight FROM (${child}) AS c INNER JOIN (SELECT TraceId, SpanId, ` +
    `ServiceName, ${identity} FROM ${shape.table} WHERE ${window}) AS p ON ${on} ` +
    'GROUP BY ClientService, ClientResource, ServerService, ServerResource ' +
    'HAVING NOT (ClientService = ServerService AND ClientResource = ServerResource) ' +
    `ORDER BY Weight DESC LIMIT ${limit}`;
  const calls = pairs(
    `SELECT TraceId, ParentSpanId, ServiceName, ${identity} FROM ${shape.table} ` +
    `WHERE ${window} AND ParentSpanId != ''`,
    'c.TraceId = p.TraceId AND c.ParentSpanId = p.SpanId');
  // ARRAY JOIN raises on unequal nested-array lengths; such rows are filtered before it.
  const links = shape.links ? pairs(
    `SELECT LinkTraceId, LinkSpanId, ServiceName, R FROM (SELECT \`Links.TraceId\` AS LT, ` +
    `\`Links.SpanId\` AS LS, ServiceName, ${identity} FROM ${shape.table} WHERE ${window} ` +
    'AND length(`Links.TraceId`) = length(`Links.SpanId`)) ARRAY JOIN LT AS LinkTraceId, LS AS LinkSpanId',
    'c.LinkTraceId = p.TraceId AND c.LinkSpanId = p.SpanId') : undefined;
  return { groups, calls, links };
}

function positiveCount(value: unknown): number | undefined {
  const n = numeric(value);
  return n !== undefined && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

function resourceIdentity(value: unknown, sourceId: string): TraceIdentity | undefined {
  const resource = object(value);
  if (!resource) return undefined;
  const span = mapOtelRow({ ResourceAttributes: resource });
  const out: TraceIdentity = { sourceId };
  for (const key of ['accountId', 'region', 'environment', 'serviceNamespace', 'k8sNamespace', 'k8sCluster'] as const) {
    if (span[key] !== undefined) out[key] = span[key];
  }
  return out;
}

/** Reads service nodes and span-pair edges as ClickHouse aggregates over the whole window, instead
 *  of the newest raw spans. Counts are complete for the window unless a row limit is reached. */
export class ClickHouseOtelAggregateSource implements TraceSource {
  constructor(private readonly instanceId?: number, private readonly shape: OtelAggregateShape = DEFAULT_OTEL_SHAPE) {}
  async available(): Promise<boolean> { return !(await resolveSource('clickhouse', this.instanceId)).reason; }

  async recentSpans(windowMins: number, cap: number, endMs = Date.now()): Promise<TraceRead> {
    const window = readWindow(windowMins, endMs);
    const { sourceId, connConfig, reason } = await resolveSource('clickhouse', this.instanceId);
    if (reason) return readResult(sourceId, window, [], [reason], reason === 'missing_configuration' ? 'unavailable' : 'error');
    if (!validWindow(window) || !Number.isFinite(cap)) return readResult(sourceId, window, [], ['invalid_request']);
    const limit = Math.min(CLICKHOUSE_ROW_CAP, Math.max(0, Math.floor(cap)));
    if (!limit) return readResult(sourceId, window, [], ['cap_reached']);
    const sql = aggregateSql(this.shape, Math.max(1, Math.floor(windowMins)), endMs, limit);
    const query = (text: string) => invokeMcpLambdaTool({
      kind: 'clickhouse', tool: 'clickhouse_query', args: { sql: text, max_rows: limit }, connConfig,
    });
    let payloads: unknown[];
    try {
      payloads = await Promise.all([sql.groups, sql.calls, ...(sql.links ? [sql.links] : [])].map(query));
    } catch {
      return readResult(sourceId, window, [], ['query_failed']);
    }
    const reasons: Reason[] = [];
    const results = payloads.map(clickhouseRows);
    // Any failed aggregate leaves the window unproven; never publish nodes without their edges.
    for (const result of results) {
      if (!result.rows) return readResult(sourceId, window, [], result.reasons);
      reasons.push(...result.reasons);
      if (result.rows.length >= limit) reasons.push('cap_reached');
    }
    // Defensive clamp, as in the span reader: a connector ignoring max_rows stays bounded.
    const [groupRows, callRows, linkRows = []] = results.map((r) => r.rows!.slice(0, limit));
    const items: TraceSpan[] = [];
    for (const value of groupRows) {
      const row = object(value);
      const weight = positiveCount(row?.Weight);
      const last = numeric(row?.LastTimestamp), first = numeric(row?.FirstTimestamp);
      const duration = numeric(row?.DurationMsSum);
      if (!row || !text(row.ServiceName) || !text(row.SampleTraceId) || !text(row.SampleSpanId)
          || weight === undefined || last === undefined || first === undefined || first > last
          || duration === undefined || !Number.isSafeInteger(duration) || duration < 0
          || (row.ResourceAttributes !== undefined && !object(row.ResourceAttributes))
          || (row.SpanAttributes !== undefined && !object(row.SpanAttributes))) {
        reasons.push('malformed_rows');
        continue;
      }
      const item = mapOtelRow({
        TraceId: row.SampleTraceId, SpanId: row.SampleSpanId, ServiceName: row.ServiceName,
        SpanKind: row.SpanKind, StatusCode: row.StatusCode, Timestamp: last, Duration: 0,
        ResourceAttributes: row.ResourceAttributes, SpanAttributes: row.SpanAttributes,
      });
      if (this.shape.statusCode && text(row.StatusCode) && !item.status) reasons.push('malformed_rows');
      const pods = Array.isArray(row.Pods)
        ? [...new Set(row.Pods.filter((p): p is string => !!text(p)))].slice(0, AGG_POD_CAP) : [];
      if (!inWindow(item, window)) { reasons.push('incomplete_collection'); continue; }
      items.push({ ...item, sourceId, weight, durationMs: duration, firstStartMs: first,
        ...(pods.length ? { k8sPods: pods } : {}) });
    }
    const calls: ServiceGraphCall[] = [];
    for (const [rows, rel] of [[callRows, 'calls'], [linkRows, 'linked']] as const) {
      for (const value of rows) {
        const row = object(value);
        const count = positiveCount(row?.Weight);
        const client = text(row?.ClientService), server = text(row?.ServerService);
        const clientIdentity = resourceIdentity(row?.ClientResource, sourceId);
        const serverIdentity = resourceIdentity(row?.ServerResource, sourceId);
        if (!client || !server || count === undefined || !clientIdentity || !serverIdentity) {
          reasons.push('malformed_rows');
          continue;
        }
        calls.push({ client, server, count, clientIdentity, serverIdentity, evidence: 'trace', rel });
      }
    }
    // Each aggregate needs its own empty proof: confirmed nodes with an unproven-empty pair query
    // would otherwise publish as a complete graph without its edges.
    for (const [i, payload] of payloads.entries()) {
      if (results[i].rows!.length) continue;
      const outer = object(payload), status = outer?.collectionStatus ?? object(outer?.result)?.collectionStatus;
      if (status !== 'ok' && status !== 'empty' && !reasons.includes('empty_not_confirmed')) reasons.push('empty_not_confirmed');
    }
    return { ...readResult(sourceId, window, items, reasons), calls };
  }
}

// --- Tempo (search -> bounded per-trace fetch) -----------------------------------------------

const TEMPO_TRACE_CAP = 20; // graph_catalog.py tempo_v1; <=21 invokes per source

// This marker describes omitted data, not verified child identity or replacement permission.
function byteBoundedTempoTrace(value: unknown): boolean {
  const r = object(value);
  return r?.tracePayloadTruncated === true && r.truncated === true
    && r.collectionStatus === 'partial' && r.error === undefined && r.status !== 'error';
}

function otlpAttrs(value: unknown, reasons: Reason[]): Obj {
  if (value === undefined) return {};
  if (!Array.isArray(value)) { reasons.push('malformed_rows'); return {}; }
  const out: Obj = {};
  for (const entry of value) {
    const a = object(entry);
    const v = object(a?.value);
    const key = text(a?.key);
    if (!key || !v) { reasons.push('malformed_rows'); continue; }
    const scalar = v.stringValue ?? v.intValue ?? v.boolValue ?? v.doubleValue;
    if (['string', 'number', 'boolean'].includes(typeof scalar)) out[key] = String(scalar);
    // Arrays/key-value lists are valid OTLP but not relevant to the normalized string allowlist.
  }
  return out;
}

function parseTempoTrace(traceId: string, value: unknown): { items: TraceSpan[]; reasons: Reason[] } {
  const r = object(value);
  const reasons = envelopeReasons(r);
  const items: TraceSpan[] = [];
  if (reasons.includes('query_failed')) return { items, reasons };
  const normalizedTraceId = normalizeTempoId(traceId, 16);
  if (!normalizedTraceId) return { items, reasons: [...reasons, 'malformed_rows'] };
  if (byteBoundedTempoTrace(r)) return { items, reasons };
  const batches = r?.batches ?? r?.resourceSpans;
  // The producer can omit an entire unverified projection. Keep that uncertainty
  // distinct from a query failure; an empty child still vetoes replacement below.
  if (!Array.isArray(batches)) return { items,
    reasons: r?.tracePayloadUnverified === true && r.truncated === true && r.collectionStatus === 'unknown'
      ? reasons : [...reasons, 'malformed_payload'] };
  for (const batch of batches) {
    const b = object(batch);
    if (b?.resource !== undefined && !object(b.resource)) reasons.push('malformed_rows');
    const resource = otlpAttrs(object(b?.resource)?.attributes, reasons);
    const scopes = b?.scopeSpans ?? b?.instrumentationLibrarySpans;
    if (!Array.isArray(scopes)) { reasons.push('malformed_rows'); continue; }
    for (const scope of scopes) {
      const spans = object(scope)?.spans;
      if (!Array.isArray(spans)) { reasons.push('malformed_rows'); continue; }
      for (const value of spans) {
        const s = object(value);
        const spanId = normalizeTempoId(s?.spanId, 8);
        const start = numeric(s?.startTimeUnixNano);
        const end = numeric(s?.endTimeUnixNano);
        if (!s || !spanId || start === undefined || end === undefined || start < 0 || end < start
            || (s.traceId !== undefined && normalizeTempoId(s.traceId, 16) !== normalizedTraceId)) {
          reasons.push('malformed_rows');
          continue;
        }
        const attrs = otlpAttrs(s.attributes, reasons);
        const item: TraceSpan = {
          traceId: normalizedTraceId, spanId,
          service: text(resource['service.name']) ?? 'unknown',
          kind: spanKind(s.kind),
          startMs: start / 1e6, durationMs: (end - start) / 1e6,
        };
        if (s.parentSpanId !== undefined && s.parentSpanId !== '') {
          const parent = normalizeTempoId(s.parentSpanId, 8, true);
          if (!parent) reasons.push('malformed_rows');
          else if (parent !== '0000000000000000') item.parentSpanId = parent;
        }
        if (text(s.name)) item.name = s.name as string;
        if (s.status !== undefined) {
          const statusObject = object(s.status);
          const status = statusObject ? spanStatus(statusObject.code ?? 0) : undefined;
          if (status) item.status = status;
          else reasons.push('malformed_rows');
        }
        if (s.links !== undefined) {
          item.links = mapLinks(s.links).flatMap(link => {
            const traceId = normalizeTempoId(link.traceId, 16);
            const spanId = normalizeTempoId(link.spanId, 8);
            return traceId && spanId ? [{ traceId, spanId }] : [];
          });
          if (!Array.isArray(s.links) || s.links.length !== item.links.length) reasons.push('malformed_rows');
        }
        spanMetadata(item, resource, attrs);
        items.push(item);
      }
    }
  }
  return { items, reasons };
}

/** Pure, non-throwing OTLP mapper, supporting Tempo batches and OTLP resourceSpans. */
export function mapTempoTrace(traceId: string, result: unknown): TraceSpan[] {
  return parseTempoTrace(traceId, result).items;
}

export class TempoTraceSource implements TraceSource {
  constructor(private readonly instanceId: number) {}
  async available(): Promise<boolean> { return !(await resolveSource('tempo', this.instanceId)).reason; }

  async recentSpans(windowMins: number, cap: number, endMs = Date.now()): Promise<SourceRead<TraceSpan>> {
    const window = readWindow(windowMins, endMs);
    const { sourceId, connConfig, reason } = await resolveSource('tempo', this.instanceId);
    if (reason) return readResult(sourceId, window, [], [reason], reason === 'missing_configuration' ? 'unavailable' : 'error');
    if (!validWindow(window) || !Number.isFinite(cap)) return readResult(sourceId, window, [], ['invalid_request']);
    const limit = Math.max(0, Math.floor(cap));
    if (!limit) return readResult(sourceId, window, [], ['cap_reached']);
    let search: unknown;
    try {
      search = await invokeMcpLambdaTool({
        kind: 'tempo', tool: 'tempo_search',
        args: { query: '{}', limit: TEMPO_TRACE_CAP,
          start: Math.floor(window.windowStartMs / 1000), end: Math.floor(window.windowEndMs / 1000) },
        connConfig,
      });
    } catch {
      return readResult(sourceId, window, [], ['query_failed']);
    }
    const reasons = envelopeReasons(search);
    if (reasons.includes('query_failed')) return readResult(sourceId, window, [], reasons);
    const traces = object(search)?.traces;
    if (!Array.isArray(traces)) return readResult(sourceId, window, [], [...reasons, 'malformed_payload']);
    if (traces.length >= TEMPO_TRACE_CAP) reasons.push('cap_reached');
    const traceIds = [...new Set(traces.flatMap((t) => {
      const id = normalizeTempoId(object(t)?.traceID, 16);
      if (!id) reasons.push('malformed_rows');
      return id ? [id] : [];
    }))].slice(0, TEMPO_TRACE_CAP);
    const items: TraceSpan[] = [];
    let missingChild = false;
    for (const traceId of traceIds) {
      if (items.length >= limit) { reasons.push('cap_reached'); break; }
      try {
        const payload = await invokeMcpLambdaTool({
          kind: 'tempo', tool: 'tempo_get_trace', args: { trace_id: traceId }, connConfig,
        });
        const parsed = parseTempoTrace(traceId, payload);
        reasons.push(...parsed.reasons);
        if (!parsed.items.length) {
          missingChild = true;
          if (!parsed.reasons.length) reasons.push('incomplete_collection');
        }
        const selected = parsed.items.filter((s) => inWindow(s, window));
        if (selected.length > limit - items.length) reasons.push('cap_reached');
        items.push(...selected.slice(0, limit - items.length).map((s) => ({ ...s, sourceId })));
      } catch {
        missingChild = true;
        reasons.push('trace_fetch_failed');
      }
    }
    requireEmptyProof(search, items, reasons);
    return { ...readResult(sourceId, window, items, reasons),
      ...(missingChild ? { canSweep: false as const } : {}) };
  }
}

// --- Prometheus/Mimir: aggregate calls, never synthetic spans --------------------------------

// Keep the finite aliases in sync with graph_catalog.py. Every recognized label must survive its
// sum by grouping; dropping an environment/namespace/cluster/account merges unrelated services.
const METRIC_IDENTITY_LABELS = {
  accountId: ['cloud_account_id', 'account_id'],
  region: ['cloud_region', 'region'],
  environment: ['deployment_environment_name', 'deployment_environment', 'environment'],
  serviceNamespace: ['service_namespace'],
  k8sNamespace: ['k8s_namespace_name', 'k8s_namespace', 'workload_namespace', 'namespace'],
  k8sCluster: ['k8s_cluster_name', 'k8s_cluster', 'cluster'],
} as const;

function metricIdentity(metric: Obj, side: 'client' | 'server'): TraceIdentity | undefined {
  const prefixes = side === 'client' ? ['client', 'source'] : ['server', 'destination'];
  const out: TraceIdentity = {};
  for (const [field, aliases] of Object.entries(METRIC_IDENTITY_LABELS)) {
    const keys = [...prefixes.flatMap((prefix) => aliases.map((alias) => `${prefix}_${alias}`)), ...aliases];
    const value = keys.map((key) => text(metric[key])).find((v) => v !== undefined);
    if (value !== undefined) Object.assign(out, { [field]: value });
  }
  return Object.keys(out).length ? out : undefined;
}

function parseServiceGraphCalls(value: unknown): { items: ServiceGraphCall[]; reasons: Reason[] } {
  const r = object(value);
  const reasons = envelopeReasons(r);
  const items: ServiceGraphCall[] = [];
  if (reasons.includes('query_failed')) return { items, reasons };
  if (!Array.isArray(r?.result) || (r.resultType !== undefined && r.resultType !== 'vector')) {
    return { items, reasons: [...reasons, 'malformed_payload'] };
  }
  for (const row of r.result) {
    const sample = object(row);
    const metric = object(sample?.metric);
    const client = text(metric?.client) ?? text(metric?.source_workload);
    const server = text(metric?.server) ?? text(metric?.destination_workload);
    const pair = sample?.value;
    const count = Array.isArray(pair) && pair.length === 2 && numeric(pair[0]) !== undefined ?
      numeric(pair[1]) : undefined;
    if (!metric || !client || !server || count === undefined || count < 0) {
      reasons.push('malformed_rows');
      continue;
    }
    if (count === 0) continue; // valid zero traffic; no edge, no data-quality failure
    const item: ServiceGraphCall = { client, server, count };
    const connectionType = text(metric.connection_type);
    if (connectionType) item.connectionType = connectionType;
    const clientIdentity = metricIdentity(metric, 'client');
    const serverIdentity = metricIdentity(metric, 'server');
    if (clientIdentity) item.clientIdentity = clientIdentity;
    if (serverIdentity) item.serverIdentity = serverIdentity;
    items.push(item);
  }
  return { items, reasons };
}

export function extractServiceGraphCalls(result: unknown): ServiceGraphCall[] {
  return parseServiceGraphCalls(result).items;
}

export class MetricsCallsSource {
  constructor(
    private readonly instanceId: number, private readonly kind: 'prometheus' | 'mimir',
    private readonly promqlTemplate: string,
  ) {}
  async available(): Promise<boolean> { return !(await resolveSource(this.kind, this.instanceId)).reason; }

  async calls(windowMins: number, endMs = Date.now()): Promise<SourceRead<ServiceGraphCall>> {
    const window = readWindow(windowMins, endMs);
    const { sourceId, connConfig, reason } = await resolveSource(this.kind, this.instanceId);
    if (reason) return readResult(sourceId, window, [], [reason], reason === 'missing_configuration' ? 'unavailable' : 'error');
    if (!validWindow(window)) return readResult(sourceId, window, [], ['invalid_request']);
    const query = this.promqlTemplate.replaceAll('{window}', String(Math.max(1, Math.floor(windowMins))));
    let payload: unknown;
    try {
      payload = await invokeMcpLambdaTool({
        kind: this.kind, tool: `${this.kind}_query`, args: { query, time: endMs / 1000 }, connConfig,
      });
    } catch {
      return readResult(sourceId, window, [], ['query_failed']);
    }
    const { items, reasons } = parseServiceGraphCalls(payload);
    requireEmptyProof(payload, items, reasons);
    return readResult(sourceId, window, items.map((item) => ({
      ...item, clientIdentity: { ...item.clientIdentity, sourceId }, serverIdentity: { ...item.serverIdentity, sourceId },
    })), reasons);
  }
}
