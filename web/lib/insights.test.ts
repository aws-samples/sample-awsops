import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const query = vi.fn();
const enqueueJob = vi.fn();
vi.mock('@/lib/db', () => ({ getPool: () => ({ query }) }));
vi.mock('@/lib/jobs', () => ({ enqueueJob: (...a: unknown[]) => enqueueJob(...a) }));

import { getLatestInsight, enqueueInsightRefresh, hasRecentInsightJob } from './insights';

beforeEach(() => {
  delete process.env.AI_INSIGHTS_ENABLED;
  query.mockReset().mockResolvedValue({ rows: [] });
  enqueueJob.mockReset().mockResolvedValue({ job_id: 'j', status: 'queued' });
});
afterEach(() => { delete process.env.AI_INSIGHTS_ENABLED; });

describe('getLatestInsight', () => {
  it('returns the latest row parsed, account-scoped', async () => {
    query.mockResolvedValueOnce({ rows: [{
      status: 'succeeded',
      insights: [{ severity: 'critical', title: 'OOM', detail: 'api', source: 'k8s' }],
      sources_used: { k8s: 1 }, model: 'bedrock', generated_at: '2026-06-24T00:00:00Z',
    }] });
    const out = (await getLatestInsight())!;
    expect(out.status).toBe('succeeded');
    expect(out.insights[0].severity).toBe('critical');
    expect(out.sourcesUsed.k8s).toBe(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/FROM ai_insights/);
    expect(sql).toMatch(/ORDER BY generated_at DESC/);
    expect(params[0]).toBe('self');
  });

  it('tolerates jsonb returned as strings', async () => {
    query.mockResolvedValueOnce({ rows: [{ status: 'partial', insights: JSON.stringify([{ severity: 'info', title: 't', detail: '', source: '' }]), sources_used: '{"cost":2}', model: null, generated_at: null }] });
    const out = (await getLatestInsight())!;
    expect(out.insights[0].title).toBe('t');
    expect(out.sourcesUsed.cost).toBe(2);
  });

  it('returns null when none exist', async () => {
    expect(await getLatestInsight()).toBeNull();
  });
});

describe('enqueueInsightRefresh', () => {
  it('fail-closes when the flag is off', async () => {
    expect(await enqueueInsightRefresh()).toBe('disabled');
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('dedups against a recent running/queued job', async () => {
    process.env.AI_INSIGHTS_ENABLED = 'true';
    query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });  // hasRecentInsightJob → true
    expect(await enqueueInsightRefresh()).toBe('deduped');
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('enqueues when enabled and no recent job', async () => {
    process.env.AI_INSIGHTS_ENABLED = 'true';
    query.mockResolvedValueOnce({ rows: [] });  // no recent job
    expect(await enqueueInsightRefresh()).toBe('queued');
    expect(enqueueJob).toHaveBeenCalledWith('insight', { scheduled: false });
  });
});

describe('hasRecentInsightJob', () => {
  it("queries worker_jobs for queued/running insight in a window", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await hasRecentInsightJob(10);
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/type = 'insight'/);
    expect(sql).toMatch(/status IN \('queued', 'running'\)/);
  });
});
