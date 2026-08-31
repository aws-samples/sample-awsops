import { getPool } from './db';

// Chat thread persistence (P3-A follow-up). Same contract as trace.ts:
// fire-and-forget writes NEVER throw and silently no-op without Aurora.

export interface ThreadSummary { id: string; title: string; sessionId: string; updatedAt: string }
export interface ThreadMessage { role: 'user' | 'assistant'; content: string; gateway: string | null; meta: unknown; createdAt: string }
export interface ExchangeInput {
  threadId: string; userSub: string; sessionId: string; promptTitle: string;
  userContent: string; assistantContent: string; gateway?: string; meta?: unknown;
}

const on = () => !!process.env.AURORA_ENDPOINT;

/** Record one user→assistant exchange. Owner-guarded upsert; never throws (chat must not block). */
export async function recordExchange(x: ExchangeInput): Promise<void> {
  if (!on()) return;
  try {
    const pool = getPool();
    // Upsert the thread; the WHERE guard means a foreign threadId updates nothing → no RETURNING row.
    // One-time legacy migration only (PR #200 review M1 → M2 → M2-followup): a pre-P3-1 thread's
    // raw-UUID session_id re-derives deterministically under the caller's sub on every resume
    // (same input -> same composite), so no rewrite is needed for correctness. But leaving the
    // legacy raw value in place forever means it never hits route.ts's OWN_PREFIX fast path. Migrate
    // it to the composite exactly once — only while the stored value isn't already namespaced under
    // THIS OWNER's sub (starts_with, not a bare 'awsops-%' — a row wrongly holding some other
    // sub's namespaced string must still be healed, not frozen as "already migrated") — then
    // freeze: once migrated, later exchanges never touch session_id again, so a thread visited from
    // a different client-supplied session value can't flip an already-migrated row (last-writer-wins
    // across the client's single per-browser session — see review M2).
    const up = await pool.query(
      `INSERT INTO chat_threads (id, user_sub, title, session_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET
         updated_at = now(),
         session_id = CASE WHEN starts_with(chat_threads.session_id, 'awsops-' || EXCLUDED.user_sub || '-') THEN chat_threads.session_id ELSE EXCLUDED.session_id END
       WHERE chat_threads.user_sub = EXCLUDED.user_sub
       RETURNING id`,
      [x.threadId, x.userSub, x.promptTitle, x.sessionId],
    );
    if (up.rows.length === 0) {
      console.warn(JSON.stringify({ evt: 'chat_thread_owner_mismatch', threadId: x.threadId }));
      return;
    }
    // NOTE: three non-transactional queries — a mid-failure can leave a user-only message;
    // harmless for fire-and-forget (next exchange records normally). Transactionality = YAGNI (P2 gate).
    await pool.query(
      `INSERT INTO chat_messages (thread_id, role, content) VALUES ($1, 'user', $2)`,
      [x.threadId, x.userContent],
    );
    await pool.query(
      `INSERT INTO chat_messages (thread_id, role, content, gateway, meta) VALUES ($1, 'assistant', $2, $3, $4::jsonb)`,
      [x.threadId, x.assistantContent, x.gateway ?? null, x.meta ? JSON.stringify(x.meta) : null],
    );
  } catch (e) {
    console.warn(`[chat-store] record failed: ${e instanceof Error ? e.message : e}`);
  }
}

export async function listThreads(userSub: string): Promise<ThreadSummary[]> {
  if (!on()) return [];
  const r = await getPool().query(
    `SELECT id, title, session_id, updated_at FROM chat_threads
     WHERE user_sub = $1 ORDER BY updated_at DESC LIMIT 20`,
    [userSub],
  );
  return r.rows.map((t) => ({ id: t.id, title: t.title, sessionId: t.session_id, updatedAt: new Date(t.updated_at).toISOString() }));
}

export async function getThread(userSub: string, threadId: string): Promise<{ thread: ThreadSummary; messages: ThreadMessage[] } | null> {
  if (!on()) return null;
  const t = await getPool().query(
    `SELECT id, title, session_id, updated_at FROM chat_threads WHERE id = $1 AND user_sub = $2`,
    [threadId, userSub],
  );
  if (t.rows.length === 0) return null;
  // Most-RECENT 200 in ascending display order (P4 gate: plain ASC LIMIT showed the oldest slice).
  const m = await getPool().query(
    `SELECT role, content, gateway, meta, created_at FROM (
       SELECT id, role, content, gateway, meta, created_at FROM chat_messages
       WHERE thread_id = $1 ORDER BY id DESC LIMIT 200
     ) recent ORDER BY id ASC`,
    [threadId],
  );
  const th = t.rows[0];
  return {
    thread: { id: th.id, title: th.title, sessionId: th.session_id, updatedAt: new Date(th.updated_at).toISOString() },
    messages: m.rows.map((r) => ({ role: r.role, content: r.content, gateway: r.gateway, meta: r.meta, createdAt: new Date(r.created_at).toISOString() })),
  };
}

/** v1-parity history search (v1 src/lib/agentcore-memory.ts searchMemory): find the user's own
 *  threads whose messages contain the query text. Case-insensitive substring; LIKE wildcards in
 *  the user input are escaped so they match literally. Returns newest-first with a hit snippet. */
export async function searchThreads(
  userSub: string, q: string, limit = 20,
): Promise<(ThreadSummary & { snippet: string })[]> {
  if (!on() || !q.trim()) return [];
  const escaped = q.trim().replace(/([\\%_])/g, '\\$1');
  const r = await getPool().query(
    `SELECT DISTINCT ON (t.id) t.id, t.title, t.session_id, t.updated_at,
            substring(m.content from greatest(1, position(lower($2) in lower(m.content)) - 40) for 120) AS snippet
     FROM chat_threads t
     JOIN chat_messages m ON m.thread_id = t.id
     WHERE t.user_sub = $1 AND m.content ILIKE '%' || $3 || '%'
     ORDER BY t.id, m.id DESC`,
    [userSub, q.trim(), escaped],
  );
  return r.rows
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    .slice(0, limit)
    .map((t) => ({
      id: t.id, title: t.title, sessionId: t.session_id,
      updatedAt: new Date(t.updated_at).toISOString(), snippet: (t.snippet ?? '').trim(),
    }));
}

export async function deleteThread(userSub: string, threadId: string): Promise<boolean> {
  if (!on()) return false;
  const r = await getPool().query(`DELETE FROM chat_threads WHERE id = $1 AND user_sub = $2`, [threadId, userSub]);
  return (r.rowCount ?? 0) > 0;
}

/** 대화 목록 전체 삭제 — 본인(user_sub) 것만. 삭제한 스레드 수를 반환. */
export async function deleteAllThreads(userSub: string): Promise<number> {
  if (!on()) return 0;
  const r = await getPool().query(`DELETE FROM chat_threads WHERE user_sub = $1`, [userSub]);
  return r.rowCount ?? 0;
}
