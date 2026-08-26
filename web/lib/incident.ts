// web/lib/incident.ts
// ADR-032 Triage data layer (web BFF side). Pure-ish: all DB through node-pg getPool().
//
// SAFETY (autonomous incident lifecycle shipped OFF):
//   - triageAndCreateOrLink returns {decision:'disabled'} and performs NO writes unless
//     BOTH AURORA_ENDPOINT is set AND INCIDENT_LIFECYCLE_ENABLED === 'true'. The webhook
//     route (Task 3) ALSO 503s when off — defense in depth; no autonomous accept.
//   - This module NEVER executes any mutation and NEVER touches tool perms / roster /
//     approval. Alert payloads are attacker-controlled; only isolated, descriptive data
//     ever flows downstream (see incident-normalize.isolatePayload, used by the agent tier).
//   - The dedup-race write (Addendum (a)) lets exactly ONE concurrent alert win 'New' via the
//     correlation_key UNIQUE constraint; all others resolve to 'Linked'.
import { randomUUID } from 'crypto';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { getPool } from '@/lib/db';
import { correlationKey, type AlertEvent, type AlertSeverity } from '@/lib/incident-normalize';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const PROJECT = process.env.PROJECT || 'awsops-v2';
const TTL_MS = 5 * 60 * 1000;

let sqs: SQSClient | null = null;
let ssm: SSMClient | null = null;

function enabled(): boolean {
  return !!process.env.AURORA_ENDPOINT && process.env.INCIDENT_LIFECYCLE_ENABLED === 'true';
}

// --- severity ranking / gate (Addendum #7) ---

function severityRank(s: AlertSeverity): number {
  return s === 'critical' ? 3 : s === 'warning' ? 2 : 1;
}

/** Isolated, bounded snapshot of the triggering alert, persisted on the New path for the W2
 *  AlertValidation stage to load by incident_id. Descriptive/normalized fields only — NOT the
 *  raw rawPayload (which bypasses isolatePayload's caps/defang). */
export function buildTriggerSnapshot(event: AlertEvent): Record<string, unknown> {
  const labels = event.labels ?? {};
  const annotations = (event.annotations ?? {}) as Record<string, string>;
  return {
    id: event.id,
    severity: event.severity,
    source: event.source,
    alertName: event.alertName,
    services: event.services ?? [],
    resources: event.resources ?? [],
    labels,
    metric: event.metric ?? null,
    timestamp: event.timestamp,
    account: labels.account_id ?? annotations.accountId ?? null,
    alarmArn: event.alarmArn ?? null,
  };
}

export type TriageDecision = 'New' | 'Linked' | 'Skipped' | 'disabled';
export interface TriageResult {
  decision: TriageDecision;
  incidentId?: string;
}

/**
 * triageAndCreateOrLink — dedup-race-safe (Addendum (a)).
 * Exactly one 'New' wins via INSERT … ON CONFLICT (correlation_key) DO NOTHING; the rest 'Linked'.
 * Below the configured min-severity → 'Skipped'. Flag off / AURORA unconfigured → 'disabled' (no writes).
 */
export async function triageAndCreateOrLink(event: AlertEvent): Promise<TriageResult> {
  if (!enabled()) return { decision: 'disabled' }; // BINDING: no autonomous accept when off

  // Severity gate (storm control #7) — configurable via SSM, NOT hardcoded.
  const minSeverity = await readMinSeverity();
  if (severityRank(event.severity) < severityRank(minSeverity)) return { decision: 'Skipped' };

  const key = correlationKey(event);
  const fingerprint = event.id;
  const id = randomUUID();
  const severity = event.severity;
  const source = event.source;
  const services = event.services ?? [];
  const resources = event.resources ?? [];
  const agentSpaceVersion = process.env.AGENT_SPACE_VERSION ?? null;

  // Addendum (a): exactly one 'New' wins, the rest 'Linked'.
  const { rows } = await getPool().query(
    `INSERT INTO incidents (id, correlation_key, fingerprint, status, severity, trigger_source, services, resources, agent_space_version)
     VALUES ($1,$2,$3,'triaged',$4,$5,$6,$7,$8)
     ON CONFLICT (correlation_key) DO NOTHING
     RETURNING id`,
    [id, key, fingerprint, severity, source, services, resources, agentSpaceVersion]);

  if (rows.length === 0) {
    // lost the race (or look-back match): link to the existing active incident, bump last_event_at
    const { rows: ex } = await getPool().query(
      `UPDATE incidents SET last_event_at = now()
       WHERE correlation_key = $1 AND status IN ('triaged','investigating') RETURNING id`, [key]);
    const incidentId = ex[0]?.id;
    if (incidentId) await getPool().query(
      `INSERT INTO incident_links (incident_id, correlation_key, reason) VALUES ($1,$2,'dedup-race-or-lookback')`,
      [incidentId, key]);
    return { decision: 'Linked', incidentId };
  }
  // Persist the isolated trigger snapshot for W2 AlertValidation (New path only). Degrade-safe:
  // tolerates the trigger_event column being absent on pre-migration substrate.
  try {
    await getPool().query(`UPDATE incidents SET trigger_event = $1::jsonb WHERE id = $2`,
      [JSON.stringify(buildTriggerSnapshot(event)), id]);
  } catch { /* column absent (migration not yet applied) — snapshot is best-effort */ }
  return { decision: 'New', incidentId: id };
}

/**
 * enqueueInitialStage — rides the P2 backbone (ADR-032 Addendum #3): a worker_jobs row
 * (type='incident_stage', queued) + SendMessage to JOBS_QUEUE_URL. No parallel queue.
 * Mirrors web/app/api/actions/[id]/route.ts. The dispatcher routes 'incident_stage' → incident SM.
 */
export async function enqueueInitialStage(incidentId: string): Promise<{ jobId: string }> {
  if (!process.env.AURORA_ENDPOINT) return { jobId: '' };
  const jobId = randomUUID();
  const payload = { incident_id: incidentId, stage: 'triage' };
  await getPool().query(
    `INSERT INTO worker_jobs (job_id, type, payload, dry_run, status) VALUES ($1,'incident_stage',$2::jsonb,false,'queued')`,
    [jobId, JSON.stringify(payload)]);
  const queueUrl = process.env.JOBS_QUEUE_URL;
  if (queueUrl) {
    if (!sqs) sqs = new SQSClient({ region: REGION });
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify({
      job_id: jobId, type: 'incident_stage', payload, dry_run: false }) }));
  }
  return { jobId };
}

// --- Reads (admin-gated at the route layer; degrade-safe here) ---

export async function listIncidents(limit = 100): Promise<Record<string, unknown>[]> {
  if (!process.env.AURORA_ENDPOINT) return [];
  const { rows } = await getPool().query(
    `SELECT id, correlation_key, status, severity, trigger_source, services, resources,
            first_event_at, last_event_at, created_at, updated_at
     FROM incidents ORDER BY last_event_at DESC LIMIT $1`, [limit]);
  return rows;
}

export interface IncidentDetail {
  id: string;
  stages: Record<string, unknown>[];
  findings: Record<string, unknown>[];
  [k: string]: unknown;
}

export async function getIncident(id: string): Promise<IncidentDetail | null> {
  if (!process.env.AURORA_ENDPOINT) return null;
  const { rows } = await getPool().query(
    `SELECT id, correlation_key, fingerprint, status, severity, trigger_source, services, resources,
            agent_space_version, rca, mitigation_plan, writeback_status, first_event_at, last_event_at, created_at, updated_at
     FROM incidents WHERE id = $1`, [id]);
  const inc = rows[0];
  if (!inc) return null;
  const { rows: stages } = await getPool().query(
    `SELECT stage, status, job_id, last_checkpoint_at, timeout_seconds, detail, created_at
     FROM incident_stages WHERE incident_id = $1 ORDER BY id`, [id]);
  const { rows: findings } = await getPool().query(
    `SELECT sub_agent, agent_version, skill_hashes, findings, created_at
     FROM incident_findings WHERE incident_id = $1 ORDER BY id`, [id]);
  // ADR-034 write-back audit (read-only; the write path is the SM Lambda, never web). Degrade-safe:
  // returns [] when the incident_writeback table / migration v6 is absent (flag-OFF substrate).
  let writeback: Record<string, unknown>[] = [];
  try {
    const r = await getPool().query(
      `SELECT target_system, status, source_object_id, rca_version, slack_thread_ts, created_at
       FROM incident_writeback WHERE incident_id = $1 ORDER BY id`, [id]);
    writeback = r.rows;
  } catch {
    writeback = []; // degrade-safe: table/flag absent
  }
  return { ...inc, stages, findings, writeback };
}

// --- SSM config readers (cached, mirror agentcore.ts TTL; Addendum #4/#7) ---

interface Cached<T> { value: T; at: number; }
const cache: Record<string, Cached<string>> = {};

async function readParam(suffix: string, fallback: string): Promise<string> {
  const name = `/ops/${PROJECT}/incident/${suffix}`;
  const c = cache[name];
  if (c && Date.now() - c.at < TTL_MS) return c.value;
  if (!ssm) ssm = new SSMClient({ region: REGION });
  try {
    const r = await ssm.send(new GetParameterCommand({ Name: name }));
    const value = r.Parameter?.Value ?? fallback;
    cache[name] = { value, at: Date.now() };
    return value;
  } catch {
    return fallback; // degrade-safe: defaults when the gated param is absent
  }
}

export async function readWindowMinutes(): Promise<number> {
  return parseInt(await readParam('correlation-window-minutes', '20'), 10) || 20;
}
export async function readStageTimeoutSeconds(): Promise<number> {
  return parseInt(await readParam('stage-timeout-seconds', '600'), 10) || 600;
}
export async function readMaxConcurrent(): Promise<number> {
  return parseInt(await readParam('max-concurrent-investigations', '5'), 10) || 5;
}
export async function readFanoutMax(): Promise<number> {
  return parseInt(await readParam('subagent-fanout-max', '4'), 10) || 4;
}
export async function readMinSeverity(): Promise<AlertSeverity> {
  const v = await readParam('min-severity', 'warning');
  return v === 'critical' ? 'critical' : v === 'info' ? 'info' : 'warning';
}
