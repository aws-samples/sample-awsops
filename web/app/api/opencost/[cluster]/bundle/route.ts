import { verifyUser } from '@/lib/auth';
import { isClusterOnboarded } from '@/lib/opencost-allowlist';
import { getOpencostConfig } from '@/lib/opencost-config';
import { renderValuesYaml, renderInstallSh, DEFAULT_CHART_VERSION, DEFAULT_CURATED_VALUES, type OpencostCuratedValues } from '@/lib/opencost';

export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

// GET — downloadable install bundle (values.yaml + install.sh). Generated from saved config
// (or defaults). cluster identity + region are injected from the path/env, never trusted from
// stored config. Read-only: the user runs the bundle out-of-band on their own kubeconfig.
export async function GET(request: Request, { params }: { params: { cluster: string } }) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ status: 'error', message: 'unauthenticated' }, 401);
  if (!(await isClusterOnboarded(params.cluster))) return json({ status: 'error', message: 'unknown cluster' }, 404);
  try {
    const region = process.env.AWS_REGION || 'ap-northeast-2';
    const saved = await getOpencostConfig(params.cluster);
    const storedValues = ((saved?.config?.values as Record<string, unknown>) ?? {}) as Partial<OpencostCuratedValues>;
    const storedOverride = saved?.config?.override as Record<string, unknown> | undefined;
    const chartVersion = saved?.chartVersion || DEFAULT_CHART_VERSION;
    const values: OpencostCuratedValues = {
      ...DEFAULT_CURATED_VALUES,
      ...storedValues,
      defaultClusterId: params.cluster, // identity always from the path
      awsRegion: region,
    };
    const valuesYaml = renderValuesYaml({ chartVersion, values, override: storedOverride });
    const installSh = renderInstallSh({ cluster: params.cluster, region, chartVersion });
    return json({ valuesYaml, installSh, chartVersion }, 200);
  } catch (e) {
    return json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, 500);
  }
}
