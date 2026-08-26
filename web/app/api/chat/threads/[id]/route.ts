import { verifyUser } from '@/lib/auth';
import { getThread, deleteThread } from '@/lib/chat-store';

export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

export async function GET(request: Request, { params }: { params: { id: string } }) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ status: 'error', message: 'unauthenticated' }, 401);
  try {
    const out = await getThread(user.sub, params.id);
    if (!out) return json({ status: 'error', message: 'not found' }, 404);
    return json(out, 200);
  } catch {
    return json({ status: 'error', message: 'not found' }, 404);
  }
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ status: 'error', message: 'unauthenticated' }, 401);
  try {
    const ok = await deleteThread(user.sub, params.id);
    return ok ? json({ status: 'ok' }, 200) : json({ status: 'error', message: 'not found' }, 404);
  } catch {
    return json({ status: 'error', message: 'not found' }, 404);
  }
}
