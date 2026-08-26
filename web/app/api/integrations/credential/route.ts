// Admin-gated credential-write route for integrations (DevOps-agent-style).
// PUT stores one integration's credential in the single Secrets Manager secret (keyed by slug=kind);
// GET returns which slugs are configured (keys only). SECURITY: never log/echo the credential value.
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { setIntegrationCredential, getConfiguredSlugs, getConfiguredIds } from '@/lib/integration-credentials';
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

export async function GET(request: Request) {
  const g = await gate(request);
  if (g.resp) return g.resp;
  // NARROW downgrade: a Secrets Manager AccessDenied/NotFound (e.g. integrations gated off, task role
  // has no access) degrades to an empty configured list so the read-only status panel doesn't 500.
  // Any OTHER failure (PG, malformed secret, …) surfaces as 500 — masking it would hide real breakage.
  try {
    const [configured, configuredIds] = await Promise.all([getConfiguredSlugs(), getConfiguredIds()]);
    return json({ configured, configuredIds }, 200);
  } catch (e) {
    const name = (e as { name?: string })?.name || '';
    if (/AccessDenied|ResourceNotFound|NotFound/i.test(name)) {
      return json({ configured: [], configuredIds: [] }, 200);
    }
    console.error('[credential GET] unexpected error reading configured integrations:', name);
    return json({ error: 'failed to read configured integrations' }, 500);
  }
}

export async function PUT(request: Request) {
  const g = await gate(request);
  if (g.resp) return g.resp;
  let body: { slug?: unknown; secret?: unknown };
  try {
    body = (await readJsonBounded(request)) as typeof body; // bound BEFORE parse (OOM guard) — small creds payload
  } catch (e) {
    if (e instanceof BodyTooLargeError) return json({ error: 'request body too large' }, 413);
    return json({ error: 'invalid JSON body' }, 400);
  }
  const slug = typeof body?.slug === 'string' ? body.slug : '';
  const secret = body?.secret;
  if (!slug || !secret || typeof secret !== 'object' || Array.isArray(secret)) {
    return json({ error: 'slug (string) and secret (object) are required' }, 400);
  }
  // Datasource endpoints are user-supplied → SSRF-guard the literal host before storing (the connector
  // Lambda re-checks at connect time). Always-block metadata/loopback/...; private RFC1918/ULA allowed.
  const endpoint = (secret as Record<string, unknown>).endpoint;
  if (typeof endpoint === 'string' && endpoint) {
    try { assertDatasourceEndpointAllowed(endpoint); }
    catch (e) { return json({ error: (e as Error).message }, 400); }
  }
  try {
    // SECURITY: do not log or echo the credential value — sensitive.
    await setIntegrationCredential(slug, secret as Record<string, unknown>);
    return json({ ok: true }, 200);
  } catch (e) {
    // Bad slug / size / store failure. The message never contains the credential value.
    return json({ error: (e as Error).message }, 400);
  }
}
