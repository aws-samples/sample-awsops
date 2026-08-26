import { verifyUser } from '@/lib/auth';
import { listClusters } from '@/lib/aws';
import { getAllowedClusters, isEnvCluster, getAuthModes } from '@/lib/eks-registry';
import { hasAccessEntry, onboardingGuide } from '@/lib/eks-access';
import { isAdmin } from '@/lib/admin';

export const dynamic = 'force-dynamic';

export type AccessState = 'connected' | 'entry-only' | 'no-entry' | 'unknown';

export async function GET(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  try {
    const accountParam = new URL(request.url).searchParams.get('account') || undefined;
    const account = accountParam === '__all__' ? undefined : accountParam;
    const [clusters, allowed, authModes] = await Promise.all([listClusters(account), getAllowedClusters(), getAuthModes()]);
    const rows = await Promise.all(clusters.map(async (c) => {
      let access: AccessState;
      const isEnv = isEnvCluster(c.name);
      const authMode = authModes.get(c.name);
      if (authMode) {
        access = 'connected'; // Aurora-stored auth (SA token / AssumeRole) — no access entry needed
      } else if (allowed.has(c.name) && isEnv) {
        access = 'connected'; // Terraform guarantees the entry — skip the per-row API call
      } else {
        const entry = await hasAccessEntry(c.name);
        if (allowed.has(c.name)) {
          // runtime-registered: re-verify the entry (spec: connected = allowed AND entry) —
          // a revoked entry shows as no-entry again (guide + still unregisterable)
          access = entry === true ? 'connected' : entry === false ? 'no-entry' : 'unknown';
        } else {
          access = entry === true ? 'entry-only' : entry === false ? 'no-entry' : 'unknown';
        }
      }
      // v1 parity: the onboarding script is ALWAYS visible for not-yet-connected clusters
      // (role ARN is cached — per-row cost is string templating only).
      const guide = access === 'connected' ? undefined : await onboardingGuide(c.name);
      return { ...c, access, runtime: allowed.has(c.name) && !isEnv, authMode, guide };
    }));
    const admin = await isAdmin(user);
    return Response.json({ clusters: rows, admin });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
