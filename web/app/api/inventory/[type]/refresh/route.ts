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
  // Gap L79 (v1 header force-refresh parity): 'all' dispatches the sync Lambda's own
  // type=all fan-out (one Event invoke; every registered type refreshes under the Lambda's
  // reserved-concurrency backpressure — the same path the 15-min EventBridge schedule takes).
  // No rows are read back (readResources('all') is not a type), so the per-type
  // ADMIN_ONLY_TYPES read-gate is not in play — the admin check above is the authorization.
  if (params.type === 'all') {
    if (!process.env.INV_SYNC_FUNCTION) {
      return Response.json({ status: 'unconfigured', message: 'inventory sync disabled' }, { status: 503 });
    }
    try {
      const sync = await triggerSync('all');
      return Response.json({ ...sync, dispatched: 'all' });
    } catch {
      // enqueue failures disclose no Lambda exception text (same contract as /api/security/refresh)
      return Response.json({ status: 'error', message: 'sync enqueue failed' }, { status: 503 });
    }
  }
  const gate = await assertInventoryTypeAllowed(params.type, user);
  if (gate) return Response.json({ status: 'error', message: gate.message }, { status: gate.status });
  try {
    const sync = await triggerSync(params.type); // enqueue bounded Steampipe -> Aurora refresh
    const page = await readResources(params.type, { limit: 100, offset: 0 });
    return Response.json({ ...page, sync });
  } catch {
    // generic message, same non-disclosure contract as the 'all' branch (a Lambda/DB error
    // can embed ARNs/account IDs); detail stays server-side
    return Response.json({ status: 'error', message: 'refresh failed' }, { status: 503 });
  }
}
