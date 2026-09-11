// web/lib/datasource-schema.ts
// Durable cache of introspected datasource schemas (Aurora `datasource_schemas`). The hub "Refresh
// schema" route writes here (via the connector Lambda's <kind>_schema tool); the chat route reads here
// to inject a compact schema block into the agent payload (the agent reads the cache, not the live
// datasource). Keyed PER INSTANCE by (account_id, integration_id) so two instances of one kind don't
// share a cache row (the PK was swapped from (account_id, slug) by the datasource-instances migration).
import { getPool } from '@/lib/db';

export const MAX_SCHEMA_BYTES = 256_000; // bound a single cached schema (Aurora row + later prompt injection)

export interface CachedSchema {
  integrationId: number;
  kind: string | null;
  schema: unknown;
  version: string | null; // captured server version (e.g. "2.48.0") for version-aware query generation
  fetched_at: string;
}

/** Pull the best-effort server version out of the introspected schema JSON (connectors store it under
 *  `schema.version`; null when the connector couldn't fetch buildinfo). */
function schemaVersion(schema: unknown): string | null {
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    const v = (schema as Record<string, unknown>).version;
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

function mapRow(r: Record<string, unknown>): CachedSchema {
  return {
    // BIGINT integration_id comes back from node-pg as a STRING — coerce so it matches the numeric
    // datasource id (chat injection keys schemas by integrationId and looks them up by datasource id).
    integrationId: Number(r.integration_id),
    kind: (r.kind as string) ?? null,
    schema: r.schema,
    version: schemaVersion(r.schema),
    fetched_at: r.fetched_at as string,
  };
}

/** Cache write shared by EVERY writer (generate-route warm, connect-time warm, admin manual refresh;
 *  the python worker mirrors it in scripts/v2/workers/db.py). An over-limit schema is trimmed to a
 *  bounded copy (`trimSchemaForCache`, marked `truncated`) instead of leaving NO row — the throw
 *  remains only for shapes that cannot be trimmed. */
export async function upsertSchema(accountId: string, integrationId: number, kind: string | null, schema: unknown): Promise<void> {
  let json = JSON.stringify(schema ?? {});
  if (Buffer.byteLength(json, 'utf8') > MAX_SCHEMA_BYTES) {
    json = JSON.stringify(trimSchemaForCache(schema) ?? {});
    if (Buffer.byteLength(json, 'utf8') > MAX_SCHEMA_BYTES) throw new Error('introspected schema exceeds size limit');
  }
  await getPool().query(
    `INSERT INTO datasource_schemas (account_id, integration_id, kind, schema, fetched_at)
     VALUES ($1, $2, $3, $4::jsonb, now())
     ON CONFLICT (account_id, integration_id)
     DO UPDATE SET kind = EXCLUDED.kind, schema = EXCLUDED.schema, fetched_at = now()`,
    [accountId, integrationId, kind, json],
  );
}

export async function getSchema(accountId: string, integrationId: number): Promise<CachedSchema | null> {
  const { rows } = await getPool().query(
    'SELECT integration_id, kind, schema, fetched_at FROM datasource_schemas WHERE account_id = $1 AND integration_id = $2',
    [accountId, integrationId],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

export async function listConfiguredSchemas(accountId: string): Promise<CachedSchema[]> {
  const { rows } = await getPool().query(
    'SELECT integration_id, kind, schema, fetched_at FROM datasource_schemas WHERE account_id = $1 ORDER BY integration_id',
    [accountId],
  );
  return rows.map(mapRow);
}

// --- Staleness / lazy refresh ----------------------------------------------
// On a cache HIT older than this TTL, the read path refreshes the schema in the BACKGROUND (serves the
// cached copy now; the next lookup is fresh). The daily refresh worker is the floor for unused datasources.
export const SCHEMA_TTL_MS = Number(process.env.DATASOURCE_SCHEMA_TTL_MS) || 6 * 60 * 60 * 1000; // 6h

/** True if a cached schema is missing/unparseable or older than the TTL → should be refreshed. */
export function isSchemaStale(fetchedAt: string | null | undefined, now: number = Date.now(), ttlMs: number = SCHEMA_TTL_MS): boolean {
  if (!fetchedAt) return true;
  const t = Date.parse(fetchedAt);
  return Number.isNaN(t) || now - t > ttlMs;
}

// --- Query-relevance prioritization ----------------------------------------
/**
 * Reorder a schema's metric / label / tag name lists so entries RELEVANT to the natural-language query
 * come FIRST — so they survive `renderSchemaForPrompt`'s per-key cap. Prometheus/Mimir return hundreds
 * of metrics in alphabetical order; without this the cap keeps only the first ~80 (`a…`/`ALERTS`/…) and
 * drops the metrics the user actually asked about (a "pod resource" query needs `kube_pod_*`, not
 * `aggregator_*`). Score = number of distinct NL tokens that appear as a substring of the name; the sort
 * is stable, so equal-scored names keep their original (alphabetical) order, and a query that matches
 * nothing leaves the order unchanged (same as before). Non-array / non-metric schemas pass through.
 */
// Korean ops vocabulary → the English substrings metric names actually carry. Without this a
// Korean NL request ("메모리 사용률이 높은 인스턴스") tokenizes to ZERO terms, the alphabetical
// head of the metric list fills the prompt, and the model answers from world knowledge (a
// kube-prometheus recording rule the target never had — the reported '메모리 사용률' bug).
// Curated, small, and additive: unknown Korean words simply contribute nothing.
export const KO_METRIC_TERMS: Readonly<Record<string, readonly string[]>> = {
  메모리: ['memory', 'mem'], 씨피유: ['cpu'], 디스크: ['disk', 'filesystem', 'fs'],
  네트워크: ['network', 'net'], 트래픽: ['network', 'bytes', 'receive', 'transmit'],
  사용률: ['usage', 'utilization', 'used'], 사용량: ['usage', 'used', 'bytes'],
  인스턴스: ['instance', 'node'], 노드: ['node'], 파드: ['pod', 'container'], 포드: ['pod'],
  컨테이너: ['container'], 서비스: ['service'], 네임스페이스: ['namespace'],
  에러: ['error', 'errors', 'failed'], 오류: ['error', 'errors', 'failed'], 실패: ['failed', 'failure', 'errors'],
  요청: ['request', 'requests'], 응답시간: ['duration', 'latency', 'seconds'], 지연: ['latency', 'duration'],
  재시작: ['restart', 'restarts'], 다운: ['up'], 타깃: ['up', 'scrape'], 타겟: ['up', 'scrape'],
  로그: ['log', 'logs'], 큐: ['queue'], 연결: ['connection', 'connections'], 스로틀: ['throttl'],
  디플로이먼트: ['deployment'], 볼륨: ['volume', 'filesystem'], 스토리지: ['storage', 'filesystem'],
  가용: ['available', 'avail'], 여유: ['free', 'available'], 부하: ['load'], 평균: ['avg', 'average'],
};

/** NL → lowercase search terms: ASCII identifier tokens (≥3 chars) plus the English expansions of
 *  any Korean ops words the request contains (substring match on the Korean, so particles like
 *  '메모리가'/'사용률이' still hit). Exported for tests. */
export function nlSearchTerms(nl: string): string[] {
  return nlSearchConcepts(nl).flat();
}

/** Same as nlSearchTerms but grouped per CONCEPT: each ASCII token is its own concept; each Korean
 *  word contributes ONE concept holding all its expansions (so 'memory'+'mem' score a name once,
 *  not twice). Exported for tests. */
export function nlSearchConcepts(nl: string): string[][] {
  const lower = (nl || '').toLowerCase();
  const seen = new Set<string>();
  const out: string[][] = [];
  const push = (terms: string[]) => {
    const fresh = terms.filter((t) => !seen.has(t));
    if (!fresh.length) return;
    fresh.forEach((t) => seen.add(t));
    out.push(fresh);
  };
  for (const t of lower.split(/[^a-z0-9_]+/)) if (t.length >= 3) push([t]);
  for (const [word, expansions] of Object.entries(KO_METRIC_TERMS)) {
    if (lower.includes(word)) push([...expansions]);
  }
  return out;
}

/** Substring match for terms ≥3 chars; SHORT terms ('up', 'fs') must match a whole '_'-separated
 *  segment (or the whole name) — otherwise they hit inside unrelated names ('group', 'setup'). */
export function termMatches(lowerName: string, term: string): boolean {
  if (term.length >= 3) return lowerName.includes(term);
  return lowerName === term || lowerName.split(/[_:]/).includes(term);
}

export function prioritizeSchemaForQuery(schema: unknown, nl: string): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const concepts = nlSearchConcepts(nl);
  if (!concepts.length) return schema;
  const s = schema as Record<string, unknown>;
  const nameOf = (x: unknown) => (typeof x === 'string' ? x : ((x as { name?: string })?.name ?? '')).toLowerCase();
  const score = (name: string) => concepts.reduce((n, c) => n + (c.some((t) => termMatches(name, t)) ? 1 : 0), 0);
  const reorder = (arr: unknown[]) =>
    arr
      .map((x, i) => ({ x, i, sc: score(nameOf(x)) }))
      .sort((a, b) => b.sc - a.sc || a.i - b.i) // score desc, stable on ties
      .map((e) => e.x);
  const out: Record<string, unknown> = { ...s };
  for (const k of ['metrics', 'labels', 'tags', 'services'] as const) {
    if (Array.isArray(s[k]) && (s[k] as unknown[]).length) out[k] = reorder(s[k] as unknown[]);
  }
  return out;
}

/** FULL metric-name list from a cached schema (PromQL kinds) — the querygen vocabulary anchor.
 *  Entries may be strings or {name}; non-conforming shapes yield []. Unlike the RENDERED prompt
 *  block (capped at ~80 names), this is the whole cached list. */
export function schemaMetricNames(schema: unknown): string[] {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [];
  const m = (schema as { metrics?: unknown }).metrics;
  if (!Array.isArray(m)) return [];
  return m
    .map((x) => (typeof x === 'string' ? x : (x as { name?: unknown })?.name))
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
}

// --- Prompt rendering -------------------------------------------------------
// Bounds so a rich introspected schema (ClickHouse allows up to 100 tables × 200 cols, OpenSearch many
// indices) never blows the model prompt. The per-line/column caps matter because a column TYPE can be a
// deeply-nested ClickHouse type string (Tuple/Map/Array(Nested(...))) thousands of chars long.
const PROMPT_MAX_TABLES = 40;
const PROMPT_MAX_COLS = 60;
const PROMPT_MAX_COL_CHARS = 80;    // one `name type` cell
const PROMPT_MAX_LINE_CHARS = 1200; // one table/domain line, regardless of column count
const PROMPT_MAX_CHARS = 6000;      // default total; callers (chat) may pass a smaller per-datasource budget

const clamp = (str: string, max: number) => (str.length > max ? `${str.slice(0, max - 1)}…` : str);

/**
 * Render a cached datasource schema into a compact, prompt-ready block.
 *
 * - SQL datasources (`tables: [{name, columns: [{name, type}]}]`) → `table(col type, col type, …)` so the
 *   model sees the COLUMNS, not just table names (the previous renderer dropped columns, so the model
 *   couldn't write a correct ClickHouse query).
 * - OpenSearch (`domains: [{name, indices: […]}]`) → `domain: idx, idx, …` so the data gateway gets index names.
 * - metric/label/tag datasources (Prometheus/Loki/Tempo) → `key: name, name, …` (names are all those carry).
 *
 * Bounded by tables/columns/domains, per-line and per-column length, and a total `maxChars` budget;
 * truncation is always disclosed (`… (+N more …)`), never a silent slice. `_kind` is reserved for
 * future kind-specific shaping (rendering is currently shape-driven, not kind-driven).
 */
export function renderSchemaForPrompt(schema: unknown, _kind?: string | null, maxChars: number = PROMPT_MAX_CHARS): string {
  const s = (schema && typeof schema === 'object' && !Array.isArray(schema)) ? (schema as Record<string, unknown>) : {};
  const lines: string[] = [];
  let budget = Math.max(80, maxChars); // running char budget so truncation is explicit, never a blind slice()

  // SQL datasources: tables WITH columns + types (the part the model actually needs for SQL).
  if (Array.isArray(s.tables) && s.tables.length) {
    const tables = s.tables as unknown[];
    let emitted = 0;
    for (const t of tables.slice(0, PROMPT_MAX_TABLES)) {
      if (!t || typeof t !== 'object') continue;
      const tt = t as { name?: unknown; columns?: unknown };
      const name = typeof tt.name === 'string' ? tt.name : '';
      if (!name) continue;
      const cols = Array.isArray(tt.columns) ? (tt.columns as unknown[]).slice(0, PROMPT_MAX_COLS) : [];
      const colStr = cols
        .map((c) => {
          if (typeof c === 'string') return clamp(c, PROMPT_MAX_COL_CHARS);
          const cc = (c || {}) as { name?: unknown; type?: unknown };
          const cn = typeof cc.name === 'string' ? cc.name : '';
          const ct = typeof cc.type === 'string' ? cc.type : '';
          return cn ? clamp(ct ? `${cn} ${ct}` : cn, PROMPT_MAX_COL_CHARS) : '';
        })
        .filter(Boolean)
        .join(', ');
      // Clamp each line to the AVAILABLE budget (reserve ~60 for the disclosure line) so even the FIRST
      // table line respects the caller's maxChars — not just the per-line cap. (Fixes a first-line that
      // could otherwise emit up to PROMPT_MAX_LINE_CHARS and blow a small per-datasource chat budget.)
      const cap = Math.min(PROMPT_MAX_LINE_CHARS, budget - 60);
      if (cap < 12) break; // out of budget
      const line = clamp(colStr ? `${name}(${colStr})` : name, cap);
      lines.push(line);
      budget -= line.length + 1;
      emitted += 1;
      if (line.length >= cap) break; // hit the budget cap → stop (remaining tables disclosed below)
    }
    // Disclose ONLY when tables were actually DROPPED (more remain than emitted) — not when the last
    // line was merely clamped to budget (that line's own `…` already discloses), which avoids a
    // misleading "+0 more tables". Silent omission would read as "these are all the tables".
    const omitted = tables.length - emitted;
    if (emitted > 0 && omitted > 0) {
      lines.push(`… (+${omitted} more tables — refine the request or query system.tables)`);
    }
  }

  const names = (a: unknown, n: number) =>
    (Array.isArray(a) ? a : [])
      .slice(0, n)
      .map((x) => (typeof x === 'string' ? x : ((x as { name?: string })?.name ?? '')))
      .filter(Boolean)
      .join(', ');

  // OpenSearch domains carry nested indices — render `domain: idx, idx` so the data gateway sees index names.
  if (Array.isArray(s.domains) && s.domains.length) {
    const domains = s.domains as unknown[];
    let emitted = 0;
    let budgetBroke = false;
    for (const d of domains.slice(0, PROMPT_MAX_TABLES)) {
      if (!d || typeof d !== 'object') continue;
      const dd = d as { name?: unknown; indices?: unknown };
      const dn = typeof dd.name === 'string' ? dd.name : '';
      if (!dn) continue;
      const idx = names(dd.indices, PROMPT_MAX_COLS);
      const line = clamp(idx ? `${dn}: ${idx}` : dn, PROMPT_MAX_LINE_CHARS);
      if (lines.length && line.length + 1 > budget - 40) { budgetBroke = true; break; }
      lines.push(line);
      budget -= line.length + 1;
      emitted += 1;
    }
    if (emitted > 0 && (domains.length > PROMPT_MAX_TABLES || budgetBroke)) {
      lines.push(`… (+${domains.length - emitted} more domains)`);
    }
  }

  // metric/label/tag/index datasources: names only (that's all they carry). (`domains` handled above.)
  for (const [k, n] of [['metrics', 80], ['labels', 80], ['tags', 80], ['indices', 60], ['services', 80]] as const) {
    if (Array.isArray(s[k]) && (s[k] as unknown[]).length) {
      if (budget < 16) break; // out of room — stop (don't silently skip an individual key out of order)
      const full = `${k}: ${names(s[k], n)}`;
      // TRUNCATE to fit (the `…` discloses it) rather than silently dropping the whole line — the docstring
      // promises truncation is always disclosed, never a silent slice.
      const line = full.length + 1 > budget ? clamp(full, budget - 1) : full;
      lines.push(line);
      budget -= line.length + 1;
    }
  }

  return lines.join('\n');
}

// --- Cache-shape helpers for the generate route (kept here: Next.js route files may only export handlers) ---
/** Per-instance background-refresh cooldown (see the generate route). */
export const REFRESH_COOLDOWN_MS = 10 * 60 * 1000;

/** Trim an introspected schema so it fits under the cache size limit — used as a fallback so a large
 *  warehouse (>256KB schema) is still cached (bounded), instead of re-introspecting on EVERY request. */
export function trimSchemaForCache(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const s = schema as Record<string, unknown>;
  if (Array.isArray(s.tables)) {
    const tables = (s.tables as unknown[]).slice(0, 50).map((t) =>
      t && typeof t === 'object' && Array.isArray((t as { columns?: unknown }).columns)
        ? { ...(t as object), columns: ((t as { columns: unknown[] }).columns).slice(0, 80) }
        : t,
    );
    return { ...s, tables, truncated: true };
  }
  // Metric schemas (Prometheus/Mimir): the connector cap is a COUNT (3000 names), so long-name
  // environments can still exceed the byte limit — halve the metric list until it fits (labels
  // trimmed first), keeping the connector's `truncated` semantics honest.
  if (Array.isArray(s.metrics)) {
    if (Buffer.byteLength(JSON.stringify(s), 'utf8') <= MAX_SCHEMA_BYTES) return schema; // already fits
    // Interleaved (every k-th name) rather than the alphabetical prefix, so the late node_*/kube_*
    // families this cap raise set out to recover survive the trim. Mirrored in scripts/v2/workers/db.py.
    // `probed` names (individually checked by the connector — definitive presence/absence even on a
    // truncated list) that ARE in the original metrics must survive the stride, or a consumer reading
    // "probed but absent from metrics" would conclude a present metric is definitively missing.
    // `trimmed: true` marks the row as a size trim (not a connector count cap) for isLegacyCapSnapshot.
    const all = s.metrics as unknown[];
    const keep = new Set<unknown>(Array.isArray(s.probed) ? (s.probed as unknown[]).filter((p) => all.includes(p)) : []);
    let stride = 1;
    let out: Record<string, unknown> = { ...s, truncated: true, trimmed: true };
    if (Array.isArray(s.labels)) out.labels = (s.labels as unknown[]).slice(0, 100);
    while (Buffer.byteLength(JSON.stringify(out), 'utf8') > MAX_SCHEMA_BYTES && stride < all.length) {
      stride *= 2;
      out = { ...out, metrics: all.filter((m, i) => i % stride === 0 || keep.has(m)) };
    }
    return out;
  }
  return schema;
}

/** The connectors' FORMER metric cap — a cached metric schema truncated at EXACTLY this many
 *  names is a snapshot taken under the old cap (the new cap is 3000). Exported for tests. */
export const LEGACY_METRIC_CAP = 500;
/** Old connectors appended up to this many individually-probed names PAST the cap (worker
 *  `probe_metrics`), so an old-cap snapshot holds LEGACY_METRIC_CAP..+LEGACY_PROBE_MAX names. */
export const LEGACY_PROBE_MAX = 24;
/** True only for a PromQL-kind cache that is (near-)provably an old-cap snapshot: connector
 *  `truncated`, NOT a size trim (`trimmed`), and LEGACY_METRIC_CAP..LEGACY_METRIC_CAP+LEGACY_PROBE_MAX
 *  names. Does not fire for ClickHouse trims, failed metric fetches (0 names) or sub-cap label-only
 *  truncation — those re-produce the same row on refresh (no convergence); a target with exactly
 *  500..524 real metrics and >200 labels is the accepted false positive (one cooldown-bounded
 *  background introspect per instance per 10 min). */
export function isLegacyCapSnapshot(kind: string | null, schema: unknown, names: string[]): boolean {
  const s = schema as { truncated?: unknown; trimmed?: unknown } | null;
  return (kind === 'prometheus' || kind === 'mimir')
    && Boolean(s?.truncated) && !s?.trimmed
    && names.length >= LEGACY_METRIC_CAP && names.length <= LEGACY_METRIC_CAP + LEGACY_PROBE_MAX;
}
