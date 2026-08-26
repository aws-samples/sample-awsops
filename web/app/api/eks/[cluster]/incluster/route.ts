import { verifyUser } from '@/lib/auth';
import { listInCluster, isKind } from '@/lib/eks-incluster';
import { isAllowed } from '@/lib/eks-registry';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: { cluster: string } }) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  if (!(await isAllowed(params.cluster))) {
    return Response.json({ status: 'error', message: 'unknown cluster' }, { status: 404 });
  }
  const kind = new URL(request.url).searchParams.get('kind') || '';
  if (!isKind(kind)) {
    return Response.json({ status: 'error', message: 'unknown kind' }, { status: 400 });
  }
  try {
    return Response.json({ kind, rows: await listInCluster(params.cluster, kind) });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
