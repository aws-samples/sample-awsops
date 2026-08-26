# AWSops v2 — P3-A: Right-Docking Chat UI (Design Spec)

> Branch `feat/v2-architecture-design`. Brainstormed 2026-06-04 (visual companion + co-agent panel review). Sub-project **A** of P3 (decomposed A→B→D→C). Builds on P1a–P1f + P2 + **P3-A0** (AgentCore Runtime now **VPC mode**).

## Goal
Give AWSops v2 its first real UI: a **right-docking slide-over chat drawer** that lets an authenticated user converse with the 9 AgentCore **section agents** (network / container / data / security / cost / monitoring / iac / ops / observability), with **per-section preset questions**, **hybrid routing** (auto-route by default, optional pin), and a **server-side typewriter** response stream — all on a minimal app shell.

## Architecture (1 sentence)
Browser drawer → `POST /api/chat` (Next.js BFF on Fargate) → verify Cognito JWT → `@aws-sdk/client-bedrock-agentcore` `InvokeAgentRuntime` (runtime ARN from SSM, TTL-cached) → AgentCore Runtime (VPC) routes to a section gateway/tool → final text → BFF **re-emits as SSE chunks** (typewriter) → drawer renders with a section/tool badge.

## Confirmed decisions (brainstorming)
1. **Layout = slide-over drawer** (B): bottom-right FAB opens a ~460px right drawer; closing reclaims full width. (Rejected: persistent rail, split-view.)
2. **Section routing = hybrid**: default **auto-route** (runtime decides) + optional **pin** to one section. Pin is a **structured bypass** (not a prompt-prepended hint) — `agent.py` skips its auto-router when a `section` is supplied. (co-agent #4)
3. **Response UX = server-side typewriter**: runtime returns final text; BFF streams it to the browser as SSE chunks. (Rejected: plain req/res, true token streaming → P3-B.)
4. **Per-section preset questions**: each section carries curated `presetPrompts`; shown as clickable chips in the empty/section-switch state; click = immediate send. Auto mode shows a mixed set of active-section prompts.

## Scope
**In:** minimal app shell (top nav + home placeholder); slide-over chat drawer (hybrid routing, 9 themed sections, preset chips, typewriter, section/tool badges, per-conversation thread); `POST /api/chat` BFF (auth verify → invoke → SSE typewriter, optional `section`); per-user memory (`actorId`=Cognito `sub`, `sessionId`=conversation thread); the backend/infra additions below.

**Out (later phases):** real dashboards/data pages; agent fleet depth — wiring the 7 not-yet-wired sections (P3-B); OpenCost button (P3-C); kubeconfig auto-reg (P3-D); true token streaming; incident orchestrator (P4).

## Components (file boundaries)
| File | Responsibility |
|---|---|
| `web/lib/sections.ts` | 9 section defs: `{ key, label, icon, color, active, presetPrompts[] }`. Single source for the section picker, theming, presets, active/coming-soon. |
| `web/lib/auth.ts` | **Cognito JWT RS256/JWKS re-verification** (cached JWKS) + extract `sub`/`email` from the forwarded `Authorization` bearer. Trust boundary — not in agentcore.ts. (co-agent #2,#6) |
| `web/lib/agentcore.ts` | SSM runtime-ARN **TTL cache (5 min)** + `@aws-sdk/client-bedrock-agentcore` `InvokeAgentRuntimeCommand` wrapper (JS v3, **not boto3**) with 1 short backoff retry. Pure AgentCore client. (co-agent #5, codex) |
| `web/app/api/chat/route.ts` | `POST` BFF: verify identity → build payload `{prompt, actorId, sessionId, section?, messageId}` → invoke → **SSE typewriter** (immediate `: heartbeat`, `text/event-stream`, `Cache-Control: no-transform`, no `Content-Length`). 413 on oversize body; per-user lightweight rate guard. |
| `web/components/chat/ChatDrawer.tsx` | Drawer shell: open/close (FAB), section header + pin dropdown, AbortController on close/reset. |
| `web/components/chat/MessageList.tsx` | Thread render + typewriter cursor + section/tool **ToolBadge**. |
| `web/components/chat/Composer.tsx` | Input + send + section-pin (`#`) affordance. |
| `web/components/chat/SectionPicker.tsx` | 9-section row (active vs coming-soon dimmed) + pin state. |
| `web/components/chat/PresetChips.tsx` | Renders the focused section's `presetPrompts` (or Auto mix) in empty state; click → send. |
| `web/components/chat/ToolBadge.tsx` | Section + tool label (from response metadata; non-authoritative if inferred). |
| shell: `web/app/layout.tsx` + `web/components/shell/TopNav.tsx` | Mounts the drawer + FAB; minimal nav + home placeholder. |

## Data flow (request lifecycle)
1. User opens drawer (FAB) → empty state shows preset chips for the current section (Auto = mixed). `sessionId` = UUID generated on first open, persisted in `localStorage`; "New chat" resets it. (co-agent: session lifecycle)
2. User sends (typed or chip) → browser `fetch('/api/chat', {method:'POST', body:{prompt, section?, sessionId, messageId}})` with `Authorization` bearer; reads the response as a **stream** (fetch streaming, since `EventSource` can't POST — co-agent).
3. BFF `route.ts`: `auth.ts` re-verifies the JWT (JWKS cached) → `sub`. Rejects if invalid (401). Size/rate guard.
4. BFF opens the SSE response, immediately writes `: heartbeat` (keeps CloudFront/ALB from idling), then calls `agentcore.ts.invoke({prompt, actorId:sub, sessionId, section, messageId})`.
5. `agentcore.ts`: SSM ARN (cached) → `InvokeAgentRuntime`. Runtime (VPC) routes: if `section` set → `agent.py` calls that gateway directly (bypass); else auto-routes. Returns final text (+ optional metadata: gateway/tools used).
6. BFF receives final text → **chunks it** (word/segment) → writes `data:` SSE frames at a small interval (typewriter) → `data: [DONE]`. Drawer renders progressively + the ToolBadge from metadata.
7. Drawer close/reset → `AbortController` aborts the fetch (BFF cancels the in-flight invoke on disconnect).

## Backend / infra additions (in P3-A)
- **IAM (least-privilege, co-agent #2 / kiro):** web task-role gets `bedrock-agentcore:InvokeAgentRuntime` on the **exact runtime ARN** only (no wildcard action/resource). Added to `ai.tf` (or workload.tf) gated with the existing pattern. (web task-role already has `ssm:GetParameter` on `/ops/awsops-v2/agentcore/*`.)
- **CloudFront + ALB (SSE, co-agent #3):** a dedicated `/api/chat*` CloudFront behavior — CachingDisabled, **origin response timeout raised (e.g. 120 s)**, forward `Authorization`. ALB **`idle_timeout` raised to 120 s**. (Edge already CACHING_DISABLED default; add the explicit behavior + timeout in `edge.tf`/`workload.tf`.)
- **agent.py contract:** payload accepts `{prompt, actorId, sessionId, section?, messageId}`. When `section` is non-null, **bypass auto-routing** and call that gateway directly. `messageId` makes the turn idempotent (no duplicate memory writes on SDK retry). (co-agent: pin bypass, idempotency)
- **Runtime networking:** already **VPC mode** (P3-A0) — no change needed; inbound public endpoint unchanged so the invoke path is identical.

## sections.ts content (presetPrompts — reviewed)
Active = **security, network** (wired); others render but are dimmed "coming soon" (co-agent #7).
- **security** 🔒 (orange-red): 과다권한 점검 · 액션 거부 이유(정책 시뮬) · 퍼블릭 노출 리소스 · 90일 미사용 역할/키
- **network** 🌐 (cyan): 통신 안 되는 원인(Reachability) · 막힌 포트(SG/NACL) · TGW/피어링 라우트 · 비정상 Flow Log
- **cost** 💰 (orange): 이번 달 추세+최대 증가 서비스 · 다음 달 예측 · RDS·EKS 절감 Top5 · 계정/태그별 분해
- **container** 📦 (green): Pending/CrashLoop 원인 · ECS 반복 재시작 · 네임스페이스 상태 · Istio 트래픽
- **data** 🗄️ (purple): RDS 느린 쿼리 · DynamoDB 스로틀링 · ElastiCache Evictions · MSK 컨슈머 랙
- **monitoring** 📊 (cyan): 최근 알람 요약 · 지표 이상 탐지 · 변경 주체(CloudTrail) · 오류 급증 구간
- **iac** 🏗️ (purple): 드리프트 스택 · 스택 변경 이력 · 삭제보호/위험 리소스 · 미관리 리소스
- **ops** ⚙️ (cyan): 운영 이슈 요약 · 인벤토리 현황 · 태그 누락 · 만료 임박 인증서/시크릿
- **observability** 🔭 (green): p99 레이턴시 · 에러율 급증 · 로그 에러 패턴(Loki) · 느린 트레이스(Tempo)
- **Auto mix:** 비용 추세 · 안 되는 통신 진단 · 역할 과다권한 · 최근 알람 요약.

## Error handling
- **Auth fail** → 401, drawer shows "세션 만료 — 새로고침". **JOBS-style** structured `{status:'error',message}` envelopes.
- **Invoke error / timeout** → 1 short backoff retry in `agentcore.ts`; on persistent failure, SSE emits an error frame → drawer shows a **retry button** (kiro). No partial-turn duplication (messageId idempotency).
- **SSE disconnect** (drawer closed) → AbortController → BFF cancels invoke.
- **Unconfigured** (no runtime ARN in SSM) → 503 "AI 미구성".
- **Coming-soon section** pinned → the chip still sends; the runtime returns a graceful "이 섹션은 아직 준비 중" for unwired gateways rather than hallucinating (co-agent #7 / kiro).
- **Oversize body** → 413. Per-user simple rate guard (in-memory) to cap a costly invoke endpoint (codex).

## Testing
- **Unit:** `auth.ts` JWT verify (valid / expired / wrong-iss/aud / forged-sig → reject); `sections.ts` shape; `agentcore.ts` ARN cache TTL + retry.
- **Route:** `POST /api/chat` — 401 (no/bad token), 503 (no ARN), 413 (oversize), 200 SSE happy path (mock invoke → chunks + `[DONE]`), section bypass passed through, AbortController cancels.
- **Build:** `npm run build` passes (real build, App-Router routes registered).
- **E2E (manual, post-deploy):** browser login → open drawer → click a Security/Network preset chip → typewriter renders real answer + badge; pin a section; "New chat" resets; verify SSE streams through CloudFront+ALB (no 504, no buffering hang) with a long answer.

## Open questions (resolve in plan, none blocking)
- Exact response metadata shape from `agent.py` for the ToolBadge (structured vs inferred) — start inferred, upgrade to structured in P3-B.
- Whether to add a `bedrock-agentcore` VPC interface endpoint now to cut NAT cost (defer — minor at MVP volume).
