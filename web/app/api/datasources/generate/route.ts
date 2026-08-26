// POST /api/datasources/generate — natural-language → datasource query (Explore "AI로 생성").
// Authenticated. Drafts a query string for the user to REVIEW then run — it NEVER executes anything.
//
// Bedrock-DIRECT (web/lib/datasource-querygen) — NOT the AgentCore monitoring gateway. Routing this
// through the section agent appended the 24-tool list + COMMON_FOOTER ("respond in markdown") after the
// thin "output a query" instruction and bound the tools, so the agent answered in PROSE instead of
// emitting SQL (then the prose was rejected by the read-only guard on run). Here: no tools, no footer,
// a strict translate-to-query prompt + the schema (real table/COLUMN names) injected as data.
import { verifyUser } from '@/lib/auth';
import { generateQuery } from '@/lib/datasource-querygen';
import { listConfiguredSchemas, renderSchemaForPrompt, prioritizeSchemaForQuery, isSchemaStale, upsertSchema } from '@/lib/datasource-schema';
import { currentAccountId } from '@/lib/account';
import { getDatasource, resolveConnConfig, type DatasourceRow } from '@/lib/datasources';
import { invokeMcpLambdaTool } from '@/lib/mcp-lambda-invoke';
import { assertDatasourceEndpointAllowed } from '@/lib/ssrf-guard';
import { isDatasourceKind } from '@/lib/integrations-category';
import { readJsonBounded, BodyTooLargeError } from '@/lib/http-body';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const LANG: Record<string, string> = {
  prometheus: 'PromQL', mimir: 'PromQL', loki: 'LogQL', tempo: 'TraceQL', clickhouse: 'read-only SQL',
  jaeger: 'Jaeger trace-search parameter string (service=<name>&operation=…&tags=…&limit=…)',
  dynatrace: 'Dynatrace metricSelector (Metrics API v2)', datadog: 'Datadog metrics query',
};
const MAX_NL = 4_000;

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

/** Trim an introspected schema so it fits under the cache size limit — used as a fallback so a large
 *  warehouse (>256KB schema) is still cached (bounded), instead of re-introspecting on EVERY request. */
function trimSchemaForCache(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const s = schema as Record<string, unknown>;
  if (!Array.isArray(s.tables)) return schema;
  const tables = (s.tables as unknown[]).slice(0, 50).map((t) =>
    t && typeof t === 'object' && Array.isArray((t as { columns?: unknown }).columns)
      ? { ...(t as object), columns: ((t as { columns: unknown[] }).columns).slice(0, 80) }
      : t,
  );
  return { ...s, tables, truncated: true };
}

/** Cache the introspected schema; on a size-limit failure, persist a trimmed copy so subsequent requests
 *  hit the cache instead of re-running the full (100+ DESCRIBE) introspect. All best-effort. */
async function cacheSchemaBestEffort(accountId: string, id: number, kind: string, schema: unknown): Promise<void> {
  try { await upsertSchema(accountId, id, kind, schema); return; }
  catch { /* likely over the size limit — fall through to a bounded write */ }
  try { await upsertSchema(accountId, id, kind, trimSchemaForCache(schema)); }
  catch { /* give up; manual Refresh remains */ }
}

/** Resolve a prompt-ready schema block. When an instance id is given, use ONLY that instance's cached
 *  schema (never a same-kind SIBLING's — that would generate SQL against the wrong instance's tables);
 *  if it has no cache (connect-time warm never ran / failed), introspect ON DEMAND and self-heal. The
 *  same-kind match is reserved for the deprecated slug/kind path. Best-effort — generation still
 *  proceeds schema-less (the model is told as much). */
/** Live-introspect the instance's schema (resolve conn-config, SSRF-guard, invoke <kind>_schema) and
 *  cache it. Returns the introspected schema. */
async function introspectAndCache(accountId: string, ds: DatasourceRow, id: number, kind: string): Promise<unknown> {
  const connConfig = await resolveConnConfig(ds);
  if (connConfig?.endpoint) assertDatasourceEndpointAllowed(connConfig.endpoint); // defense-in-depth (connector guards too)
  const schema = await invokeMcpLambdaTool({ kind, tool: `${kind}_schema`, connConfig });
  await cacheSchemaBestEffort(accountId, id, kind, schema);
  return schema;
}

// Dedupe concurrent background refreshes per instance (the web tier is long-lived Fargate, so a
// fire-and-forget refresh completes after the response).
const refreshing = new Set<number>();
function refreshInBackground(accountId: string, ds: DatasourceRow, id: number, kind: string): void {
  if (refreshing.has(id)) return;
  refreshing.add(id);
  void introspectAndCache(accountId, ds, id, kind).catch(() => {}).finally(() => refreshing.delete(id));
}

async function resolveSchemaBlock(ds: DatasourceRow | null, id: number, hasId: boolean, kind: string, nl: string): Promise<string> {
  const accountId = currentAccountId();
  // Float NL-relevant metric/label names to the front so they survive the render cap (Prometheus/Mimir
  // return hundreds of metrics alphabetically; the relevant ones would otherwise be dropped).
  const render = (schema: unknown, k: string | null) => renderSchemaForPrompt(prioritizeSchemaForQuery(schema, nl), k);
  try {
    const schemas = await listConfiguredSchemas(accountId);
    const own = hasId ? schemas.find((s) => s.integrationId === id) : schemas.find((s) => s.kind === kind);
    if (own?.schema) {
      const block = render(own.schema, own.kind);
      if (block) {
        // Lazy refresh: cache hit but stale → refresh in the background (next lookup is fresh), serve now.
        if (hasId && ds && isSchemaStale(own.fetched_at)) refreshInBackground(accountId, ds, id, kind);
        return block;
      }
    }
  } catch { /* cache is optional */ }

  // Cache miss → do NOT block the read path with a heavy introspect (version() + system.tables + up to
  // 100×DESCRIBE + an Aurora write would violate thin-BFF and let any authed read trigger heavy work).
  // Warm the cache in the BACKGROUND so the NEXT lookup is grounded; serve schema-less now (the model
  // writes a best-effort query and the connector's read-only guard backstops it on run).
  if (hasId && ds) refreshInBackground(accountId, ds, id, kind);
  return '';
}

export async function POST(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ error: 'unauthenticated' }, 401);

  let body: { id?: unknown; slug?: unknown; kind?: unknown; nl?: unknown };
  try { body = (await readJsonBounded(request)) as typeof body; }
  catch (e) {
    if (e instanceof BodyTooLargeError) return json({ error: 'request body too large' }, 413);
    return json({ error: 'invalid JSON body' }, 400);
  }

  // Resolve the kind: by instance id (preferred) or by slug/kind (deprecated).
  let kind = '';
  let ds: DatasourceRow | null = null;
  const id = Number(body.id);
  const hasId = Number.isInteger(id) && id > 0;
  if (hasId) {
    ds = await getDatasource(id);
    if (!ds) return json({ error: 'unknown datasource instance' }, 400);
    kind = ds.kind;
  } else {
    kind = typeof body.kind === 'string' && body.kind ? body.kind : (typeof body.slug === 'string' ? body.slug : '');
  }
  if (!isDatasourceKind(kind)) return json({ error: 'unknown datasource' }, 400);

  const lang = LANG[kind] || 'query';
  const isSql = /SQL/i.test(lang);
  const nl = typeof body.nl === 'string' ? body.nl.trim().slice(0, MAX_NL) : '';
  if (!nl) return json({ error: 'nl (natural-language request) required' }, 400);

  const schemaBlock = await resolveSchemaBlock(ds, id, hasId, kind, nl);

  try {
    const query = await generateQuery({ nl, lang, schemaBlock, isSql });
    return json({ query, lang }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'generation failed' }, 502);
  }
}
