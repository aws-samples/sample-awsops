// web/lib/datasource-schema.ts
// Durable cache of introspected datasource schemas (Aurora `datasource_schemas`). The hub "Refresh
// schema" route writes here (via the connector Lambda's <kind>_schema tool); the chat route reads here
// to inject a compact schema block into the agent payload (the agent reads the cache, not the live
// datasource). Keyed PER INSTANCE by (account_id, integration_id) so two instances of one kind don't
// share a cache row (the PK was swapped from (account_id, slug) by the datasource-instances migration).
import { getPool } from '@/lib/db';

const MAX_SCHEMA_BYTES = 256_000; // bound a single cached schema (Aurora row + later prompt injection)

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

export async function upsertSchema(accountId: string, integrationId: number, kind: string | null, schema: unknown): Promise<void> {
  const json = JSON.stringify(schema ?? {});
  if (Buffer.byteLength(json, 'utf8') > MAX_SCHEMA_BYTES) {
    throw new Error('introspected schema exceeds size limit');
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
export function prioritizeSchemaForQuery(schema: unknown, nl: string): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const terms = Array.from(
    new Set((nl || '').toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length >= 3)),
  );
  if (!terms.length) return schema;
  const s = schema as Record<string, unknown>;
  const nameOf = (x: unknown) => (typeof x === 'string' ? x : ((x as { name?: string })?.name ?? '')).toLowerCase();
  const reorder = (arr: unknown[]) =>
    arr
      .map((x, i) => ({ x, i, sc: terms.reduce((n, t) => n + (nameOf(x).includes(t) ? 1 : 0), 0) }))
      .sort((a, b) => b.sc - a.sc || a.i - b.i) // score desc, stable on ties
      .map((e) => e.x);
  const out: Record<string, unknown> = { ...s };
  for (const k of ['metrics', 'labels', 'tags', 'services'] as const) {
    if (Array.isArray(s[k]) && (s[k] as unknown[]).length) out[k] = reorder(s[k] as unknown[]);
  }
  return out;
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
