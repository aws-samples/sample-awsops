# 스크립트 / Scripts

## 역할 / Role
v2 배포·운영 자동화 (`v2/` — Makefile 타겟의 구현체) + PR 리뷰 패널 (`pr-review/`).
Node deps는 `scripts/v2/package.json`(pg, @inquirer/prompts, secrets-manager) — `make deps`가 설치.
(Deployment/ops automation behind the Makefile targets, plus the PR review panel.)

## 주요 파일 / Key Files
- `v2/configure.mjs` — `make configure`: 대화형 TUI → `terraform.tfvars` + `backend.hcl`. AWS 접근은 SDK 아닌 `aws` CLI shell-out (Interactive TUI; shells out to the aws CLI, no SDK)
- `v2/deploy.mjs` — `make deploy`(migrate 선행): arm64 build → ECR push → ECS force-new-deployment → wait stable → smoke `/api/health`. `DOCKER` env 기본값 `sudo docker` (web deploy pipeline; DOCKER defaults to `sudo docker`)
- `v2/workers.mjs` — `make workers`: 워커 이미지 build+push**만**. Fargate 워커는 ECS 서비스가 아님 — SFN RunTask가 job 시점에 `:worker-latest`를 pull. 짧은 job은 Lambda zip으로 배포되어 이미지 불필요. `workers_enabled=true` apply 후 실행 (Image push only; worker is launched on demand by SFN, not a service)
- `v2/migrate.mjs` + `migrate-core.mjs` — `make migrate`: advisory-lock, 체크섬, `-- since:` 헤더로 릴리스 버전 스탬프. `DRY_RUN=1` 프리뷰, `--status` 오프라인 요약. 크리덴셜은 `terraform output aurora_secret_arn` → Secrets Manager (collision-free, fail-loud migration runner)
- `v2/agentcore.mjs` + `agentcore/` — `make agentcore`: arm64 agent 이미지 + 멱등 provisioner, SSM 기록 (idempotent AgentCore provisioner)
- `v2/*.itest.mjs` — 일회용 PostgreSQL 17 컨테이너 대상 마이그레이션 통합 테스트 (integration tests against a disposable PG17 container)
- `v2/upgrade.sh` — `make upgrade`: RDS 스냅샷 → migrate → deploy. `CONFIRM=go` 없으면 프리뷰 (safe release upgrade; preview unless CONFIRM=go)
- `pr-review/` — lens×모델 매트릭스 리뷰 패널: `run-panel.sh`(병렬 fan-out, lens당 `*.txt` 프롬프트), `synthesize.sh`(의장 종합), `lib.sh`(슬롯/크리덴셜 스크럽) (lens x model review panel fan-out + chair synthesis)

## 마이그레이션 파일명 규칙 / Migration Filename Rule
- `terraform/foundation/migrations/<ULID>_<snake_name>.sql`
- ULID = Crockford base32 26자 — **I, L, O, U 문자 금지** (`/^[0-9A-HJKMNP-TV-Z]{26}$/i`). 수동 번호(정수 id) 금지 — 비ULID 파일명은 runner가 거부 (Crockford base32, 26 chars, no I/L/O/U; hand-numbered ids rejected)
- id 중복은 연결 전 fail-loud, 정렬은 lexical(ULID는 시간순) (duplicate ids fail before connecting; lexical sort = time order)

## 규칙 / Rules
- 스크립트는 repo 루트 기준 실행 전제(`terraform -chdir=terraform/foundation output`으로 리소스 주소 해석) — 직접 실행보다 Makefile 타겟 사용 (Prefer Makefile targets; scripts resolve resources via terraform output from repo root)
- IAM 긴급 수정 시 put-role-policy 관례는 `terraform/CLAUDE.md` 참조 (see terraform/CLAUDE.md for the put-role-policy convention)
