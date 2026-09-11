import { describe, expect, it } from 'vitest';
import { jobTiming, summarizeJobs } from './job-observability';

const job = {
  job_id: 'job-1', type: 'report', status: 'succeeded', attempt: 1,
  created_at: '2026-09-11T00:00:00Z', started_at: '2026-09-11T00:00:10Z',
  finished_at: '2026-09-11T00:00:40Z',
};
const now = Date.parse('2026-09-11T00:01:00Z');

describe('async workload timing', () => {
  it('separates acceptance-to-start wait from worker lifecycle and end-to-end duration', () => {
    expect(jobTiming(job, now)).toMatchObject({
      correlationId: 'job-1', waitMs: 10000, workerLifecycleMs: 30000, totalMs: 40000,
      coverage: 'complete',
    });
  });
  it('leaves old job timing unknown instead of substituting updated_at', () => {
    expect(jobTiming({ ...job, started_at: null, finished_at: null,
      updated_at: '2026-09-11T00:00:40Z' }, now)).toMatchObject({
      waitMs: null, workerLifecycleMs: null, totalMs: null, coverage: 'partial',
    });
  });
  it('does not clamp inverted timestamps into a healthy zero duration', () => {
    expect(jobTiming({ ...job, started_at: '2026-09-10T00:00:00Z' }, now)).toMatchObject({
      waitMs: null, workerLifecycleMs: null, coverage: 'partial',
    });
  });
  it.each(['canceled', 'manual_intervention'])('preserves observed timing for terminal state %s', (status) => {
    expect(jobTiming({ ...job, status }, now).totalMs).toBe(40000);
    expect(summarizeJobs([{ ...job, status }], { nowMs: now, targetMs: 45000, totalCount: 1 }))
      .toMatchObject({ bad: 1, unknown: 0, attainment: 0 });
  });
});

describe('workload completion objective', () => {
  it('counts overdue running work as a missed objective and separates work not yet due', () => {
    const rows = [
      job,
      { ...job, job_id: 'overdue', status: 'running', finished_at: null },
      { ...job, job_id: 'pending', status: 'queued', created_at: '2026-09-11T00:00:55Z',
        started_at: null, finished_at: null },
    ];
    expect(summarizeJobs(rows, { nowMs: now, targetMs: 45000, totalCount: 3 })).toMatchObject({
      good: 1, bad: 1, pending: 1, unknown: 0, attainment: 0.5, coverage: 'complete',
    });
  });
  it('withholds attainment when a terminal job has unknown duration', () => {
    const rows = [job, { ...job, job_id: 'old', finished_at: null }];
    expect(summarizeJobs(rows, { nowMs: now, targetMs: 45000, totalCount: 2 })).toMatchObject({
      attainment: null, unknown: 1, coverage: 'partial',
    });
  });
  it('does not report a passing objective from a truncated sample', () => {
    expect(summarizeJobs([job], { nowMs: now, targetMs: 45000, totalCount: 2001 })).toMatchObject({
      attainment: null, coverage: 'partial', sampled: 1, totalCount: 2001,
    });
  });
  it('does not invent an objective or a success rate when none is configured', () => {
    expect(summarizeJobs([job], { nowMs: now, totalCount: 1 })).toMatchObject({
      targetMs: null, attainment: null,
    });
  });
  it('withholds p95 for incomplete terminal timing even without a configured objective', () => {
    expect(summarizeJobs([job, { ...job, job_id: 'old', finished_at: null }],
      { nowMs: now, totalCount: 2 })).toMatchObject({
      coverage: 'partial', unknown: 1, p95Ms: null, latencySampleCount: 1,
    });
  });
});
