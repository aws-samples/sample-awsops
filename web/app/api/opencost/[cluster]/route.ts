import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { isClusterOnboarded } from '@/lib/opencost-allowlist';
import { getOpencostConfig, upsertOpencostConfig } from '@/lib/opencost-config';
import { assertSafeName, assertSafeYamlKeys } from '@/lib/opencost';
import { readJsonBounded, BodyTooLargeError } from '@/lib/http-body';

export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

// GET — read saved config (any authenticated user). null config = none saved (page uses defaults).
export async function GET(request: Request, { params }: { params: { cluster: string } }) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ status: 'error', message: 'unauthenticated' }, 401);
  if (!(await isClusterOnboarded(params.cluster))) return json({ status: 'error', message: 'unknown cluster' }, 404);
  const config = await getOpencostConfig(params.cluster);
  return json({ cluster: params.cluster, config }, 200);
}

// PUT — save config (admin only). Writes only the app's own Aurora (no cluster/AWS write).
export async function PUT(request: Request, { params }: { params: { cluster: string } }) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ status: 'error', message: 'unauthenticated' }, 401);
  if (!(await isAdmin(user))) return json({ status: 'error', message: 'admin only' }, 403);
  if (!(await isClusterOnboarded(params.cluster))) return json({ status: 'error', message: 'unknown cluster' }, 404);
  let body: { chartVersion?: string | null; config?: Record<string, unknown> } = {};
  try { body = (await readJsonBounded(request)) as typeof body; } // bound BEFORE parse (OOM guard)
  catch (e) { if (e instanceof BodyTooLargeError) return json({ status: 'error', message: 'request body too large' }, 413); /* tolerate empty/invalid body */ }
  // pentest-remediation P1-2 (Finding 4): fail fast at save time (400) instead of only failing when
  // the bundle is later rendered — renderValuesYaml() throws on any config key outside the
  // YAML-safe charset (a literal '\n' or ':' would otherwise rewrite YAML structure). Also validate
  // chartVersion here (same as renderInstallSh's assertSafeName), so a bad chartVersion never
  // reaches storage and permanently 500s the bundle route for this cluster.
  if (body.config !== undefined && (typeof body.config !== 'object' || body.config === null || Array.isArray(body.config))) {
    return json({ status: 'error', message: 'config must be an object' }, 400);
  }
  // pentest-remediation P1-2 round 2: assertSafeName's regex check (SAFE.test(v)) coerces its
  // argument to a string, so a non-string chartVersion (e.g. an array) silently passes validation
  // and gets stored as-is — reproducing the same permanent-500 bug this file's chartVersion check
  // exists to prevent. Reject non-string chartVersion outright, before assertSafeName ever sees it.
  if (body.chartVersion !== undefined && body.chartVersion !== null && typeof body.chartVersion !== 'string') {
    return json({ status: 'error', message: 'chartVersion must be a string' }, 400);
  }
  try {
    assertSafeYamlKeys((body.config ?? {}) as any);
    if (body.chartVersion) assertSafeName('chartVersion', body.chartVersion);
  } catch (e) {
    return json({ status: 'error', message: e instanceof Error ? e.message : 'invalid config' }, 400);
  }
  const ok = await upsertOpencostConfig({
    cluster: params.cluster,
    chartVersion: body.chartVersion ?? null,
    config: body.config ?? {},
    updatedBy: user.sub,
  });
  if (!ok) return json({ status: 'error', message: 'config storage unavailable' }, 503);
  return json({ saved: true }, 200);
}
