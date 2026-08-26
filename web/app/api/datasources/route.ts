// GET /api/datasources — list configured datasource INSTANCES for the hub + Explore picker.
// Authenticated (read-only), NOT admin. Returns {id,name,kind,authType,isDefault,connected} — never
// credentials. Degrade-safe: [] when Aurora is off / on error so the page doesn't 500.
import { verifyUser } from '@/lib/auth';
import { listDatasources } from '@/lib/datasources';
import { isAdmin } from '@/lib/admin';
import { getConfiguredIds } from '@/lib/integration-credentials';

export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

export async function GET(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ error: 'unauthenticated' }, 401);

  try {
    const [rows, configuredIds, admin] = await Promise.all([listDatasources(), getConfiguredIds(), isAdmin(user)]);
    const idSet = new Set(configuredIds);
    const datasources = rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      // Connection detail is admin-only (v1 showed the URL; v2 keeps it off the read-any shape).
      ...(admin ? { endpoint: r.endpoint } : {}),
      authType: r.authType,
      isDefault: r.isDefault,
      // "connected" = a credential is resolvable: the instance id key, or (for migrated defaults) the kind mirror.
      connected: idSet.has(String(r.id)) || r.isDefault,
    }));
    return json({ datasources }, 200);
  } catch {
    return json({ datasources: [] }, 200);
  }
}
