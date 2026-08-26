// POST (create) / PATCH (update) a datasource instance. Admin-gated. Persists the row via
// datasources.ts and the credential (flat connConfig blob) under the instance id. When the instance is
// (or becomes) the default for its kind, the kind-mirror credential is refreshed so the agent gateway
// no-inline path resolves to it. SECURITY: the credential value is never logged or echoed.
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { createDatasource, updateDatasource, getDatasource } from '@/lib/datasources';
import { setIntegrationCredentialById, mirrorDefaultCredential } from '@/lib/integration-credentials';
import { isDatasourceKind } from '@/lib/integrations-category';
import { assertDatasourceEndpointAllowed } from '@/lib/ssrf-guard';
import { readJsonBounded, BodyTooLargeError } from '@/lib/http-body';
import { invokeMcpLambdaTool, type ConnConfig } from '@/lib/mcp-lambda-invoke';
import { upsertSchema } from '@/lib/datasource-schema';
import { enqueueDatasourceIndex } from '@/lib/diag-signals';
import { currentAccountId } from '@/lib/account';

export const dynamic = 'force-dynamic';

const AUTH_TYPES = ['none', 'basic', 'bearer', 'custom_header'];

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

/** §3.C connect-time: warm the schema+version cache best-effort so chat/diag never depend on a manual
 *  "Refresh schema". Fire-and-forget — the web tier is long-lived Fargate (not Lambda), so this runs
 *  after the response; a failure logs (name only — never the credential) and leaves manual Refresh. */
function warmSchemaCache(id: number, kind: string, connConfig: ConnConfig): void {
  void (async () => {
    try {
      const schema = await invokeMcpLambdaTool({ kind, tool: `${kind}_schema`, connConfig });
      await upsertSchema(currentAccountId(), id, kind, schema);
      await enqueueDatasourceIndex(id, kind);  // rebuild pre-built diagnostic signals (prom/mimir; best-effort)
    } catch (e) {
      console.warn('[datasources] connect-time introspect failed (manual Refresh remains):', (e as { name?: string })?.name || 'error');
    }
  })();
}

async function gate(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return { resp: json({ error: 'unauthenticated' }, 401) };
  if (!(await isAdmin(user))) return { resp: json({ error: 'admin access required' }, 403) };
  if (!process.env.AURORA_ENDPOINT) return { resp: json({ error: 'Aurora not configured' }, 400) };
  return {};
}

async function parseBody(request: Request) {
  return (await readJsonBounded(request)) as Record<string, unknown>;
}

export async function POST(request: Request) {
  const g = await gate(request); if (g.resp) return g.resp;
  let body: Record<string, unknown>;
  try { body = await parseBody(request); }
  catch (e) { return e instanceof BodyTooLargeError ? json({ error: 'request body too large' }, 413) : json({ error: 'invalid JSON body' }, 400); }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const kind = typeof body.kind === 'string' ? body.kind : '';
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
  const authType = typeof body.authType === 'string' && AUTH_TYPES.includes(body.authType) ? body.authType : 'none';
  const creds = (body.creds && typeof body.creds === 'object' && !Array.isArray(body.creds)) ? (body.creds as Record<string, unknown>) : {};

  if (!name) return json({ error: 'name required' }, 400);
  if (!isDatasourceKind(kind)) return json({ error: 'unknown datasource kind' }, 400);
  if (!endpoint) return json({ error: 'endpoint required' }, 400);
  try { assertDatasourceEndpointAllowed(endpoint); } catch (e) { return json({ error: (e as Error).message }, 400); }

  const blob = { endpoint, authType, ...creds };
  try {
    const id = await createDatasource({ name, kind, endpoint, authType: authType as 'none' });
    await setIntegrationCredentialById(id, blob);
    const ds = await getDatasource(id);
    if (ds?.isDefault) await mirrorDefaultCredential(kind, blob); // first of its kind → it is the default
    warmSchemaCache(id, kind, blob as ConnConfig); // §3.C connect-time introspect (best-effort, after response)
    return json({ id }, 201);
  } catch (e) {
    const msg = (e as Error).message || 'create failed';
    return json({ error: msg }, /duplicate/i.test(msg) ? 409 : 400);
  }
}

export async function PATCH(request: Request) {
  const g = await gate(request); if (g.resp) return g.resp;
  let body: Record<string, unknown>;
  try { body = await parseBody(request); }
  catch (e) { return e instanceof BodyTooLargeError ? json({ error: 'request body too large' }, 413) : json({ error: 'invalid JSON body' }, 400); }

  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return json({ error: 'valid id required' }, 400);
  const ds = await getDatasource(id);
  if (!ds) return json({ error: 'datasource not found' }, 404);

  const name = typeof body.name === 'string' ? body.name.trim() : undefined;
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : undefined;
  const authType = typeof body.authType === 'string' && AUTH_TYPES.includes(body.authType) ? body.authType : undefined;
  const creds = (body.creds && typeof body.creds === 'object' && !Array.isArray(body.creds)) ? (body.creds as Record<string, unknown>) : undefined;

  if (endpoint !== undefined) {
    try { assertDatasourceEndpointAllowed(endpoint); } catch (e) { return json({ error: (e as Error).message }, 400); }
  }
  // Re-write the id credential when any connection field changed (so updateDatasource's mirror is fresh).
  if (endpoint !== undefined || authType !== undefined || creds !== undefined) {
    const blob = {
      endpoint: endpoint ?? ds.endpoint ?? '',
      authType: authType ?? ds.authType ?? 'none',
      ...(creds ?? {}),
    };
    await setIntegrationCredentialById(id, blob);
  }
  try {
    await updateDatasource(id, { name, endpoint, authType: authType as 'none' | undefined });
    return json({ ok: true }, 200);
  } catch (e) {
    const msg = (e as Error).message || 'update failed';
    return json({ error: msg }, /duplicate/i.test(msg) ? 409 : 400);
  }
}
