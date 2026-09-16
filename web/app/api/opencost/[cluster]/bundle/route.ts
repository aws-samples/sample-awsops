import { verifyUser } from '@/lib/auth';
import { isClusterOnboarded } from '@/lib/opencost-allowlist';
import { getOpencostConfig } from '@/lib/opencost-config';
import { renderValuesYaml, renderInstallSh, DEFAULT_CHART_VERSION, DEFAULT_CURATED_VALUES, type OpencostCuratedValues } from '@/lib/opencost';
import { resolveEksCluster, EksScopeError } from '@/lib/eks-context';

export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

// GET — downloadable install bundle (values.yaml + install.sh). Generated from saved config
// (or defaults). Cluster identity + region are resolved from the request, never trusted from
// stored config. Read-only: the user runs the bundle out-of-band on their own kubeconfig.
export async function GET(request: Request, { params }: { params: { cluster: string } }) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ status: 'error', message: 'unauthenticated' }, 401);
  try {
    const context = await resolveEksCluster(params.cluster, new URL(request.url).searchParams);
    if (!(await isClusterOnboarded(context.id))) return json({ status: 'error', message: 'unknown cluster' }, 404);
    const saved = await getOpencostConfig(context.id);
    const storedValues = ((saved?.config?.values as Record<string, unknown>) ?? {}) as Partial<OpencostCuratedValues>;
    const storedOverride = saved?.config?.override as Record<string, unknown> | undefined;
    const chartVersion = saved?.chartVersion || DEFAULT_CHART_VERSION;
    const values: OpencostCuratedValues = {
      ...DEFAULT_CURATED_VALUES,
      ...storedValues,
      defaultClusterId: context.name,
      awsRegion: context.region,
    };
    const valuesYaml = renderValuesYaml({ chartVersion, values, override: storedOverride });
    const installSh = renderInstallSh({
      cluster: context.name, region: context.region, chartVersion,
      accountId: context.accountId === 'self' ? undefined : context.accountId,
    });
    return json({ valuesYaml, installSh, chartVersion }, 200);
  } catch (e) {
    return json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, e instanceof EksScopeError ? e.status : 500);
  }
}
