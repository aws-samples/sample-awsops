# 온보딩 가이드 / Onboarding Guide

## 역할 / Role
신규 개발자가 AWSops v2(Terraform · ECS Fargate · Aurora · AgentCore)를 로컬에서 빌드/테스트하고 배포할 수 있게 하는 최소 경로.
(Minimal path for a new developer to build/test locally and deploy AWSops v2.)
아키텍처·규칙의 진실은 루트 `CLAUDE.md`와 `DESIGN.md` — 이 문서는 명령어 중심 요약이다.

## 사전 요구사항 / Prerequisites
| 도구 | 버전/조건 | 비고 |
|------|-----------|------|
| terraform | **>= 1.15** | S3 native state locking(`use_lockfile`) 필요 — DynamoDB 없음 |
| node | **>= 18** (configurator TUI 기준) | web 컨테이너는 `node:20-alpine` |
| aws CLI | 대상 계정 자격증명 구성 | `AWS_REGION` 기본값 `ap-northeast-2` |
| docker + buildx | **arm64 크로스빌드 필수** (`--platform linux/arm64`) | `deploy.mjs`는 기본 `sudo docker` 사용 — `DOCKER` env로 오버라이드 가능 |

## 셋업 순서 / Setup
```bash
git clone <repo> && cd awsops-v2
npm ci --prefix web            # web 의존성 (configurator deps는 make configure가 자동 설치)

make configure                 # 대화형 TUI → terraform.tfvars + backend.hcl 생성
terraform -chdir=terraform/foundation init -backend-config=backend.hcl
terraform -chdir=terraform/foundation plan -out tfplan
terraform -chdir=terraform/foundation apply tfplan   # 공유 인프라에 -auto-approve 금지
make deploy                    # migrate → arm64 빌드 → ECR push → ECS 롤링 → smoke /api/health
```
- `terraform.tfvars`·`backend.hcl`은 **gitignore 대상 — 비밀번호/시크릿 값 커밋 금지.** 예시는 `terraform/foundation/terraform.tfvars.example` / `backend.hcl.example`. 스테이징 값 파일(예: `staging.tfvars`)도 untracked로 유지한다. 시크릿은 env/tfvars가 아닌 SSM/Secrets Manager 경유.
- 신규 대형 기능 플래그(`agentcore_enabled`, `workers_enabled`, `steampipe_enabled` 등)는 전부 기본 false — 켜기 전 `plan` = No changes, $0.

## 로컬 개발 / Local Development
```bash
cd web
cp .env.example .env.local     # 값 채우기 — 실제 값(특히 시크릿) 커밋 금지
npm run dev                    # next dev
```
- 프로덕션 env는 ECS task definition이 주입 — `.env.example`은 로컬(`web/.env.local`) 참조용.
- **루트 경로 서빙(basePath 없음)** — fetch는 `/api/*` (v1의 `/awsops/api/*` 규칙 미적용).
- web은 thin-BFF: 무거운/장기 작업은 인라인 실행하지 말고 `POST /api/jobs`로 워커에 enqueue.
- Aurora 연결은 `AURORA_ENDPOINT` 미설정 시 `/api/db`가 503 — DB 없는 UI 작업은 그대로 가능.

## 테스트 / Tests
```bash
cd web && npx vitest run       # 단위 테스트 (= npm test)
bash tests/run-all.sh          # 저장소 루트 — TAP 구조/훅 테스트
```
- 통합 테스트는 `scripts/v2/*.itest.mjs` (마이그레이션/백필 — DB 필요).

## 배포 / Deployment
```bash
make deploy                    # = migrate 후 scripts/v2/deploy.mjs
```
`deploy.mjs` 5단계: ECR login → `buildx --platform linux/arm64 --push web/` → `ecs update-service --force-new-deployment` → `ecs wait services-stable` → smoke `curl {public_url}/api/health`.
- terraform output(`ecr_web_uri` 등)을 읽으므로 **해당 디렉토리 init/apply가 선행**되어야 함.
- docker가 PATH에 있어야 하며 기본 `sudo docker`(`DOCKER=docker`로 변경 가능). `IMAGE_TAG` 기본 `web-latest`.
- 기타 타깃: `make agentcore`(apply·migration 후, `SMOKE=1`은 provisioning 후 검사) · `make workers`(`workers_enabled=true` apply 후) · `make upgrade`(`CONFIRM=go` 없으면 PREVIEW) · `make migrate` / `make migrate-status`(`DRY_RUN=1` 프리뷰). 전체 목록은 `make help`.

Dev AgentCore uses the reusable private migration workflow and requires the `AWS_ACCOUNT_ID_DEV` repository secret. Optional smoke needs the deployed readiness producer, `runtime_deployment` and enabled/collected inventory; it checks producer-classified
freshness. Main/preview keep `make migrate` and advisory compatibility smoke, without a development-output prerequisite before provisioning. See [the AgentCore contract](reference/05-agentcore.md). dev AgentCore는 사설 재사용 migration과
저장소 시크릿 `AWS_ACCOUNT_ID_DEV`를 사용한다. 선택 smoke는 대응 readiness producer·`runtime_deployment`·활성/수집된 inventory가 필요하다. main/preview는 `make migrate`와 참고용 호환 smoke를 유지하며 dev output 부재로 provisioning 자체를 차단하지 않는다.

## 주요 문서 / Key Docs
- `CLAUDE.md`(루트) — 필수 규칙·알려진 함정 (SG description 불변, HOSTNAME=0.0.0.0, ENTRYPOINT 금지 등)
- `DESIGN.md` — v2 설계
- `docs/reference/01-edge-network.md` ~ `07-eks.md` — 레이어별 구현 레퍼런스
- `docs/runbooks/deploy-new-version.md` — 릴리스 배포 런북
- 결정(ADR) 본문과 BASELINE 레지스터는 비공개 upstream 리포지토리에서 관리됩니다 (이 트리에는 없음 — 문서의 ADR 번호는 추적용 인용)
