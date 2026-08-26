// GET /api/insights — latest cached AI insight for the Overview dashboard. Authenticated; DB read only.
import { verifyUser } from '@/lib/auth';
import { getLatestInsight } from '@/lib/insights';

export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

export async function GET(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ error: 'unauthenticated' }, 401);
  // Flag OFF → no-op: skip the DB query entirely (avoids 500 on an unmigrated env) and tell the client
  // the feature is disabled so the card hides itself (v2 "default false → no behavior change").
  if (process.env.AI_INSIGHTS_ENABLED !== 'true') return json({ enabled: false, insight: null }, 200);
  try {
    return json({ enabled: true, insight: await getLatestInsight() }, 200);
  } catch (e) {
    console.error('[insights] read failed:', e);
    return json({ error: 'failed to load insights' }, 500);
  }
}
