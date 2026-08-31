// SG Rules & Usage — Aurora read/write helpers for the daily rule-inventory + Athena traffic-
// evidence pipeline (docs/superpowers/specs/2026-08-13-security-group-rules-usage-design.md,
// gated by sg_rule_activity_enabled, ADR-019). This module does NOT run Athena itself — it only
// reads/writes the Aurora tables (sg_flow_sources, sg_rule_inventory, sg_rule_activity_daily,
// sg_rule_scan_runs) and, for admin source validation, invokes the isolated Athena broker Lambda
// (the only principal allowed to assume the target account's AWSopsSgRuleAthenaRole — ADR-019 §4).
//
// Every workgroup/database/table identifier that reaches AWS Glue/Athena is validated against a
// strict allowlist regex BEFORE it is stored or sent anywhere — never string-concatenated from an
// untrusted, non-admin request (spec's IAM section). Aurora reads/writes below use bound ($n)
// parameters throughout; there is no dynamic SQL text assembly from caller input.
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { getPool } from './db';

// ── Strict identifier allowlists ────────────────────────────────────────────────────────────────
// Athena/Glue database & table names: letters/digits/underscore, must start with a letter or
// underscore (matches Glue's own naming rules closely enough to reject anything that could not be
// a real identifier). Workgroup names allow '.', '-' in addition (Athena's own charset).
export const GLUE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const WORKGROUP_RE = /^[A-Za-z0-9._-]{1,128}$/;
export const ACCOUNT_ID_RE = /^\d{12}$/;
// Mirrors web/lib/sg-analysis.ts / app/api/sg/route.ts's REGION_RE (2-4 char prefix, e.g.
// eusc-de-east-1 sovereign-cloud regions) rather than a fixed 3-segment shape.
export const REGION_RE = /^[a-z]{2,4}(-[a-z]+)+-\d$/;

export interface FlowSourceInput {
  accountId: string;
  region: string;
  workgroup: string;
  databaseName: string;
  tableName: string;
  enabled?: boolean;
}

export interface FlowSourceRow {
  id: number;
  account_id: string;
  region: string;
  workgroup: string;
  database_name: string;
  table_name: string;
  enabled: boolean;
  validation: Record<string, unknown>;
  created_by_sub: string;
  created_at: string;
  updated_at: string;
}

/** Returns a list of validation error messages (empty = valid). Never throws. */
export function validateFlowSourceInput(input: Partial<FlowSourceInput>): string[] {
  const errors: string[] = [];
  if (typeof input.accountId !== 'string' || !ACCOUNT_ID_RE.test(input.accountId)) {
    errors.push('accountId must be a 12-digit AWS account id');
  }
  if (typeof input.region !== 'string' || !REGION_RE.test(input.region)) {
    errors.push('region must be a valid AWS region name');
  }
  if (typeof input.workgroup !== 'string' || !WORKGROUP_RE.test(input.workgroup)) {
    errors.push('workgroup must match ^[A-Za-z0-9._-]{1,128}$');
  }
  if (typeof input.databaseName !== 'string' || !GLUE_IDENT_RE.test(input.databaseName)) {
    errors.push('databaseName must be a valid Glue identifier');
  }
  if (typeof input.tableName !== 'string' || !GLUE_IDENT_RE.test(input.tableName)) {
    errors.push('tableName must be a valid Glue identifier');
  }
  return errors;
}

export async function listFlowSources(): Promise<FlowSourceRow[]> {
  const r = await getPool().query<FlowSourceRow>(
    `SELECT id, account_id, region, workgroup, database_name, table_name, enabled, validation,
            created_by_sub, created_at, updated_at
       FROM sg_flow_sources ORDER BY account_id, region`,
  );
  return r.rows;
}

export async function getFlowSource(accountId: string, region: string): Promise<FlowSourceRow | null> {
  const r = await getPool().query<FlowSourceRow>(
    `SELECT id, account_id, region, workgroup, database_name, table_name, enabled, validation,
            created_by_sub, created_at, updated_at
       FROM sg_flow_sources WHERE account_id = $1 AND region = $2`,
    [accountId, region],
  );
  return r.rows[0] ?? null;
}

/** All ENABLED sources — used by the daily dispatcher to fan out one job per source. */
export async function listEnabledFlowSources(): Promise<FlowSourceRow[]> {
  const r = await getPool().query<FlowSourceRow>(
    `SELECT id, account_id, region, workgroup, database_name, table_name, enabled, validation,
            created_by_sub, created_at, updated_at
       FROM sg_flow_sources WHERE enabled ORDER BY account_id, region`,
  );
  return r.rows;
}

/**
 * Admin create/update. Caller MUST have already checked isAdmin() — this function does not
 * re-check authorization, only input shape (validateFlowSourceInput). `validation` is stored as
 * whatever the caller passed (typically the broker's validation result, or {status:'pending'}
 * when the broker is not configured/reachable) — never executed as SQL, always jsonb-bound.
 */
export async function upsertFlowSource(
  input: FlowSourceInput,
  createdBySub: string,
  validation: Record<string, unknown> = { status: 'pending' },
): Promise<FlowSourceRow> {
  const errors = validateFlowSourceInput(input);
  if (errors.length > 0) throw new Error(`invalid flow source: ${errors.join('; ')}`);
  const r = await getPool().query<FlowSourceRow>(
    `INSERT INTO sg_flow_sources
       (account_id, region, workgroup, database_name, table_name, enabled, validation, created_by_sub)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
     ON CONFLICT (account_id, region) DO UPDATE SET
       workgroup = EXCLUDED.workgroup,
       database_name = EXCLUDED.database_name,
       table_name = EXCLUDED.table_name,
       enabled = EXCLUDED.enabled,
       validation = EXCLUDED.validation,
       updated_at = now()
     RETURNING id, account_id, region, workgroup, database_name, table_name, enabled, validation,
               created_by_sub, created_at, updated_at`,
    [
      input.accountId, input.region, input.workgroup, input.databaseName, input.tableName,
      input.enabled ?? true, JSON.stringify(validation), createdBySub,
    ],
  );
  return r.rows[0];
}

export interface ValidationResult {
  ok: boolean;
  status: 'valid' | 'invalid' | 'unconfigured' | 'error';
  reason?: string;
  schemaFields?: string[];
  partitionStrategy?: string;
  /** Canonical Flow Log field name -> the ACTUAL column alias present on this table (e.g.
   * `interface_id` -> `interface-id`) — resolved once by the broker's `_validate` (Glue
   * DescribeTable) and persisted so scripts/v2/workers/sg_rule_scan.py's build_day_select can query
   * using the real schema instead of assuming underscore names (fixes the MAJOR "build_day_select
   * ignores what _validate resolved" finding). */
  columnMap?: Record<string, string>;
  /** Actual Glue partition key names (Hive-style year/month/day, or a single date-typed key) —
   * lets the worker add a real partition predicate instead of relying on the `start` filter alone. */
  partitionKeys?: string[];
  /** Glue catalog type for each entry in `partitionKeys`, same order (e.g. `["date"]`,
   * `["string","string","string"]` for a Hive year/month/day scheme, or `["bigint"]`) — lets the
   * worker refuse to treat a non-date-typed single partition key as an ISO-date column (item 7
   * follow-up fix: `sm.single_date_partition_key`). */
  partitionKeyTypes?: string[];
  /** Optional Flow Log fields actually present on this table (e.g. `bytes` may be absent on a
   * custom-format table) — lets the worker make `sum(bytes)` conditional instead of assuming it. */
  optionalFields?: string[];
  /** Item 1 follow-up fix (round 2): how (if at all) `account_id`/`region` scoping resolved for
   * this table — `"partition"` | `"column"` | `null` per field. Resolved from the UNION of Glue
   * PartitionKeys and Columns (with hyphen aliases), independently per field — see the broker's
   * `_validate` docstring. Persisted so operators can distinguish a genuinely single-account table
   * from a mis-detected org-wide one, instead of the two looking identical. */
  scopeResolution?: { account_id: 'partition' | 'column' | null; region: 'partition' | 'column' | null };
  /** True when NEITHER account_id nor region scoping resolved — this source will be scanned fully
   * unscoped (every account/region's rows in the table are read), which is expected/correct for a
   * genuinely single-account table but worth an explicit operator-visible signal for a table that
   * was meant to be centralized/org-wide. */
  scannedUnscoped?: boolean;
  checkedAt: string;
}

/**
 * Runs the admin-triggered source validation described in the spec's "Flow Log source
 * configuration" section (workgroup/database/table existence, schema field resolution,
 * partition-pruning strategy) by invoking the isolated Athena broker Lambda — this function
 * itself never calls Athena/Glue directly and never assumes AWSopsSgRuleAthenaRole; only the
 * broker's own role may do that (ADR-019 §4 isolation). Fails closed to `unconfigured` when the
 * broker is not deployed (feature flag off) so PUT can still store the source without live AWS
 * verification, and to `error` on any invoke failure — never silently claims a source is valid.
 */
export async function validateFlowSourceViaBroker(input: FlowSourceInput): Promise<ValidationResult> {
  const checkedAt = new Date().toISOString();
  const errors = validateFlowSourceInput(input);
  if (errors.length > 0) return { ok: false, status: 'invalid', reason: errors.join('; '), checkedAt };
  const brokerArn = process.env.SG_RULE_ATHENA_BROKER_ARN;
  if (!brokerArn) return { ok: false, status: 'unconfigured', reason: 'sg_rule_activity_enabled is off', checkedAt };
  try {
    const client = new LambdaClient({ region: process.env.AWS_REGION || 'ap-northeast-2' });
    const res = await client.send(new InvokeCommand({
      FunctionName: brokerArn,
      Payload: Buffer.from(JSON.stringify({
        action: 'validate',
        account_id: input.accountId,
        region: input.region,
        workgroup: input.workgroup,
        database: input.databaseName,
        table: input.tableName,
      })),
    }));
    const raw = res.Payload ? Buffer.from(res.Payload).toString('utf-8') : '{}';
    const body = JSON.parse(raw || '{}');
    if (res.FunctionError || body.ok !== true) {
      return { ok: false, status: 'invalid', reason: String(body.reason || res.FunctionError || 'validation failed'), checkedAt };
    }
    return {
      ok: true, status: 'valid', schemaFields: body.schemaFields, partitionStrategy: body.partitionStrategy,
      columnMap: body.columnMap, partitionKeys: body.partitionKeys, partitionKeyTypes: body.partitionKeyTypes,
      optionalFields: body.optionalFields,
      scopeResolution: body.scopeResolution, scannedUnscoped: body.scannedUnscoped,
      checkedAt,
    };
  } catch (e) {
    return { ok: false, status: 'error', reason: e instanceof Error ? e.message : String(e), checkedAt };
  }
}

// ── Rules inventory + activity read (paginated, filtered) ──────────────────────────────────────

export type RuleStatus = 'observed_compatible' | 'overlapping' | 'no_observed_evidence' | 'unassessable' | 'not_configured';

export interface RuleFilter {
  accountId?: string;
  region?: string;
  vpcId?: string;
  sgId?: string;
  direction?: 'ingress' | 'egress';
  status?: RuleStatus;
  text?: string;
  days?: 30 | 90 | 180;
  page?: number;
  pageSize?: number;
}

export interface RuleRow {
  account_id: string;
  region: string;
  rule_id: string;
  group_id: string;
  /** Gap-5 fix: the SG's VPC id, wired through from `sg_rule_inventory.vpc_id` — populated by the
   * daily worker (scripts/v2/workers/sg_rule_scan.py) from the ENI-membership snapshot it already
   * takes. Optional/nullable: rows snapshotted before this fix (or an SG with no ENI currently
   * attached) legitimately have no known VPC yet. */
  vpc_id?: string | null;
  is_egress: boolean;
  protocol: string;
  from_port: number | null;
  to_port: number | null;
  peer_kind: string;
  peer_value: string;
  description: string | null;
  compatible_match_count: number;
  overlap_match_count: number;
  last_observed_at: string | null;
  status: RuleStatus;
}

const ALLOWED_DAYS = new Set([30, 90, 180]);

/**
 * Filtered/paginated read over sg_rule_inventory joined with the sg_rule_activity_daily window and
 * sg_flow_sources (to derive `not_configured`). This is a READ-TIME classification approximation —
 * the authoritative per-day classification (including unassessable/fingerprint_epoch_crossing) is
 * computed once by the worker and stored in sg_rule_activity_daily.coverage; this aggregate only
 * rolls those already-computed per-day facts up into one status per rule for the selected window.
 */
export async function listRules(filter: RuleFilter): Promise<{ rows: RuleRow[]; total: number }> {
  const days = filter.days && ALLOWED_DAYS.has(filter.days) ? filter.days : 90;
  const page = Math.max(1, Math.floor(filter.page ?? 1));
  const pageSize = Math.min(500, Math.max(1, Math.floor(filter.pageSize ?? 50)));
  const offset = (page - 1) * pageSize;

  const where: string[] = ['ri.active'];
  const whereParams: unknown[] = [];
  const bindWhere = (v: unknown) => { whereParams.push(v); return `$${whereParams.length}`; };
  if (filter.accountId) where.push(`ri.account_id = ${bindWhere(filter.accountId)}`);
  if (filter.region) where.push(`ri.region = ${bindWhere(filter.region)}`);
  if (filter.vpcId) where.push(`ri.vpc_id = ${bindWhere(filter.vpcId)}`);
  if (filter.sgId) where.push(`ri.group_id = ${bindWhere(filter.sgId)}`);
  if (filter.direction) where.push(`ri.is_egress = ${bindWhere(filter.direction === 'egress')}`);
  if (filter.text) where.push(`(ri.rule_id ILIKE ${bindWhere(`%${filter.text}%`)} OR ri.description ILIKE ${bindWhere(`%${filter.text}%`)})`);
  const whereSql = where.join(' AND ');

  // rows query params = whereParams + [days, pageSize, offset] (in that positional order).
  const rowsParams = [...whereParams, days, pageSize, offset];
  const daysIdx = whereParams.length + 1;
  const limitIdx = whereParams.length + 2;
  const offsetIdx = whereParams.length + 3;

  const sql = `
    WITH act AS (
      SELECT account_id, region, rule_id,
             SUM(compatible_match_count) AS compatible_match_count,
             SUM(overlap_match_count) AS overlap_match_count,
             MAX(last_observed_at) AS last_observed_at,
             bool_or(coalesce((coverage->>'unassessable')::boolean, false)
                     OR coalesce((coverage->>'fingerprint_epoch_crossing')::boolean, false)) AS any_unassessable
        FROM sg_rule_activity_daily
       WHERE observed_on >= (current_date - $${daysIdx}::int)
       GROUP BY account_id, region, rule_id
    )
    SELECT ri.account_id, ri.region, ri.rule_id, ri.group_id, ri.vpc_id, ri.is_egress, ri.protocol,
           ri.from_port, ri.to_port, ri.peer_kind, ri.peer_value, ri.description,
           COALESCE(a.compatible_match_count, 0) AS compatible_match_count,
           COALESCE(a.overlap_match_count, 0) AS overlap_match_count,
           a.last_observed_at,
           (fs.id IS NOT NULL AND fs.enabled) AS has_source,
           COALESCE(a.any_unassessable, false) AS any_unassessable
      FROM sg_rule_inventory ri
      LEFT JOIN act a ON a.account_id = ri.account_id AND a.region = ri.region AND a.rule_id = ri.rule_id
      LEFT JOIN sg_flow_sources fs ON fs.account_id = ri.account_id AND fs.region = ri.region
     WHERE ${whereSql}
     ORDER BY ri.account_id, ri.region, ri.rule_id
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`;

  const countSql = `SELECT count(*)::int AS n FROM sg_rule_inventory ri
                     LEFT JOIN sg_flow_sources fs ON fs.account_id = ri.account_id AND fs.region = ri.region
                     WHERE ${whereSql}`;

  const pool = getPool();
  const [rowsRes, countRes] = await Promise.all([
    pool.query(sql, rowsParams),
    pool.query(countSql, whereParams),
  ]);

  const rows: RuleRow[] = rowsRes.rows.map((r: any) => {
    let status: RuleStatus;
    if (!r.has_source) status = 'not_configured';
    else if (r.any_unassessable && r.compatible_match_count === 0) status = 'unassessable';
    else if (r.overlap_match_count > 0) status = 'overlapping';
    else if (r.compatible_match_count > 0) status = 'observed_compatible';
    else status = 'no_observed_evidence';
    return {
      account_id: r.account_id, region: r.region, rule_id: r.rule_id, group_id: r.group_id,
      vpc_id: r.vpc_id ?? null,
      is_egress: r.is_egress, protocol: r.protocol, from_port: r.from_port, to_port: r.to_port,
      peer_kind: r.peer_kind, peer_value: r.peer_value, description: r.description,
      compatible_match_count: Number(r.compatible_match_count) || 0,
      overlap_match_count: Number(r.overlap_match_count) || 0,
      last_observed_at: r.last_observed_at,
      status,
    };
  });
  const filtered = filter.status ? rows.filter((r) => r.status === filter.status) : rows;
  return { rows: filtered, total: countRes.rows[0]?.n ?? filtered.length };
}

/** CSV export of already-fetched rows (no re-query; caller passes listRules() output). */
export function rulesToCsv(rows: RuleRow[]): string {
  const header = ['account_id', 'region', 'vpc_id', 'rule_id', 'group_id', 'direction', 'protocol',
    'from_port', 'to_port', 'peer_kind', 'peer_value', 'status', 'compatible_match_count',
    'overlap_match_count', 'last_observed_at'];
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.account_id, r.region, r.vpc_id ?? '', r.rule_id, r.group_id, r.is_egress ? 'egress' : 'ingress',
      r.protocol, r.from_port, r.to_port, r.peer_kind, r.peer_value, r.status, r.compatible_match_count,
      r.overlap_match_count, r.last_observed_at,
    ].map(esc).join(','));
  }
  return lines.join('\n');
}
