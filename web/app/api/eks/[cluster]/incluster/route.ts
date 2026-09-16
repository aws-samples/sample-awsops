import { verifyUser } from '@/lib/auth';
import { listInCluster, isKind } from '@/lib/eks-incluster';
import { isAllowed } from '@/lib/eks-registry';
import { resolveEksCluster, EksScopeError } from '@/lib/eks-context';

export const dynamic = 'force-dynamic';

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
    const kind = search.get('kind') || '';
    if (!isKind(kind)) {
      return Response.json({ status: 'error', message: 'unknown kind' }, { status: 400 });
    }
    return Response.json({ kind, rows: await listInCluster(context.id, kind) });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof EksScopeError ? e.message : 'EKS resources are unavailable.' }, { status: e instanceof EksScopeError ? e.status : 502 });
  }
}
