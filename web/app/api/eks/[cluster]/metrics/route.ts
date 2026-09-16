import { verifyUser } from '@/lib/auth';
import { isAllowed } from '@/lib/eks-registry';
import { eksDiagnosisMetrics } from '@/lib/metrics';
import { resolveEksCluster, EksScopeError } from '@/lib/eks-context';
import type { EksDiagnosisMetricsResponse } from '@/lib/eks-metrics-types';

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
    const metrics = await eksDiagnosisMetrics(context.name, context.region, range, context.accountId);
    const body: EksDiagnosisMetricsResponse = { range, accountId: context.accountId, region: context.region, ...metrics };
    return Response.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return Response.json({
      status: 'error', message: e instanceof EksScopeError ? e.message : 'EKS metrics are unavailable.',
    }, { status: e instanceof EksScopeError ? e.status : 502 });
  }
}
