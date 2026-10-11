// GET /api/datasources — list configured datasource INSTANCES for the hub + Explore picker.
// Authenticated (read-only), NOT admin. Returns {id,name,kind,authType,isDefault,connected} — never
// credentials. Configured is distinct from tested connectivity; connected is a legacy
// configuration alias. Degrade-safe: [] when Aurora is off / on error.
import { verifyUser } from '@/lib/auth';
import { listDatasources } from '@/lib/datasources';
import { isAdmin } from '@/lib/admin';
import { getConfiguredDatasourceIds } from '@/lib/integration-credentials';

export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

export async function GET(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ error: 'unauthenticated' }, 401);

  try {
    const [rows, admin] = await Promise.all([listDatasources(), isAdmin(user)]);
    const configuredIds = await getConfiguredDatasourceIds(rows);
    const idSet = new Set(configuredIds);
    const datasources = rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      // Connection detail is admin-only (v1 showed the URL; v2 keeps it off the read-any shape).
      // settings ride the same admin-only visibility as the endpoint (gap L203)
      ...(admin ? { endpoint: r.endpoint, settings: r.settings } : {}),
      authType: r.authType,
      isDefault: r.isDefault,
      configured: idSet.has(String(r.id)),
      connected: idSet.has(String(r.id)), // compatibility alias; not a live connection test
      connectionStatus: 'not_checked',
    }));
    return json({ datasources }, 200);
  } catch {
    return json({ datasources: [] }, 200);
  }
}
