# Chat 리디자인 + `/assistant` 전용 페이지 — 설계 (2026-06-11)

> 브랜치 `feat/v2-architecture-design`. v2 웹(`web/`, Next.js 14 thin-BFF, 루트 경로, paper/ink + Claude orange 테마). 스크린샷 이슈 출발: 채팅이 좁은 사이드바에 갇혀 시인성 부족, 색이 앱과 불일치, 마크다운이 raw 텍스트로 노출.

## 문제 (현황)

현재 채팅 UI(`web/components/chat/*` + `ChatDrawer`)는 v2 리스킨 이전의 **남색·청록 인라인 스타일**로 남아 있어 세 가지 문제가 있다.

1. **크기 고정·시인성** — 드로어가 460px 고정, 리사이즈 불가 → 좁고 답답함.
2. **테마 갭** — 배경 `#0f1629`, 액센트 `#00d4ff`로 앱의 paper/ink/claude 테마와 충돌.
3. **마크다운 미렌더링** — `MessageList`가 `<span style="white-space:pre-wrap">{content}</span>`로 raw 출력 → `##`, `**`, 표(`|`), `---`가 그대로 노출.

## 목표

- **A안 확정**: 채팅을 **리사이즈 가능한 우측 드로어**로 (드래그 폭조절 + 최대화 토글, 폭 영속).
- **신규 `/assistant` 전용 페이지**: 넓은 화면에서 스레드 목록 + 대화, 세션 이어가기.
- **공유 히스토리**: 드로어와 페이지가 같은 Aurora 스레드 저장소 사용(이미 구축). 드로어 → "전체화면으로(↗)" 버튼으로 현재 대화를 페이지로 인계.
- **마크다운 렌더링** + **앱 테마 리스킨**은 드로어/페이지 양쪽에 공통 적용.

비목표(YAGNI): 멀티유저 공유, 메시지 편집/재생성, 스레드 검색/페이지네이션, 마크다운 안의 원시 HTML, 첨부.

## 아키텍처

기존 `ChatDrawer.tsx`가 상태·스트리밍·레이아웃을 모두 떠안고 있다. 드로어와 페이지가 동일 로직을 재사용하도록 **엔진(훅)과 레이아웃(셸)을 분리**한다.

```
components/chat/
  useChat.ts        (신규) ── 챗 엔진 훅: msgs/busy/threadId/threads/session,
                              send·stream·handleFrame·selectThread·newChat·
                              refreshThreads·removeThread·resendWith. (ChatDrawer에서 추출)
  Markdown.tsx      (신규) ── react-markdown + remark-gfm, 테마 components 맵 (assistant 전용)
  MessageList.tsx   (수정) ── 리스킨 + assistant 본문은 <Markdown>, user는 평문
  Composer.tsx      (수정) ── 리스킨 (Tailwind)
  SectionPicker.tsx (수정) ── 리스킨
  PresetChips.tsx   (수정) ── 리스킨
  ThreadList.tsx    (수정) ── 리스킨
  ChatDrawer.tsx    (수정) ── useChat 사용하는 얇은 드로어: 드래그 리사이즈+최대화+폭영속,
                              헤더에 ↗ 전체화면 버튼
app/assistant/
  page.tsx          (신규) ── useChat 사용하는 풀페이지: ThreadList(상시) + 대화 영역,
                              ?thread= 쿼리로 특정 스레드 열기(pop-out 대상)
components/shell/Sidebar.tsx (수정) ── 고정 메뉴에 "Assistant" 항목 추가(채팅 아이콘)
lib/sections.ts    (수정) ── 섹션 색을 라이트 테마용 카테고리 팔레트로 리매핑
```

### `useChat` 훅 (계약)
- 반환 state: `msgs, busy, threadId, threads, showThreads, pinned`
- 반환 actions: `send, selectThread, newChat, refreshThreads, removeThread, toggleThreads, setPinned, resendWith, abort`
- 내부: 기존 `ChatDrawer`의 sessionRef/abortRef/threadIdRef/showThreadsRef 로직과 SSE 프레임 파서(`handleFrame`/`patchLast`)를 그대로 이전. `awsops:open-chat` 이벤트 구독은 **드로어 셸에 잔류**(페이지엔 불필요). localStorage 키(`awsops_chat_session/thread`)는 공유.
- 변경 없음: `/api/chat`(POST·SSE), `/api/chat/threads`(+`/[id]`) 엔드포인트와 `chat-store.ts`는 그대로 재사용.

### `Markdown.tsx`
- `react-markdown` + `remark-gfm`. **rehype-raw 미사용** → 원시 HTML 미렌더(XSS 기본 차단). 콘텐츠는 자사 Bedrock 에이전트 출력이지만 방어적 기본값 유지.
- `components` 맵으로 테마 매핑: `h1–h4`(ink-800, 위계), `p/ul/ol/li`(ink-600), `code`(인라인=muted+claude-700, 블록=`<pre>` 가로스크롤), `table/th/td`(ink-100 보더, th=muted), `a`(claude-700, `target=_blank rel="noopener noreferrer"`), `hr`(ink-100), `blockquote`(좌측 claude 보더), `img`(max-width 제한). 스트리밍 중 부분 마크다운은 react-markdown이 관용 처리.

### 드로어 리사이즈
- 기본 폭 420px, min 360, max `min(960, 96vw)`. 왼쪽 모서리 3px 그립(`cursor: col-resize`); mousedown→mousemove로 `width = innerWidth - clientX` 클램프. 폭은 `localStorage.awsops_chat_width`에 영속.
- 최대화(⤢) 토글: `width = 96vw` ↔ 저장폭. `awsops_chat_maximized` 영속.
- 헤더 버튼: ☰ 스레드, ＋ 새 대화, **↗ 전체화면**(`router.push('/assistant' + (threadId ? '?thread='+threadId : ''))` 후 드로어 닫기), ✕ 닫기.
- 플로팅 ✦ 런처 유지(리스킨).

### `/assistant` 페이지
- `app/assistant/page.tsx`(client). AppShell의 `<main>` 안에서 높이를 채우는 2단: **ThreadList(상시 좌측)** + **대화 영역**(SectionPicker → msgs 있으면 MessageList / 없으면 PresetChips → Composer).
- 마운트 시 `useSearchParams().get('thread')`가 있으면 `selectThread(id)`로 인계분 복원.
- 동일 `useChat` 사용 → 드로어와 완전 동일한 송수신/스트리밍.

### Sidebar
- `FIXED` 배열에 `{ href:'/assistant', label:'Assistant', icon: <채팅 아이콘> }` 추가(lucide `MessagesSquare`). 활성표시 `path === '/assistant'`.

### sections.ts 색 리매핑
- paper 배경에서 대비가 나는 카테고리 색으로 교체(예: claude-600/ink-600/emerald-700/rose-700/보라·청록의 어두운 톤). `color` 필드 의미는 유지(섹션 식별). 구현 시 `s.color`/`sectionByKey().color` 사용처 전수 확인(SectionPicker, MessageList, Overview AI 카드 등).

## 데이터 흐름

변경 없음. `POST /api/chat`(섹션 라우팅·SSE) → 토큰 스트림 + meta(threadId/gateway/ranked). 첫 메시지에서 서버가 threadId 발급 → `recordExchange`가 Aurora 기록. `GET /api/chat/threads`(목록 20)·`/[id]`(메시지 200, 소유자 가드). 드로어/페이지가 같은 user_sub로 같은 스레드를 본다.

## 에러 처리
- 스트림 실패/401: 기존 메시지(만료 안내/응답 실패) 유지.
- Aurora 미설정: `chat-store`가 무력화(스레드 빈 목록) — 채팅은 인메모리로 계속 동작(기존 계약).
- 마크다운 파싱 예외: react-markdown은 던지지 않음. 만약을 위해 `Markdown`을 에러 경계 없이도 안전하게(빈/부분 입력 허용).

## 테스트 / 검증
- **단위(vitest)**: `Markdown` 렌더(제목·표·코드·링크 target/rel·원시 HTML 비렌더), `MessageList`(assistant=마크다운, user=평문; 기존 테스트 갱신), `useChat`(SSE 프레임 파싱·threadId 인계), `/assistant` 페이지 마운트(빈 상태/thread 쿼리). 기존 `ThreadList`/`chat-store`/route 테스트 GREEN 유지.
- **빌드**: `next build`(standalone) + 타입체크 + lint 무에러.
- **시각 확인**: `npm run dev`(로컬엔 Cognito 게이트 없음 — 인증은 CloudFront Lambda@Edge) 띄워 Playwright로 (a) 드로어 열기·드래그·최대화, (b) `/assistant` 빈상태/마크다운 버블, (c) 테마 일치 스크린샷 확인 — 배포 전.
- **배포**: `make deploy`(arm64 빌드→ECR→ECS 롤링→`/api/health` 스모크). react-markdown/remark-gfm 신규 의존성 포함 재빌드.

## 영향 / 리스크
- 신규 런타임 의존성 2개(react-markdown, remark-gfm) — 번들 증가 소폭, standalone 빌드 영향 미미.
- `ChatDrawer` 리팩터(엔진 추출)로 회귀 위험 → 기존 테스트 + 로컬 시각 확인으로 가드.
- 섹션 색 변경이 Overview AI 카드 등 타 화면에 파급 가능 → 사용처 전수 확인 필수.
- read-only 진단 도구 성격 유지(ADR 2026-06-11 번복 준수) — 본 작업은 UI/표현 한정, 변이·자율 기능 없음.
```
