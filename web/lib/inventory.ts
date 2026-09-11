import { getPool } from '@/lib/db';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { isAdmin } from '@/lib/admin';
import { INVENTORY_TYPES } from '@/lib/inventory-types';
import { AGG_DERIVED_KEYS } from '@/lib/inventory-derived';
import type { User } from '@/lib/auth';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
let lambda: LambdaClient | null = null;
function lambdaClient(): LambdaClient { if (!lambda) lambda = new LambdaClient({ region: REGION }); return lambda; }

// v1 parity: IAM inventories are admin-only (identity data is sensitive). Single source of truth —
// GET /api/inventory/[type] and POST /api/inventory/[type]/refresh both call this instead of each
// re-declaring their own ADMIN_ONLY_TYPES set (pentest-remediation P2-2: the refresh route had no
// gate at all and returned the same IAM rows the GET route 403s a non-admin for).
const ADMIN_ONLY_TYPES = new Set(['iam_user', 'iam_role']);

/** Returns an error message if `type` is unknown or the caller lacks the type's required role; null if allowed. */
export async function assertInventoryTypeAllowed(
  type: string,
  user: Pick<User, 'email' | 'sub' | 'groups'>,
): Promise<{ status: number; message: string } | null> {
  if (!Object.hasOwn(INVENTORY_TYPES, type)) return { status: 404, message: 'unknown type' };
  if (ADMIN_ONLY_TYPES.has(type) && !(await isAdmin(user))) {
    return { status: 403, message: '관리자 전용 메뉴입니다 (IAM)' };
  }
  return null;
}

export interface SyncRun { status: string; finished_at: string | null; row_count: number | null; error?: string | null; last_success_at?: string | null }
export interface InventoryPage { rows: Record<string, unknown>[]; run: SyncRun | null }

/** Region allow-list, or '__all__' for no region filter. */
export type RegionScope = string[] | '__all__';

/**
 * Appends a region predicate to `params` (mutated) and returns the SQL fragment to AND onto a
 * WHERE clause (possibly ''). Shared by readResources and the metrics route so both apply the
 * same region/includeGlobal contract — ANY() over an array beats an OR clause, and folding
 * includeGlobal into the array means it isn't silently dropped when regions === '__all__'.
 */
export function regionWhereClause(regions: RegionScope, includeGlobal: boolean, params: unknown[]): string {
  if (regions !== '__all__') {
    // includeGlobal is an independent toggle — strip a caller-supplied 'global' first so it
    // can't smuggle a global row back in when includeGlobal=false.
    const base = regions.filter((r) => r !== 'global');
    const allowed = includeGlobal ? [...base, 'global'] : base;
    params.push(allowed.length ? allowed : ['__none__']); // empty selection → empty result, not unfiltered
    return ` AND region = ANY($${params.length})`;
  }
  if (!includeGlobal) return ` AND region <> 'global'`;
  return '';
}

export type AccountScope = '__all__' | string[];

/** WHERE fragment for the account scope. '__all__' → no filter (host 'self' + every member). */
export function accountWhereClause(accounts: AccountScope, params: unknown[]): string {
  if (accounts === '__all__') return '';
  params.push(accounts.length ? accounts : ['self']);
  return ` AND account_id = ANY($${params.length})`;
}

export interface ReadResourcesOpts {
  limit: number;
  offset: number;
  /** Region allow-list, or '__all__' (default) for no region filter. */
  regions?: RegionScope;
  /** Include region='global' rows (IAM, Route53, ...). Default true. */
  includeGlobal?: boolean;
  /** Account allow-list ('self' = host), or '__all__'. Default ['self'] (legacy behavior). */
  accounts?: AccountScope;
}

// Worst-first ordering must run BEFORE the LIMIT (gap L68): with >LIMIT rows, a client-side
// re-sort only reorders whichever rows happened to survive the near-uniform captured_at cut —
// firing alarms could be silently excluded exactly when triage matters. Built from the STATIC
// spec (trusted code, not user input); identifiers are still charset-validated before inlining
// as defense-in-depth, and an invalid spec falls back to the default ordering.
function worstFirstOrderBy(type: string): string {
  const wf = INVENTORY_TYPES[type]?.worstFirst;
  if (!wf) return '';
  const ID = /^[a-z0-9_]{1,64}$/;
  if (!ID.test(wf.col) || (wf.tieBreak !== undefined && !ID.test(wf.tieBreak))) return '';
  const whens = Object.entries(wf.rank)
    .filter(([k]) => /^[A-Za-z0-9_-]{1,64}$/.test(k))
    .filter(([, v]) => Number.isFinite(Number(v)))
    .map(([k, v]) => `WHEN '${k.toLowerCase()}' THEN ${Number(v)}`)
    .join(' ');
  if (!whens) return '';
  const tie = wf.tieBreak ? `data->>'${wf.tieBreak}' DESC NULLS LAST, ` : '';
  return `CASE lower(data->>'${wf.col}') ${whens} ELSE ${Object.keys(wf.rank).length} END, ${tie}`;
}

export interface AggBucket { name: string; value: number }
export interface InventoryAggregates {
  total: number;
  state: AggBucket[] | null;
  dist: AggBucket[] | null;
  dist2: AggBucket[] | null;
  facets: Record<string, AggBucket[]>;
}

// Server-side bound for the aggregation statement (the auth.ts SET LOCAL precedent: the
// timeout must be a literal integer — SET LOCAL can't take a bound parameter).
const AGG_STATEMENT_TIMEOUT_MS = 15000;
if (!Number.isInteger(AGG_STATEMENT_TIMEOUT_MS)) throw new Error('AGG_STATEMENT_TIMEOUT_MS must be a literal integer');

/** Full-fleet aggregates for a capped inventory page (gap L102, v1 parity): GROUP BYs over
 *  the WHOLE scoped fleet for the spec's stateKey/distKey/distKey2/filterKeys, plus the true
 *  total — v1 ran summary/statusCount/typeDistribution SQL fleet-wide; the v2 client computed
 *  them from the 500-row sample.
 *  Round-1 hardening:
 *  - CLIENT-DERIVED spec keys (AGG_DERIVED_KEYS — e.g. dynamodb billing_h, ecs_task
 *    cluster_h, lambda's COALESCEd runtime) are EXCLUDED: the JSONB doesn't hold them (or
 *    holds the untransformed value) — those dimensions stay sample-based on the page, with
 *    the sample qualifier;
 *  - ONE round-trip (UNION ALL of the total + every GROUP BY) inside a scoped transaction
 *    with SET LOCAL statement_timeout — never a serial 1+N chain pinning a `max: 3` pool
 *    connection unbounded (the web/lib/auth.ts pool-starvation precedent);
 *  - deterministic bucket order (count DESC, name ASC) and a 50-bucket cap per key; the
 *    CLIENT computes the remainder against `total` so donuts still sum to the fleet.
 *  Keys come from the STATIC spec (trusted code) and are still charset-validated before
 *  inlining (the worstFirstOrderBy defense-in-depth precedent); ''/NULL coalesce to '(none)'
 *  to match the client-side countBy convention. */
export async function readAggregates(
  type: string,
  { regions = '__all__', includeGlobal = true, accounts = ['self'] }: Omit<ReadResourcesOpts, 'limit' | 'offset'>,
): Promise<InventoryAggregates> {
  if (!Object.hasOwn(INVENTORY_TYPES, type)) return { total: 0, state: null, dist: null, dist2: null, facets: {} };
  const spec = INVENTORY_TYPES[type];
  const params: unknown[] = [type];
  const where = `resource_type = $1` + accountWhereClause(accounts, params) + regionWhereClause(regions, includeGlobal, params);
  const ID = /^[a-z0-9_]{1,64}$/;
  const skip = new Set(AGG_DERIVED_KEYS[type] ?? []);
  const keys = new Set<string>();
  for (const k of [spec?.stateKey, spec?.distKey, spec?.distKey2, ...(spec?.filterKeys ?? [])]) {
    if (k && ID.test(k) && !skip.has(k)) keys.add(k);
  }
  const parts = [
    `SELECT '__total__' AS k, NULL::text AS name, count(*)::int AS value FROM inventory_resources WHERE ${where}`,
  ];
  for (const k of keys) {
    parts.push(
      `SELECT '${k}' AS k, name, value FROM (
         SELECT COALESCE(NULLIF(data->>'${k}', ''), '(none)') AS name, count(*)::int AS value
         FROM inventory_resources WHERE ${where} GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT 50
       ) sub_${k}`,
    );
  }
  const clientConn = await getPool().connect();
  let rows: { k: string; name: string | null; value: number }[];
  try {
    await clientConn.query('BEGIN');
    await clientConn.query(`SET LOCAL statement_timeout = ${AGG_STATEMENT_TIMEOUT_MS}`);
    rows = (await clientConn.query(parts.join(' UNION ALL '), params)).rows;
    await clientConn.query('COMMIT');
  } catch (e) {
    await clientConn.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    clientConn.release();
  }
  const byKey: Record<string, AggBucket[]> = {};
  let total = 0;
  for (const r of rows) {
    if (r.k === '__total__') { total = Number(r.value) || 0; continue; }
    (byKey[r.k] ??= []).push({ name: String(r.name ?? '(none)'), value: Number(r.value) || 0 });
  }
  // UNION ALL does not guarantee branch ordering — re-sort deterministically here.
  for (const k of Object.keys(byKey)) byKey[k].sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  const facets: Record<string, AggBucket[]> = {};
  for (const k of spec?.filterKeys ?? []) if (byKey[k]) facets[k] = byKey[k];
  const pick = (k?: string) => (k && byKey[k] ? byKey[k] : null);
  return { total, state: pick(spec?.stateKey), dist: pick(spec?.distKey), dist2: pick(spec?.distKey2), facets };
}

export async function readResources(type: string, { limit, offset, regions = '__all__', includeGlobal = true, accounts = ['self'] }: ReadResourcesOpts): Promise<InventoryPage> {
  const pool = getPool();
  const params: unknown[] = [type];
  const where = `resource_type = $1` + accountWhereClause(accounts, params) + regionWhereClause(regions, includeGlobal, params);
  params.push(limit, offset);
  const r = await pool.query(
    `SELECT resource_id, region, account_id, data, captured_at FROM inventory_resources
     WHERE ${where} ORDER BY ${worstFirstOrderBy(type)}captured_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const s = await pool.query(
    `SELECT status, finished_at, row_count, error, last_success_at FROM inventory_sync_runs WHERE resource_type = $1 AND account_id = 'self'`,
    [type],
  );
  return { rows: r.rows, run: s.rows[0] ?? null };
}

export async function triggerSync(type: string): Promise<{ status: 'queued' }> {
  const fn = process.env.INV_SYNC_FUNCTION;
  if (!fn) throw new Error('INV_SYNC_FUNCTION not set');
  const out = await lambdaClient().send(new InvokeCommand({
    FunctionName: fn,
    InvocationType: 'Event',
    Payload: new TextEncoder().encode(JSON.stringify({ type })),
  }));
  if (out.StatusCode !== 202) {
    throw new Error(`inventory sync enqueue failed: status ${out.StatusCode ?? 'unknown'}`);
  }
  return { status: 'queued' };
}
