import { verifyUser } from '@/lib/auth';
import { getAllowedClusters } from '@/lib/eks-registry';
import { listInCluster, type Kind } from '@/lib/eks-incluster';

export const dynamic = 'force-dynamic';

// v1 K8s-Overview parity: aggregate live counts across every connected cluster.
// Per-cluster failures degrade to zeros for that cluster (the fleet view must not 500).

const KINDS: Kind[] = ['nodes', 'pods', 'deployments', 'services'];

export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const clusters = [...(await getAllowedClusters())];
  const totals: Record<string, number> = { nodes: 0, pods: 0, deployments: 0, services: 0 };
  let reachable = 0;
  await Promise.all(clusters.map(async (cluster) => {
    try {
      const counts = await Promise.all(KINDS.map(async (k) => (await listInCluster(cluster, k)).length));
      KINDS.forEach((k, i) => { totals[k] += counts[i]; });
      reachable += 1;
    } catch { /* unreachable/revoked cluster — skip, keep the fleet view alive */ }
  }));
  return Response.json({ clusters: clusters.length, reachable, ...totals });
}
