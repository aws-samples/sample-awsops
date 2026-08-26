import { verifyUser } from '@/lib/auth';
import { triggerSync, readResources } from '@/lib/inventory';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(request: Request, { params }: { params: { type: string } }) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  try {
    const sync = await triggerSync(params.type); // warm Steampipe -> Aurora (seconds); 'busy' if locked
    const page = await readResources(params.type, { limit: 100, offset: 0 });
    return Response.json({ ...page, sync });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 503 });
  }
}
