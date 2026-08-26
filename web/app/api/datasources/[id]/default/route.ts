// POST /api/datasources/[id]/default — make this instance the default for its kind. Admin-gated.
// setDefaultDatasource unsets other defaults of the kind (transactional) and mirrors the credential
// under the kind key (agent gateway no-inline path).
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { setDefaultDatasource } from '@/lib/datasources';

export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ error: 'unauthenticated' }, 401);
  if (!(await isAdmin(user))) return json({ error: 'admin access required' }, 403);
  const id = Number(params?.id);
  if (!Number.isInteger(id) || id <= 0) return json({ error: 'valid id required' }, 400);
  try {
    await setDefaultDatasource(id);
    return json({ ok: true }, 200);
  } catch (e) {
    const msg = (e as Error).message || 'set-default failed';
    return json({ error: msg }, /not found/i.test(msg) ? 404 : 400);
  }
}
