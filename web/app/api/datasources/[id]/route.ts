// DELETE /api/datasources/[id] — remove a datasource instance. Admin-gated. deleteDatasource cascades
// schema-cache rows + the id credential, re-picks a new default (or clears the kind mirror) if needed.
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { deleteDatasource } from '@/lib/datasources';

export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ error: 'unauthenticated' }, 401);
  if (!(await isAdmin(user))) return json({ error: 'admin access required' }, 403);
  const id = Number(params?.id);
  if (!Number.isInteger(id) || id <= 0) return json({ error: 'valid id required' }, 400);
  await deleteDatasource(id);
  return json({ ok: true }, 200);
}
