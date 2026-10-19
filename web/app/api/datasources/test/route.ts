// POST /api/datasources/test — probe a datasource connection BEFORE saving (v1 "Test connection").
// Admin-gated. Takes an UNSAVED candidate {kind, endpoint, authType, creds}, SSRF-guards the endpoint,
// and invokes the connector's `${kind}_health` tool with an INLINE conn-config (nothing is stored).
// SECURITY: the credential value is never logged or echoed — only {ok, latency_ms, error?} is returned.
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { invokeMcpLambdaTool, KNOWN_MCP_LAMBDA_KINDS } from '@/lib/mcp-lambda-invoke';
import { isDatasourceKind } from '@/lib/integrations-category';
import { assertDatasourceEndpointAllowed } from '@/lib/ssrf-guard';
import { readJsonBounded, BodyTooLargeError } from '@/lib/http-body';

export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

export async function POST(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ error: 'unauthenticated' }, 401);
  if (!(await isAdmin(user))) return json({ error: 'admin access required' }, 403);

  let body: { kind?: unknown; endpoint?: unknown; authType?: unknown; creds?: unknown };
  try { body = (await readJsonBounded(request)) as typeof body; }
  catch (e) {
    if (e instanceof BodyTooLargeError) return json({ error: 'request body too large' }, 413);
    return json({ error: 'invalid JSON body' }, 400);
  }

  const kind = typeof body.kind === 'string' ? body.kind : '';
  if (!isDatasourceKind(kind) || !(KNOWN_MCP_LAMBDA_KINDS as readonly string[]).includes(kind)) {
    return json({ error: 'unknown datasource kind' }, 400);
  }
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
  if (!endpoint) return json({ error: 'endpoint required' }, 400);
  try { assertDatasourceEndpointAllowed(endpoint); }
  catch (e) { return json({ error: (e as Error).message }, 400); }

  const authType = typeof body.authType === 'string' ? body.authType : 'none';
  const creds = (body.creds && typeof body.creds === 'object' && !Array.isArray(body.creds))
    ? (body.creds as Record<string, unknown>) : {};
  const connConfig = { endpoint, authType, ...creds }; // flat blob the connector Lambda understands

  try {
    const result = (await invokeMcpLambdaTool({
      kind, tool: `${kind}_health`, connConfig,
    })) as { ok?: boolean; latency_ms?: number; error?: string };
    return json({ ok: Boolean(result?.ok), latencyMs: result?.latency_ms, error: result?.error }, 200);
  } catch (e) {
    // message only — connector errors never carry the credential value
    return json({ ok: false, error: e instanceof Error ? e.message : 'connection test failed' }, 200);
  }
}
