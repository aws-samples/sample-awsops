// v1-parity AgentCore status API (v1 GET /api/agentcore). Serves control-plane status
// (runtime/gateways/memory/interpreter) and, via ?action=stats, the chat-invoke ops stats
// (getChatInvokeStats — the v2 home for what v1's agentcore-stats.ts provided).
import { verifyUser } from '@/lib/auth';
import { getAgentCoreStatus } from '@/lib/agentcore-status';
import { getChatInvokeStats } from '@/lib/trace';

export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

export async function GET(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ status: 'error', message: 'unauthenticated' }, 401);

  const params = new URL(request.url).searchParams;
  const action = params.get('action');

  if (action === 'stats') {
    const daysRaw = Number(params.get('days') ?? 7);
    const days = Number.isFinite(daysRaw) ? Math.min(90, Math.max(1, Math.trunc(daysRaw))) : 7;
    return json(await getChatInvokeStats(days), 200);
  }

  const bustCache = params.get('bustCache') === 'true';
  try {
    return json(await getAgentCoreStatus(bustCache), 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'failed to fetch AgentCore status' }, 500);
  }
}
