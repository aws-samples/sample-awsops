# 04. Web thin-BFF — v2 Reference

## Purpose / 목적

**EN** — The v2 web tier: a deliberately **thin** Backend-for-Frontend. It serves the UI (SSR) plus a light `/api/*` layer and nothing heavy. Any long-running, memory-hungry, or fan-out work is **enqueued as a job**, never executed inline on the request path, so the web container stays small and fast to roll.

**KO** — v2 웹 계층은 의도적으로 **얇은** BFF다. UI(SSR)와 가벼운 `/api/*` 계층만 담당하고 무거운 작업은 하지 않는다. 장시간·고메모리·팬아웃 작업은 요청 경로에서 인라인 실행하지 않고 **잡(job)으로 큐잉**하여, 웹 컨테이너를 가볍고 빠르게 롤아웃 가능한 상태로 유지한다.

Bounded operator readiness waits for AgentCore, as existing chat streaming does; heavy work
remains in the worker tier. `POST /api/deployment/readiness` permits admins or deployment-verifiers,
uses one in-flight probe and a 60-second process cooldown, and verifies actual identity/SSM/runtime
permissions. Resource reads stay behind the curated MCP tools.

제한된 운영 검증은 채팅 스트리밍처럼 AgentCore 응답을 기다리며 무거운 작업은 워커에 둡니다.
검증 API는 관리자·전용 verifier만 허용하고 단일 실행·60초 간격으로 실제 권한을 확인합니다.
리소스 읽기는 지정 MCP 도구를 통합니다.

## Current design / 현행 설계

**EN**

- **Framework**: Next.js 15 / React 19 thin-BFF in `web/`, App Router, `output: 'standalone'`, built for **arm64**.
- **Path**: served at the **root path `/`** — there is **no `basePath`** (v1's `/awsops` prefix is gone in v2).
- **Routes**:
  - `/api/health` — **public** liveness; the deploy smoke target and the health-check path for both the container and the ALB target group.
  - `/api/stream` — **SSE** stream (heartbeat ~15s, comfortably under the LB/CloudFront read timeouts).
  - `/api/db` — **Aurora ping** via the shared node-`pg` pool (`getPool` in `web/lib/db.ts`). Successful responses contain `status: "ok"`, `public_tables`, and `server_time` (UTC ISO with milliseconds, sampled by Aurora's `clock_timestamp()` in the same SELECT). An unset `AURORA_ENDPOINT` still returns `unconfigured` (503); database failures return the existing generic error (500). CloudFront edge authentication and the ADR-002 §2-4 BFF `verifyUser()` exception are unchanged.
  - `/api/jobs` (+ `/api/jobs/[id]`) — **P2 async** job submission/lookup, but the *generic* route only accepts `noop`/`noop-heavy`. Heavy/long/OOM-risk work is never run inline — it's enqueued via `web/lib/jobs.ts` `enqueueJob()` (durable Aurora ledger row, then best-effort SQS), but on user-facing paths `report`/`compliance` are reachable only through their own ownership-scoped routes, `POST /api/diagnosis` and `POST /api/compliance/run`, which compute `requestedBy` server-side; the trusted `schedule_dispatcher.py` direct enqueue is an internal exception for scheduled reports. The generic route deliberately rejects those two types: they'd otherwise trust a client-supplied `report_id`/`run_id`/`requested_by` with no ownership check — a cross-user IDOR write closed in the PR #195 pentest remediation.
- **Image distribution — dual-tier ECR**: dev-private `awsops-v2-web` and prod-public `public.ecr.aws/r7z4t3s6/awsops-v2-web`.
- **Deploy loop**: `make deploy` → `scripts/v2/deploy.mjs`: ECR login → `buildx` arm64 build+push → ECS `force-new-deployment` → `aws ecs wait services-stable` → smoke `GET /api/health`.
- **Database authentication**: the task role has cluster/user-scoped `rds-db:connect`; the shared pool generates a fresh IAM token per physical connection as `awsops_web`. It does not use the Aurora master secret.

**KO**

- **프레임워크**: `web/`의 Next.js 15 / React 19 얇은 BFF, App Router, `output: 'standalone'`, **arm64** 빌드.
- **경로**: **루트 경로 `/`** 에서 서비스 — **`basePath` 없음** (v1의 `/awsops` 접두사는 v2에서 제거).
- **라우트**: `/api/health`(공개 liveness, 배포 스모크 + 컨테이너/타깃그룹 헬스 경로), `/api/stream`(SSE, ~15s 하트비트), `/api/db`(node-`pg` 공유 풀 `getPool`로 Aurora ping), `/api/jobs`(+`/[id]`, P2 비동기 — 단 범용 라우트는 `noop`/`noop-heavy`만 허용). 무거운 작업은 인라인 실행 없이 `web/lib/jobs.ts`의 `enqueueJob()`으로 큐잉되지만, 사용자 경로 기준 `report`/`compliance`는 범용 라우트가 아니라 각자의 소유권-스코프 전용 라우트(`POST /api/diagnosis`, `POST /api/compliance/run`, 둘 다 `requestedBy`를 서버 측에서 계산)로만 도달 가능하며 예약 리포트의 신뢰된 `schedule_dispatcher.py` 내부 직접 enqueue는 예외다 — 클라이언트가 넘긴 `report_id`/`run_id`/`requested_by`를 소유권 검증 없이 신뢰하면 cross-user IDOR write가 되므로(PR #195 pentest-remediation에서 차단) 범용 라우트는 이 두 타입을 거부한다.
- **이미지 배포 — 듀얼 티어 ECR**: dev-private `awsops-v2-web`, prod-public `public.ecr.aws/r7z4t3s6/awsops-v2-web`.
- **배포 루프**: `make deploy` → `scripts/v2/deploy.mjs` (login → buildx arm64 push → ECS force-new-deployment → wait stable → `/api/health` 스모크).
- **DB 인증**: 태스크 역할의 cluster/user 한정 `rds-db:connect` 권한으로 `awsops_web` IAM 토큰을 연결마다 생성한다. 웹 풀은 Aurora 마스터 시크릿을 사용하지 않는다.

## Decisions (ADRs) / 결정

- **ADR-001** — v2 foundation: ECS Fargate workload + Aurora split (the v2 workload topology this component runs on). → [`../decisions/001-v2-foundation.md`](../decisions/001-v2-foundation.md)
- **ADR-024 (legacy → consolidated into ADR-001)** — CDK three-stack split (v1 precedent; **superseded** by the Terraform-based v2 foundation). → [`../decisions/001-v2-foundation.md`](../decisions/001-v2-foundation.md)

## Key files / 핵심 파일

| File | Role |
|------|------|
| `web/app/api/health/route.ts` | Public liveness; smoke + health-check target |
| `web/app/api/stream/route.ts` | SSE stream (heartbeat ~15s) |
| `web/app/api/db/route.ts` | Edge-authenticated Aurora ping via `getPool`; successful `status`, `public_tables` and UTC `server_time` |
| `web/app/api/jobs/route.ts` | P2 async job submit/list (`noop`/`noop-heavy` only) + ledger write + SQS enqueue |
| `web/app/api/jobs/[id]/route.ts` | P2 async job lookup by id (ownership-gated) |
| `web/lib/jobs.ts` | `enqueueJob()` — durable ledger write + best-effort SQS send, shared by `/api/jobs`, `/api/diagnosis`, `/api/compliance/run` |
| `web/app/api/diagnosis/route.ts` | Diagnosis report job submission — computes `requestedBy` server-side, not client-supplied |
| `web/app/api/compliance/run/route.ts` | CIS compliance scan job submission — computes `requestedBy` server-side, not client-supplied |
| `web/lib/db.ts` / `db-connection.ts` | Shared IAM-authenticated pool and redacted physical-connection phase observer / IAM 공유 풀·연결 단계 계측 |
| `web/Dockerfile` | Multi-stage standalone arm64 build (sets `HOSTNAME=0.0.0.0`) |
| `terraform/foundation/workload.tf` | ECS cluster/service/task definition, ALB, target group and IAM database-connect permissions |
| `terraform/foundation/ecr.tf` | Dual-tier ECR (dev-private repo + prod-public repo) |
| `scripts/v2/deploy.mjs` | `make deploy` loop: build → push → roll → wait → smoke |

## Status / 상태

**P1d implementation milestone complete.** The implementation supports standalone web deployment
and IAM database authentication.
`/api/health` proves liveness only; deployment-specific login/database readiness must be verified.
standalone 웹 배포와 IAM DB 인증이 구현돼 있다. `/api/health`는 프로세스 생존만 확인하므로
각 배포의 로그인·DB 준비 상태는 별도로 검증한다.

## Learnings & gotchas / 학습·함정

Reuse-critical, in priority order:

1. **`HOSTNAME=0.0.0.0` must be a runtime env in the ECS task def — not just an image ENV.** An image-level `ENV HOSTNAME=0.0.0.0` is **overwritten by ECS** with the container's ENI IP. Next.js standalone then binds **only the ENI IP**, so the `127.0.0.1` container healthcheck fails → circuit-breaker rolls the deploy back. Set `HOSTNAME=0.0.0.0` explicitly in the task definition's container `environment`.
   - **KO** — 이미지 레벨 `ENV HOSTNAME`은 ECS가 컨테이너 ENI IP로 덮어쓴다. standalone이 ENI IP에만 바인딩 → `127.0.0.1` 컨테이너 헬스체크 실패 → 서킷 브레이커 롤백. **task def `environment`에 `HOSTNAME=0.0.0.0`를 명시**해야 한다.

2. **Health path must be `/api/health` in BOTH places** — the container healthcheck command AND the ALB target-group health path. A mismatch fails health checks and circuit-breaker-loops the rollout.

3. **For consumers that use ECS `secrets`/`valueFrom` (such as the optional Steampipe task), permissions belong on the execution role.** Missing `secretsmanager:GetSecretValue` / `kms:Decrypt` causes `ResourceInitializationError`. The web pool instead uses IAM DB authentication; its task role needs `rds-db:connect`, and no Aurora master password is injected.
   - **KO** — 선택적 Steampipe처럼 ECS 시크릿 주입을 사용하는 소비자는 실행 역할 권한이 필요하다. 웹 풀은 시크릿 주입 대신 태스크 역할의 `rds-db:connect`로 IAM DB 인증하며 마스터 비밀번호를 주입하지 않는다.

4. **`web/` was previously a Docusaurus guide site.** It was relocated to `docs-site/` before the v2 web app went in. Always `ls` a directory before declaring it "new" — the original plan hadn't inspected `web/`, which forced an unplanned relocation task.

### Connection failure phases / 연결 실패 단계

`db_connection_failed` records one failed physical connection's `phase`, `elapsed_ms` and
`milestones_ms`; it contains no endpoint, user, credentials, token, SQL or raw error. The
existing timeout, pool size, authentication and TLS settings are unchanged. Phase identifies
where progress stopped, not its root cause. A pool-slot wait creates no new physical connection.
`db_connection_failed`는 물리 연결 실패의 단계·경과 시간만 기록하며 endpoint·사용자·자격증명·
토큰·SQL·오류 원문은 포함하지 않는다. 시간 제한·풀 크기·인증·TLS 설정은 그대로다. 단계는
진행이 멈춘 위치이며 원인 확정이 아니다. 풀 슬롯 대기에는 새 물리 연결 이벤트가 없다.

| Phase | Meaning / 의미 |
|---|---|
| `dns_tcp_connect`, `tcp_connect` | TCP connection unproven / TCP 연결 미확인 |
| `tls_negotiation` | TCP complete; awaiting PostgreSQL SSL acceptance / TCP 완료, SSL 수락 대기 |
| `tls_handshake` | SSL accepted; TLS handshake not complete / SSL 수락, TLS handshake 미완료 |
| `postgres_startup` | Waiting for PostgreSQL protocol progress / PostgreSQL 프로토콜 진행 대기 |
| `iam_token` | Password requested; signing/credential resolution pending / 비밀번호 요청 후 서명·자격증명 준비 대기 |
| `postgres_authentication` | Password challenge/authentication phase; use `token_ready` to confirm signing completed / 비밀번호 요청·인증 단계이며 서명 완료는 `token_ready`로 확인 |

`tls_connected` proves handshake completion under the configured TLS policy, not certificate
trust verification. Production retains `rejectUnauthorized: false`; the direct PostgreSQL test fixture
verifies certificates. Web socket tests cover negotiation/handshake boundaries, while the
required PostgreSQL suite covers async credentials, authentication rejection and error identity.
`tls_connected`는 설정된 정책 아래 handshake 완료를 뜻하며 인증서 신뢰 검증을 보장하지 않는다.
직접 PostgreSQL 테스트 fixture는 인증서를 검증하고, 웹 socket 테스트는 TLS 경계를 검사한다.
필수 PostgreSQL suite는 비동기 자격증명·인증 거부·오류 동일성을 검사한다.

## Source / 출처

- Plan (archived): `docs/history/archive/2026-05-31-awsops-v2-p1d-web-cicd-auth.md`.
- Readiness / cross-AI review: `v2-p1d-readiness-architecture-review` (private upstream repo).
- Root `CLAUDE.md` — HOSTNAME / arm64 deployment gotchas.
