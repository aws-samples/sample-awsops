# 설계: 챗 스레드 Aurora 영속 (P3-A 후속 — "새 챗이 기존 대화를 지움" 해결)

> 작성 2026-06-10 · 브랜치 `feat/v2-architecture-design` · 사용자 승인 완료 (보존 방식 = Aurora 서버 영속)

## 1. 문제 / 목표

`ChatDrawer.tsx`의 `newChat()`이 `setMsgs([])`로 기존 대화를 폐기한다 (P3-A 챗 UI = 단일 스레드 + client-held messages). 사용자가 `+`(새 대화)를 누르면 기존 대화가 사라진다.

**목표**: 대화를 **Aurora에 스레드 단위로 영속** — 새 챗은 "전환"일 뿐 기존 대화는 보존되고, 목록에서 돌아갈 수 있다. 기기 간 공유·영구 보관(사용자 선택: localStorage 아닌 서버 영속).

## 2. 스키마 (migration **v9** — v8은 동시 세션 ADR-031 Ph2 agent_spaces가 선점)

`terraform/foundation/data/schema.sql`에 추가 (멱등 `IF NOT EXISTS` + `schema_migrations` v8 행):

```sql
CREATE TABLE IF NOT EXISTS chat_threads (
  id          UUID PRIMARY KEY,
  user_sub    TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '새 대화',
  session_id  TEXT NOT NULL,            -- AgentCore runtimeSessionId (>=33자) — 스레드 복귀 시 Memory 맥락 복원
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
  meta        JSONB,                    -- ranked/method/customAgent (ADR-038 meta)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages (thread_id, id);
```

- 메시지는 **행 단위** (jsonb 배열 아님 — 동시쓰기 race 회피, 페이지네이션 여지).
- 적용: in-VPC psql (기존 마이그레이션 v4~v7과 동일 절차, 운영 단계).

## 3. 기록 주체 = 서버 (chat route, fire-and-forget)

- `POST /api/chat` body에 `threadId?: string` 추가.
- 응답 **성공 완료 후** user 메시지 + assistant 응답을 **fire-and-forget**으로 기록 (`web/lib/trace.ts` 패턴: `AURORA_ENDPOINT` 없으면 조용히 생략, **절대 throw 금지** — 챗을 막지 않음). 스레드 `updated_at` 갱신.
- `threadId` 미제공(새 대화 첫 메시지) → 서버가 `randomUUID()`로 스레드 생성, `title` = 프롬프트 앞 40자, `session_id` = 요청의 sessionId. **meta SSE 이벤트에 `threadId` 포함** → 클라이언트가 기억.
- 소유 검증: upsert의 `WHERE user_sub = EXCLUDED.user_sub` 가드 — 불일치(위조/타인 threadId) 시 **기록을 drop하고 구조화 로그만 남긴다**(P2 게이트 합의: 정상 클라이언트는 서버가 meta로 발급한 threadId만 사용하므로 이 경로는 위조 시도뿐 — drop이 가장 안전하고 단순. 챗 스트림은 영향 없음).
- 비활성 단락(ADR-038 안내 메시지) 응답도 동일하게 기록(사용자 질문 보존 가치).

## 4. API (신규 `web/app/api/chat/threads/`)

모두 `verifyUser` + `user_sub` 스코프:
- `GET /api/chat/threads` → `{ threads: [{id, title, sessionId, updatedAt}] }` 최근 20개.
- `GET /api/chat/threads/[id]` → `{ thread, messages: [{role, content, gateway, meta, createdAt}] }` (소유 아니면 404).
- `DELETE /api/chat/threads/[id]` → 삭제 (CASCADE). 소유 아니면 404.
- Aurora 미설정 시 전부 `{threads: []}` / 404 degrade (500 아님).

데이터 액세스는 신규 **`web/lib/chat-store.ts`** 단일 모듈: `recordExchange()`(fire-and-forget upsert thread + insert 2 messages), `listThreads()`, `getThread()`, `deleteThread()` — 전부 `getPool()`(web/lib/db.ts) 사용, 파라미터라이즈드 쿼리.

## 5. ChatDrawer UX

- 헤더에 **☰ 스레드 목록 버튼** 추가 → 드로어 내부 오버레이 패널: 스레드 제목·시간·삭제(🗑). 열 때 `GET /api/chat/threads`.
- **`+` 새 챗 = 전환만**: `msgs=[]`, 새 sessionId, `threadId=null` — 서버 기록은 다음 메시지부터 새 스레드로. **기존 대화는 서버에 남는다** (버그 해소 지점).
- 스레드 클릭 → `GET /api/chat/threads/[id]` → msgs 복원(gateway/meta 포함 — ADR-038 칩도 복원) + **`sessionId` 를 그 스레드의 session_id로 복원** → AgentCore Memory 맥락 연속.
- meta에서 받은 `threadId`를 state + localStorage(`awsops_chat_thread`)에 보관, 후속 메시지에 전달.
- 기존 localStorage `awsops_chat_session` 동작은 유지(스레드 미사용 폴백).

## 6. 에러 처리 / Degrade

| 상황 | 처리 |
|---|---|
| Aurora 미설정/INSERT 실패 | 기록 생략(현재처럼 휘발), 챗 정상. console.warn 1줄 |
| threads API에서 DB 실패 | `{threads: []}` 또는 404 — UI는 빈 목록 표시 |
| threadId 소유 불일치 | 기록 drop + 구조화 로그 (chat — §3) / 404 (threads API) |
| 비로그인 | 401 (기존 패턴) |

## 7. 테스트

- `chat-store.test.ts`: pool 모킹 — recordExchange upsert/insert 호출 형태, 실패 무해성(never throws), listThreads user_sub 스코프 쿼리.
- `threads/route.test.ts`: 401 / 목록 / 소유검증 404 / DELETE / DB-degrade.
- `chat/route.test.ts` 확장: meta에 threadId 포함, threadId 전달 시 같은 스레드 기록, 기록 실패해도 SSE 정상.
- UI: ThreadList 컴포넌트 렌더/클릭/삭제 (jsdom, 기존 MessageList.test.tsx 패턴).

## 8. 범위 밖

- 메시지 페이지네이션(>최근 200), 스레드 검색/이름변경, 보존 정리 잡(cap), 기기 간 실시간 동기화, v1.
