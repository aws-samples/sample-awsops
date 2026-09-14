import type { Pool } from 'pg';
import { graphTransaction } from './graph-transaction';
export { graphTransaction } from './graph-transaction';
import type { GraphAttempt, GraphClass } from './graph-state';
import type { Row } from './infra-topology';
import { HOST_ONLY_TREND_TYPES } from './trend-utils';

/** Same SDK host-only scope used by the existing inventory producer/trend contract. */
export const inventoryTypesForAccount = (types: string[], account: string) =>
  account === 'self' ? types : types.filter(type => !HOST_ONLY_TREND_TYPES.has(type));

// These fields/types are the placement inputs consumed by buildInfraGraph and produced by
// sync_lambda. Nested opensearch.vpc_options / msk.provisioned are not placement inputs.
export const INFRA_TYPES = ['vpc', 'subnet', 'security_group', 'ec2', 'lambda', 'rds',
  'alb', 'nlb', 'target_group', 'elasticache', 'route_table', 'nat_gateway', 'neptune_cluster'];
const INFRA_FIELDS = ['vpc_id', 'subnet_id', 'subnet_ids', 'vpc_subnet_ids', 'subnets',
  'availability_zones', 'security_groups', 'security_group_ids', 'vpc_security_group_ids',
  'vpc_security_groups', 'endpoint_address', 'group_name', 'title', 'name', 'tags'];
// Flow joins and safe display fields consumed by buildFlowGraph; unused provider blobs
// must not exhaust the transfer budget or override authoritative identity columns.
const FLOW_FIELDS = ['name', 'arn', 'dns_name', 'domain_name', 'aliases', 'origins', 'web_acl_id',
  'target_group_name', 'target_type', 'target_health_descriptions', 'load_balancer_arns',
  'vpc_id', 'scheme', 'private_zone', 'alias_target', 'records', 'type', 'last_status',
  'task_group', 'cluster_arn', 'attachments', 'origin_refs', 'api_id', 'integration_uri',
  'connection_type', 'tags', 'status', 'enabled', 'protocol', 'port', 'subnet_ids', 'security_groups'];
export type InventoryRow = Row & { resource_type: string; captured_at?: unknown; account_id: string };
type Run = Record<string, any>;
const ROW_CAP = 2000;
const ROW_BYTES = 64 * 1024;
const SNAPSHOT_BYTES = 8 * 1024 * 1024;

export async function inventoryAccounts(pool: Pool, cls: GraphClass, types: string[]) {
  return graphTransaction(pool, true, async client => {
    const schema = await client.query("SELECT to_regclass('public.topology_graph_state') IS NOT NULL AS ready");
    if (!schema.rows[0]?.ready) return null;
    // Bounded keys only; all accounts beyond the sentinel retain their prior publication.
    const result = await client.query(`SELECT accounts.account_id FROM (
      SELECT 'self'::text AS account_id
      UNION SELECT account_id FROM topology_nodes WHERE class=$1
      UNION SELECT account_id FROM topology_graph_state WHERE class=$1
      UNION SELECT account_id FROM inventory_resources WHERE resource_type=ANY($2)
      UNION SELECT account_id FROM inventory_sync_runs WHERE resource_type=ANY($2)
    ) accounts LEFT JOIN topology_graph_state s ON s.account_id=accounts.account_id AND s.class=$1
    ORDER BY CASE WHEN s.details->>'sourceAttempted'='false' THEN
      CASE WHEN jsonb_typeof(s.details->'lastSourceAttemptedAtMs')='number'
        THEN (s.details->>'lastSourceAttemptedAtMs')::numeric END
      ELSE extract(epoch FROM s.attempted_at)*1000 END NULLS FIRST,
      (accounts.account_id='self') DESC, accounts.account_id LIMIT 101`, [cls, types]);
    return result.rows.map(row => row.account_id as string);
  });
}

/** One bounded metadata write for skipped accounts; never touches graph rows or publication clocks. */
export async function recordUnattempted(pool: Pool, cls: GraphClass, lock: number, accounts: string[], at: string) {
  if (!accounts.length) return true;
  return graphTransaction(pool, false, async client => {
    if (!(await client.query('SELECT pg_try_advisory_xact_lock($1) AS acquired', [lock])).rows[0]?.acquired) return false;
    await client.query(`INSERT INTO topology_graph_state(account_id,class,status,attempted_at,captured_at,details)
      SELECT account,$1,'unavailable',$3::timestamptz,NULL,
        jsonb_build_object('sources','[]'::jsonb,'sourceAttempted',false,'failureReason','not_attempted',
          'retainedPrevious',EXISTS(SELECT 1 FROM topology_nodes WHERE account_id=account AND class=$1))
      FROM unnest($2::text[]) pending(account)
      ON CONFLICT(account_id,class) DO UPDATE SET status=EXCLUDED.status, attempted_at=EXCLUDED.attempted_at,
        details=EXCLUDED.details || jsonb_build_object(
          'retainedPrevious',topology_graph_state.captured_at IS NOT NULL OR (EXCLUDED.details->>'retainedPrevious')::boolean,
          'publishedSources',coalesce(topology_graph_state.details->'publishedSources','[]'::jsonb),
          'lastSourceAttemptedAtMs',CASE WHEN topology_graph_state.details->>'sourceAttempted'='false'
            THEN topology_graph_state.details->'lastSourceAttemptedAtMs'
            ELSE to_jsonb(extract(epoch FROM topology_graph_state.attempted_at)*1000) END)
      WHERE topology_graph_state.attempted_at < EXCLUDED.attempted_at`, [cls, accounts, at]);
    return true;
  });
}

export async function inventorySnapshot(pool: Pool, cls: GraphClass, account: string, types: string[]) {
  return graphTransaction(pool, true, async client => {
    const runs = await client.query(`SELECT account_id, resource_type, status, started_at,
      finished_at, last_success_at, row_count, unknown_attribute_count
      FROM inventory_sync_runs WHERE account_id=ANY($1) AND resource_type=ANY($2)`,
    [[...new Set(['self', account])], types]);
    // sync() writes these per-account counts only for observed/probed participants after
    // pruning. The self-keyed job ledger alone cannot prove a member's empty result.
    const participation = account === 'self' ? { rows: [] } : await client.query(`
      SELECT DISTINCT ON (s.resource_type) s.resource_type,s.resource_count,s.captured_at
      FROM inventory_snapshots s WHERE s.account_id=$1 AND s.resource_type=ANY($2)
        AND EXISTS (SELECT 1 FROM accounts a WHERE a.account_id=$1 AND a.enabled
          AND (a.all_regions OR EXISTS (SELECT 1 FROM account_regions ar
            WHERE ar.account_id=a.account_id AND ar.enabled)))
      ORDER BY s.resource_type,s.captured_at DESC`, [account, types]);
    // Both classes project their consumed fields before SQL byte guards prevent oversized
    // provider payloads from reaching Node. Identity columns remain authoritative.
    const result = await client.query(`WITH bounded AS MATERIALIZED (
      SELECT account_id, resource_type, resource_id, region, captured_at,
        (SELECT coalesce(jsonb_object_agg(key,value), '{}'::jsonb)
         FROM jsonb_each(data) WHERE key=ANY($3)) AS data
      FROM inventory_resources WHERE account_id=$1 AND resource_type=ANY($2)
      ORDER BY resource_type, region, resource_id LIMIT $4
    ), sized AS MATERIALIZED (
      SELECT *, octet_length(data::text)+octet_length(resource_id)+octet_length(region) AS bytes FROM bounded
    ), budgeted AS (
      SELECT *, sum(bytes) OVER (ORDER BY resource_type, region, resource_id) AS total_bytes FROM sized
    ) SELECT account_id, resource_type,
      CASE WHEN bytes <= $5 AND total_bytes <= $6 THEN resource_id ELSE '' END AS resource_id,
      CASE WHEN bytes <= $5 AND total_bytes <= $6 THEN region ELSE '' END AS region, captured_at,
      CASE WHEN bytes <= $5 AND total_bytes <= $6 THEN data ELSE NULL END AS data,
      bytes > $5 OR total_bytes > $6 AS oversized
      FROM budgeted ORDER BY resource_type, region, resource_id`,
    [account, types, cls === 'infra' ? INFRA_FIELDS : FLOW_FIELDS, ROW_CAP + 1, ROW_BYTES, SNAPSHOT_BYTES]);
    const rows = result.rows as InventoryRow[];
    // Reconcile every succeeded aggregate, including nonempty input, before any sweep.
    // The producer count spans accounts; it is not this account's local row count.
    // A matching aggregate still does not prove an unobserved member participated.
    const countTypes = runs.rows.filter(run => run.account_id === 'self'
      && run.status === 'succeeded').map(run => run.resource_type);
    const counts = countTypes.length ? await client.query(`SELECT resource_type, count(*)::int AS count
      FROM inventory_resources WHERE resource_type=ANY($1) GROUP BY resource_type`, [countTypes]) : { rows: [] };
    const aggregateCounts = new Map<string, number>(countTypes.map(type => [type, 0]));
    for (const row of counts.rows) aggregateCounts.set(row.resource_type, row.count);
    return { rows, runs: runs.rows as Run[],
      aggregateCounts, participation: participation.rows as Run[], truncated: rows.length > ROW_CAP || rows.some(row => row.oversized) };
  });
}

const stamp = (value: unknown): number | null => {
  const ms = typeof value === 'string' || value instanceof Date ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
};

export function inventoryAttempt(snapshot: Awaited<ReturnType<typeof inventorySnapshot>>, types: string[],
  cls: GraphClass, account: string, attemptedAt: string): GraphAttempt {
  const { rows, runs, aggregateCounts, participation, truncated } = snapshot;
  // Every source this class can collect in this account contributes a coverage result.
  const required = [...new Set(types)];
  let safe = required.length > 0 && !truncated;
  const sources = required.map(type => {
    const items = rows.filter(row => row.resource_type === type);
    const run = runs.find(row => row.resource_type === type && row.account_id === 'self');
    const point = participation.find(row => row.resource_type === type);
    const pointAt = stamp(point?.captured_at), started = stamp(run?.started_at), finished = stamp(run?.finished_at);
    const participated = account === 'self' || (run?.status === 'succeeded' && pointAt !== null
      && started !== null && finished !== null && started <= pointAt && pointAt <= finished
      && finished <= Date.now() && finished === stamp(run?.last_success_at)
      && Number.isSafeInteger(point?.resource_count) && point!.resource_count >= 0);
    const unknownScope = !participated;
    const captures = items.map(row => stamp(row.captured_at));
    const capturedAtMs = captures.length && captures.every(value => value !== null)
      ? Math.min(...captures as number[]) : null;
    const lastSuccessAtMs = stamp(run?.last_success_at);
    const producerStatus = ['succeeded', 'failed', 'partial', 'running'].includes(run?.status) ? run!.status : 'unknown';
    const validCount = Number.isSafeInteger(run?.row_count) && run!.row_count >= 0;
    const countConfirmed = validCount && aggregateCounts.get(type) === run!.row_count
      && (account === 'self' || (participated && point!.resource_count === items.length));
    const confirmedEmpty = !unknownScope && countConfirmed;
    const blockers = !run ? ['missing_ledger'] : producerStatus === 'failed' ? ['source_failed']
      : unknownScope ? ['unknown_account_coverage'] : producerStatus !== 'succeeded' ? ['incomplete_collection']
      : items.length > 0 && !countConfirmed ? ['count_not_confirmed']
      : !items.length && !confirmedEmpty ? ['empty_not_confirmed']
      : !lastSuccessAtMs || (items.length > 0 && capturedAtMs === null) ? ['unknown_capture'] : [];
    if (blockers.length) safe = false;
    const unknownAttributes = !Number.isSafeInteger(run?.unknown_attribute_count) || run!.unknown_attribute_count !== 0;
    const reasons = [...blockers, ...(run && unknownAttributes ? ['unknown_attributes'] : [])];
    const status = producerStatus === 'failed' ? 'error'
      : producerStatus === 'unknown' || !lastSuccessAtMs || unknownScope ? 'unavailable'
      : reasons.length ? 'partial' : items.length ? 'ok' : 'empty';
    return { sourceId: `inventory:${type}`, scope: account !== 'self' && participated ? 'account' : 'aggregate',
      status, producerStatus, reasons, itemCount: items.length, capturedAtMs, lastSuccessAtMs,
      attemptedAtMs: stamp(run?.started_at), finishedAtMs: stamp(run?.finished_at) };
  });
  const status = sources.some(s => s.status === 'error') ? 'error'
    : !sources.length || sources.some(s => s.status === 'unavailable') ? 'unavailable'
    : truncated || sources.some(s => s.status === 'partial') ? 'partial' : rows.length ? 'ok' : 'empty';
  return { status, attemptedAt, publish: safe,
    details: { sources, retainedPrevious: !safe, ...(truncated ? { inputTruncated: true } : {}) } };
}
