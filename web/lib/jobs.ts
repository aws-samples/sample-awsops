import { randomUUID } from 'crypto';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { getPool } from '@/lib/db';

let sqs: SQSClient | null = null;
function getSqs(): SQSClient {
  if (!sqs) sqs = new SQSClient({ region: process.env.AWS_REGION || 'ap-northeast-2' });
  return sqs;
}

export interface EnqueueOpts {
  idempotencyKey?: string | null;
  dryRun?: boolean;
  // Caller-supplied job id (so the BFF can link worker_job_id before the job runs).
  jobId?: string;
}

export interface EnqueueResult {
  job_id: string;
  status: string;
}

/**
 * Raised when the durable ledger row was written but the SQS delivery failed. The job_id is
 * already 'queued' (a redrive/reaper recovers), so callers can return 202 instead of 500.
 */
export class EnqueueDeliveryError extends Error {
  constructor(public readonly job_id: string, public readonly status: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'EnqueueDeliveryError';
  }
}

/**
 * Enqueue a worker job: durable ledger write to worker_jobs (source of truth) then a best-effort
 * SQS SendMessage. Extracted verbatim from app/api/jobs/route.ts so both routes share one seam.
 *
 * Phase 1 — insert-or-get on idempotency_key (NULLs are distinct → keyless jobs always insert).
 * Phase 2 — enqueue (re-send on idempotent replay is safe; the dispatcher dedups via SFN exec name).
 * Throws if JOBS_QUEUE_URL is unset (caller keeps the 503 behavior) or on a DB/SQS failure.
 */
export async function enqueueJob(
  type: string,
  payload: Record<string, unknown>,
  opts: EnqueueOpts = {},
): Promise<EnqueueResult> {
  const queueUrl = process.env.JOBS_QUEUE_URL;
  if (!queueUrl) throw new Error('JOBS_QUEUE_URL not set (workers disabled)');

  const dryRun = Boolean(opts.dryRun);
  const idempotencyKey = opts.idempotencyKey ?? null;
  // SECURITY (consensus gate): `scheduled` is a scheduler-provenance marker the report worker uses to
  // decide whether to email the mailing list. It must originate ONLY from the EventBridge dispatcher,
  // which writes SQS directly (bypassing this function) — never from a client. Strip it from every
  // web-originated enqueue so a caller can't POST {type:"report", payload:{scheduled:true}} to force a
  // mailing-list blast. (No legitimate BFF caller sets it.)
  const safePayload: Record<string, unknown> = { ...(payload ?? {}) };
  delete safePayload.scheduled;
  const payloadJson = JSON.stringify(safePayload);

  const pool = getPool();
  let jobId = '';
  let status = 'queued';
  const ins = await pool.query(
    `INSERT INTO worker_jobs (job_id, type, payload, dry_run, idempotency_key, status)
     VALUES ($1, $2, $3::jsonb, $4, $5, 'queued')
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING job_id`,
    [opts.jobId || randomUUID(), type, payloadJson, dryRun, idempotencyKey],
  );
  if (ins.rows.length > 0) {
    jobId = ins.rows[0].job_id;
  } else {
    const existing = await pool.query(
      `SELECT job_id, status FROM worker_jobs WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    if (existing.rows.length === 0) {
      throw new Error('idempotency conflict but no existing row');
    }
    jobId = existing.rows[0].job_id;
    status = existing.rows[0].status;
  }

  try {
    await getSqs().send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({ job_id: jobId, type, payload: safePayload, dry_run: dryRun }),
      }),
    );
  } catch (e) {
    // Ledger row is durable; surface a distinct error so the caller can return 202 (not 500).
    throw new EnqueueDeliveryError(jobId, status, e);
  }

  return { job_id: jobId, status };
}
