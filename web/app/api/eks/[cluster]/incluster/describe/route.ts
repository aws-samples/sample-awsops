import { verifyUser } from '@/lib/auth';
import { isAllowed } from '@/lib/eks-registry';
import { describeInCluster, isDescribableKind } from '@/lib/eks-incluster';

export const dynamic = 'force-dynamic';

// EKS 탐색기 describe (v1 K9s row-describe parity) — ONE full object, read-only GET.
// Security posture matches the list path: secrets are not a Kind (never describable);
// configmap data VALUES are redacted in the lib; managedFields stripped.
const NAME_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/; // RFC1123 subdomain

export async function GET(request: Request, { params }: { params: { cluster: string } }) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  if (!(await isAllowed(params.cluster))) {
    return Response.json({ status: 'error', message: 'unknown cluster' }, { status: 404 });
  }
  const url = new URL(request.url);
  const kind = url.searchParams.get('kind') ?? '';
  const name = url.searchParams.get('name') ?? '';
  const namespace = url.searchParams.get('namespace') ?? undefined;
  if (!isDescribableKind(kind)) {
    return Response.json({ status: 'error', message: 'kind not describable' }, { status: 400 });
  }
  if (!NAME_RE.test(name) || (namespace && !NAME_RE.test(namespace))) {
    return Response.json({ status: 'error', message: 'invalid name/namespace' }, { status: 400 });
  }
  try {
    return Response.json({ object: await describeInCluster(params.cluster, kind, name, namespace) });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
