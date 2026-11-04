import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const enqueueJob = vi.fn();
vi.mock('@/lib/jobs', () => ({ enqueueJob: (...a: unknown[]) => enqueueJob(...a) }));

import { enqueueConnectorTargetSync } from './connector-targets';

describe('enqueueConnectorTargetSync', () => {
  beforeEach(() => { enqueueJob.mockReset(); });
  afterEach(() => { delete process.env.CONNECTOR_TARGET_SYNC_ENABLED; });

  it('is a no-op unless the Terraform gate sets the env', async () => {
    await enqueueConnectorTargetSync('clickhouse');
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('enqueues one connector_target_sync job for the kind', async () => {
    process.env.CONNECTOR_TARGET_SYNC_ENABLED = 'true';
    enqueueJob.mockResolvedValue({ jobId: 'j' });
    await enqueueConnectorTargetSync('tempo');
    expect(enqueueJob).toHaveBeenCalledWith('connector_target_sync', { kind: 'tempo' });
  });

  it('never throws when the enqueue fails', async () => {
    process.env.CONNECTOR_TARGET_SYNC_ENABLED = 'true';
    enqueueJob.mockRejectedValue(new Error('JOBS_QUEUE_URL not set'));
    await expect(enqueueConnectorTargetSync('prometheus')).resolves.toBeUndefined();
  });
});
