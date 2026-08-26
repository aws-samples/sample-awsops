import { verifyUser } from '@/lib/auth';
import { isAllowed } from '@/lib/eks-registry';
import { eksControlPlane, eksClusterCI, eksNodesCI } from '@/lib/metrics';

export const dynamic = 'force-dynamic';

// EKS diagnosis metrics (owner 가이드): AWS/EKS 컨트롤 플레인 + ContainerInsights 클러스터/노드.
// CloudWatch-only — in-cluster signals (conditions, addon health) come from the incluster route.
const RANGE_ALLOWED = [3600, 21600, 86400, 604800];

export async function GET(request: Request, { params }: { params: { cluster: string } }) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  if (!(await isAllowed(params.cluster))) {
    return Response.json({ status: 'error', message: 'unknown cluster' }, { status: 404 });
  }
  const rangeRaw = Number(new URL(request.url).searchParams.get('range') ?? 3600);
  const range = RANGE_ALLOWED.includes(rangeRaw) ? rangeRaw : 3600;
  const [controlPlane, cluster, nodes] = await Promise.all([
    eksControlPlane(params.cluster, undefined, range),
    eksClusterCI(params.cluster, undefined, range),
    eksNodesCI(params.cluster, undefined, range),
  ]);
  return Response.json({ range, controlPlane, cluster, nodes });
}
