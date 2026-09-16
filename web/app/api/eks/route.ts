import { verifyUser } from '@/lib/auth';
import { listClusterInventory } from '@/lib/aws';
import { getAllowedClusters, isEnvCluster, getAuthModes } from '@/lib/eks-registry';
import { hasAccessEntry, onboardingGuide } from '@/lib/eks-access';
import { isAdmin } from '@/lib/admin';
import { currentAccountId } from '@/lib/account';
import { qualifiedEksClusterId } from '@/lib/eks-cluster-id';
import { getEksScope, eksErrorStatus, mapEksConcurrent } from '@/lib/eks-scope';

export const dynamic = 'force-dynamic';

export type AccessState = 'connected' | 'entry-only' | 'no-entry' | 'unknown';

export async function GET(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  try {
    const [scope, allowed, authModes] = await Promise.all([
      getEksScope(new URL(request.url).searchParams), getAllowedClusters(true), getAuthModes(),
    ]);
    const results = await mapEksConcurrent(scope.targets, async target => {
      try {
        const inventory = await listClusterInventory(target.accountId, target.region);
        const clusters = await mapEksConcurrent(inventory.clusters, async (c) => {
          const hostDefault = target.accountId === 'self' && target.region === (process.env.AWS_REGION || 'ap-northeast-2');
          const id = hostDefault ? c.name : qualifiedEksClusterId(
            c.name, target.accountId === 'self' ? currentAccountId() : target.accountId, target.region,
          );
          let access: AccessState;
          const isEnv = isEnvCluster(id);
          const authMode = authModes.get(id);
          if (authMode) {
            access = 'connected'; // Aurora-stored auth (SA token / AssumeRole) — no access entry needed
          } else if (allowed.has(id) && isEnv) {
            access = 'connected'; // Terraform guarantees the entry — skip the per-row API call
          } else {
            const entry = await hasAccessEntry(id);
            if (allowed.has(id)) {
              // runtime-registered: re-verify the entry (spec: connected = allowed AND entry) —
              // a revoked entry shows as no-entry again (guide + still unregisterable)
              access = entry === true ? 'connected' : entry === false ? 'no-entry' : 'unknown';
            } else {
              access = entry === true ? 'entry-only' : entry === false ? 'no-entry' : 'unknown';
            }
          }
          // v1 parity: the onboarding script is ALWAYS visible for not-yet-connected clusters
          // (role ARN is cached — per-row cost is string templating only).
          const guide = access === 'connected' ? undefined : await onboardingGuide(id);
          return { ...c, id, accountId: target.accountId === 'self' ? currentAccountId() : target.accountId,
            region: target.region, access, runtime: allowed.has(id) && !isEnv, authMode, guide };
        });
        return { clusters, truncated: inventory.truncated, error: undefined };
      } catch (error) {
        return { clusters: [], truncated: false, error: {
          ...target, message: error instanceof Error ? error.message.slice(0, 300) : 'EKS inventory query failed',
        } };
      }
    });
    const admin = await isAdmin(user);
    const queryErrors = results.flatMap(result => result.error ? [result.error] : []);
    const errors = [...(scope.errors ?? []), ...queryErrors];
    const failed = results.length > 0 && queryErrors.length === results.length;
    return Response.json({
      clusters: results.flatMap(result => result.clusters), admin,
      region: scope.targets.length === 1 ? scope.targets[0].region : undefined,
      truncated: scope.truncated || results.some(result => result.truncated), errors,
      ...(failed ? { status: 'error', message: queryErrors[0].message } : {}),
    }, { status: failed ? 502 : 200 });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: eksErrorStatus(e) });
  }
}
