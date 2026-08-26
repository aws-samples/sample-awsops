import { verifyUser } from '@/lib/auth';
import { listThreads, searchThreads, deleteAllThreads } from '@/lib/chat-store';

export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

export async function GET(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ status: 'error', message: 'unauthenticated' }, 401);
  try {
    // v1-parity history search (?q=): substring match over the caller's own messages.
    const q = new URL(request.url).searchParams.get('q')?.slice(0, 200) ?? '';
    if (q.trim()) return json({ threads: await searchThreads(user.sub, q) }, 200);
    return json({ threads: await listThreads(user.sub) }, 200);
  } catch {
    return json({ threads: [] }, 200); // degrade, never 500 the drawer
  }
}

// 대화 목록 전체 삭제 (본인 것만) — ThreadList의 '전체 삭제' 버튼이 호출.
export async function DELETE(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ status: 'error', message: 'unauthenticated' }, 401);
  try {
    return json({ deleted: await deleteAllThreads(user.sub) }, 200);
  } catch (e) {
    return json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, 502);
  }
}
