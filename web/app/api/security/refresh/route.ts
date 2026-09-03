import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { triggerSync } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

// The security-relevant inventory types feeding /api/security findings.
const TYPES = ['s3_public_access', 'security_group', 'ebs_volume', 'iam_user'] as const;

export async function POST(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  if (!(await isAdmin(user))) {
    return Response.json({ status: 'error', message: 'admin only' }, { status: 403 });
  }
  // triggerSync reads INV_SYNC_FUNCTION; when unset (steampipe disabled) it throws — report disabled.
  if (!process.env.INV_SYNC_FUNCTION) {
    return Response.json({ status: 'unconfigured', message: 'inventory sync disabled' }, { status: 503 });
  }
  // Enqueue independently so one rejected type cannot stop later types. Responses disclose only
  // the safe type names and counts, never the underlying Lambda exception text.
  const outcomes = await Promise.allSettled(TYPES.map((type) => triggerSync(type)));
  const queuedTypes = TYPES.filter((_, index) => {
    const outcome = outcomes[index];
    return outcome.status === 'fulfilled' && outcome.value.status === 'queued';
  });
  const failedTypes = TYPES.filter((_, index) => !queuedTypes.includes(TYPES[index]));
  const status = queuedTypes.length === 0
    ? 'failed'
    : failedTypes.length > 0
      ? 'partial'
      : 'refreshing';
  return Response.json({
    status,
    types: TYPES,
    queuedCount: queuedTypes.length,
    failedCount: failedTypes.length,
    queuedTypes,
    failedTypes,
  }, { status: queuedTypes.length > 0 ? 202 : 503 });
}
