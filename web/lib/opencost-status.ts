// web/lib/opencost-status.ts — read-only OpenCost install detection.
// Reuses eks-incluster.listInCluster (presigned-STS, READ-only) WITHOUT modifying it.
// Degrades on any in-cluster error (incl. 403 = Access Entry revoked) — never throws (consensus).
import { listInCluster, type DeploymentRow } from '@/lib/eks-incluster';
import { OPENCOST_NAMESPACE } from '@/lib/opencost';

export interface OpencostStatus {
  installed: boolean;
  ready: boolean;
  deployment: DeploymentRow | null;
  reason?: string; // set when detection couldn't complete (degraded)
}

/** Find the opencost deployment in the opencost namespace among all deployments. Pure. */
export function pickOpencostDeployment(rows: DeploymentRow[]): DeploymentRow | null {
  return rows.find((d) => d.name === 'opencost' && d.namespace === OPENCOST_NAMESPACE) ?? null;
}

export async function detectOpencostInstall(cluster: string): Promise<OpencostStatus> {
  try {
    const rows = (await listInCluster(cluster, 'deployments')) as DeploymentRow[];
    const dep = pickOpencostDeployment(rows);
    if (!dep) return { installed: false, ready: false, deployment: null };
    // ready when available > 0 and ready is "N/N" (readyReplicas == desired)
    const ready = dep.available > 0 && /^(\d+)\/\1$/.test(dep.ready);
    return { installed: true, ready, deployment: dep };
  } catch (e) {
    // 403 (entry revoked) / transport / not-found → degrade to not-installed, do NOT throw
    return { installed: false, ready: false, deployment: null, reason: e instanceof Error ? e.message : 'unreachable' };
  }
}
