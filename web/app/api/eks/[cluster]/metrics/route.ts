import { verifyUser } from '@/lib/auth';
import { isAllowed } from '@/lib/eks-registry';
import { eksControlPlane, eksClusterCI, eksNodesCI } from '@/lib/metrics';
import { resolveEksCluster, EksScopeError } from '@/lib/eks-context';

export const dynamic = 'force-dynamic';

// EKS diagnosis metrics (owner 가이드): AWS/EKS 컨트롤 플레인 + ContainerInsights 클러스터/노드.
// CloudWatch-only — in-cluster signals (conditions, addon health) come from the incluster route.
const RANGE_ALLOWED = [3600, 21600, 86400, 604800];

export async function GET(request: Request, { params }: { params: { cluster: string } }) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  try {
    const search = new URL(request.url).searchParams;
    const context = await resolveEksCluster(params.cluster, search);
    if (!(await isAllowed(context.id))) {
      return Response.json({ status: 'error', message: 'unknown cluster' }, { status: 404 });
    }
    const rangeRaw = Number(search.get('range') ?? 3600);
    const range = RANGE_ALLOWED.includes(rangeRaw) ? rangeRaw : 3600;
    const [controlPlane, cluster, nodes] = await Promise.all([
      eksControlPlane(context.name, context.region, range, context.accountId),
      eksClusterCI(context.name, context.region, range, context.accountId),
      eksNodesCI(context.name, context.region, range, 100, context.accountId),
    ]);
    return Response.json({ range, controlPlane, cluster, nodes });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: e instanceof EksScopeError ? e.status : 502 });
  }
}
