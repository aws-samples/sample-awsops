import { getPool } from './db';
import { isAdmin } from './admin';
import type { User } from './auth';

export type DiagnosisTier = 'light' | 'mid' | 'deep';
// Bedrock model for the report. Only the deep tier may select 'opus'; light/mid are always 'sonnet'.
export type DiagnosisModel = 'sonnet' | 'opus';
export interface DiagnosisReport {
  id: number;
  worker_job_id: string | null;
  /** Diagnosed account id (from the linked job payload; null on legacy rows). */
  account?: string | null;
  tier: DiagnosisTier;
  status: 'running' | 'succeeded' | 'failed' | 'partial';
  requested_by: string;
  sources_used: string[];
  summary: Record<string, unknown>;
  artifact_uri: string | null;
  error: string | null;
  created_at: string;
  // Bedrock model used (NULL on legacy rows → render as 'sonnet'). Display metadata only.
  model: string | null;
  // LLM auto key-insight title (editable) + tags (auto-suggested + manual); soft-delete timestamp.
  title: string | null;
  tags: string[];
  deleted_at: string | null;
  // BFF-enriched: may the current user edit/delete this report (owner or admin)? Not a DB column.
  can_edit?: boolean;
  // A3/A5 (V1 parity): live per-section progress written by the worker as generate() advances.
  progress: DiagnosisProgress;
}

export interface DiagnosisProgress {
  current?: number;
  total?: number;
  section?: string;
  phase?: 'collect' | 'render' | 'assemble';
}

const COLS =
  'id, worker_job_id, tier, status, requested_by, sources_used, summary, artifact_uri, error, created_at, model, title, tags, deleted_at, progress';

export async function listReports(limit = 50): Promise<DiagnosisReport[]> {
  const { rows } = await getPool().query(
    `SELECT ${COLS.split(', ').map((c) => `r.${c}`).join(', ')}, j.payload->>'account' AS account
     FROM diagnosis_reports r LEFT JOIN worker_jobs j ON j.job_id = r.worker_job_id
     WHERE r.deleted_at IS NULL ORDER BY r.created_at DESC LIMIT $1`,
    [limit],
  );
  return rows as DiagnosisReport[];
}

export async function getReport(id: number): Promise<DiagnosisReport | null> {
  // Filters soft-deleted → a deleted report is 404 on GET/download/PATCH/DELETE.
  const { rows } = await getPool().query(
    `SELECT ${COLS} FROM diagnosis_reports WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return (rows[0] as DiagnosisReport) ?? null;
}

// [GATE-FIX R2 CRITICAL] FK ORDERING: diagnosis_reports.worker_job_id REFERENCES worker_jobs(job_id).
// The row must be created with worker_job_id=NULL (column is nullable), and LINKED only AFTER the
// worker_jobs row exists (post-enqueue) — otherwise the FK insert fails on the first request.
// The worker finds its row via payload.report_id (not the FK), so NULL-at-insert is safe.
// [Plan 2] parent_report_id = the most-recent SUCCEEDED report of the SAME tier (diff lineage). Set
// atomically in the INSERT via a subquery so the worker can compute summary.diff vs the prior run.
export async function createReport(
  tier: DiagnosisTier,
  requestedBy: string,
  model: DiagnosisModel = 'sonnet',
): Promise<number> {
  const { rows } = await getPool().query(
    `INSERT INTO diagnosis_reports (worker_job_id, tier, requested_by, status, parent_report_id, model)
     VALUES (NULL, $1, $2, 'running',
       (SELECT id FROM diagnosis_reports
         WHERE tier = $1 AND status = 'succeeded' AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT 1),
       $3)
     RETURNING id`,
    [tier, requestedBy, model],
  );
  return rows[0].id as number;
}

// Link the report to its job AFTER enqueueJob has inserted worker_jobs(job_id) (FK now satisfiable).
export async function linkReportJob(reportId: number, workerJobId: string): Promise<void> {
  await getPool().query(
    `UPDATE diagnosis_reports SET worker_job_id = $1 WHERE id = $2`,
    [workerJobId, reportId],
  );
}

// Idempotency-first: return the report already attached to an existing job for this key, if any.
export async function reportForIdempotencyKey(key: string): Promise<number | null> {
  const { rows } = await getPool().query(
    `SELECT r.id FROM diagnosis_reports r JOIN worker_jobs j ON j.job_id = r.worker_job_id
     WHERE j.idempotency_key = $1 AND r.deleted_at IS NULL ORDER BY r.id DESC LIMIT 1`,
    [key],
  );
  return rows[0]?.id ?? null;
}

// Fail an orphaned 'running' row (e.g. when enqueue throws after createReport).
export async function markReportFailed(reportId: number, msg: string): Promise<void> {
  await getPool().query(
    `UPDATE diagnosis_reports SET status = 'failed', error = $2 WHERE id = $1 AND status = 'running'`,
    [reportId, msg],
  );
}

// Partial metadata update — only sets the columns provided (tags-only must not clobber title).
export async function updateReportMeta(
  id: number,
  meta: { title?: string | null; tags?: string[] },
): Promise<void> {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (meta.title !== undefined) {
    args.push(meta.title);
    sets.push(`title = $${args.length}`);
  }
  if (meta.tags !== undefined) {
    args.push(meta.tags);
    sets.push(`tags = $${args.length}`);
  }
  if (sets.length === 0) return;
  args.push(id);
  await getPool().query(
    `UPDATE diagnosis_reports SET ${sets.join(', ')} WHERE id = $${args.length} AND deleted_at IS NULL`,
    args,
  );
}

// Soft delete — hide from the list (recoverable; S3 retained). Idempotent (re-delete = no-op).
export async function softDeleteReport(id: number): Promise<void> {
  await getPool().query(
    `UPDATE diagnosis_reports SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
}

// Edit/delete gate: report owner (requested_by) OR an admin. Fail-closed (server-side enforced).
export async function canMutateReport(
  user: Pick<User, 'email' | 'sub' | 'groups'>,
  report: Pick<DiagnosisReport, 'requested_by'>,
): Promise<boolean> {
  if (await isAdmin(user)) return true;
  return report.requested_by === (user.email ?? user.sub);
}
