import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { isClusterOnboarded } from '@/lib/opencost-allowlist';
import { getOpencostConfig, upsertOpencostConfig } from '@/lib/opencost-config';
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
  const ok = await upsertOpencostConfig({
    cluster: params.cluster,
    chartVersion: body.chartVersion ?? null,
    config: body.config ?? {},
    updatedBy: user.sub,
  });
  if (!ok) return json({ status: 'error', message: 'config storage unavailable' }, 503);
  return json({ saved: true }, 200);
}
