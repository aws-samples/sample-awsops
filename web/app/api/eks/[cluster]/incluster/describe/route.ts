import { verifyUser } from '@/lib/auth';
import { isAllowed } from '@/lib/eks-registry';
import { describeInCluster, isDescribableKind } from '@/lib/eks-incluster';
import { resolveEksCluster, EksScopeError } from '@/lib/eks-context';

export const dynamic = 'force-dynamic';

// EKS 탐색기 describe (v1 K9s row-describe parity) — ONE full object, read-only GET.
// Security posture matches the list path: secrets are not a Kind (never describable);
// configmap data VALUES are redacted in the lib; managedFields stripped.
const NAME_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/; // RFC1123 subdomain

export async function GET(request: Request, { params }: { params: { cluster: string } }) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  try {
    const search = new URL(request.url).searchParams;
    const context = await resolveEksCluster(params.cluster, search);
    if (!(await isAllowed(context.id))) {
      return Response.json({ status: 'error', message: 'unknown cluster' }, { status: 404 });
    }
    const kind = search.get('kind') ?? '';
    const name = search.get('name') ?? '';
    const namespace = search.get('namespace') ?? undefined;
    if (!isDescribableKind(kind)) {
      return Response.json({ status: 'error', message: 'kind not describable' }, { status: 400 });
    }
    if (!NAME_RE.test(name) || (namespace && !NAME_RE.test(namespace))) {
      return Response.json({ status: 'error', message: 'invalid name/namespace' }, { status: 400 });
    }
    return Response.json({ object: await describeInCluster(context.id, kind, name, namespace) });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof EksScopeError ? e.message : 'EKS resource details are unavailable.' }, { status: e instanceof EksScopeError ? e.status : 502 });
  }
}
