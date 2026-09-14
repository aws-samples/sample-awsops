# Runtime foundation / 런타임 기반 구성

## Symptoms and verification / 증상과 검증
A healthy web endpoint does not prove inventory, SSM, AgentCore or worker readiness; inspect disabled backends, pending parameters and failed collection separately.
웹 health 성공은 수집·SSM·AgentCore·워커 정상 증거가 아니다. 기능 비활성·파라미터 미완료·수집 실패를 구분한다.
Use Terraform 1.15.7 and both `scripts/v2/requirements-test.txt` and `scripts/v2/steampipe/requirements.txt`. From the repository root, run these mocked-provider checks:
위 도구·의존성을 설치하고 루트에서 mock 검사를 실행한다.
```bash
python3 -m pytest -q scripts/v2/test_ci_*.py
bash scripts/v2/terraform-test.sh
python3 -m pytest -q scripts/v2/steampipe/test_host_scope.py
node --test scripts/v2/ci/prepare-runtime-host.test.mjs scripts/v2/ci/runtime-release.test.mjs scripts/v2/ci/runtime-release.workflow.test.mjs
```

## Activation / 활성화
1. Configure the **secret** `AWS_ACCOUNT_ID_DEV`, backend and existing CI roles. Checks establish account/role consistency, not dev/production isolation.
   계정은 시크릿에 두며 계정·역할 일치를 스택 격리 보장으로 해석하지 않는다.
2. A new inactive stack needs foundation, migration and working login first. `CI_READONLY_RUNTIME_DEV=true` enables core runtime; manual full plan/apply require real login/DB and an enabled host registry with no enabled foreign rows.
   신규 스택은 기반 인프라·migration·로그인을 먼저 준비한다. 수동 전체 계획/적용의 실제 호스트 검증에서 누락·활성 외부 계정은 차단된다.
3. `runtime-ecr-bootstrap` creates only three repositories. Build ARM64 images and set verified `STEAMPIPE_IMAGE_DIGEST_DEV` / `WORKER_IMAGE_DIGEST_DEV` before a full plan.
   저장소 세 개를 bootstrap한 뒤 ARM64 이미지의 검증된 digest 두 개를 설정한다.
4. Dev/preview private discovery requires full-plan `runtime_rollout=true` and DNS permission; dev also requires the profile. Keep `domain_rollout=false`. Profile/rollout require remediation, RCA write-back, integrations write and diagnosis notifications off; governed external writes are not reclassified as FROZEN.
   사설 DNS 전환에는 full 계획·runtime marker·DNS 허용이 필요하다. 해당 쓰기·알림 플래그는 끄되 외부 쓰기 정책 자체를 FROZEN으로 바꾸지 않는다.
5. Review/apply the same branch/SHA plan and encrypted assets. Preserve public DNS, certificates and network topology; unchanged owned ECS registration still requires DNS permission. Missing/mismatched bundles require a new plan. `CI_ASSETS_READY=true` selects layer verification, not rebuilding.
   같은 브랜치·SHA 계획/asset을 적용하고 공용 DNS·인증서·네트워크를 보존한다. ECS 등록의 DNS 허용을 유지하며 위 플래그로 레이어를 검증한다. 불일치 시 새 계획이 필요하다.

```bash
# After the profile, base application and verified digests are configured:
gh workflow run terraform.yml -R aws-samples/sample-awsops --ref dev -f mode=plan -f plan_scope=full -f runtime_rollout=true -f allow_dns_changes=true
```
Host-only removes only collector AssumeRole; Agent MCP grants remain. IAM includes known regions regardless of current opt-in; newly launched AWS regions require a fresh apply. IAM narrowing also applies to already-enabled main/preview stacks independently of the dev profile.
호스트 모드는 수집기 AssumeRole만 제외한다. 알려진 리전은 opt-in 전에도 IAM에 포함되며 AWS 신규 출시 리전은 재적용이 필요하다. IAM 축소는 dev 프로필과 무관하게 기존 main/preview에도 적용된다.
S3 steady denials remain unknown: rows carry `attributes_unknown`, the ledger increments `unknown_attribute_count`, and freshness is `degraded`; full readiness rejects that incomplete evidence.
S3 지속 거부는 행별 미확인 속성·원장 unknown 수·degraded 신선도로 드러나며 완전한 배포 검증을 통과하지 않는다.
The digest/host-preflight profile is dev-only. Preview retains operator-configured mutable tags or digests and multi-account scope, without dev host verification; account/role and private-DNS ownership checks still apply.
digest·호스트 사전 검증은 dev 프로필 전용이다. preview는 운영자 설정 태그/digest·다중 계정 범위를 유지하며 계정·역할·사설 DNS 소유권만 공통으로 검증한다.

## Rollback / 롤백
Retain runtime resources and restore reviewed prior digests/settings. Manual dev/preview plans and apply block listed core deletion/replacement/forget; this development policy does not cover main. No retirement mode is provided. A destructive teardown needs a separate reviewed procedure covering Aurora ingress, migration dependencies and optional gates.
런타임 리소스를 유지하고 검토된 이전 digest·설정을 복원한다. 수동 dev/preview 계획·적용은 지정 핵심 리소스 삭제·교체·forget을 차단한다. 이 개발 정책은 main에 적용되지 않으며 종료 모드는 제공하지 않는다. 파괴적 종료는 Aurora ingress·migration 의존성·선택 기능을 포함한 별도 검토 절차가 필요하다.

## Promotion to main / main 승격
Sequence: merge reviewed code to dev → reviewed dev apply and full live readiness → main promotion → reviewed production apply. Do not promote this IAM narrowing until live dev exercises verify gateway-backed chat, worker diagnosis, and an SFN/Fargate run with managed tags. Record actual identities, outcomes and denied operations privately; a mock plan or IAM document alone cannot satisfy this promotion gate. This dev PR is the prerequisite for that evidence, not production deployment authorization.
순서: 검토된 dev 코드 머지 → 검토된 dev apply와 전체 실제 준비 상태 검증 → main 승격 → 검토된 운영 apply. 실제 dev gateway 경유 채팅·워커 진단·관리 태그를 포함한 SFN/Fargate 실행을 검증하기 전에는 이 IAM 축소를 main으로 승격하지 않는다. 실제 신원·결과·거부 작업의 증거를 비공개로 기록한다. Mock 계획이나 IAM 문서만으로 승격 조건을 충족할 수 없으며 이 dev PR은 증거 수집의 선행 조건이지 운영 배포 승인이 아니다.

## Required development release check / 개발 배포 필수 검증

Every dev Deploy Web release now verifies the running web role/revision/digest, the owned
inventory Lambda code, fresh completed collection, actual SSM/AgentCore/model access and
owned Lambda/Fargate job completion. `verify_database` cannot disable this gate.
The dev runtime profile also enables `ci_readiness_enabled`; Terraform creates only the
verifier application group and managed demo membership only while AgentCore is enabled. Public CI rejects the readiness flag outside dev; no admin/IAM role is granted.

모든 dev Deploy Web 배포는 실제 웹 역할·revision·digest, 수집 Lambda 코드, 최신 수집,
SSM·AgentCore·모델 권한과 두 워커 완료를 검증합니다. 기존 입력으로 생략할 수 없습니다.
프로필은 검증 플래그도 켭니다. 공개 CI는 이 플래그를 dev에서만 허용하고, Terraform은 AgentCore가 켜져 있을 때만 검증 그룹·관리 demo 멤버십을 생성합니다. 관리자·IAM 역할은 부여하지 않습니다.

For a new inactive stack, first apply the reviewed base plan so runtime_deployment exists;
never disable an already-active profile to repeat bootstrap. Prepare the existing host,
bootstrap/build the three runtime repositories and verified images, then review/apply the
full private-DNS runtime plan. Provision AgentCore after its private migration, then deploy:
신규 비활성 스택만 기본 계획을 먼저 적용합니다. 기존 호스트 준비, 저장소·이미지 준비,
전체 런타임 계획, 사설 migration·AgentCore provisioning 순서 후 배포합니다.

```bash
gh workflow run collect-runtime.yml -R aws-samples/sample-awsops --ref dev -f mode=prepare
# After verified images and the reviewed full runtime apply:
gh workflow run deploy-agentcore.yml -R aws-samples/sample-awsops --ref dev -f smoke=false
gh workflow run deploy-web.yml -R aws-samples/sample-awsops --ref dev -f build=true
```

Prepare accepts disabled backends and reports prepared, not ready. Manual collect additionally
requires the exact deployed image_sha. Keep credentials unchanged; never reset a password or
promote the user to admin. Runtime retirement remains unsupported by this workflow.
prepare는 배포 성공이 아니며 수동 collect에는 배포된 image_sha가 필요합니다. 암호·관리자
권한을 변경해 검증을 통과시키지 않습니다. 이 워크플로는 런타임 삭제를 지원하지 않습니다.

### Existing stacks and rollback / 기존 스택과 롤백

Before the first gated release, apply the reviewed runtime/readiness configuration, complete private migrations and provision the matching AgentCore image. This applies to existing stacks too. `Capture development runtime contract` validates feature flags **before** the image pin and ECS rollout; absent runtime features fail there. Actual access/data/worker proof still runs after rollout. Roll back to a reviewed prior image with these runtime prerequisites intact; there is no health-only escape or password reset.
기존 스택도 첫 필수 검증 배포 전에 검토된 runtime/readiness 설정 적용·사설 migration·AgentCore provisioning을 완료한다. runtime contract 캡처는 이미지 pin·ECS rollout 전에 기능 플래그를 검사한다. 실제 접근·데이터·워커 검증은 rollout 후에도 필수다. 롤백은 런타임 전제조건을 유지한 채 검토된 이전 이미지를 사용하며 health-only 우회나 암호 재설정은 없다.

### Collection contention / 수집 경합

The initial all-type dispatcher retries only confirmed Lambda throttling at ten-second intervals within 450 seconds; denial and uncertain delivery failures are distinct and are not re-dispatched. The freshness marker precedes the accepted dispatch attempt. Collection polling and retry admission share a single deadline 20 minutes after that marker, including login/DB time. The standalone smoke without a retry callback keeps its ten-minute window.
최초 전체 타입 dispatch는 확인된 Lambda throttling만 10초 간격·450초 이내로 재시도하며 권한 거부나 전달 여부가 불명확한 실패는 반복하지 않는다. freshness marker는 접수된 dispatch 시도 직전이고, 수집 polling·재시도 모두 이 시각부터 20분이라는 같은 deadline을 사용한다. 로그인·DB 확인 시간도 포함하며 callback 없는 독립 smoke는 10분을 유지한다.

Recovery waits at least 420 seconds for the initial queue. It then requires no running or missing required ledger rows and no ledger progress for 60 seconds. Only stale terminal acknowledged types can be retried: at most four synchronous `RequestResponse` calls concurrently, batches at least 60 seconds apart, eight calls total per release. Each call requires 450 seconds remaining, covering the verified Lambda timeout of at most 420 seconds and CLI/network overhead. `busy`/throttled calls remain eligible; successful RPCs are not submitted again. A fresh successful ledger row with zero unknowns is still required, even after a successful RPC. Partial/failed results and permission/protocol failures remain distinct. Exhausted call/time budgets skip new RPCs while polling continues; they never imply success. The scheduler is unchanged.
복구는 최초 대기열에 최소 420초를 준 뒤, 필수 원장의 running·누락 행이 없고 60초간 진행 변화도 없을 때만 시작한다. 접수된 타입 중 오래된 종료 상태만 RequestResponse로 동시에 최대 4개, batch 간 최소 60초, 배포당 총 8회까지 호출한다. 각 호출에는 450초 이상 남아 있어야 하며 Lambda timeout 최대 420초와 CLI·네트워크 여유를 포함한다. busy·throttling은 재대상으로 남고 성공 RPC는 다시 보내지 않는다. RPC 성공 뒤에도 unknown 0인 최신 성공 원장이 필수이며 partial·failed·권한·protocol 실패는 구분한다. 예산 소진 시 새 RPC만 생략하고 polling을 계속하며 성공으로 처리하지 않는다. 스케줄은 변경하지 않는다.

The workflow gate allows 45 minutes for bounded dispatcher admission, collection, AgentCore and both five-minute worker polls. The manual workflow job allows 60 minutes including setup. These are upper bounds, not sleeps; ready components advance immediately. A timeout means complete readiness was not established within the capacity/time budget.
workflow gate는 제한된 최초 dispatch·수집·AgentCore·각 5분 워커 polling을 위해 최대 45분, 수동 job은 setup 포함 최대 60분이다. 고정 대기가 아니라 상한이므로 준비 완료 즉시 다음 단계로 진행한다. timeout은 처리 용량·시간 예산 안에 완전한 readiness를 입증하지 못했다는 뜻이다.

CI deliberately requires zero unknown attributes; the product may still display degraded inventory. There is no baseline/allowlist exception for release. Timeout means complete readiness was not established within the bound; inspect contention, throughput and permissions rather than accepting stale or incomplete data.
제품은 degraded 인벤토리를 표시할 수 있지만 CI 수락 기준은 unknown 0이다. 배포용 baseline·allowlist 예외는 없다. timeout은 제한 시간 내 완전한 준비 상태를 입증하지 못했다는 뜻이며 오래되거나 불완전한 데이터를 허용하지 말고 경합·처리량·권한을 조사한다.

### Deployer verification permissions / Deployer 검증 권한

The configured dev deployer needs these scopes before the first gated release. They supplement the existing build/pin/roll permissions; this controller does not grant IAM. Replace placeholders with the independently configured account, deployment region and project. Never grant wildcard Lambda invocation to pass the gate.
첫 필수 검증 배포 전 dev deployer에 아래 범위가 필요하다. 기존 build/pin/roll 권한과 구분하며 컨트롤러는 IAM을 부여하지 않는다. placeholder는 검증된 계정·리전·프로젝트로 바꾸고 gate 통과를 위해 Lambda 호출을 전체 리소스로 넓히지 않는다.

| Action | Resource / condition |
|---|---|
| `ecr:BatchGetImage` | `arn:aws:ecr:<region>:<account>:repository/<project>-web` |
| `ecs:DescribeServices` | `arn:aws:ecs:<region>:<account>:service/<project>/<project>-web` |
| `ecs:DescribeTasks` | `arn:aws:ecs:<region>:<account>:task/<project>/*` |
| `ecs:ListTasks` | `Resource: "*"`; `ArnEquals` `ecs:cluster` = `arn:aws:ecs:<region>:<account>:cluster/<project>` and deployment `aws:RequestedRegion` |
| `ecs:DescribeTaskDefinition` | `Resource: "*"` with deployment `aws:RequestedRegion`; AWS defines no task-definition resource scope for this action |
| `lambda:GetFunctionConfiguration`, `lambda:InvokeFunction` | `arn:aws:lambda:<region>:<account>:function:<project>-inv-sync` only, for initial dispatch and bounded retries |

ListTasks is constrained by its cluster condition for this Fargate/service query; do not substitute task-definition ARNs for unsupported resource scoping. STS caller verification remains mandatory. An API failure means access is unverified, not permission to broaden grants. Scope references: `https://docs.aws.amazon.com/service-authorization/latest/reference/list_ecs.html` and `https://docs.aws.amazon.com/service-authorization/latest/reference/list_lambda.html`.
ListTasks는 이 Fargate/service 조회에서 cluster 조건으로 제한하며 지원되지 않는 resource scope를 task-definition ARN으로 꾸미지 않는다. STS 호출자 검증도 필수다. API 실패는 접근 미검증이지 권한 확대 승인이 아니다.

## Related / 관련

[CI setup/assets](dev-repo-setup.md) · [SQL reader](agent-sql-reader.md) · [Multi-account](onboard-target-account.md) · [Inventory rollback](steampipe-quota-and-staleness.md).
Sources: `scripts/v2/ci_runtime_policy.py`, `scripts/v2/ci_tf_assets.py`, `scripts/v2/ci/prepare-runtime-host.mjs`, `scripts/v2/ci/runtime-release.mjs`, `terraform/foundation/runtime-read-scope.tf`, `terraform/foundation/controller-readiness.tf`, `.github/workflows/terraform.yml`, `.github/workflows/collect-runtime.yml`, `.github/workflows/deploy-web.yml`.
ADRs: ADR-001, ADR-002, ADR-005, ADR-007, ADR-011, ADR-016, ADR-017, ADR-021. Infrastructure apply is not live readiness proof. 인프라 적용만으로 실제 권한·수집·워커 검증을 통과한 것으로 처리하지 않는다.
