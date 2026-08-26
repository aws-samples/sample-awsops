import { verifyUser } from '@/lib/auth';
import { getAllowedClusters } from '@/lib/eks-registry';
import { getAllocation } from '@/lib/opencost-allocation';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** OpenCost 1-day allocation for one onboarded cluster (KPI + per-pod costs). Degrade-safe. */
export async function GET(request: Request, { params }: { params: { cluster: string } }) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  try {
    const allowed = await getAllowedClusters();
    if (!allowed.has(params.cluster)) {
      return Response.json({ available: false, message: 'cluster not onboarded' }, { status: 200 });
    }
    return Response.json(await getAllocation(params.cluster));
  } catch (e) {
    return Response.json({ available: false, message: e instanceof Error ? e.message : String(e) }, { status: 200 });
  }
}
