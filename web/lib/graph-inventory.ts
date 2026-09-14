import type { Pool, PoolClient } from 'pg';
import type { GraphAttempt, GraphClass } from './graph-state';
import type { Row } from './infra-topology';

// These fields/types are the placement inputs consumed by buildInfraGraph and produced by
// sync_lambda. Nested opensearch.vpc_options / msk.provisioned are not placement inputs.
export const INFRA_TYPES = ['vpc', 'subnet', 'security_group', 'ec2', 'lambda', 'rds',
  'alb', 'nlb', 'target_group', 'elasticache', 'route_table', 'nat_gateway', 'neptune_cluster'];
const INFRA_FIELDS = ['vpc_id', 'subnet_id', 'subnet_ids', 'vpc_subnet_ids', 'subnets',
  'availability_zones', 'security_groups', 'security_group_ids', 'vpc_security_group_ids',
  'vpc_security_groups', 'endpoint_address', 'group_name', 'title', 'name', 'tags'];
export type InventoryRow = Row & { resource_type: string; captured_at?: unknown; account_id: string };
type Run = Record<string, any>;
const ROW_CAP = 2000;
const ROW_BYTES = 64 * 1024;
const SNAPSHOT_BYTES = 8 * 1024 * 1024;

/** One shared-pool slot for a short transaction. No lock waits or remote IO in the callback.
 * PG17 transaction_timeout also bounds the sum of individually short statements. */
export async function graphTransaction<T>(pool: Pool, readOnly: boolean, fn: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    await client.query("SET LOCAL statement_timeout = '2s'");
    await client.query("SET LOCAL lock_timeout = '100ms'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '3s'");
    await client.query("SET LOCAL transaction_timeout = '4s'");
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function inventoryAccounts(pool: Pool, cls: GraphClass, types: string[]) {
  return graphTransaction(pool, true, async client => {
    const schema = await client.query("SELECT to_regclass('public.topology_graph_state') IS NOT NULL AS ready");
    if (!schema.rows[0]?.ready) return null;
    // Bounded keys only; all accounts beyond the sentinel retain their prior publication.
    const result = await client.query(`SELECT account_id FROM (
      SELECT 'self'::text AS account_id
      UNION SELECT account_id FROM topology_nodes WHERE class=$1
      UNION SELECT account_id FROM topology_graph_state WHERE class=$1
      UNION SELECT account_id FROM inventory_resources WHERE resource_type=ANY($2)
      UNION SELECT account_id FROM inventory_sync_runs WHERE resource_type=ANY($2)
    ) accounts ORDER BY (account_id='self') DESC, account_id LIMIT 101`, [cls, types]);
    return result.rows.map(row => row.account_id as string);
  });
}

export async function inventorySnapshot(pool: Pool, cls: GraphClass, account: string, types: string[]) {
  return graphTransaction(pool, true, async client => {
    const prior = await client.query(`SELECT ARRAY(
      SELECT DISTINCT jsonb_build_object('sourceId', source->>'sourceId')
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(details->'publishedSources')='array'
        THEN details->'publishedSources' ELSE '[]'::jsonb END) source
      WHERE source->>'sourceId'=ANY($3)
    ) AS sources FROM topology_graph_state WHERE class=$1 AND account_id=$2`,
    [cls, account, types.map(type => `inventory:${type}`)]);
    const runs = await client.query(`SELECT account_id, resource_type, status, started_at,
      finished_at, last_success_at, row_count, unknown_attribute_count
      FROM inventory_sync_runs WHERE account_id=ANY($1) AND resource_type=ANY($2)`,
    [[...new Set(['self', account])], types]);
    // No raw all-account aggregation. Infra strips unused provider payloads; flow retains the
    // existing builder's row contract. SQL byte guards prevent oversized JSON reaching Node.
    const result = await client.query(`WITH bounded AS MATERIALIZED (
      SELECT account_id, resource_type, resource_id, region, captured_at,
        CASE WHEN $3='infra' THEN
          (SELECT coalesce(jsonb_object_agg(key,value), '{}'::jsonb)
           FROM jsonb_each(data) WHERE key=ANY($4)) ELSE data END AS data
      FROM inventory_resources WHERE account_id=$1 AND resource_type=ANY($2)
      ORDER BY resource_type, region, resource_id LIMIT $5
    ), sized AS MATERIALIZED (
      SELECT *, octet_length(data::text)+octet_length(resource_id)+octet_length(region) AS bytes FROM bounded
    ), budgeted AS (
      SELECT *, sum(bytes) OVER (ORDER BY resource_type, region, resource_id) AS total_bytes FROM sized
    ) SELECT account_id, resource_type,
      CASE WHEN bytes <= $6 AND total_bytes <= $7 THEN resource_id ELSE '' END AS resource_id,
      CASE WHEN bytes <= $6 AND total_bytes <= $7 THEN region ELSE '' END AS region, captured_at,
      CASE WHEN bytes <= $6 AND total_bytes <= $7 THEN data ELSE NULL END AS data,
      bytes > $6 OR total_bytes > $7 AS oversized
      FROM budgeted ORDER BY resource_type, region, resource_id`,
    [account, types, cls, INFRA_FIELDS, ROW_CAP + 1, ROW_BYTES, SNAPSHOT_BYTES]);
    const rows = result.rows as InventoryRow[];
    // A succeeded aggregate proves host participation: sync() requires host rows or its host
    // probe before marking success. Reconcile the full type count to avoid interpreting missing
    // input as empty. Never extrapolate this proof to unobserved members.
    const emptyTypes = account === 'self' ? runs.rows.filter(run => run.account_id === 'self'
      && run.status === 'succeeded' && !rows.some(row => row.resource_type === run.resource_type))
      .map(run => run.resource_type) : [];
    const counts = emptyTypes.length ? await client.query(`SELECT resource_type, count(*)::int AS count
      FROM inventory_resources WHERE resource_type=ANY($1) GROUP BY resource_type`, [emptyTypes]) : { rows: [] };
    const aggregateCounts = new Map<string, number>(emptyTypes.map(type => [type, 0]));
    for (const row of counts.rows) aggregateCounts.set(row.resource_type, row.count);
    return { rows, runs: runs.rows as Run[], previous: prior.rows[0]?.sources,
      aggregateCounts, truncated: rows.length > ROW_CAP || rows.some(row => row.oversized) };
  });
}

const stamp = (value: unknown): number | null => {
  const ms = typeof value === 'string' || value instanceof Date ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
};

export function inventoryAttempt(snapshot: Awaited<ReturnType<typeof inventorySnapshot>>, types: string[],
  cls: GraphClass, account: string, attemptedAt: string): GraphAttempt {
  const { rows, runs, previous, aggregateCounts, truncated } = snapshot;
  const previousTypes = Array.isArray(previous) ? previous.flatMap(source =>
    typeof source?.sourceId === 'string' && types.includes(source.sourceId.slice(10))
      && source.sourceId.startsWith('inventory:') ? [source.sourceId.slice(10)] : []) : [];
  const required = [...new Set([
    ...(account === 'self' && cls === 'flow' ? types : []),
    // Aggregate failures are missing coverage even on a member's first publication.
    // Aggregate success still cannot certify absence for an unobserved member.
    ...runs.filter(run => types.includes(run.resource_type) && (run.account_id === account
      || (run.account_id === 'self' && run.status !== 'succeeded'))).map(run => run.resource_type),
    ...rows.map(row => row.resource_type), ...previousTypes,
  ])];
  let safe = required.length > 0 && !truncated;
  const sources = required.map(type => {
    const items = rows.filter(row => row.resource_type === type);
    const direct = runs.find(row => row.resource_type === type && row.account_id === account);
    const run = direct ?? runs.find(row => row.resource_type === type && row.account_id === 'self');
    const unknownScope = account !== 'self' && !direct && !items.length;
    const captures = items.map(row => stamp(row.captured_at));
    const capturedAtMs = captures.length && captures.every(value => value !== null)
      ? Math.min(...captures as number[]) : null;
    const lastSuccessAtMs = stamp(run?.last_success_at);
    const producerStatus = ['succeeded', 'failed', 'partial', 'running'].includes(run?.status) ? run!.status : 'unknown';
    const validCount = Number.isSafeInteger(run?.row_count) && run!.row_count >= 0;
    const confirmedEmpty = !unknownScope && validCount && (account === 'self'
      ? aggregateCounts.get(type) === run!.row_count : direct?.row_count === 0);
    const blockers = !run ? ['missing_ledger'] : producerStatus === 'failed' ? ['source_failed']
      : unknownScope ? ['unknown_account_coverage'] : producerStatus !== 'succeeded' ? ['incomplete_collection']
      : !items.length && !confirmedEmpty ? ['empty_not_confirmed']
      : !lastSuccessAtMs || (items.length > 0 && capturedAtMs === null) ? ['unknown_capture'] : [];
    if (blockers.length) safe = false;
    const unknownAttributes = !Number.isSafeInteger(run?.unknown_attribute_count) || run!.unknown_attribute_count !== 0;
    const reasons = [...blockers, ...(run && unknownAttributes ? ['unknown_attributes'] : [])];
    const status = producerStatus === 'failed' ? 'error'
      : producerStatus === 'unknown' || !lastSuccessAtMs || unknownScope ? 'unavailable'
      : reasons.length ? 'partial' : items.length ? 'ok' : 'empty';
    return { sourceId: `inventory:${type}`, scope: direct && account !== 'self' ? 'account' : 'aggregate',
      status, producerStatus, reasons, itemCount: items.length, capturedAtMs, lastSuccessAtMs,
      attemptedAtMs: stamp(run?.started_at), finishedAtMs: stamp(run?.finished_at) };
  });
  const status = sources.some(s => s.status === 'error') ? 'error'
    : !sources.length || sources.some(s => s.status === 'unavailable') ? 'unavailable'
    : truncated || sources.some(s => s.status === 'partial') ? 'partial' : rows.length ? 'ok' : 'empty';
  return { status, attemptedAt, publish: safe,
    details: { sources, retainedPrevious: !safe, ...(truncated ? { inputTruncated: true } : {}) } };
}
