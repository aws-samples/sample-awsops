import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));

describe('chat-store', () => {
  beforeEach(() => { query.mockReset(); process.env.AURORA_ENDPOINT = 'x'; });

  it('recordExchange upserts the thread (owner-guarded) then inserts both messages', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 't1' }] }); // upsert RETURNING id
    query.mockResolvedValue({ rows: [] });                  // message inserts
    const { recordExchange } = await import('./chat-store');
    await recordExchange({
      threadId: 't1', userSub: 'u1', sessionId: 's'.repeat(36), promptTitle: '제목후보',
      userContent: 'q', assistantContent: 'a', gateway: 'network', meta: { method: 'llm' },
    });
    expect(query).toHaveBeenCalledTimes(3);
    const [upsertSql, upsertParams] = query.mock.calls[0];
    expect(String(upsertSql)).toContain('ON CONFLICT (id) DO UPDATE');
    expect(String(upsertSql)).toContain('user_sub = EXCLUDED.user_sub'); // ownership guard
    expect(upsertParams).toEqual(['t1', 'u1', '제목후보', 's'.repeat(36)]);
  });

  it('recordExchange skips message inserts when the thread upsert returns no row (foreign thread)', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // owner mismatch → no RETURNING row
    const { recordExchange } = await import('./chat-store');
    await recordExchange({ threadId: 't1', userSub: 'other', sessionId: 's'.repeat(36), promptTitle: 't', userContent: 'q', assistantContent: 'a' });
    expect(query).toHaveBeenCalledTimes(1); // no message inserts
  });

  it('recordExchange never throws on DB failure', async () => {
    query.mockRejectedValue(new Error('db down'));
    const { recordExchange } = await import('./chat-store');
    await expect(recordExchange({ threadId: 't1', userSub: 'u', sessionId: 's'.repeat(36), promptTitle: 't', userContent: 'q', assistantContent: 'a' })).resolves.toBeUndefined();
  });

  it('recordExchange is a no-op without AURORA_ENDPOINT', async () => {
    delete process.env.AURORA_ENDPOINT;
    const { recordExchange } = await import('./chat-store');
    await recordExchange({ threadId: 't1', userSub: 'u', sessionId: 's'.repeat(36), promptTitle: 't', userContent: 'q', assistantContent: 'a' });
    expect(query).not.toHaveBeenCalled();
  });

  it('listThreads scopes by user_sub with a limit', async () => {
    query.mockResolvedValue({ rows: [{ id: 't1', title: 'T', session_id: 's', updated_at: new Date() }] });
    const { listThreads } = await import('./chat-store');
    const out = await listThreads('u1');
    expect(out).toHaveLength(1);
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toContain('WHERE user_sub = $1');
    expect(String(sql)).toContain('LIMIT 20');
    expect(params).toEqual(['u1']);
  });

  it('getThread returns null for a thread the user does not own', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // thread lookup scoped by user
    const { getThread } = await import('./chat-store');
    expect(await getThread('u1', 't-foreign')).toBeNull();
  });

  it('deleteThread deletes scoped by user_sub', async () => {
    query.mockResolvedValue({ rowCount: 1, rows: [] });
    const { deleteThread } = await import('./chat-store');
    expect(await deleteThread('u1', 't1')).toBe(true);
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toContain('DELETE FROM chat_threads');
    expect(String(sql)).toContain('user_sub = $2');
    expect(params).toEqual(['t1', 'u1']);
  });
});
