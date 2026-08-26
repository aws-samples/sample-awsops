# Chat Thread Persistence (Aurora) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or the co-agent consensus P3 loop to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 챗 대화를 Aurora 스레드로 영속 — `+` 새 챗이 기존 대화를 지우지 않고, 목록에서 복귀(메시지+AgentCore 세션 맥락까지)할 수 있다.

**Architecture:** migration v9(chat_threads/chat_messages) → 단일 데이터 모듈 `web/lib/chat-store.ts`(fire-and-forget 기록, never-throws) → chat route가 응답 후 서버 기록 + meta에 threadId → threads REST API(user_sub 스코프) → ChatDrawer ☰ 목록/복귀/삭제. Aurora 미설정 시 현재의 휘발 동작으로 degrade.

**Tech Stack:** Next.js 14 BFF · node-pg(`getPool`) · vitest 2.x · 기존 trace.ts/jobs route 패턴 재사용

**사전 확보된 사실:** schema_migrations 최신 **v8**(ADR-031 Ph2 agent_spaces가 8509360에서 선점) → 본 작업 **v9**. `verifyUser(cookie) → {sub,...}|null`. `web/lib/trace.ts` = fire-and-forget·never-throws·`AURORA_ENDPOINT` 게이트 전례. chat route는 ADR-038 통합 완료 상태(meta 선방출, `route`/`spec`/`inactiveSection`). ChatDrawer는 `send(prompt, overrideSection?, switchedFrom?)` + `handleFrame` meta 파싱 + `newChat()`이 `setMsgs([])`. 테스트 모킹 컨벤션 = `vi.fn()` 클로저 + `vi.mock('@/lib/...')` + 동적 `await import('./route')`.

**커밋 규율:** 태스크마다 명시 경로 add + 즉시 커밋. 메시지 끝 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: migration v9 — chat_threads / chat_messages

**Files:**
- Modify: `terraform/foundation/data/schema.sql`

- [ ] **Step 1: 스키마 추가** — 파일 끝(현 v7 블록 뒤)에 append:

```sql
-- ============================================================
-- v9: chat thread persistence (P3-A follow-up) — chat_threads + chat_messages
-- New chat no longer wipes history; threads restore messages + AgentCore session.
-- ============================================================
CREATE TABLE IF NOT EXISTS chat_threads (
  id          UUID PRIMARY KEY,
  user_sub    TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '새 대화',
  session_id  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_threads_user ON chat_threads (user_sub, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id          BIGSERIAL PRIMARY KEY,
  thread_id   UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content     TEXT NOT NULL,
  gateway     TEXT,
  meta        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages (thread_id, id);

INSERT INTO schema_migrations (version, description)
VALUES (9, 'chat thread persistence: chat_threads + chat_messages (new-chat no longer wipes history)')
ON CONFLICT (version) DO NOTHING;
```

- [ ] **Step 2: SQL 문법 sanity** — Run: `grep -c "IF NOT EXISTS" terraform/foundation/data/schema.sql` (증가 확인) + 수동 검토(세미콜론/멱등).
- [ ] **Step 3: 커밋** — `git add terraform/foundation/data/schema.sql && git commit -m "feat(chat-threads): migration v8 — chat_threads + chat_messages"`

### Task 2: 데이터 모듈 `web/lib/chat-store.ts`

**Files:**
- Create: `web/lib/chat-store.ts`
- Test: `web/lib/chat-store.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성** — `web/lib/chat-store.test.ts`:

```ts
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
```

- [ ] **Step 2: RED 확인** — `cd web && npx vitest run lib/chat-store.test.ts` → `Cannot find module './chat-store'`
- [ ] **Step 3: 구현** — `web/lib/chat-store.ts`:

```ts
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
    const up = await pool.query(
      `INSERT INTO chat_threads (id, user_sub, title, session_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET updated_at = now()
       WHERE chat_threads.user_sub = EXCLUDED.user_sub
       RETURNING id`,
      [x.threadId, x.userSub, x.promptTitle, x.sessionId],
    );
    if (up.rows.length === 0) {
      console.warn(JSON.stringify({ evt: 'chat_thread_owner_mismatch', threadId: x.threadId }));
      return;
    }
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
  const m = await getPool().query(
    `SELECT role, content, gateway, meta, created_at FROM chat_messages
     WHERE thread_id = $1 ORDER BY id ASC LIMIT 200`,
    [threadId],
  );
  const th = t.rows[0];
  return {
    thread: { id: th.id, title: th.title, sessionId: th.session_id, updatedAt: new Date(th.updated_at).toISOString() },
    messages: m.rows.map((r) => ({ role: r.role, content: r.content, gateway: r.gateway, meta: r.meta, createdAt: new Date(r.created_at).toISOString() })),
  };
}

export async function deleteThread(userSub: string, threadId: string): Promise<boolean> {
  if (!on()) return false;
  const r = await getPool().query(`DELETE FROM chat_threads WHERE id = $1 AND user_sub = $2`, [threadId, userSub]);
  return (r.rowCount ?? 0) > 0;
}
```

- [ ] **Step 4: GREEN 확인** — `npx vitest run lib/chat-store.test.ts` → 7 pass. 전체 회귀 `npx vitest run`.
- [ ] **Step 5: 커밋** — `git add web/lib/chat-store.ts web/lib/chat-store.test.ts && git commit -m "feat(chat-threads): chat-store data module (owner-guarded upsert, never-throws)"`

### Task 3: threads REST API

**Files:**
- Create: `web/app/api/chat/threads/route.ts`
- Create: `web/app/api/chat/threads/[id]/route.ts`
- Test: `web/app/api/chat/threads/route.test.ts`

- [ ] **Step 1: 실패하는 테스트** — `web/app/api/chat/threads/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const listThreads = vi.fn();
const getThread = vi.fn();
const deleteThread = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/chat-store', () => ({
  listThreads: (...a: unknown[]) => listThreads(...a),
  getThread: (...a: unknown[]) => getThread(...a),
  deleteThread: (...a: unknown[]) => deleteThread(...a),
}));

const req = (url: string, method = 'GET') => new Request(url, { method, headers: { cookie: 'awsops_token=t' } });

describe('threads API', () => {
  beforeEach(() => { verifyUser.mockReset(); listThreads.mockReset(); getThread.mockReset(); deleteThread.mockReset(); });

  it('GET list: 401 without auth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req('http://x/api/chat/threads'))).status).toBe(401);
  });

  it('GET list: returns user-scoped threads', async () => {
    verifyUser.mockResolvedValue({ sub: 'u1' });
    listThreads.mockResolvedValue([{ id: 't1', title: 'T', sessionId: 's', updatedAt: 'now' }]);
    const { GET } = await import('./route');
    const res = await GET(req('http://x/api/chat/threads'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ threads: [{ id: 't1', title: 'T', sessionId: 's', updatedAt: 'now' }] });
    expect(listThreads).toHaveBeenCalledWith('u1');
  });

  it('GET [id]: 404 for a foreign/missing thread', async () => {
    verifyUser.mockResolvedValue({ sub: 'u1' });
    getThread.mockResolvedValue(null);
    const { GET } = await import('./[id]/route');
    const res = await GET(req('http://x/api/chat/threads/tX'), { params: { id: 'tX' } });
    expect(res.status).toBe(404);
  });

  it('GET [id]: returns thread + messages', async () => {
    verifyUser.mockResolvedValue({ sub: 'u1' });
    getThread.mockResolvedValue({ thread: { id: 't1', title: 'T', sessionId: 's', updatedAt: 'now' }, messages: [] });
    const { GET } = await import('./[id]/route');
    const res = await GET(req('http://x/api/chat/threads/t1'), { params: { id: 't1' } });
    expect(res.status).toBe(200);
    expect(getThread).toHaveBeenCalledWith('u1', 't1');
  });

  it('DELETE [id]: 404 when nothing deleted, 200 when deleted', async () => {
    verifyUser.mockResolvedValue({ sub: 'u1' });
    const { DELETE } = await import('./[id]/route');
    deleteThread.mockResolvedValue(false);
    expect((await DELETE(req('http://x/api/chat/threads/t1', 'DELETE'), { params: { id: 't1' } })).status).toBe(404);
    deleteThread.mockResolvedValue(true);
    expect((await DELETE(req('http://x/api/chat/threads/t1', 'DELETE'), { params: { id: 't1' } })).status).toBe(200);
  });

  it('GET list: DB failure degrades to empty list (not 500)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u1' });
    listThreads.mockRejectedValue(new Error('db down'));
    const { GET } = await import('./route');
    const res = await GET(req('http://x/api/chat/threads'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ threads: [] });
  });
});
```

- [ ] **Step 2: RED 확인** — `npx vitest run app/api/chat/threads/route.test.ts`
- [ ] **Step 3: 구현** — `web/app/api/chat/threads/route.ts`:

```ts
import { verifyUser } from '@/lib/auth';
import { listThreads } from '@/lib/chat-store';

export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

export async function GET(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ status: 'error', message: 'unauthenticated' }, 401);
  try {
    return json({ threads: await listThreads(user.sub) }, 200);
  } catch {
    return json({ threads: [] }, 200); // degrade, never 500 the drawer
  }
}
```

`web/app/api/chat/threads/[id]/route.ts`:

```ts
import { verifyUser } from '@/lib/auth';
import { getThread, deleteThread } from '@/lib/chat-store';

export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

export async function GET(request: Request, { params }: { params: { id: string } }) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ status: 'error', message: 'unauthenticated' }, 401);
  try {
    const out = await getThread(user.sub, params.id);
    if (!out) return json({ status: 'error', message: 'not found' }, 404);
    return json(out, 200);
  } catch {
    return json({ status: 'error', message: 'not found' }, 404);
  }
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ status: 'error', message: 'unauthenticated' }, 401);
  try {
    const ok = await deleteThread(user.sub, params.id);
    return ok ? json({ status: 'ok' }, 200) : json({ status: 'error', message: 'not found' }, 404);
  } catch {
    return json({ status: 'error', message: 'not found' }, 404);
  }
}
```

- [ ] **Step 4: GREEN + 회귀** — `npx vitest run app/api/chat/threads/route.test.ts` 6 pass → `npx vitest run` 전체.
- [ ] **Step 5: 커밋** — `git add web/app/api/chat/threads && git commit -m "feat(chat-threads): threads REST API (list/get/delete, user-scoped, degrade-safe)"`

### Task 4: chat route 기록 통합

**Files:**
- Modify: `web/app/api/chat/route.ts`
- Test: `web/app/api/chat/route.test.ts`

- [ ] **Step 1: 실패하는 테스트 추가** — 기존 모킹 블록에 추가:

```ts
const recordExchange = vi.fn();
vi.mock('@/lib/chat-store', () => ({ recordExchange: (...a: unknown[]) => recordExchange(...a) }));
```

`beforeEach`에 `recordExchange.mockReset(); recordExchange.mockResolvedValue(undefined);` 추가. 신규 테스트 (기존 describe 안):

```ts
describe('thread persistence', () => {
  it('emits threadId in meta and records the exchange after a successful invoke', async () => {
    verifyUser.mockResolvedValue({ sub: 'u1' });
    pickGateway.mockReturnValue('security');
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'security', skill: 'security', agentName: 'security', skillHashes: [] });
    invokeAgent.mockResolvedValue('answer');
    const { POST } = await import('./route');
    const body = await readStream(await POST(req({ prompt: '질문', sessionId: 's'.repeat(36) })));
    expect(body).toContain('"threadId":"');
    expect(recordExchange).toHaveBeenCalledWith(expect.objectContaining({
      userSub: 'u1', userContent: '질문', assistantContent: 'answer', gateway: 'security',
    }));
  });

  it('reuses a provided threadId', async () => {
    verifyUser.mockResolvedValue({ sub: 'u1' });
    pickGateway.mockReturnValue('security');
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'security', skill: 'security', agentName: 'security', skillHashes: [] });
    invokeAgent.mockResolvedValue('ok');
    const tid = '123e4567-e89b-42d3-a456-426614174000';
    const { POST } = await import('./route');
    const body = await readStream(await POST(req({ prompt: 'q', threadId: tid, sessionId: 's'.repeat(36) })));
    expect(body).toContain(`"threadId":"${tid}"`);
    expect(recordExchange).toHaveBeenCalledWith(expect.objectContaining({ threadId: tid }));
  });

  it('does not record when the agent invoke fails, and chat still streams the error', async () => {
    verifyUser.mockResolvedValue({ sub: 'u1' });
    pickGateway.mockReturnValue('security');
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'security', skill: 'security', agentName: 'security', skillHashes: [] });
    invokeAgent.mockRejectedValue(new Error('boom'));
    const { POST } = await import('./route');
    const body = await readStream(await POST(req({ prompt: 'q', sessionId: 's'.repeat(36) })));
    expect(body).toContain('[DONE]');
    expect(recordExchange).not.toHaveBeenCalled();
  });

  it('records the inactive-section guidance exchange too (spec §3)', async () => {
    process.env.HYBRID_ROUTING_ENABLED = 'true';
    verifyUser.mockResolvedValue({ sub: 'u1' });
    classifyRoute.mockResolvedValue({ primary: 'data', ranked: [{ key: 'data', score: 0.9, active: false }], method: 'llm' });
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'data', skill: 'data', agentName: 'data', skillHashes: [] });
    const { POST } = await import('./route');
    await readStream(await POST(req({ prompt: 'RDS 느린 쿼리', sessionId: 's'.repeat(36) })));
    expect(invokeAgent).not.toHaveBeenCalled();
    expect(recordExchange).toHaveBeenCalledWith(expect.objectContaining({
      userContent: 'RDS 느린 쿼리',
      assistantContent: expect.stringContaining('P3'),
    }));
  });

  it('a rejecting recordExchange does not break the SSE stream (defensive)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u1' });
    pickGateway.mockReturnValue('security');
    resolveAgent.mockReturnValue({ tier: 'builtin', gateway: 'security', skill: 'security', agentName: 'security', skillHashes: [] });
    invokeAgent.mockResolvedValue('answer');
    recordExchange.mockRejectedValue(new Error('store blew up'));
    const { POST } = await import('./route');
    const body = await readStream(await POST(req({ prompt: 'q', sessionId: 's'.repeat(36) })));
    expect(body).toContain('answer');
    expect(body).toContain('[DONE]');
  });
});
```

- [ ] **Step 2: RED 확인**
- [ ] **Step 3: 구현** — `web/app/api/chat/route.ts`:
  - import 추가: `import { randomUUID } from 'crypto';` + `import { recordExchange } from '@/lib/chat-store';`
  - body 타입에 `threadId?: string` 추가.
  - 라우팅 결정부 아래(스트림 생성 전): UUID v4 형식 검증 후 채택, 아니면 신규 발급:
    ```ts
    const THREAD_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const threadId = (typeof body.threadId === 'string' && THREAD_RE.test(body.threadId)) ? body.threadId : randomUUID();
    ```
  - meta 객체에 `threadId,` 필드 추가 (gateway 옆).
  - 타자기 청크 루프 **후, `[DONE]` 직전** fire-and-forget (P2 게이트: void는 비차단이지만 위치를 명시해 first-byte 우려 제거):
    ```ts
    recordExchange({
      threadId, userSub: user.sub, sessionId,
      promptTitle: prompt.slice(0, 40),
      userContent: prompt, assistantContent: text,
      gateway: spec.gateway,
      meta: route
        ? { ranked: route.ranked, method: route.method, ...(spec.tier === 'custom' ? { customAgent: spec.agentName } : {}) }
        : (spec.tier === 'custom' ? { customAgent: spec.agentName } : undefined),
    }).catch(() => { /* store is never-throws by contract; belt-and-suspenders (P2 gate) */ });
    ```
    (P2 게이트 codex: `customAgent` 포함 — meta 복원 시 ADR-038 칩/뱃지 완전성.)
  - 비활성 단락 경로에도 guide 텍스트로 동일 기록(assistantContent=guide) — `[DONE]` 직전에 `recordExchange({...}).catch(() => {})` (meta 동일 규칙).
- [ ] **Step 4: GREEN + 회귀** — chat 테스트 전체 + `npx vitest run`.
- [ ] **Step 5: 커밋** — `git add web/app/api/chat/route.ts web/app/api/chat/route.test.ts && git commit -m "feat(chat-threads): server-side exchange recording + threadId in meta"`

### Task 5: UI — ThreadList + ChatDrawer 통합

**Files:**
- Create: `web/components/chat/ThreadList.tsx`
- Modify: `web/components/chat/ChatDrawer.tsx`
- Test: `web/components/chat/ThreadList.test.tsx`

- [ ] **Step 1: 실패하는 테스트** — `web/components/chat/ThreadList.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import ThreadList from './ThreadList';

afterEach(cleanup);
const threads = [
  { id: 't1', title: '첫 대화', sessionId: 's1', updatedAt: new Date().toISOString() },
  { id: 't2', title: '둘째 대화', sessionId: 's2', updatedAt: new Date().toISOString() },
];

describe('ThreadList', () => {
  it('renders thread titles and calls onSelect on click', () => {
    const onSelect = vi.fn();
    render(<ThreadList threads={threads} activeId="t1" onSelect={onSelect} onDelete={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByText('둘째 대화'));
    expect(onSelect).toHaveBeenCalledWith('t2');
  });
  it('calls onDelete with the thread id (and not onSelect)', () => {
    const onSelect = vi.fn(); const onDelete = vi.fn();
    render(<ThreadList threads={threads} activeId={null} onSelect={onSelect} onDelete={onDelete} onClose={() => {}} />);
    fireEvent.click(screen.getAllByLabelText(/삭제/)[0]);
    expect(onDelete).toHaveBeenCalledWith('t1');
    expect(onSelect).not.toHaveBeenCalled();
  });
  it('shows an empty state', () => {
    render(<ThreadList threads={[]} activeId={null} onSelect={() => {}} onDelete={() => {}} onClose={() => {}} />);
    expect(screen.getByText(/저장된 대화가 없습니다/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: RED 확인**
- [ ] **Step 3: `ThreadList.tsx` 구현** (인라인 스타일, 시블링 컨벤션):

```tsx
'use client';
import type { ThreadSummary } from '@/lib/chat-store';

export default function ThreadList({ threads, activeId, onSelect, onDelete, onClose }: {
  threads: ThreadSummary[]; activeId: string | null;
  onSelect: (id: string) => void; onDelete: (id: string) => void; onClose: () => void;
}) {
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#0f1629f2', zIndex: 5, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '10px 12px', borderBottom: '1px solid #1a2540', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>대화 목록</span>
        <button onClick={onClose} aria-label="목록 닫기" style={{ background: 'none', border: 'none', color: '#7da2c9', cursor: 'pointer' }}>✕</button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
        {threads.length === 0 && <div style={{ color: '#7da2c9', fontSize: 12, padding: 12 }}>저장된 대화가 없습니다.</div>}
        {threads.map((t) => (
          <div key={t.id} onClick={() => onSelect(t.id)}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 10px', borderRadius: 8, cursor: 'pointer', background: t.id === activeId ? '#1d3350' : 'transparent', border: '1px solid #21314e', marginBottom: 6 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12.5, color: '#dcebff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</div>
              <div style={{ fontSize: 10, color: '#7da2c9' }}>{new Date(t.updatedAt).toLocaleString()}</div>
            </div>
            <button onClick={(e) => { e.stopPropagation(); onDelete(t.id); }} aria-label={`${t.title} 삭제`}
              style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 13 }}>🗑</button>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: `ChatDrawer.tsx` 통합** — 변경점:
  - state 추가: `const [threadId, setThreadId] = useState<string | null>(null);` `const [threads, setThreads] = useState<ThreadSummary[]>([]);` `const [showThreads, setShowThreads] = useState(false);` (+ `import ThreadList from './ThreadList'; import type { ThreadSummary } from '@/lib/chat-store';`)
  - `handleFrame` meta에 `threadId: obj.threadId` 수신 → `if (isMeta && obj.threadId) { setThreadId(obj.threadId); localStorage.setItem('awsops_chat_thread', obj.threadId); }` (patchLast와 별도 라인)
  - **mount 시 hydrate** (기존 session useEffect 안): `const tid = localStorage.getItem('awsops_chat_thread'); if (tid) setThreadId(tid);` — reload 후에도 활성 스레드 유지(P2 게이트 MAJOR). 단 msgs는 비어 있으므로, hydrate된 threadId가 있으면 `selectThread(tid)`를 호출해 메시지도 복원 — selectThread의 404 정리 로직이 stale 키도 청소한다(P2 r2 glm).
  - `send`의 body에 `threadId,` 추가.
  - `newChat()`: 기존 로직 유지 + `setThreadId(null); localStorage.removeItem('awsops_chat_thread');` — **msgs를 비워도 서버에 보존**되므로 사라짐 문제 해소.
  - 목록 열기: 헤더에 ☰ 버튼(`aria-label="대화 목록"`) → `openThreads()`: `fetch('/api/chat/threads')` → `setThreads(json.threads)` → `setShowThreads(true)`.
  - `selectThread(id)`: `fetch('/api/chat/threads/'+id)` 200이면 `setMsgs(messages.map((m) => ({ role: m.role, content: m.content, gateway: m.gateway ?? undefined, ranked: (m.meta as any)?.ranked, method: (m.meta as any)?.method })))`, `sessionRef.current = thread.sessionId; localStorage.setItem('awsops_chat_session', thread.sessionId);`, `setThreadId(id); localStorage.setItem('awsops_chat_thread', id); setShowThreads(false);` **404/실패 시(P2 r2 glm): `localStorage.removeItem('awsops_chat_thread'); setThreadId(null);` 후 조용히 return** — stale threadId가 빈 히스토리로 잔존하는 것 방지.
  - `removeThread(id)`: `fetch(..., {method:'DELETE'})` → 목록 재로드; 삭제한 게 활성 스레드면 `newChat()` (localStorage thread 키도 제거됨).
  - 렌더: 드로어 컨테이너에 `position:'fixed'` 유지하면서 ThreadList는 `{showThreads && <ThreadList threads={threads} activeId={threadId} onSelect={selectThread} onDelete={removeThread} onClose={() => setShowThreads(false)} />}` (컨테이너에 `position: 'relative'`가 아니므로 드로어 root div에 그대로 — absolute inset 0이 드로어를 덮음; root에 이미 fixed라 OK).
- [ ] **Step 5: GREEN + 빌드** — `npx vitest run components/chat/ThreadList.test.tsx && npx vitest run && npm run build`
- [ ] **Step 6: 커밋** — `git add web/components/chat/ThreadList.tsx web/components/chat/ThreadList.test.tsx web/components/chat/ChatDrawer.tsx && git commit -m "feat(chat-threads): thread list UI + restore/switch/delete; new-chat no longer wipes history"`

**비고(P2 r2 kiro-opus MINOR):** recordExchange의 3개 쿼리는 비트랜잭션 — 중간 실패 시 user 메시지만 남을 수 있으나 fire-and-forget 특성상 무해(다음 교환이 정상 기록). 트랜잭션화는 YAGNI.

### Task 6: 운영 — 마이그레이션 + 배포 (컨트롤러 실행)

**Files:**
- Modify: `terraform/foundation/data/schema.sql` (Task 1에서 이미 — 본 태스크는 적용만)

- [ ] **Step 1:** in-VPC psql로 migration v9 적용 (기존 v4~v7 절차와 동일) — `schema_migrations`에 9 확인.
- [ ] **Step 2:** `make deploy` → smoke `/api/health` 200.
- [ ] **Step 3:** 브라우저 확인: 대화 → `+` 새 챗 → ☰ 목록에 이전 대화 → 클릭 복귀(메시지+칩 복원) → 삭제.
