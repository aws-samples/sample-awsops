// Admin schema refresh/read for datasource INSTANCES. POST introspects an instance (resolves its
// row + credential, invokes the connector's <kind>_schema tool with an inline conn-config) and caches
// the result in Aurora keyed by integration_id; GET returns cached summaries. The agent reads the
// cache via the chat route (not here). accountId is server-derived (never the request body).
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { currentAccountId } from '@/lib/account';
import { invokeMcpLambdaTool } from '@/lib/mcp-lambda-invoke';
import { upsertSchema, listConfiguredSchemas } from '@/lib/datasource-schema';
import { enqueueDatasourceIndex } from '@/lib/diag-signals';
import { getDatasource, resolveConnConfig } from '@/lib/datasources';
import { isDatasourceKind } from '@/lib/integrations-category';
import { assertDatasourceEndpointAllowed } from '@/lib/ssrf-guard';
import { readJsonBounded, BodyTooLargeError } from '@/lib/http-body';

export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

async function gate(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return { resp: json({ error: 'unauthenticated' }, 401) };
  if (!(await isAdmin(user))) return { resp: json({ error: 'admin access required' }, 403) };
  if (!process.env.AURORA_ENDPOINT) return { resp: json({ error: 'Aurora not configured' }, 400) };
  return { user };
}

/** Counts only — never the introspected values themselves. */
function summarize(schema: unknown): Record<string, number> {
  const s = (schema || {}) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const k of ['tables', 'metrics', 'labels', 'tags', 'domains', 'indices'] as const) {
    if (Array.isArray(s[k])) out[k] = (s[k] as unknown[]).length;
  }
  return out;
}

export async function POST(request: Request) {
  const g = await gate(request);
  if (g.resp) return g.resp;
  let body: { id?: unknown };
  try { body = (await readJsonBounded(request)) as typeof body; } // bound BEFORE parse (OOM guard)
  catch (e) {
    if (e instanceof BodyTooLargeError) return json({ error: 'request body too large' }, 413);
    return json({ error: 'invalid JSON body' }, 400);
  }
  const id = Number(body?.id);
  if (!Number.isInteger(id) || id <= 0) return json({ error: 'valid datasource id required' }, 400);

  const ds = await getDatasource(id);
  if (!ds || !isDatasourceKind(ds.kind)) return json({ error: 'unknown datasource instance' }, 400);

  const connConfig = await resolveConnConfig(ds); // row endpoint (authoritative) + SM cred — works even for auth=none
  if (connConfig?.endpoint) {
    try { assertDatasourceEndpointAllowed(connConfig.endpoint); }
    catch (e) { return json({ error: (e as Error).message }, 400); }
  }

  const accountId = currentAccountId(); // server-side; never the request body
  try {
    const schema = await invokeMcpLambdaTool({ kind: ds.kind, tool: `${ds.kind}_schema`, connConfig });
    await upsertSchema(accountId, id, ds.kind, schema);
    await enqueueDatasourceIndex(id, ds.kind);  // rebuild pre-built diagnostic signals (prom/mimir; best-effort)
    return json({ ok: true, id, kind: ds.kind, summary: summarize(schema) }, 200);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}

export async function GET(request: Request) {
  const g = await gate(request);
  if (g.resp) return g.resp;
  const rows = await listConfiguredSchemas(currentAccountId());
  return json({ schemas: rows.map((r) => ({ integrationId: r.integrationId, kind: r.kind, fetched_at: r.fetched_at, summary: summarize(r.schema) })) }, 200);
}
