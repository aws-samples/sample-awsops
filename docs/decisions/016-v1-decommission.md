# ADR-016: v1 레거시 폐기 / v1 Legacy Decommission

> **브랜치 확인 (반복 리뷰 이슈 방지):** 이 문서·`docs/runbooks/v1-decommission.md`·`docs/history/v1-v2-gap-audit-2026-07-09.md`는 모두 `feat/v2-architecture-design` 브랜치(루트 `CLAUDE.md` 명시 작업 브랜치)에 존재한다. 저장소 **default 브랜치 `main`은 ADR 통합 리셋 이전의 옛 스킴**을 담고 있어(`docs/decisions/016-bedrock-model-selection-strategy.md`가 거기 있고 `docs/runbooks/v1-decommission.md`는 없음) 이 브랜치와 완전히 다른 트리다. 리뷰 툴이 PR 대상(`feat/v2-architecture-design`)이 아니라 `main`을 대조해 "런북이 없다"/"016 번호 충돌"을 재기하는 사례가 실제로 있었다(2026-07-09, PR #148·#149) — ADR-015의 동일 각주와 같은 패턴. 재발 시 이 각주와 실제 PR base(`gh pr view --json baseRefName`)를 근거로 반박할 것.
>
> **Branch note (to preempt a recurring review false-positive):** This ADR, `docs/runbooks/v1-decommission.md`, and `docs/history/v1-v2-gap-audit-2026-07-09.md` all live on `feat/v2-architecture-design` (the working branch per root `CLAUDE.md`). This repo's **default branch `main` predates the ADR consolidation** and holds a different tree (`docs/decisions/016-bedrock-model-selection-strategy.md` exists there; `docs/runbooks/v1-decommission.md` does not). A review tool has been observed diffing against `main` instead of the PR's actual base and concluding the runbook is missing / ADR-016 collides (2026-07-09, PR #148/#149) — same failure class ADR-015's footnote already documents. If this recurs, cite this note plus the PR's actual `baseRefName`.

## Status / 상태
**Accepted.**

- **Owner 지시:** 오준석(Junseok Oh), 2026-07-09 — "v1 폐기하고 v2로 갈아치우려고해". 이는 ADR-005 autonomy freeze의 예외가 아니다(ADR-015와 달리) — **에이전트 자율 조치가 아니라 매 단계 사람이 지시·검토·승인하는 수동 폐기 작업**이며, BASELINE §0의 "안전한 운영 지속 고도화" 목표 아래의 일상적 제품 결정이다.
- **범위 갱신:** BASELINE §0/§1의 "v1은 별도 레거시, 이 문서의 제약 대상 아님" 문구는 v1이 **영구히** 손대지 않는 대상이라는 뜻이 아니었다 — 폐기 결정이 나면 당연히 대상이 된다. 이 ADR로 그 전제가 갱신된다.

## Context / 컨텍스트

v1(`src/`, CDK/EC2/Steampipe, `awsops.atomai.click`)은 v2 개발 기간 내내 "손대지 않는 레거시 프로덕션"으로 유지되어 왔다(root `CLAUDE.md` 헤더). v2(Terraform/Fargate/Aurora, `awsops-v2.atomai.click`)는 P1~P2가 GREEN이고 P3가 부분 진행 중이며, 실사용 가능한 상태로 프로덕션에 배포되어 있다.

v1은 계속 비용을 발생시킨다: EC2(m7g.2xlarge, 상시 실행, ~$235/월) + EBS 100GB + 공개 ALB + CloudFront + VPC 엔드포인트 3개. 병렬 운영의 실익이 소진되었다고 판단, 폐기를 결정한다.

폐기 전 확인한 사항(`docs/history/v1-v2-gap-audit-2026-07-09.md`):
- 2026-06-10 최초 감사의 missing 36건 중 12건은 이후 v2에 실제로 착지됨(ai-diagnosis, compliance, topology `@xyflow/react`, EOL 배지, EBS 스냅샷/ECS 서비스 인벤토리 수집, i18n, admin 그룹 게이트, opencost 등).
- 잔존 갭은 전부 **drop(의도적 수용)** 또는 **backlog(P3/P4 로드맵 기재)** — 폐기를 막는 차단 항목 없음.
- 유일한 실행 조건: **alert-webhook 외부 발신자 경로** — v1은 CloudWatch SNS/SQS(AWS 네이티브, poller가 EC2 인-프로세스) + Alertmanager/Grafana 직결 웹훅(외부 시스템이 v1 URL을 설정에 박아놓을 수 있음) 두 경로를 가진다. v2 `incidents/webhook`은 URL·인증 방식이 다르다 → Phase 1에서 실사 확인 필수.

## Decision / 결정

**v1을 Phase 0(본 ADR·문서 게이트) + Phase 1~5(실행 5단계)로 단계적 폐기하고, 도메인 `awsops.atomai.click`을 v2로 컷오버한다.**

1. **Phase 0(본 ADR)** — 갭 재검토 문서화 + 이 ADR + 런북(`docs/runbooks/v1-decommission.md`) 작성, BASELINE 갱신. 인프라 변경 전 게이트.
2. **Phase 1(데이터 확보)** — 기존 backfill 도구(`scripts/v2/backfill-v1.mjs`, 런북 `v1-to-v2-aurora-backfill.md`)로 inventory/cost/alert/event-scaling 이력을 v1이 살아있는 동안 최종 실행·검증. v1 Cognito 사용자를 v2 풀과 대조해 누락 사용자 재생성(비밀번호는 이관 불가 — 재설정). alert-webhook 외부 발신자 실사(위 Context §마지막 항).
   - **수용하는 데이터 손실**(명시): `data/config.json`(부서 ACL·브랜딩·자격증명), AI 대화 이력(`data/memory/`), `agentcore-stats.json`, `report-schedule.json`의 v1 항목 — backfill 대상 외로 원래부터 아웃오브스코프였으며, S3 아카이브도 하지 않는다(비용 대비 가치 낮음, owner 승인).
3. **Phase 2(도메인 컷오버)** — Terraform으로 `awsops.atomai.click`을 v2 CloudFront의 추가 별칭(SAN)으로 편입, Route53 레코드를 v2 소유로 이전(`terraform import`). v1 CloudFront에서는 별칭 제거. 기존 URL이 계속 동작하되 v2를 가리키게 됨.
4. **Phase 3(다크, 유예 시작)** — v1 EC2 **stop**(terminate 아님) + v1 CloudFront **disable**. 즉시 EC2 비용 절감(~$235/월). 1~2주 유예 관찰 — 문제 발생 시 EC2 start + CloudFront enable + 별칭 원복으로 롤백 가능.
5. **Phase 4(완전 삭제, 유예 후)** — `cdk destroy AwsopsStack`(또는 스택별 삭제) + 스택 밖 고아 리소스(`awsops-*-mcp` Lambda 18개 py3.12, `awsops-cognito-auth` Lambda@Edge, `awsops-deploy-*` S3) 개별 삭제. **spoke 계정의 `AWSopsReadOnlyRole`, 공유 VPC/hosted zone/CDKToolkit, v2 리소스 전체는 삭제 대상이 아님** — v2의 cross-account 조회 경로가 spoke 롤을 계속 사용한다.
6. **Phase 5(코드 정리, 별도 PR)** — Phase 4 완료 후 `src/`, `infra-cdk/`, v1 전용 스크립트(`scripts/0N-*.sh`), 루트의 v1 전용 빌드 설정(`next.config.mjs`/`tailwind.config.ts`/`postcss.config.mjs`/`.eslintrc.json`/`vitest.config.ts`/루트 `Dockerfile`)을 삭제하는 별도 PR. `agent/`는 부분 유지(`agent.py`, `agent/lambda/*.py`는 v2 `ai.tf`가 계속 참조) — v1 전용 부분(`agent/rca/`, `anthropic_loop.py` 등)만 대조 후 삭제.

**Phase 2까지 apply되면 v2가 v1의 유일한 살아있는 프로덕션 진입점이 되고, Phase 4가 끝나면 v1은 AWS 계정에서 완전히 사라진다.**

## Phase 1 실행 기록 (2026-07-09) / Phase 1 execution record

`docs/runbooks/v1-decommission.md` §1의 세 항목을 실행·확인했다:

- **1.1 backfill**: SSM으로 v1 `data/`(5.8MB) 추출 → dry-run → 실행. `--account-id`는 조사 시점 STS `GetCallerIdentity` 계정과 v1 데이터의 단일-계정 레이아웃 기준으로 일치시켜 사용(런북 §1.1의 tenant-fork 경고 대상 아님 — 멀티계정 분기 데이터 없음). 결과: `inventory: scanned=26 inserted=693 errored=0`, `cost: scanned=24 inserted=24 errored=0`, `alert`/`scaling`은 v1에 데이터 자체가 없어 0. 에러 없음 — 완료.
- **1.2 Cognito 사용자 대조**: v1은 CFN 스택 밖(고아) `AWSops-UserPool`이 **2개** 존재(재배포로 중복 생성된 것으로 보임). 둘 다 사용자 **1명뿐**이며 이메일이 `admin@awsops.local`(플레이스홀더 테스트 계정)로 동일. v2 풀에도 **이미 동일한 `admin@awsops.local` 계정이 존재** → **실이관 대상 사용자 없음. 신규 생성/재설정 불필요.**
- **1.3 alert 경로 외부 발신자 확인**: AWS 네이티브 경로(CloudWatch→SNS→SQS)와 외부 웹훅 경로(Alertmanager/Grafana→앱 HTTP endpoint)를 별도로 확인했다.
  - **AWS 네이티브**: (a) `awsops-alert-topic`의 구독자는 자체 SQS 큐 하나뿐, 외부 HTTP/email 구독 없음. (b) 이 토픽을 action으로 쓰는 CloudWatch Alarm **0건**. (c) `awsops-alert-queue`/`awsops-alert-dlq` 모두 큐 깊이 0. → 세 신호 일치, 발신자 없음.
  - **외부 웹훅**: 최초 조사 시 v1 앱 로그(`/tmp/awsops-server.log`, 서버 기동 이후 전체 기간)에서 문자열 grep으로 "0건"을 근거로 들었으나, 이는 **불충분한 증거였다** — `alert-webhook` route.ts를 직접 읽어보니 성공 로그는 `[AlertWebhook]`(하이픈 없는 표기, grep 대상 문자열과 불일치)로만 남고, rate-limit(429)·HMAC 실패(401)·비활성 소스(403)·잘못된 JSON(400) 등 **거부 경로는 아예 로그를 남기지 않는다** — 즉 grep 0건은 "POST 시도 자체가 없었다"를 증명하지 못한다. ALB 액세스 로그도 비활성(`access_logs.s3.enabled=false`)이라 HTTP 레벨 대안 증거도 없다.
  - 대신 **백필한 실제 `data/config.json`을 직접 열어 확정 증거를 확보**했다: 최상위 키에 `alertDiagnosis`가 **존재하지 않는다**(`isAlertDiagnosisEnabled()`는 `getConfig().alertDiagnosis?.enabled || false`를 반환하므로 이 키 부재 = 항상 `false`). **route.ts:112-114 확인 결과, 안전 게이트는 오직 이 503 하나뿐이다** — POST 핸들러는 파싱·HMAC 검증·로깅 이전에 이 체크에서 즉시 반환된다. (정정: `alertSources` 미설정 자체는 차단 근거가 아니다 — route.ts:142-160을 보면 `sourceConfig`가 없을 때는 disable 체크와 HMAC 검증을 **모두 스킵하고 처리를 계속**하므로, 이 503 게이트가 없다면 오히려 무검증 통과 경로가 된다. 이 문서가 근거로 삼는 것은 `alertDiagnosis` OFF 하나이며, `alertSources` 부재는 별개의 사실일 뿐 안전성 논거에 포함되지 않는다.)
  - → **네 가지 독립 신호(SNS 구독자·CloudWatch Alarm·큐 깊이·`alertDiagnosis` OFF 확정)가 모두 "AWSops가 알림을 현재 수신·처리하고 있지 않다"로 일치**(과거 전체 기간에 걸쳐 "한 번도 성공한 적 없다"는 별개 주장이며, 이는 조사하지 않았다). 이는 **AWSops 수신측의 무음 유실 리스크가 없다는 근거**로 한정된다 — Alertmanager/Grafana 등 외부 발신 측에 여전히 이 엔드포인트를 가리키는 webhook 설정이 남아있을 가능성 자체를 배제하지는 못한다(모두 503으로 실패해왔을 뿐이므로 그쪽에서는 계속 실패 로그가 쌓이고 있을 수 있다 — 이는 v1을 끄기 전에 없애야 할 v1측 리스크는 아니지만, 외부 시스템 정리 차원에서 별도로 확인할 사안으로 남긴다). Phase 3(EC2 정지)는 이 스코프에서 안전하게 진행 가능.

## Phase 2 실행 기록 (2026-07-09) / Phase 2 execution record

`terraform/foundation`에 `extra_domain_aliases` 도입(PR #150) 후 실제 적용:

- ACM cert에 두 도메인 SAN 추가 → 재발급, `ISSUED`, CloudFront viewer cert in-place 교체(무중단).
- `edge.tf`의 `aws_route53_record.alias`가 **singleton**이었음을 발견 — `moved` 블록으로 기존 v2 레코드를 for_each 키로 먼저 리매핑(순수 state 정리, 0 변경)한 뒤에 v1 도메인 키를 추가.
- CloudFront 레벨 별칭 이동은 `associate-alias`가 아니라 **`aws cloudfront update-domain-association`**을 사용했다 — 계정 내 이동에 대해 AWS가 문서화한 정식 경로이며, `associate-alias`가 요구하는 DNS TXT 소유권 검증이 필요 없다(같은 계정 내 두 distribution 모두에 대한 `cloudfront:UpdateDistribution` 권한만 필요).
- **런북의 "v1 CDK 스택에서 DomainARecord를 RETAIN 처리 후 템플릿에서 제거" 단계는 이번 실행에서 건너뛰었다** — `cdk deploy AwsopsStack` 전체 재배포는 그 자체로 실 리스크가 있다: 라이브 EC2 `InstanceType`이 `m7g.2xlarge`인데 CFN 템플릿 기본값은 `t4g.2xlarge`(실수로 인자를 빠뜨리면 인스턴스가 강제 교체될 수 있음), `VSCodePassword`는 `NoEcho`라 현재 값을 알 수 없음(CDK가 "이전 값 유지"로 처리한다는 전제에 의존해야 함), `vpcCidr` 컨텍스트가 SG 인그레스 규칙에 영향. 이 모든 리스크를 감수할 이유가 없다고 판단한 근거: `terraform import`는 CFN의 소유권 자체를 바꾸지 않고 실제 AWS 리소스도 변경하지 않으며(state만 편입), Phase 4까지 v1 CDK 스택에 `cdk deploy`를 다시 실행할 계획이 없으므로 두 IaC가 "동시에 쓰기"를 시도할 일이 없다. Phase 4의 필수 `--retain-resources DomainARecord`가 실제 위험(스택 삭제 시 레코드 삭제)을 이미 완전히 커버한다.
- 검증: `terraform import` → 새 plan(`0 to add, 2 to change`: Route53 alias target + Cognito callback/logout URL) → apply → `terraform plan` = No changes. `curl https://awsops.atomai.click/api/health` 및 `/login` 리다이렉트 정상, `awsops-v2.atomai.click` 영향 없음, v1/v2 CloudFront 별칭 목록 확인(v1: 0개, v2: 2개).

## Phase 3 실행 기록 (2026-07-09) / Phase 3 execution record

- v1 EC2(m7g.2xlarge) **stop** 실행 → `stopped` 확인(terminate 아님, 롤백 가능).
- v1 CloudFront distribution **Enabled=false**로 업데이트(전파 중 확인, `Status: InProgress`) — 트래픽은 Phase 2에서 이미 전량 v2로 이동했으므로 이 disable은 형식적 마무리에 가깝다.
- 검증: 두 도메인(`awsops.atomai.click`, `awsops-v2.atomai.click`) 모두 정상 응답(302 → `/login`) 유지.
- **유예 시작.** 1~2주 관찰 후 문제 없으면 Phase 4(완전 삭제)로 진행. 문제 발생 시 런북 §Phase 3 롤백 절차(EC2 start + CloudFront enable + associate-alias 역이동 + Route53 target 원복) 사용.

## Phase 5 실행 기록 (2026-07-12) / Phase 5 execution record

**런북 순서를 앞당김 — 오준석 owner-override.** 런북은 Phase 5(코드 정리)를 Phase 4(AWS 완전삭제) 완료 후로 규정하지만, Phase 4는 유예기간(2026-07-09 시작, 최대 07-23) 종료 전이라 아직 미실행. 코드 삭제는 git history/tag로 복원 가능하고 AWS 인프라(v1 EC2/CFN/Lambda@Edge/S3)와 독립적이므로, **코드 정리만 유예기간과 무관하게 먼저 진행** — AWS 측 Phase 4는 원래 일정대로 유예 종료 후 별도 실행.

- 삭제 전 `main`에 태그 `v1-pre-code-removal-20260712` 생성(push 완료) — 복원 지점.
- 커밋 `0a12b79b`(296 files, -76738 lines): `src/`, `infra-cdk/`, `powerpipe/`, 루트 `public/`, 루트 Next.js 빌드 설정(`next.config.mjs` 등), v1 EC2 셋업 스크립트(`scripts/00~15-*.sh` 등), `tests/unit/*`(v1 vitest) + `tests/structure/test-plugin-structure.sh` 삭제. 루트 `package.json`을 `scripts/v2/*.mjs`가 실제 쓰는 3개 의존성(`pg`/`@inquirer/prompts`/`@aws-sdk/client-secrets-manager`)으로 축소.
- **런북의 삭제 대상 목록과 실제 실행이 갈린 지점**: `agent/rca/`·`agent/rca_orchestrator.py`·`anthropic_loop.py`는 런북 초안이 "v1 전용 여부 대조 필요"로 남겨뒀던 항목인데, 확인 결과 `agent/agent.py`가 `rca_orchestrator`를 직접 참조하는 **live v2 기능**이라 삭제하지 않음. 또한 `tests/`는 런북에 "전체 삭제" 대상으로 적혀 있었으나 실사(import 추적)로 `tests/hooks/`·`tests/structure/`(PR-review 워크플로/Steampipe/ExternalId 배선 테스트 포함)와 `agent/` pytest 구동부는 v2에서 여전히 쓰이는 것으로 확인 — 이 부분은 보존.
- 부작용 발견 및 수정: `.claude/hooks/pre-commit.sh`가 `next.config.mjs`/`src/` 기준 v1 전용 체크만 갖고 있어 삭제 후 항상 실패로 바뀜(다만 훅 자체는 `|| true`로 무력화되어 커밋을 막지는 않았음) — v2 등가 규칙이 없어 체크를 제거하고 no-op화.
- 검증: `bash tests/run-all.sh`를 삭제 전 태그와 비교 — 신규 회귀 없음(오히려 삭제된 v1 스킬-등록 체크 4건이 사라져 실패 수 감소). `bash scripts/v2/merge-verify.sh`(pytest + web vitest 1600건 + terraform validate) 전부 PASS.
- **Follow-up (PR #159)**: 위에서 3개 의존성으로 축소했던 루트 `package.json`을 그 유일한 소비자인 `scripts/v2/`로 완전히 이동(더 이상 루트에 존재하지 않음) — `make deps`는 `npm ci --prefix scripts/v2`로 갱신.
- **AWS 측 v1 인프라(EC2/CFN/Lambda@Edge/S3)는 이번 실행과 무관하게 그대로 유지** — Phase 4는 원래 유예 일정대로 별도 진행.

## Consequences / 결과

### Positive / 긍정
- EC2 상시 실행 비용(~$235/월) + EBS/ALB/VPCe 즉시 절감, 폐기 완료 시 v1 전체 인프라 비용 소멸.
- 병렬 운영으로 인한 이중 유지보수 부담(두 인증 시스템, 두 데이터 저장소, 두 배포 파이프라인) 해소.
- 기존 URL(`awsops.atomai.click`)이 유지되어 사용자 습관·북마크·외부 연동이 끊기지 않음.

### Negative / Trade-offs
- 명시된 데이터(부서 ACL·브랜딩·AI 대화이력·agentcore-stats·report-schedule)는 복구 불가능하게 손실 — owner가 사전 승인.
- v1 Cognito 사용자는 비밀번호 재설정 필요(이관 불가).
- alert-webhook 외부 발신자를 놓치면 무음 유실 위험 — Phase 1 실사로 완화하되 100% 보증은 아님.
- CloudFront 별칭 이동 구간에서 짧은 순단 가능성.

## 6 Pillars (보안 중심) / 6 Pillars (security-focused)
- **Operational Excellence**: 단계적(정지→유예→삭제) 폐기로 되돌릴 여지를 유예기간 동안 유지, 각 단계가 사람 지시·검토 하에 수행(ADR-005 자율 조치 아님).
- **Security**: v1 별도 Cognito 풀·인증 경로 제거로 공격면 축소. spoke 계정 `AWSopsReadOnlyRole`은 v2 경로 보존을 위해 명시적으로 삭제 대상 제외.
- **Reliability**: 도메인 컷오버는 alias 추가(SAN) + `create_before_destroy` 패턴으로 무중단 지향; 유예기간이 조기 문제 발견의 안전망.
- **Cost**: 즉시·확정적 절감(EC2 상시 실행 제거가 최대 비중).
- **Performance Efficiency**: 단일 스택(v2) 운영으로 배포·모니터링 대상 중복 제거.
- **Sustainability**: 유예기간 종료 후 EC2/EBS/ALB/VPCe 유휴 리소스 완전 반납으로 리소스 중복 소멸.
