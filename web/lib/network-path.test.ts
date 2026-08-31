import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));

const isAdmin = vi.fn();
vi.mock('@/lib/admin', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }));

const enqueueJob = vi.fn();
vi.mock('@/lib/jobs', () => ({ enqueueJob: (...a: unknown[]) => enqueueJob(...a) }));

const user = (sub: string) => ({ sub, email: undefined, groups: [] }) as any;

beforeEach(() => {
  query.mockReset();
  isAdmin.mockReset();
  enqueueJob.mockReset();
  isAdmin.mockResolvedValue(false);
});

const VALID_DEFINITION = {
  source: { kind: 'pod', account_id: '123456789012', region: 'ap-northeast-2', eni_id: 'eni-1' },
  destination: { kind: 'aws_resource', eni_id: 'eni-2' },
  request: { protocol: 'tcp', port: 443 },
};

describe('createCheck', () => {
  it('rejects a missing name before touching the DB', async () => {
    const { createCheck, ValidationError } = await import('./network-path');
    await expect(createCheck(user('u-1'), {
      name: '', source_account_id: '123456789012', definition: VALID_DEFINITION,
    })).rejects.toThrow(ValidationError);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a malformed source_account_id', async () => {
    const { createCheck, ValidationError } = await import('./network-path');
    await expect(createCheck(user('u-1'), {
      name: 'x', source_account_id: 'not-an-account', definition: VALID_DEFINITION,
    })).rejects.toThrow(ValidationError);
  });

  it('rejects a definition missing source/destination/request', async () => {
    const { createCheck, ValidationError } = await import('./network-path');
    await expect(createCheck(user('u-1'), {
      name: 'x', source_account_id: '123456789012', definition: { source: {} },
    })).rejects.toThrow(ValidationError);
  });

  it('inserts with created_by_sub bound to the caller (immutable ownership key)', async () => {
    query.mockResolvedValue({ rows: [{ id: 'c1', created_by_sub: 'u-1' }] });
    const { createCheck } = await import('./network-path');
    await createCheck(user('u-1'), { name: 'x', source_account_id: '123456789012', definition: VALID_DEFINITION });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('INSERT INTO network_path_checks');
    expect(params).toContain('u-1');
  });
});

describe('updateCheck — creator-or-admin only', () => {
  const existing = {
    id: 'c1', name: 'old', source_account_id: '123456789012', definition: VALID_DEFINITION,
    created_by_sub: 'creator', deleted_at: null,
  };

  it('throws NotFoundError for a soft-deleted check', async () => {
    query.mockResolvedValue({ rows: [{ ...existing, deleted_at: '2026-01-01T00:00:00Z' }] });
    const { updateCheck, NotFoundError } = await import('./network-path');
    await expect(updateCheck(user('creator'), 'c1', { name: 'new' })).rejects.toThrow(NotFoundError);
  });

  it('throws ForbiddenError for a non-creator, non-admin', async () => {
    query.mockResolvedValueOnce({ rows: [existing] }); // getCheck
    isAdmin.mockResolvedValue(false);
    const { updateCheck, ForbiddenError } = await import('./network-path');
    await expect(updateCheck(user('someone-else'), 'c1', { name: 'new' })).rejects.toThrow(ForbiddenError);
  });

  it('allows the creator to edit', async () => {
    query.mockResolvedValueOnce({ rows: [existing] })
      .mockResolvedValueOnce({ rows: [{ ...existing, name: 'new' }] });
    const { updateCheck } = await import('./network-path');
    const result = await updateCheck(user('creator'), 'c1', { name: 'new' });
    expect(result.name).toBe('new');
  });

  it('allows an admin (not the creator) to edit', async () => {
    query.mockResolvedValueOnce({ rows: [existing] })
      .mockResolvedValueOnce({ rows: [{ ...existing, name: 'new' }] });
    isAdmin.mockResolvedValue(true);
    const { updateCheck } = await import('./network-path');
    const result = await updateCheck(user('admin-1'), 'c1', { name: 'new' });
    expect(result.name).toBe('new');
  });
});

describe('softDeleteCheck — creator-or-admin only, soft delete', () => {
  const existing = {
    id: 'c1', name: 'x', source_account_id: '123456789012', definition: VALID_DEFINITION,
    created_by_sub: 'creator', deleted_at: null,
  };

  it('throws ForbiddenError for a non-creator, non-admin', async () => {
    query.mockResolvedValueOnce({ rows: [existing] });
    const { softDeleteCheck, ForbiddenError } = await import('./network-path');
    await expect(softDeleteCheck(user('someone-else'), 'c1')).rejects.toThrow(ForbiddenError);
  });

  it('sets deleted_at (never deletes runs) for the creator', async () => {
    query.mockResolvedValueOnce({ rows: [existing] }).mockResolvedValueOnce({ rows: [] });
    const { softDeleteCheck } = await import('./network-path');
    await softDeleteCheck(user('creator'), 'c1');
    const [sql] = query.mock.calls[1];
    expect(sql).toContain('SET deleted_at = now()');
    expect(sql).not.toContain('DELETE FROM network_path_runs');
  });
});

describe('createRun', () => {
  const check = {
    id: 'c1', name: 'x', source_account_id: '123456789012', definition: VALID_DEFINITION,
    created_by_sub: 'creator', deleted_at: null,
  };

  it('throws NotFoundError when the check is soft-deleted', async () => {
    query.mockResolvedValueOnce({ rows: [{ ...check, deleted_at: '2026-01-01T00:00:00Z' }] });
    const { createRun, NotFoundError } = await import('./network-path');
    await expect(createRun(user('viewer'), 'c1')).rejects.toThrow(NotFoundError);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('any authenticated viewer (not just the creator) may run a visible check', async () => {
    query.mockResolvedValueOnce({ rows: [check] }) // getCheck
      .mockResolvedValueOnce({ rows: [{ id: 'run-1', definition_snapshot: VALID_DEFINITION, status: 'queued', phase: 'resolve' }] }) // insert run
      .mockResolvedValueOnce({ rows: [] }); // update worker_job_id
    enqueueJob.mockResolvedValue({ job_id: 'job-1' });
    const { createRun } = await import('./network-path');
    const run = await createRun(user('viewer-not-creator'), 'c1');
    expect(run.worker_job_id).toBe('job-1');
    expect(enqueueJob).toHaveBeenCalledWith(
      'network_path',
      expect.objectContaining({
        run_id: expect.any(String), definition: VALID_DEFINITION,
        source_account_id: '123456789012',
      }),
      expect.objectContaining({ requestedBy: 'viewer-not-creator' }),
    );
  });

  it('threads the check\'s own source_account_id into the job payload (CI-review item 5: the worker '
    + 'binds definition.source.account_id against this column rather than trusting the definition alone)', async () => {
    query.mockResolvedValueOnce({ rows: [check] })
      .mockResolvedValueOnce({ rows: [{ id: 'run-1', definition_snapshot: VALID_DEFINITION, status: 'queued', phase: 'resolve' }] })
      .mockResolvedValueOnce({ rows: [] });
    enqueueJob.mockResolvedValue({ job_id: 'job-1' });
    const { createRun } = await import('./network-path');
    await createRun(user('viewer'), 'c1');
    const [, payload] = enqueueJob.mock.calls[0];
    expect(payload.source_account_id).toBe(check.source_account_id);
  });

  it('snapshots the definition — mutating the source object after createRun does not affect what was persisted', async () => {
    const mutableDef = JSON.parse(JSON.stringify(VALID_DEFINITION));
    const mutableCheck = { ...check, definition: mutableDef };
    query.mockResolvedValueOnce({ rows: [mutableCheck] })
      .mockResolvedValueOnce({ rows: [{ id: 'run-1', definition_snapshot: mutableDef, status: 'queued', phase: 'resolve' }] })
      .mockResolvedValueOnce({ rows: [] });
    enqueueJob.mockResolvedValue({ job_id: 'job-1' });
    const { createRun } = await import('./network-path');
    await createRun(user('viewer'), 'c1');
    const [, insertParams] = query.mock.calls[1];
    const persistedSnapshotJson = insertParams[3];
    mutableDef.source.eni_id = 'MUTATED-AFTER-SNAPSHOT';
    // The JSON string bound to the INSERT was captured BEFORE this mutation.
    expect(persistedSnapshotJson).not.toContain('MUTATED-AFTER-SNAPSHOT');
  });
});

describe('getRunDetail', () => {
  it('joins run + candidates + steps', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'run-1', status: 'succeeded', overall_status: 'allowed' }] })
      .mockResolvedValueOnce({ rows: [{ candidate_id: 'c0', candidate_kind: 'resolved', status: 'allowed', first_blocker: null }] })
      .mockResolvedValueOnce({ rows: [{ candidate_id: 'c0', ordinal: 0, layer: 'sg', status: 'allowed' }] });
    const { getRunDetail } = await import('./network-path');
    const detail = await getRunDetail('run-1');
    expect(detail?.candidates).toHaveLength(1);
    expect(detail?.steps).toHaveLength(1);
  });

  it('returns null for an unknown run', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const { getRunDetail } = await import('./network-path');
    expect(await getRunDetail('missing')).toBeNull();
  });
});
