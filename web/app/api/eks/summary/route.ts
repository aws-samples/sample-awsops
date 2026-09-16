import { verifyUser } from '@/lib/auth';
import { getScopedEksRegistrations, eksErrorStatus, mapEksConcurrent } from '@/lib/eks-scope';
import { listInCluster, type Kind } from '@/lib/eks-incluster';

export const dynamic = 'force-dynamic';

// v1 K8s-Overview parity: aggregate live counts across every connected cluster.
// Per-cluster failures degrade to zeros for that cluster (the fleet view must not 500).

const KINDS: Kind[] = ['nodes', 'pods', 'deployments', 'services'];

export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  let scope: Awaited<ReturnType<typeof getScopedEksRegistrations>>;
  try { scope = await getScopedEksRegistrations(new URL(request.url).searchParams); }
  catch (error) {
    return Response.json({ status: 'error', message: 'EKS scope could not be loaded' },
      { status: eksErrorStatus(error, 503) });
  }
  const clusters = scope.clusters;
  const totals: Record<string, number> = { nodes: 0, pods: 0, deployments: 0, services: 0 };
  let reachable = 0;
  await mapEksConcurrent(clusters, async (cluster) => {
    try {
      const counts = await Promise.all(KINDS.map(async (k) => (await listInCluster(cluster.id, k)).length));
      KINDS.forEach((k, i) => { totals[k] += counts[i]; });
      reachable += 1;
    } catch { /* unreachable/revoked cluster — skip, keep the fleet view alive */ }
  });
  return Response.json({ clusters: clusters.length, reachable, ...totals, truncated: scope.truncated });
}
