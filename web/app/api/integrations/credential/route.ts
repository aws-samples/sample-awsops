// Admin-gated credential-write route for integrations (DevOps-agent-style).
// PUT stores one integration's credential in the single Secrets Manager secret (keyed by slug=kind);
// GET returns which slugs are configured (keys only). SECURITY: never log/echo the credential value.
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import {
  setIntegrationCredential,
  setMcpPresetCredential,
  getConfiguredSlugs,
  getConfiguredMcpPresetSlugs,
  getConfiguredIds,
} from '@/lib/integration-credentials';
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
    // Keep the plain connector-mirror slugs and the ADR-017 namespaced ("mcp:<slug>") MCP-preset
    // slugs as TWO DISTINCT sets (round-2 review MAJOR, 2026-07-31: merging them into one
    // `configured` set let the UI claim a preset was "configured" from a plain datasource-mirror
    // credential while the namespaced "mcp:" key — the ONLY one provision.py reads — was actually
    // empty, or vice versa). `configured` also strips any stray "mcp:"/numeric-id keys that
    // getConfiguredSlugs' unfiltered Object.keys() would otherwise leak in.
    const [rawSlugs, mcpConfigured, configuredIds] = await Promise.all([
      getConfiguredSlugs(),
      getConfiguredMcpPresetSlugs(),
      getConfiguredIds(),
    ]);
    const configured = rawSlugs.filter((k) => !k.startsWith('mcp:') && !/^\d+$/.test(k));
    return json({ configured, mcpConfigured, configuredIds }, 200);
  } catch (e) {
    const name = (e as { name?: string })?.name || '';
    if (/AccessDenied|ResourceNotFound|NotFound/i.test(name)) {
      return json({ configured: [], mcpConfigured: [], configuredIds: [] }, 200);
    }
    console.error('[credential GET] unexpected error reading configured integrations:', name);
    return json({ error: 'failed to read configured integrations' }, 500);
  }
}

export async function PUT(request: Request) {
  const g = await gate(request);
  if (g.resp) return g.resp;
  let body: { slug?: unknown; secret?: unknown; official?: unknown };
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
    // official=true (ADR-017 ConnectorsTab MCP presets) writes to the namespaced "mcp:<slug>" key
    // so it never collides with the plain-slug datasource-connector kind-mirror for the 5 slugs
    // that are members of BOTH catalogs (clickhouse/tempo/jaeger/dynatrace/datadog) — see
    // integration-credentials.ts. Absent/false = unchanged legacy behavior (Notion, datasource
    // connector saves).
    if (body?.official === true) {
      await setMcpPresetCredential(slug, secret as Record<string, unknown>);
    } else {
      await setIntegrationCredential(slug, secret as Record<string, unknown>);
    }
    return json({ ok: true }, 200);
  } catch (e) {
    // Bad slug / size / store failure. The message never contains the credential value.
    return json({ error: (e as Error).message }, 400);
  }
}
