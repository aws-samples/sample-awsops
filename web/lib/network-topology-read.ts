// Bounded central-inventory read for the network topology projection. One statement
// (one MVCC snapshot) reads the fleet-level connection rows for every account plus, when
// VPCs are selected, their detail rows. Rows stay server-side: only the builder's named
// fields reach the response.
import { getPool } from './db';
import type { NetRow } from './network-topology-types';

export const FLEET_TYPES = ['vpc', 'transit_gateway', 'transit_gateway_attachment', 'vpc_peering_connection'];
export const DETAIL_TYPES = ['subnet', 'route_table', 'internet_gateway', 'nat_gateway', 'vpc_endpoint', 'ec2', 'alb', 'nlb', 'rds', 'lambda'];
const FLEET_LIMIT = 20000, DETAIL_LIMIT = 8000;
const COLUMNS = 'resource_type, account_id, region, resource_id, data, captured_at';
const ORDER = 'ORDER BY resource_type, account_id, region, resource_id';

export async function readNetworkRows(vpcIds: string[]): Promise<{ rows: NetRow[]; truncated: boolean }> {
  const params: unknown[] = [FLEET_TYPES];
  let sql = `(SELECT ${COLUMNS}, 'fleet' AS part FROM inventory_resources
    WHERE resource_type = ANY($1) ${ORDER} LIMIT ${FLEET_LIMIT + 1})`;
  if (vpcIds.length) {
    params.push(DETAIL_TYPES, vpcIds);
    // vpc_id alone is not unique across accounts; the builder re-scopes by account+region.
    sql += ` UNION ALL (SELECT ${COLUMNS}, 'detail' AS part FROM inventory_resources
      WHERE resource_type = ANY($2) AND (data->>'vpc_id' = ANY($3) OR (resource_type = 'internet_gateway' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(data->'attachments') = 'array'
          THEN data->'attachments' ELSE '[]'::jsonb END) a
        WHERE COALESCE(a->>'VpcId', a->>'vpc_id') = ANY($3))))
      ${ORDER} LIMIT ${DETAIL_LIMIT + 1})`;
  }
  const result = await getPool().query(sql, params);
  const fleet: NetRow[] = [], detail: NetRow[] = [];
  for (const r of result.rows as Array<NetRow & { part: string; captured_at: unknown }>) {
    const row: NetRow = {
      resource_type: r.resource_type, account_id: r.account_id, region: r.region, resource_id: r.resource_id,
      data: r.data && typeof r.data === 'object' ? r.data : {},
      captured_at: r.captured_at instanceof Date ? r.captured_at.toISOString() : typeof r.captured_at === 'string' ? r.captured_at : null,
    };
    (r.part === 'detail' ? detail : fleet).push(row);
  }
  const truncated = fleet.length > FLEET_LIMIT || detail.length > DETAIL_LIMIT;
  return { rows: [...fleet.slice(0, FLEET_LIMIT), ...detail.slice(0, DETAIL_LIMIT)], truncated };
}
