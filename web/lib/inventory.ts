import { getPool } from '@/lib/db';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
let lambda: LambdaClient | null = null;
function lambdaClient(): LambdaClient { if (!lambda) lambda = new LambdaClient({ region: REGION }); return lambda; }

export interface SyncRun { status: string; finished_at: string | null; row_count: number | null; error?: string | null }
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

export async function readResources(type: string, { limit, offset, regions = '__all__', includeGlobal = true, accounts = ['self'] }: ReadResourcesOpts): Promise<InventoryPage> {
  const pool = getPool();
  const params: unknown[] = [type];
  const where = `resource_type = $1` + accountWhereClause(accounts, params) + regionWhereClause(regions, includeGlobal, params);
  params.push(limit, offset);
  const r = await pool.query(
    `SELECT resource_id, region, account_id, data, captured_at FROM inventory_resources
     WHERE ${where} ORDER BY captured_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const s = await pool.query(
    `SELECT status, finished_at, row_count, error FROM inventory_sync_runs WHERE resource_type = $1 AND account_id = 'self'`,
    [type],
  );
  return { rows: r.rows, run: s.rows[0] ?? null };
}

export async function triggerSync(type: string): Promise<{ status: string; row_count?: number; error?: string }> {
  const fn = process.env.INV_SYNC_FUNCTION;
  if (!fn) throw new Error('INV_SYNC_FUNCTION not set');
  const out = await lambdaClient().send(new InvokeCommand({
    FunctionName: fn,
    Payload: new TextEncoder().encode(JSON.stringify({ type })),
  }));
  const raw = out.Payload ? new TextDecoder().decode(out.Payload) : '{}';
  try { return JSON.parse(raw); } catch { return { status: 'unknown' }; }
}
