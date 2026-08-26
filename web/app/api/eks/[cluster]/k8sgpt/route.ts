// web/app/api/eks/[cluster]/k8sgpt/route.ts
// ADR-035 read-only diagnosis route. Auth (verifyUser) + admin (isAdmin) + cluster-allowlist gated.
// Flag OFF (K8SGPT_ENABLED !== 'true') → 503 {enabled:false} and getDiagnosis does NO cluster read.
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { getDiagnosis } from '@/lib/k8sgpt';
import { isAllowed } from '@/lib/eks-registry';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: { cluster: string } }) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  if (!(await isAdmin(user))) return Response.json({ status: 'error', message: 'admin required' }, { status: 403 });

  if (process.env.K8SGPT_ENABLED !== 'true') {
    // Dark when off: no cluster read, no STS presign, no Bedrock — honest 503.
    return Response.json({ enabled: false, message: 'k8sgpt diagnosis disabled' }, { status: 503 });
  }

  if (!(await isAllowed(params.cluster))) {
    return Response.json({ status: 'error', message: 'unknown cluster' }, { status: 404 });
  }
  try {
    return Response.json(await getDiagnosis(params.cluster));
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
