export interface ObservedJob {
  job_id: string; type: string; status: string; attempt?: number;
  created_at: string | Date; started_at?: string | Date | null; finished_at?: string | Date | null;
  updated_at?: string | Date;
}

const TERMINAL = new Set(['succeeded', 'failed', 'canceled', 'manual_intervention']);

function timestamp(value: string | Date | null | undefined, nowMs: number): number | null {
  if (value == null) return null;
  const result = new Date(value).getTime();
  return Number.isFinite(result) && result <= nowMs ? result : null;
}

export function jobTiming(job: ObservedJob, nowMs: number) {
  const created = timestamp(job.created_at, nowMs);
  const started = timestamp(job.started_at, nowMs);
  const terminal = TERMINAL.has(job.status);
  const finished = terminal ? timestamp(job.finished_at, nowMs) : null;
  const startValid = created !== null && started !== null && started >= created
    && (finished === null || started <= finished);
  const totalMs = created !== null && finished !== null && finished >= created ? finished - created : null;
  const waitMs = startValid ? started! - created! : null;
  const workerLifecycleMs = startValid && finished !== null ? finished - started! : null;
  return {
    correlationId: job.job_id,
    waitMs, workerLifecycleMs, totalMs,
    ageMs: created === null ? null : nowMs - created,
    attempts: Number.isInteger(job.attempt) && job.attempt! >= 0 ? job.attempt! : null,
    coverage: waitMs !== null && workerLifecycleMs !== null && totalMs !== null ? 'complete' : 'partial',
    waitBoundary: 'accepted_to_first_worker_start',
    workerBoundary: 'first_start_to_terminal_including_retries',
  };
}

export function summarizeJobs(
  jobs: ObservedJob[],
  options: { nowMs: number; targetMs?: number; totalCount: number },
) {
  const targetMs = Number.isFinite(options.targetMs) && options.targetMs! > 0 ? options.targetMs! : null;
  let good = 0, bad = 0, pending = 0, unknown = 0;
  let missingDurationCount = 0;
  const durations: number[] = [];
  const statuses: Record<string, number> = {};
  for (const job of jobs) {
    statuses[job.status] = (statuses[job.status] ?? 0) + 1;
    const timing = jobTiming(job, options.nowMs);
    if (timing.totalMs !== null) durations.push(timing.totalMs);
    else if (TERMINAL.has(job.status)) missingDurationCount++;
    if (targetMs === null) continue;
    if (job.status === 'succeeded') {
      if (timing.totalMs === null) unknown++;
      else if (timing.totalMs <= targetMs) good++;
      else bad++;
    } else if (TERMINAL.has(job.status)) bad++;
    else if (job.status === 'queued' || job.status === 'running') {
      if (timing.ageMs === null) unknown++;
      else if (timing.ageMs > targetMs) bad++;
      else pending++;
    } else unknown++;
  }
  durations.sort((a, b) => a - b);
  const countKnown = Number.isSafeInteger(options.totalCount) && options.totalCount >= jobs.length;
  const complete = countKnown && options.totalCount === jobs.length && unknown === 0 && missingDurationCount === 0;
  return {
    targetMs, good, bad, pending, unknown: targetMs === null ? missingDurationCount : unknown,
    missingDurationCount, statuses,
    sampled: jobs.length, totalCount: countKnown ? options.totalCount : null,
    coverage: complete ? 'complete' : 'partial',
    attainment: targetMs !== null && complete && good + bad > 0 ? good / (good + bad) : null,
    latencySampleCount: durations.length,
    p95Ms: complete && durations.length ? durations[Math.ceil(durations.length * 0.95) - 1] : null,
    cohort: 'accepted_in_window',
  };
}
