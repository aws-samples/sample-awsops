// POST (create) / PATCH (update) a datasource instance. Admin-gated. Persists the row via
// datasources.ts and the credential (flat connConfig blob) under the instance id. When the instance is
// (or becomes) the default for its kind, the kind-mirror credential is refreshed so the agent gateway
// no-inline path resolves to it. SECURITY: the credential value is never logged or echoed.
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { createDatasource, updateDatasource, getDatasource, sanitizeDsSettings, withDatasourceLock } from '@/lib/datasources';
import { setIntegrationCredentialById, mirrorDefaultCredential, getCredentialById } from '@/lib/integration-credentials';
import { isDatasourceKind } from '@/lib/integrations-category';
import { assertDatasourceEndpointAllowed } from '@/lib/ssrf-guard';
import { readJsonBounded, BodyTooLargeError } from '@/lib/http-body';
import { invokeMcpLambdaTool, type ConnConfig } from '@/lib/mcp-lambda-invoke';
import { upsertSchema } from '@/lib/datasource-schema';
import { enqueueDatasourceIndex } from '@/lib/diag-signals';
import { currentAccountId } from '@/lib/account';

export const dynamic = 'force-dynamic';

const AUTH_TYPES = ['none', 'basic', 'bearer', 'custom_header'];
// The only keys a client may place in the credential blob via `creds` — anything else
// (endpoint/database/timeoutS/...) must come through its own validated field, never smuggled
// through the creds spread (round-5: creds.endpoint would otherwise override the validated
// endpoint in the blob without tripping the host-change guard).
const CRED_KEYS = ['username', 'password', 'token', 'headerName', 'headerValue', 'headerName2', 'headerValue2', 'org_id'] as const;
/** True when a present `settings` value is not a plain object — 400, never a silent clear
 *  (round-8: null/array/string/number shapes bypassed the round-6 empty-sanitize guard). */
function settingsShapeInvalid(body: Record<string, unknown>): boolean {
  return 'settings' in body
    && (body.settings === null || typeof body.settings !== 'object' || Array.isArray(body.settings));
}
function pickCredKeys(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const o = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of CRED_KEYS) if (k in o) out[k] = o[k];
  return out;
}

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
  const creds = pickCredKeys(body.creds) ?? {};
  // gap L203: connection settings — sanitized. A non-empty settings object that sanitizes to
  // EMPTY is a 400 (round-6: a fully-invalid direct-API payload must not read as an explicit
  // clear); a NON-OBJECT settings value is a 400 too (round-8 — null/array/string shapes
  // bypassed the object-only guard); individually invalid keys alongside valid ones drop.
  if (settingsShapeInvalid(body)) return json({ error: 'settings must be an object' }, 400);
  const settings = sanitizeDsSettings(body.settings);
  // database is ClickHouse-only config — never persist it on the row for other kinds either
  // (round-12: the blob-side delete alone left stale, admin-visible row config).
  if (kind !== 'clickhouse') delete settings.database;
  if (body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings)
      && Object.keys(body.settings as object).length > 0 && Object.keys(settings).length === 0) {
    return json({ error: 'invalid settings (timeoutS 1–60 integer; database identifier, non-system)' }, 400);
  }

  if (!name) return json({ error: 'name required' }, 400);
  if (!isDatasourceKind(kind)) return json({ error: 'unknown datasource kind' }, 400);
  if (!endpoint) return json({ error: 'endpoint required' }, 400);
  try { assertDatasourceEndpointAllowed(endpoint); } catch (e) { return json({ error: (e as Error).message }, 400); }

  // Settings ride the secret blob too (non-secret config, but it keeps the agent/worker
  // connector path credential-blind — load_datasource reads only the secret map there).
  const blob = { endpoint, authType, ...creds, ...settings };
  try {
    const id = await createDatasource({ name, kind, endpoint, authType: authType as 'none', settings });
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
  // The ENTIRE read→merge→write span is serialized per datasource (round-10: interleaved
  // PATCHes could write a pre-scrub merge base back over a host-change scrub, rebinding
  // stored write-only credentials to the newly pointed endpoint). ds is read INSIDE the
  // lock so the merge always starts from the latest committed row.
  return withDatasourceLock(id, async (client) => {
  const ds = await getDatasource(id, client);
  if (!ds) return json({ error: 'datasource not found' }, 404);

  const name = typeof body.name === 'string' ? body.name.trim() : undefined;
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : undefined;
  const authType = typeof body.authType === 'string' && AUTH_TYPES.includes(body.authType) ? body.authType : undefined;
  const creds = pickCredKeys(body.creds);
  // gap L203: settings update only when the key is present (absent ≠ clear; {} clears).
  // A NON-EMPTY object sanitizing to empty is a 400 (round-6), and a NON-OBJECT settings
  // value is a 400 too (round-8) — never a silent clear.
  if (settingsShapeInvalid(body)) return json({ error: 'settings must be an object' }, 400);
  const settings = body.settings !== undefined ? sanitizeDsSettings(body.settings) : undefined;
  if (settings !== undefined && ds.kind !== 'clickhouse') delete settings.database;
  if (body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings)
      && Object.keys(body.settings as object).length > 0 && settings !== undefined && Object.keys(settings).length === 0) {
    return json({ error: 'invalid settings (timeoutS 1–60 integer; database identifier, non-system)' }, 400);
  }

  if (endpoint !== undefined) {
    try { assertDatasourceEndpointAllowed(endpoint); } catch (e) { return json({ error: (e as Error).message }, 400); }
  }
  // Re-write the id credential when any connection field changed (so updateDatasource's mirror is fresh).
  // MERGE onto the EXISTING blob — setIntegrationCredentialById is a full replace, so a
  // settings-only (or endpoint-only) PATCH that reconstructed the blob from scratch would
  // silently destroy the stored auth material (username/password/token/headers) and, for a
  // default instance, mirror the de-authenticated blob to the kind key the agent path reads.
  // The merge is NOT blind (round-3 review):
  //  - settings keys are stripped from the existing blob whenever the request carries
  //    `settings` — `{}` genuinely clears and a partial replace leaves no stale sibling;
  //  - auth material never follows an ENDPOINT HOST change unless creds are re-supplied
  //    (write-only credentials must not become admin-extractable by pointing the row at a
  //    new host — the next query would transmit them there);
  //  - keys outside the EFFECTIVE authType are pruned (basic→none leaves no residue).
  // Write order (rounds 4–5, comment corrected round 10): (1) name preflight — the only
  // unique-constraint field — so a duplicate-name 409 commits nothing; (2) the CREDENTIAL
  // strip/rewrite; (3) the row update (endpoint etc.). On a host change WITHOUT re-supplied
  // creds this order is fail-safe in both directions (secret-write failure → row stays on
  // the old host; row failure → stripped blob is unauthenticated). Residual, disclosed:
  // when creds ARE re-supplied together with a host change and the row update then fails,
  // the NEW credential can transmit to the OLD host until the admin retries.
  if (name !== undefined && name !== ds.name) {
    try {
      await updateDatasource(id, { name }, client);
    } catch (e) {
      const msg = (e as Error).message || 'update failed';
      return json({ error: msg }, /duplicate/i.test(msg) ? 409 : 400);
    }
  }
  if (endpoint !== undefined || authType !== undefined || creds !== undefined || settings !== undefined) {
    // Merge base: for a migrated DEFAULT instance the credential can live only under the
    // kind mirror (round-4 gate) — an id-only read would come back empty and a settings-only
    // PATCH would de-authenticate the instance AND clobber the mirror the agent path reads.
    const existing: Record<string, unknown> = { ...((await getCredentialById(id, ds.isDefault ? ds.kind : undefined)) ?? {}) };
    // Settings keys are stripped UNCONDITIONALLY (the row is authoritative; an endpoint-only
    // PATCH must not carry a historical stale timeoutS/database forward either).
    delete existing.timeoutS;
    delete existing.database;
    // ORIGIN compare (scheme+host+port — an https→http downgrade must count as a change, or
    // Basic material would transmit in cleartext); a malformed URL counts as changed.
    const originOf = (u: string | null | undefined): string | null => { try { return new URL(u ?? '').origin; } catch { return null; } };
    // Defense in depth (round-9): the kind mirror could in principle hold ANOTHER same-kind
    // instance's blob — trust it as a merge base only when its endpoint origin matches THIS
    // row's; otherwise drop the auth keys rather than bind foreign creds to this endpoint.
    if (ds.isDefault && existing.endpoint && originOf(String(existing.endpoint)) !== originOf(ds.endpoint)) {
      for (const k of CRED_KEYS) delete existing[k];
    }
    const hostChanged = endpoint !== undefined && originOf(endpoint) !== originOf(ds.endpoint);
    // On a host change, stored auth material is dropped UNCONDITIONALLY (round-5: a partial
    // creds object like {username} must not carry the stored password to the new origin) —
    // whatever the client genuinely re-supplied is reinstated by the creds spread below.
    if (hostChanged) {
      for (const k of CRED_KEYS) delete existing[k]; // org_id included — tenant id is host-scoped
    }
    const effAuth = authType ?? ds.authType ?? 'none';
    const KEEP_BY_AUTH: Record<string, readonly string[]> = {
      none: [], basic: ['username', 'password'], bearer: ['token'],
      custom_header: ['headerName', 'headerValue', 'headerName2', 'headerValue2'],
    };
    for (const k of CRED_KEYS) if (k !== 'org_id' && !(KEEP_BY_AUTH[effAuth] ?? []).includes(k)) delete existing[k];
    // creds is key-allowlisted (pickCredKeys) so nothing here can override the validated
    // endpoint/authType/settings fields regardless of spread order.
    const blob: Record<string, unknown> = {
      ...existing,
      ...(creds ?? {}),
      endpoint: endpoint ?? ds.endpoint ?? '',
      authType: effAuth,
      ...(settings ?? ds.settings),
    };
    // Prune the FINAL blob too (round-10: {authType:'none', creds:{password}} re-added the
    // key AFTER the merge-base pruning) — keys outside the effective authType never persist.
    for (const k of CRED_KEYS) if (k !== 'org_id' && !(KEEP_BY_AUTH[effAuth] ?? []).includes(k)) delete blob[k];
    // database is ClickHouse-only config — never persist it for other kinds (inert but stale).
    if (ds.kind !== 'clickhouse') delete blob.database;
    await setIntegrationCredentialById(id, blob, client);
    // updateDatasource (below) re-mirrors from the freshly written id blob for a default
    // instance; this explicit refresh keeps the mirror correct even when the row update has
    // nothing to change.
    if (ds.isDefault) await mirrorDefaultCredential(ds.kind, blob, client);
    // A database change (set OR clear) re-grounds AI query generation — mirror POST's
    // connect-time warm (best-effort; the 6h isSchemaStale refresh remains).
    if (settings !== undefined && (settings.database ?? null) !== (ds.settings?.database ?? null)) {
      warmSchemaCache(id, ds.kind, blob as ConnConfig);
    }
  }
  try {
    await updateDatasource(id, { endpoint, authType: authType as 'none' | undefined, settings }, client);
    return json({ ok: true }, 200);
  } catch (e) {
    const msg = (e as Error).message || 'update failed';
    return json({ error: msg }, 400);
  }
  });
}
