// Network Path Check — Aurora CRUD for saved check definitions + run history.
//
// Design spec: docs/superpowers/specs/2026-08-13-network-path-check-design.md (Approved 2026-08-19).
// Tables: migrations/01M0CZS7GNHBC8FNYTTENA56N2_network_path_check.sql (network_path_checks,
// network_path_runs, network_path_run_candidates, network_path_run_steps) — never hand-edit that
// migration; schema changes go in a new ULID migration file.
//
// Ownership (spec "UI and ownership"): "The creator and an AWSops administrator may edit or delete
// a saved definition. Any authorized viewer may run the check and view its history." Ownership is
// keyed on the immutable Cognito `sub` (matchesIdentity(), web/lib/auth.ts) — never a mutable email.
//
// Versioning (spec): "Checks ... are versioned by snapshotting the full request into every run.
// Editing a definition never rewrites prior results." createRun() JSON-round-trips `definition`
// into `definition_snapshot` at insert time — the row is never updated afterward by any code path
// in this module, so a later edit to the parent check can never retroactively change a past run.
import { randomUUID } from 'crypto';
import { getPool } from '@/lib/db';
import { matchesIdentity, type User } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { enqueueJob } from '@/lib/jobs';

export interface NetworkPathDefinition {
  source: Record<string, unknown>;
  destination: Record<string, unknown>;
  request: Record<string, unknown>;
}

export interface NetworkPathCheckRow {
  id: string;
  name: string;
  source_account_id: string;
  definition: NetworkPathDefinition;
  created_by_sub: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface NetworkPathRunRow {
  id: string;
  check_id: string;
  requested_by_sub: string;
  definition_snapshot: NetworkPathDefinition;
  status: string;
  phase: string;
  overall_status: string | null;
  validation_bundle: unknown | null;
  worker_job_id: string | null;
  created_at: string;
  finished_at: string | null;
  // MINOR fix (pr-review round 2): the worker now persists WHY a run failed (migration
  // 01M0CZS7GZJJJ7S050Y9Z04964) — nullable, never set on a non-failed run.
  error: string | null;
}

export class NotFoundError extends Error {
  constructor(msg = 'not found') {
    super(msg);
    this.name = 'NotFoundError';
  }
}

export class ForbiddenError extends Error {
  constructor(msg = 'forbidden') {
    super(msg);
    this.name = 'ForbiddenError';
  }
}

export class ValidationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ValidationError';
  }
}

function validateDefinition(definition: unknown): NetworkPathDefinition {
  if (!definition || typeof definition !== 'object') {
    throw new ValidationError('definition must be an object');
  }
  const d = definition as Record<string, unknown>;
  for (const key of ['source', 'destination', 'request']) {
    if (!d[key] || typeof d[key] !== 'object') {
      throw new ValidationError(`definition.${key} must be an object`);
    }
  }
  return d as unknown as NetworkPathDefinition;
}

// ── Checks CRUD ─────────────────────────────────────────────────────────────────────────────────

/**
 * Visible to any authenticated user who can access the source account (spec "UI and ownership") —
 * approximated the same way /api/compliance/run scopes its `account` param: the account must exist
 * and be enabled in `accounts`, OR the caller is an admin (who can access every onboarded account).
 */
export async function listChecks(user: User): Promise<NetworkPathCheckRow[]> {
  const admin = await isAdmin(user);
  const r = admin
    ? await getPool().query(
        `SELECT id, name, source_account_id, definition, created_by_sub, created_at, updated_at, deleted_at
         FROM network_path_checks WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 200`,
      )
    : await getPool().query(
        `SELECT c.id, c.name, c.source_account_id, c.definition, c.created_by_sub, c.created_at, c.updated_at, c.deleted_at
         FROM network_path_checks c
         WHERE c.deleted_at IS NULL
           AND EXISTS (SELECT 1 FROM accounts a WHERE a.account_id = c.source_account_id AND a.enabled)
         ORDER BY c.created_at DESC LIMIT 200`,
      );
  return r.rows;
}

export async function getCheck(id: string): Promise<NetworkPathCheckRow | null> {
  const r = await getPool().query(
    `SELECT id, name, source_account_id, definition, created_by_sub, created_at, updated_at, deleted_at
     FROM network_path_checks WHERE id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

export async function createCheck(
  user: User,
  input: { name: string; source_account_id: string; definition: unknown },
): Promise<NetworkPathCheckRow> {
  if (typeof input?.name !== 'string' || !input.name.trim()) {
    throw new ValidationError('name is required');
  }
  if (typeof input?.source_account_id !== 'string' || !/^[0-9]{12}$/.test(input.source_account_id)) {
    throw new ValidationError('source_account_id must be a 12-digit account id');
  }
  const definition = validateDefinition(input.definition);
  const id = randomUUID();
  const r = await getPool().query(
    `INSERT INTO network_path_checks (id, name, source_account_id, definition, created_by_sub)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING id, name, source_account_id, definition, created_by_sub, created_at, updated_at, deleted_at`,
    [id, input.name.trim(), input.source_account_id, JSON.stringify(definition), user.sub],
  );
  return r.rows[0];
}

/** Creator-or-admin only (spec). Never mutates `deleted_at` here — see softDeleteCheck. */
export async function updateCheck(
  user: User,
  id: string,
  patch: { name?: string; definition?: unknown },
): Promise<NetworkPathCheckRow> {
  const existing = await getCheck(id);
  if (!existing || existing.deleted_at) throw new NotFoundError();
  const admin = await isAdmin(user);
  if (!admin && !matchesIdentity(existing.created_by_sub, user)) throw new ForbiddenError();

  const name = typeof patch.name === 'string' && patch.name.trim() ? patch.name.trim() : existing.name;
  const definition = patch.definition !== undefined ? validateDefinition(patch.definition) : existing.definition;
  const r = await getPool().query(
    `UPDATE network_path_checks SET name = $1, definition = $2::jsonb, updated_at = now()
     WHERE id = $3
     RETURNING id, name, source_account_id, definition, created_by_sub, created_at, updated_at, deleted_at`,
    [name, JSON.stringify(definition), id],
  );
  return r.rows[0];
}

/**
 * Soft delete (spec): removes the definition from active lists and prevents new runs while
 * preserving prior run evidence for audit/comparison. Never touches network_path_runs/*.
 */
export async function softDeleteCheck(user: User, id: string): Promise<void> {
  const existing = await getCheck(id);
  if (!existing || existing.deleted_at) throw new NotFoundError();
  const admin = await isAdmin(user);
  if (!admin && !matchesIdentity(existing.created_by_sub, user)) throw new ForbiddenError();
  await getPool().query(`UPDATE network_path_checks SET deleted_at = now() WHERE id = $1`, [id]);
}

// ── Runs ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Validates the check exists and is not soft-deleted, snapshots the FULL definition into the run
 * row (immutable from this point on), creates the run, and enqueues the `network_path` worker job.
 * Never goes through the generic POST /api/jobs (ADR-009) — see app/api/network-paths/[id]/runs/route.ts.
 */
export async function createRun(user: User, checkId: string): Promise<NetworkPathRunRow> {
  const check = await getCheck(checkId);
  if (!check || check.deleted_at) throw new NotFoundError('check not found or deleted');

  const runId = randomUUID();
  const snapshot = JSON.parse(JSON.stringify(check.definition));
  const ins = await getPool().query(
    `INSERT INTO network_path_runs (id, check_id, requested_by_sub, definition_snapshot, status, phase)
     VALUES ($1, $2, $3, $4::jsonb, 'queued', 'resolve')
     RETURNING id, check_id, requested_by_sub, definition_snapshot, status, phase, overall_status,
               validation_bundle, worker_job_id, created_at, finished_at`,
    [runId, checkId, user.sub, JSON.stringify(snapshot)],
  );
  const run: NetworkPathRunRow = ins.rows[0];

  // CI-review MAJOR fix (round 17, item 5): `source_account_id` is threaded into the job payload
  // alongside the immutable definition snapshot so the worker can bind `definition.source.account_id`
  // to the check's OWN validated column (network_path.py's `run()`) rather than trusting an
  // arbitrary account_id embedded in the (user-authored) definition at resolve time.
  const { job_id } = await enqueueJob(
    'network_path',
    { run_id: runId, definition: snapshot, source_account_id: check.source_account_id },
    { requestedBy: user.sub },
  );
  await getPool().query(`UPDATE network_path_runs SET worker_job_id = $1 WHERE id = $2`, [job_id, runId]);
  run.worker_job_id = job_id;
  return run;
}

/**
 * Run history for one check — spec "Any authorized viewer may run the check and view its
 * history." Ownership/account-scoping is intentionally NOT re-checked here (unlike listChecks()):
 * a run row is immutable evidence of something that already happened, and the caller (the
 * dedicated GET /api/network-paths/[id]/runs route) already resolves the parent check first, so a
 * nonexistent/soft-deleted check_id simply yields an empty list rather than a second authorization
 * decision duplicating listChecks()'s.
 */
export async function listRunsForCheck(checkId: string, limit = 50): Promise<NetworkPathRunRow[]> {
  const r = await getPool().query(
    `SELECT id, check_id, requested_by_sub, definition_snapshot, status, phase, overall_status,
            validation_bundle, worker_job_id, created_at, finished_at, error
     FROM network_path_runs WHERE check_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [checkId, Math.min(200, Math.max(1, Math.floor(limit)))],
  );
  return r.rows;
}

export interface NetworkPathRunDetail extends NetworkPathRunRow {
  candidates: Array<{ candidate_id: string; candidate_kind: string; status: string | null; first_blocker: string | null }>;
  steps: Array<{
    candidate_id: string; account_id: string; region: string; ordinal: number; layer: string;
    status: string; resource: string | null; summary: string; evidence: unknown; observed_at: string | null;
  }>;
}

export async function getRunDetail(runId: string): Promise<NetworkPathRunDetail | null> {
  const runRes = await getPool().query(
    `SELECT id, check_id, requested_by_sub, definition_snapshot, status, phase, overall_status,
            validation_bundle, worker_job_id, created_at, finished_at, error
     FROM network_path_runs WHERE id = $1`,
    [runId],
  );
  const run = runRes.rows[0];
  if (!run) return null;

  const [candidatesRes, stepsRes] = await Promise.all([
    getPool().query(
      `SELECT candidate_id, candidate_kind, status, first_blocker
       FROM network_path_run_candidates WHERE run_id = $1 ORDER BY candidate_id`,
      [runId],
    ),
    getPool().query(
      `SELECT candidate_id, account_id, region, ordinal, layer, status, resource, summary, evidence, observed_at
       FROM network_path_run_steps WHERE run_id = $1 ORDER BY candidate_id, ordinal`,
      [runId],
    ),
  ]);

  return { ...run, candidates: candidatesRes.rows, steps: stepsRes.rows };
}
