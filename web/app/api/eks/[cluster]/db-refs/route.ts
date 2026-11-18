import { eksReadFailure } from '@/lib/eks-read-error';
import { verifyUser } from '@/lib/auth';
import { listDbRefs } from '@/lib/eks-db-refs';
import { resolveDbHosts } from '@/lib/db-ref-resolve';
import { isAllowed } from '@/lib/eks-registry';
import { resolveEksCluster, EksScopeError } from '@/lib/eks-context';

export const dynamic = 'force-dynamic';

const HEADERS = { 'Cache-Control': 'private, no-store' };
// Only the scope params resolveEksCluster reads are accepted.
const SCOPE_PARAMS = new Set(['account', 'region']);

export async function GET(request: Request, { params: pendingParams }: { params: Promise<{ cluster: string }> }) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401, headers: HEADERS });
  }
  try {
    const params = await pendingParams;
    const search = new URL(request.url).searchParams;
    for (const key of search.keys()) {
      if (!SCOPE_PARAMS.has(key)) {
        return Response.json({ status: 'error', message: 'unsupported query parameter' }, { status: 400, headers: HEADERS });
      }
    }
    const context = await resolveEksCluster(params.cluster, search);
    if (!(await isAllowed(context.id))) {
      return Response.json({ status: 'error', message: 'unknown cluster' }, { status: 404, headers: HEADERS });
    }
    const result = await listDbRefs(context.id);
    const resources = await resolveDbHosts([...new Set(result.refs.map(r => r.host))], context.accountId);
    // Explicit allow-list serialization: no value, error body or extra field can pass through.
    return Response.json({
      refs: result.refs.map(r => {
        const found = resources.get(r.host);
        return {
          workload: { namespace: r.workload.namespace, name: r.workload.name },
          via: r.via, host: r.host, kind: r.kind,
          resource: found ? { type: found.type, id: found.id, region: found.region, accountId: found.accountId } : null,
        };
      }),
      secretRefs: result.secretRefs.map(s => ({ workload: { namespace: s.workload.namespace, name: s.workload.name }, secret: s.secret })),
      truncated: result.truncated, partial: result.partial,
    }, { headers: HEADERS });
  } catch (e) {
    return Response.json({ status: 'error', ...eksReadFailure(e, 'db-refs') }, { status: e instanceof EksScopeError ? e.status : 502, headers: HEADERS });
  }
}
