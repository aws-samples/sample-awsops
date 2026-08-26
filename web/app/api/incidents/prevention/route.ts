// web/app/api/incidents/prevention/route.ts
// ADR-032 Phase 4: read-only cross-incident prevention-insights API.
//
// SAFETY (cross-incident prevention loop shipped OFF; recommend-only):
//   - GET is READ-ONLY and degrade-safe: it never mutates AWS/k8s/SSM/SFN, never
//     calls /api/actions, and never returns 5xx (an empty list is a valid panel).
//   - Admin-gated (verifyUser + isAdmin). Returns {insights:[]} when Aurora is
//     unconfigured or the query fails, so the panel degrades gracefully when off.
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';
function json(o: unknown, s: number) { return new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } }); }

export async function GET(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ error: 'unauthenticated' }, 401);
  if (!(await isAdmin(user))) return json({ error: 'admin access required' }, 403);
  if (!process.env.AURORA_ENDPOINT) return json({ insights: [] }, 200); // degrade-safe
  try {
    const { rows } = await getPool().query(
      `SELECT id, category, scope_ref, recommendation, narration, recurrence_count,
              source_incident_ids, evidence, status, last_seen_at
       FROM prevention_insights WHERE status = 'open' ORDER BY last_seen_at DESC LIMIT 200`,
    );
    return json({ insights: rows }, 200);
  } catch {
    return json({ insights: [] }, 200); // never 5xx the panel
  }
}
