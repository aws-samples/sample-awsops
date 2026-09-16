import { eksReadFailure } from '@/lib/eks-read-error';
import { verifyUser } from '@/lib/auth';
import { isClusterOnboarded } from '@/lib/opencost-allowlist';
import { detectOpencostInstall } from '@/lib/opencost-status';
import { resolveEksCluster, EksScopeError } from '@/lib/eks-context';

export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

// GET — read-only install-status badge. detectOpencostInstall already degrades on in-cluster
// 403/error, so the route returns 200 {installed:false, reason} (NOT a 5xx) for the revoked case.
export async function GET(request: Request, { params: pendingParams }: { params: Promise<{ cluster: string }> }) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ status: 'error', message: 'unauthenticated' }, 401);
  try {
    const params = await pendingParams;
    const context = await resolveEksCluster(params.cluster, new URL(request.url).searchParams);
    if (!(await isClusterOnboarded(context.id))) return json({ status: 'error', message: 'unknown cluster' }, 404);
    const status = await detectOpencostInstall(context.id);
    return json(status, 200);
  } catch (e) {
    return json({ status: 'error', ...eksReadFailure(e, 'opencost-status') }, e instanceof EksScopeError ? e.status : 500);
  }
}
