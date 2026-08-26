// v1-parity AI-call ops stats (v1 GET /api/agentcore?action=stats): call volume, success rate,
// avg latency per gateway + recent calls — aggregated from agentcore_stats chat_invoke rows.
import { verifyUser } from '@/lib/auth';
import { getChatInvokeStats } from '@/lib/trace';

export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

export async function GET(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ status: 'error', message: 'unauthenticated' }, 401);
  const daysRaw = Number(new URL(request.url).searchParams.get('days') ?? 7);
  const days = Number.isFinite(daysRaw) ? Math.min(90, Math.max(1, Math.trunc(daysRaw))) : 7;
  return json(await getChatInvokeStats(days), 200);
}
