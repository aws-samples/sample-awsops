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
import { listConfiguredSchemas, renderSchemaForPrompt, prioritizeSchemaForQuery, isSchemaStale, upsertSchema, schemaMetricNames, isLegacyCapSnapshot, REFRESH_COOLDOWN_MS } from '@/lib/datasource-schema';
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


/** Cache the introspected schema (best-effort — the read path never depends on the write). */
async function cacheSchemaBestEffort(accountId: string, id: number, kind: string, schema: unknown): Promise<void> {
  // upsertSchema itself stores a bounded (trimmed, `truncated`) copy when the schema is over the
  // size limit — the same fallback every other writer gets. Best-effort: manual Refresh remains.
  try { await upsertSchema(accountId, id, kind, schema); } catch { /* give up */ }
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
// Per-instance cooldown: a trigger whose condition survives the refresh (e.g. a schema that is
// truncated for reasons a re-introspect cannot change) must not fire a fresh introspect on EVERY
// request — one attempt per cooldown window per instance, regardless of trigger.
const lastRefreshAt = new Map<number, number>();
function refreshInBackground(accountId: string, ds: DatasourceRow, id: number, kind: string): void {
  if (refreshing.has(id)) return;
  const now = Date.now();
  if (now - (lastRefreshAt.get(id) ?? 0) < REFRESH_COOLDOWN_MS) return;
  lastRefreshAt.set(id, now);
  refreshing.add(id);
  void introspectAndCache(accountId, ds, id, kind).catch(() => {}).finally(() => refreshing.delete(id));
}

async function resolveSchemaBlock(ds: DatasourceRow | null, id: number, hasId: boolean, kind: string, nl: string): Promise<{ block: string; metricNames: string[]; vocabularyComplete: boolean }> {
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
        // ALSO refresh a PromQL cache that is provably a snapshot under the connectors' former
        // 500-name cap (now 3000): it lacks whole metric families (node_*/kube_*) the prompt
        // needs — one background re-introspect (cooldown-guarded) brings the fuller list.
        const names = schemaMetricNames(own.schema);
        const legacySnapshot = isLegacyCapSnapshot(own.kind, own.schema, names);
        if (hasId && ds && (isSchemaStale(own.fetched_at) || legacySnapshot)) refreshInBackground(accountId, ds, id, kind);
        // FULL cached metric list (not the ~80-name rendered block) — the querygen anchor;
        // an in-block-only anchor falsely rejected real metrics past the render cap.
        // vocabularyComplete: the connector's OWN truncated flag (never inferred from length)
        // AND cache freshness — an incomplete/stale vocabulary softens the advisory warning.
        const truncated = Boolean((own.schema as { truncated?: unknown })?.truncated);
        return {
          block,
          metricNames: names,
          vocabularyComplete: !truncated && !isSchemaStale(own.fetched_at),
        };
      }
    }
  } catch { /* cache is optional */ }

  // Cache miss → do NOT block the read path with a heavy introspect (version() + system.tables + up to
  // 100×DESCRIBE + an Aurora write would violate thin-BFF and let any authed read trigger heavy work).
  // Warm the cache in the BACKGROUND so the NEXT lookup is grounded; serve schema-less now (the model
  // writes a best-effort query and the connector's read-only guard backstops it on run).
  if (hasId && ds) refreshInBackground(accountId, ds, id, kind);
  return { block: '', metricNames: [], vocabularyComplete: false };
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

  const { block: schemaBlock, metricNames, vocabularyComplete } = await resolveSchemaBlock(ds, id, hasId, kind, nl);

  try {
    // ADVISORY contract: a vocabulary violation surviving the corrective retry returns the
    // draft WITH `warning` (the user reviews before running) — never a 502.
    const { query, warning } = await generateQuery({ nl, lang, schemaBlock, isSql, metricNames, vocabularyComplete });
    return json({ query, lang, ...(warning ? { warning } : {}) }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'generation failed' }, 502);
  }
}
