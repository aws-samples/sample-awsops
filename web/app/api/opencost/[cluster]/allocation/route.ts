import { eksReadFailure } from '@/lib/eks-read-error';
import { verifyUser } from '@/lib/auth';
import { isClusterOnboarded } from '@/lib/opencost-allowlist';
import { getAllocation } from '@/lib/opencost-allocation';
import { resolveEksCluster, EksScopeError } from '@/lib/eks-context';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** OpenCost 1-day allocation for one onboarded cluster (KPI + per-pod costs). Degrade-safe. */
export async function GET(request: Request, { params: pendingParams }: { params: Promise<{ cluster: string }> }) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  try {
    const params = await pendingParams;
    const context = await resolveEksCluster(params.cluster, new URL(request.url).searchParams);
    if (!(await isClusterOnboarded(context.id))) {
      return Response.json({ available: false, message: 'cluster not onboarded' }, { status: 200 });
    }
    return Response.json(await getAllocation(context.id));
  } catch (e) {
    return Response.json({ available: false, ...eksReadFailure(e, 'opencost-allocation') }, { status: e instanceof EksScopeError ? e.status : 200 });
  }
}
