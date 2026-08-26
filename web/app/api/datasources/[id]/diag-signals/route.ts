// GET /api/datasources/[id]/diag-signals — pre-built diagnostic signals for one datasource (Explore
// quick-query buttons). Authenticated; single-account (WHERE account_id='self'); DB read only (no egress).
import { verifyUser } from '@/lib/auth';
import { getDiagSignals } from '@/lib/diag-signals';

export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

export async function GET(request: Request, { params }: { params: { id: string } }) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ error: 'unauthenticated' }, 401);
  const id = Number(params?.id);
  if (!Number.isInteger(id) || id <= 0) return json({ error: 'valid id required' }, 400);
  try {
    return json(await getDiagSignals(id), 200);
  } catch (e) {
    console.error('[diag-signals] read failed:', e);  // detail to server logs only
    return json({ error: 'failed to load diagnostic signals' }, 500);  // generic to client (no internal leak)
  }
}
