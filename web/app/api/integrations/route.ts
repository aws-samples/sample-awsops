// ADR-039 P2 — admin-gated Integrations registration (egress connectors + ingress webhook sources).
// Registration is the egress/credential/SSRF surface → admin-only (ADR-023). Reads are SSRF-guarded
// (ADR-011) using the account's allow_private_datasource opt-in. Ingress rows get a server-generated
// receive_path. The actual Secrets Manager write + live MCP connection + edge carve-out are P2-infra.
import { randomBytes } from 'crypto';
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { currentAccountId } from '@/lib/account';
import { getPool } from '@/lib/db';
import { writeAudit } from '@/lib/catalog';
import { validateIntegration } from '@/lib/integration-validation';
import { assertEgressEndpointAllowed } from '@/lib/ssrf-guard';
import { upsertIntegration, listIntegrations, setIntegrationEnabled } from '@/lib/integrations';
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

async function getAllowPrivate(accountId: string): Promise<boolean> {
  try {
    const { rows } = await getPool().query(
      'SELECT allow_private_datasource FROM agent_spaces WHERE account_id = $1', [accountId]);
    return rows[0]?.allow_private_datasource === true;
  } catch { return false; } // fail-closed: no opt-in row ⇒ private endpoints blocked
}

export async function GET(request: Request) {
  const g = await gate(request);
  if (g.resp) return g.resp;
  return json({ integrations: await listIntegrations() }, 200);
}

export async function POST(request: Request) {
  const g = await gate(request);
  if (g.resp) return g.resp;
  let body: Record<string, unknown>;
  try { body = (await readJsonBounded(request)) as Record<string, unknown>; }
  catch (e) { if (e instanceof BodyTooLargeError) return json({ error: 'request body too large' }, 413); return json({ error: 'invalid JSON' }, 400); }

  const v = validateIntegration(body as never);
  if (!v.ok) return json({ error: 'invalid integration', detail: v.errors }, 400);

  const direction = String(body.direction);
  let receivePath: string | undefined;
  if (direction === 'egress') {
    // SSRF guard at registration (ADR-011) — allowPrivate from the account's agent_spaces opt-in.
    const allowPrivate = await getAllowPrivate(currentAccountId());
    try { assertEgressEndpointAllowed(String(body.endpoint), { allowPrivate }); }
    catch (e) { return json({ error: e instanceof Error ? e.message : 'endpoint rejected' }, 400); }
  } else {
    // ingress: generate a stable server-side receive path (the actual route handler/edge carve-out is P2-infra)
    receivePath = `/api/integrations/ingress/${randomBytes(16).toString('hex')}`;
  }

  let id: number;
  try {
    id = await upsertIntegration({
      name: String(body.name), kind: String(body.kind), direction: direction as 'egress' | 'ingress',
      description: body.description ? String(body.description) : undefined,
      endpoint: body.endpoint ? String(body.endpoint) : undefined,
      transport: body.transport ? String(body.transport) : undefined,
      credentialsRef: body.credentialsRef ? String(body.credentialsRef) : undefined,
      privateConnectionRef: body.privateConnectionRef ? String(body.privateConnectionRef) : undefined,
      capability: (body.capability as 'read' | 'read_write') ?? undefined,
      exposedTools: (body.exposedTools as string[]) ?? undefined,
      writeActionRefs: (body.writeActionRefs as string[]) ?? undefined,
      authMode: body.authMode ? String(body.authMode) : undefined,
      receivePath,
      inboundAuthRef: body.inboundAuthRef ? String(body.inboundAuthRef) : undefined,
      sourceAllowlist: (body.sourceAllowlist as string[]) ?? undefined,
      triggerTarget: body.triggerTarget ? String(body.triggerTarget) : undefined,
      tier: 'custom', createdBy: g.user!.email,
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'upsert failed' }, 409); // built-in name collision
  }
  await writeAudit({ actor: g.user!.email ?? g.user!.sub, action: 'upsert', objectType: 'integration', objectId: String(id) });
  return json({ ok: true, id, ...(receivePath ? { receivePath } : {}) }, 200);
}

export async function PUT(request: Request) {
  const g = await gate(request);
  if (g.resp) return g.resp;
  let body: Record<string, unknown>;
  try { body = (await readJsonBounded(request)) as Record<string, unknown>; }
  catch (e) { if (e instanceof BodyTooLargeError) return json({ error: 'request body too large' }, 413); return json({ error: 'invalid JSON' }, 400); }
  if (body.op === 'enable' || body.op === 'disable') {
    await setIntegrationEnabled(Number(body.id), body.op === 'enable'); // custom-only at the SQL level
    await writeAudit({ actor: g.user!.email ?? g.user!.sub, action: String(body.op), objectType: 'integration', objectId: String(body.id) });
    return json({ ok: true }, 200);
  }
  return json({ error: 'unknown op' }, 400);
}
