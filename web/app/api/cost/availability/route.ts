import { verifyUser } from '@/lib/auth';
import { checkCostAvailability } from '@/lib/cost-availability';

export const dynamic = 'force-dynamic';

/** CE availability probe (1h cache; ?force=1 = Re-check). v1 cost-check parity. */
export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const force = new URL(request.url).searchParams.get('force') === '1';
  return Response.json(await checkCostAvailability(force));
}
