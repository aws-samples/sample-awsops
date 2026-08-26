import { verifyUser } from '@/lib/auth';
import { isClusterOnboarded } from '@/lib/opencost-allowlist';
import { detectOpencostInstall } from '@/lib/opencost-status';

export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

// GET — read-only install-status badge. detectOpencostInstall already degrades on in-cluster
// 403/error, so the route returns 200 {installed:false, reason} (NOT a 5xx) for the revoked case.
export async function GET(request: Request, { params }: { params: { cluster: string } }) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ status: 'error', message: 'unauthenticated' }, 401);
  if (!(await isClusterOnboarded(params.cluster))) return json({ status: 'error', message: 'unknown cluster' }, 404);
  const status = await detectOpencostInstall(params.cluster);
  return json(status, 200);
}
