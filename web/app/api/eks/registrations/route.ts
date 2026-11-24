import { verifyUser } from '@/lib/auth';
import { getAllowedClusters } from '@/lib/eks-registry';
import { currentAccountId } from '@/lib/account';
import { parseEksClusterId } from '@/lib/eks-cluster-id';
import { eksErrorStatus } from '@/lib/eks-scope';
import { eksReadFailure } from '@/lib/eks-read-error';

export const dynamic = 'force-dynamic';

// Every registered EKS cluster (Aurora registry plus env-configured clusters), for the client's trace-join name
// uniqueness check (web/lib/eks-fleet.ts). Listings only cover each account's configured regions, so a registered
// cluster elsewhere would otherwise be invisible. Registry rows only: no AWS call, no access state. Clusters of
// disabled accounts are kept (more names is more conservative). A bare id is a host cluster in the deployment
// region (host account = currentAccountId(): the numeric id, or `self` without HOST_ACCOUNT_ID; the client
// canonicalizes both). An unavailable registry fails the read (503) instead of returning a partial set; an id that
// does not parse is dropped and flags the list `truncated: true` (`unparsed`: how many) so it is never taken as complete.
export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  let ids: Set<string>;
  try { ids = await getAllowedClusters(true); }
  catch (error) {
    return Response.json({ status: 'error', ...eksReadFailure(error, 'eks-registrations') }, { status: eksErrorStatus(error, 503) });
  }
  const deploymentRegion = process.env.AWS_REGION || 'ap-northeast-2';
  let unparsed = 0;
  const clusters = [...ids].sort().flatMap((id) => {
    const parsed = parseEksClusterId(id);
    if (!parsed) { unparsed++; return []; }
    return [{ id, name: parsed.name, accountId: parsed.accountId ?? currentAccountId(), region: parsed.region ?? deploymentRegion }];
  });
  // getAllowedClusters reads the whole registry (no row cap), so the list is complete only when every registry id
  // parsed. A dropped (legacy or hand-edited) id could hide a same-named cluster, so the list is then flagged
  // `truncated: true` with the count of dropped ids (never their text); the client treats that as an incomplete fleet.
  const headers = { 'Cache-Control': 'private, no-store' };
  if (unparsed > 0) return Response.json({ clusters, truncated: true, unparsed }, { headers });
  return Response.json({ clusters, truncated: false }, { headers });
}
