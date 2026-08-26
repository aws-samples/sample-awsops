import { verifyUser } from '@/lib/auth';
import { getAllowedClusters } from '@/lib/eks-registry';
import { listInCluster, type NodeRow, type PodRow, type DeploymentRow, type ServiceRow, type EventRow } from '@/lib/eks-incluster';
import { aggregateNodeResources, instanceTypeDistribution } from '@/lib/eks-resources';
import { podStatusCounts, podsByNamespace } from '@/lib/eks-tab-stats';

export const dynamic = 'force-dynamic';

// v1 /k8s Overview parity: per-cluster live aggregates, computed SERVER-side.
// Raw pod rows never ship to the client (thin-BFF) — only small aggregates do.
// Per-cluster failures degrade to reachable:false; even a registry failure
// returns 200 + an empty fleet (the fleet view must not 500).
// NOTE: per-cluster podsByNamespace is pre-capped at 10, so any cross-cluster
// merge is an approximation near the cut — acceptable for an overview.

const EVENTS_CAP = 25;
const NS_CAP = 10;

const empty = (name: string) => ({
  name, reachable: false,
  counts: { nodes: 0, nodesReady: 0, pods: 0, podsRunning: 0, deployments: 0, services: 0 },
  nodeAgg: [], instanceTypes: [], podStatus: {}, podsByNamespace: [], events: [],
});

export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  let names: string[] = [];
  try { names = [...(await getAllowedClusters())]; } catch { return Response.json({ clusters: [] }); }
  const clusters = await Promise.all(names.map(async (name) => {
    try {
      const [nodes, pods, deployments, services, events] = await Promise.all([
        listInCluster(name, 'nodes') as Promise<NodeRow[]>,
        listInCluster(name, 'pods') as Promise<PodRow[]>,
        listInCluster(name, 'deployments') as Promise<DeploymentRow[]>,
        listInCluster(name, 'services') as Promise<ServiceRow[]>,
        (listInCluster(name, 'events') as Promise<EventRow[]>).catch(() => [] as EventRow[]), // events-only failure must not kill the cluster entry
      ]);
      return {
        name,
        reachable: true,
        counts: {
          nodes: nodes.length,
          nodesReady: nodes.filter((n) => n.status === 'Ready').length,
          pods: pods.length,
          podsRunning: pods.filter((p) => p.status === 'Running').length,
          deployments: deployments.length,
          services: services.length,
        },
        nodeAgg: aggregateNodeResources(nodes, pods),
        instanceTypes: instanceTypeDistribution(nodes),
        podStatus: podStatusCounts(pods),
        podsByNamespace: podsByNamespace(pods).slice(0, NS_CAP),
        events: [...events].sort((a, b) => b.lastSeenTs - a.lastSeenTs).slice(0, EVENTS_CAP),
      };
    } catch {
      return empty(name);
    }
  }));
  return Response.json({ clusters });
}
