import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const query = vi.fn();
const enqueueJob = vi.fn();
vi.mock('@/lib/db', () => ({ getPool: () => ({ query }) }));
vi.mock('@/lib/jobs', () => ({ enqueueJob: (...a: unknown[]) => enqueueJob(...a) }));

import { getDiagSignals, enqueueDatasourceIndex } from './diag-signals';

beforeEach(() => {
  delete process.env.DATASOURCE_DIAGNOSIS_ENABLED;
  query.mockReset().mockResolvedValue({ rows: [] });
  enqueueJob.mockReset().mockResolvedValue({ job_id: 'j', status: 'queued' });
});
afterEach(() => { delete process.env.DATASOURCE_DIAGNOSIS_ENABLED; });

describe('getDiagSignals', () => {
  it('splits ready vs unavailable, scoped by integration_id, parses jsonb', async () => {
    query.mockResolvedValueOnce({ rows: [
      { signal_key: 'oom_kills', title: 'OOM Kill', status: 'ready',
        query: { tool: 'prometheus_query', queries: [{ label: 'x', expr: 'up' }] },
        missing_metrics: null, meta: { pillar: 'reliability', threshold: 0 } },
      { signal_key: 'node_disk_usage', title: '디스크', status: 'unavailable',
        query: null, missing_metrics: ['node_filesystem_avail_bytes'], meta: {} },
    ] });
    const out = await getDiagSignals(7);
    expect(out.ready).toHaveLength(1);
    expect(out.ready[0].query.tool).toBe('prometheus_query');
    expect(out.unavailable[0].missingMetrics).toEqual(['node_filesystem_avail_bytes']);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/FROM datasource_diag_signals/);
    expect(sql).toMatch(/account_id = 'self' AND integration_id = \$1/);
    expect(params[0]).toBe(7);
  });

  it('tolerates jsonb returned as strings', async () => {
    query.mockResolvedValueOnce({ rows: [
      { signal_key: 'k', title: 't', status: 'ready',
        query: JSON.stringify({ tool: 'mimir_query', queries: [] }), missing_metrics: null, meta: '{}' },
    ] });
    const out = await getDiagSignals(1);
    expect(out.ready[0].query.tool).toBe('mimir_query');
  });
});

describe('enqueueDatasourceIndex', () => {
  it('skips when datasource diagnosis is disabled', async () => {
    await enqueueDatasourceIndex(5, 'prometheus');
    expect(enqueueJob).not.toHaveBeenCalled();
  });
  it('enqueues a datasource_index job for prometheus when enabled', async () => {
    process.env.DATASOURCE_DIAGNOSIS_ENABLED = 'true';
    await enqueueDatasourceIndex(5, 'prometheus');
    expect(enqueueJob).toHaveBeenCalledWith('datasource_index', { integration_id: 5 });
  });
  it('skips non-prom/mimir kinds (v1 scope)', async () => {
    await enqueueDatasourceIndex(5, 'loki');
    expect(enqueueJob).not.toHaveBeenCalled();
  });
  it('swallows enqueue failure (never blocks the caller)', async () => {
    process.env.DATASOURCE_DIAGNOSIS_ENABLED = 'true';
    enqueueJob.mockRejectedValueOnce(new Error('queue down'));
    await expect(enqueueDatasourceIndex(5, 'mimir')).resolves.toBeUndefined();
  });
});
