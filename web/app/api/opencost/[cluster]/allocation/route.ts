import { verifyUser } from '@/lib/auth';
import { isClusterOnboarded } from '@/lib/opencost-allowlist';
import { getAllocation } from '@/lib/opencost-allocation';
import { resolveEksCluster, EksScopeError } from '@/lib/eks-context';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** OpenCost 1-day allocation for one onboarded cluster (KPI + per-pod costs). Degrade-safe. */
export async function GET(request: Request, { params }: { params: { cluster: string } }) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  try {
    const context = await resolveEksCluster(params.cluster, new URL(request.url).searchParams);
    if (!(await isClusterOnboarded(context.id))) {
      return Response.json({ available: false, message: 'cluster not onboarded' }, { status: 200 });
    }
    return Response.json(await getAllocation(context.id));
  } catch (e) {
    return Response.json({ available: false, message: e instanceof EksScopeError ? e.message : 'OpenCost allocation is unavailable.' }, { status: e instanceof EksScopeError ? e.status : 200 });
  }
}
