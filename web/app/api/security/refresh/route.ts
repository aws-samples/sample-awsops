import { verifyUser } from '@/lib/auth';
import { triggerSync } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

// The security-relevant inventory types feeding /api/security findings.
const TYPES = ['s3_public_access', 'security_group', 'ebs_volume', 'iam_user'] as const;

export async function POST(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  // triggerSync reads INV_SYNC_FUNCTION; when unset (steampipe disabled) it throws — report disabled.
  if (!process.env.INV_SYNC_FUNCTION) {
    return Response.json({ status: 'unconfigured', message: 'inventory sync disabled' }, { status: 503 });
  }
  // Re-sync each security type; a single failing type must not fail the whole refresh.
  await Promise.all(TYPES.map((t) => triggerSync(t).catch(() => null)));
  return Response.json({ status: 'refreshing', types: TYPES }, { status: 202 });
}
