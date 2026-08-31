import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const query = vi.fn();
const enqueueJob = vi.fn();
vi.mock('@/lib/db', () => ({ getPool: () => ({ query }) }));
vi.mock('@/lib/jobs', () => ({ enqueueJob: (...a: unknown[]) => enqueueJob(...a) }));

import { getDiagSignals, enqueueDatasourceIndex } from './diag-signals';

beforeEach(() => {
  delete process.env.DATASOURCE_DIAGNOSIS_ENABLED;
  delete process.env.DIAG_SIGNAL_QUERYGEN_ENABLED;
  query.mockReset().mockResolvedValue({ rows: [] });
  enqueueJob.mockReset().mockResolvedValue({ job_id: 'j', status: 'queued' });
});
afterEach(() => {
  delete process.env.DATASOURCE_DIAGNOSIS_ENABLED;
  delete process.env.DIAG_SIGNAL_QUERYGEN_ENABLED;
});

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

  it('excludes generated rows while the querygen flag is off, includes them when on', async () => {
    // The worker sweeps generated rows when the flag goes off, but only if it RUNS — with workers or the
    // daily job paused they would keep being served after the gate closed, so the read path gates too.
    await getDiagSignals(7);
    expect(query.mock.calls[0][0]).toMatch(/provenance.*IS DISTINCT FROM 'generated'/s);
    expect(query.mock.calls[0][1]).toEqual([7, false]);
    process.env.DIAG_SIGNAL_QUERYGEN_ENABLED = 'true';
    await getDiagSignals(7);
    expect(query.mock.calls[1][1]).toEqual([7, true]);
  });

  it('excludes the weekly-retry budget bookkeeping row alongside the schema-version sentinel', () => {
    // '__diag_signal_budget__' (db.py BUDGET_KEY) holds the marker in its own row's meta field, precisely
    // so it never shares a version column with real content (a prior design that did caused a schema
    // rollback to serve stale, mistagged content — see datasource_index.py). Neither bookkeeping key is
    // a signal, so neither may reach the UI as a chip.
    getDiagSignals(7);
    expect(query.mock.calls[0][0]).toMatch(/__schema_version__/);
    expect(query.mock.calls[0][0]).toMatch(/__diag_signal_budget__/);
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
  it.each(['loki', 'tempo', 'clickhouse'])('enqueues for %s (wired into the diag-signal pipeline)', async (kind) => {
    process.env.DATASOURCE_DIAGNOSIS_ENABLED = 'true';
    await enqueueDatasourceIndex(5, kind);
    expect(enqueueJob).toHaveBeenCalledWith('datasource_index', { integration_id: 5 });
  });
  it('skips kinds not wired into the diag-signal pipeline (jaeger)', async () => {
    process.env.DATASOURCE_DIAGNOSIS_ENABLED = 'true';
    await enqueueDatasourceIndex(5, 'jaeger');
    expect(enqueueJob).not.toHaveBeenCalled();
  });
  it('swallows enqueue failure (never blocks the caller)', async () => {
    process.env.DATASOURCE_DIAGNOSIS_ENABLED = 'true';
    enqueueJob.mockRejectedValueOnce(new Error('queue down'));
    await expect(enqueueDatasourceIndex(5, 'mimir')).resolves.toBeUndefined();
  });
});
