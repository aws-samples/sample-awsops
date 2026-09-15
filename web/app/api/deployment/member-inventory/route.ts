import { verifyUser } from '@/lib/auth';
import { getPool } from '@/lib/db';
import { registrationTargetAccountIds } from '@/lib/account-registration-scope';

export const dynamic = 'force-dynamic';

// One statement snapshot, an exact indexed identity lookup, and at most two tiny
// projections. Two rows distinguish ambiguous regional identities from a proof.
const MEMBER_IDENTITY_SQL = `
SELECT a.account_id, a.enabled, a.is_host, a.role_name,
       (a.all_regions OR EXISTS (
         SELECT 1 FROM account_regions ar WHERE ar.account_id = a.account_id AND ar.enabled
       )) AS scan_enabled,
       COALESCE((
         SELECT jsonb_agg(proof) FROM (
           SELECT ir.account_id, ir.resource_type, ir.resource_id, ir.region, ir.captured_at,
                  CASE WHEN jsonb_typeof(ir.data -> $4::text) = 'string'
                         AND length(ir.data ->> $4::text) <= 2048
                       THEN ir.data ->> $4::text ELSE NULL END AS observed_id
           FROM inventory_resources ir
           WHERE ir.account_id = $1 AND ir.resource_type = $2 AND ir.resource_id = $3
             AND ($2 = 'cloudfront' OR a.all_regions OR EXISTS (
               SELECT 1 FROM account_regions ar
               WHERE ar.account_id = a.account_id AND ar.enabled AND ar.region = ir.region
             ))
           ORDER BY ir.region
           LIMIT 2
         ) proof
       ), '[]'::jsonb) AS resources
FROM accounts a WHERE a.account_id = $1`;

export async function GET(request: Request) {
  const reply = (body: unknown, status = 200) => Response.json(body, {
    status, headers: { 'Cache-Control': 'private, no-store' },
  });
  const unavailable = (reason: string, status = 200) => reply({ schemaVersion: 1, status: 'not_ready', reason }, status);
  if (!(await verifyUser(request.headers.get('cookie')))) return unavailable('unauthenticated', 401);
  const params = new URL(request.url).searchParams;
  const accountId = params.get('accountId') || '';
  const type = params.get('type') || '';
  const resourceId = params.get('resourceId') || '';
  if (!/^\d{12}$/.test(accountId) || !['ec2', 'cloudfront'].includes(type) ||
      !/^[\x21-\x7e]{1,2048}$/.test(resourceId)) return unavailable('invalid_input', 400);
  let targets: string[] | undefined;
  try {
    targets = registrationTargetAccountIds(process.env.INVENTORY_TARGET_ACCOUNT_IDS, (process.env.HOST_ACCOUNT_ID || '').trim());
  } catch {
    return unavailable('scope_unavailable', 503);
  }
  if (!targets?.includes(accountId)) return unavailable('target_not_configured', 403);
  try {
    const { rows } = await getPool().query(MEMBER_IDENTITY_SQL,
      [accountId, type, resourceId, type === 'ec2' ? 'instance_id' : 'id']);
    const account = rows[0];
    if (rows.length !== 1 || account?.account_id !== accountId || account.enabled !== true ||
        account.is_host !== false || account.role_name !== 'AWSopsReadOnlyRole') return unavailable('account_not_ready');
    if (account.scan_enabled !== true) return unavailable('scan_scope_unavailable');
    const resources = account.resources;
    if (!Array.isArray(resources) || resources.length === 0) return unavailable('resource_missing');
    if (resources.length !== 1) return unavailable('resource_ambiguous');
    const resource = resources[0];
    if (!resource || resource.account_id !== accountId || resource.resource_type !== type ||
        resource.resource_id !== resourceId || resource.observed_id !== resourceId ||
        typeof resource.region !== 'string' || resource.region.length > 64 ||
        (type === 'ec2' && !/^[a-z]{2}-[a-z]+-\d+$/.test(resource.region)) ||
        typeof resource.captured_at !== 'string' || resource.captured_at.length > 64 ||
        !Number.isFinite(Date.parse(resource.captured_at))) return unavailable('resource_identity_invalid');
    return reply({
      schemaVersion: 1, status: 'verified', accountId, type, resourceId,
      region: resource.region, capturedAt: new Date(resource.captured_at).toISOString(),
    });
  } catch {
    return unavailable('inventory_unavailable', 503);
  }
}
