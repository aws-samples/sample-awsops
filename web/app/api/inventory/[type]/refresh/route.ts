import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { triggerSync, readResources, assertInventoryTypeAllowed } from '@/lib/inventory';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// Manual inventory collection spends the shared control-plane quota budget, so every type is
// admin-only. The per-type gate remains as defense in depth for sensitive IAM inventory.
export async function POST(request: Request, { params }: { params: { type: string } }) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  if (!(await isAdmin(user))) {
    return Response.json({ status: 'error', message: 'admin only' }, { status: 403 });
  }
  const gate = await assertInventoryTypeAllowed(params.type, user);
  if (gate) return Response.json({ status: 'error', message: gate.message }, { status: gate.status });
  try {
    const sync = await triggerSync(params.type); // enqueue bounded Steampipe -> Aurora refresh
    const page = await readResources(params.type, { limit: 100, offset: 0 });
    return Response.json({ ...page, sync });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 503 });
  }
}
