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
2. This controller adopts an already-running web stack with working foundation, migrations and login; first-web bootstrap is outside this workflow. `CI_READONLY_RUNTIME_DEV=true` enables core runtime; manual full plan/apply require real login/DB and an enabled host registry with no enabled foreign rows.
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

For an **already-running web stack with inactive backends**, first apply the reviewed base plan so runtime_deployment exists; never disable an active profile to repeat bootstrap. Prepare verifies that existing web image/service/login and host registry. It does not create the first web deployment. Bootstrap/build the three runtime repositories and verified images, then review/apply the full private-DNS runtime plan. Provision AgentCore after its private migration, then deploy. A brand-new stack without a working web service needs a separate reviewed bootstrap procedure before using these commands; this controller supplies no first-web bootstrap or health-only bypass.

```bash
gh workflow run collect-runtime.yml -R aws-samples/sample-awsops --ref dev -f mode=prepare
# After verified images and the reviewed full runtime apply:
gh workflow run deploy-agentcore.yml -R aws-samples/sample-awsops --ref dev -f smoke=false
gh workflow run deploy-web.yml -R aws-samples/sample-awsops --ref dev -f build=true
```

Prepare accepts disabled backends and reports prepared, not ready. Manual collect additionally
requires the exact deployed image_sha. Keep credentials unchanged; never reset a password or
promote the user to admin. Runtime retirement remains unsupported by this workflow.

### Existing stacks and rollback / 기존 스택과 롤백

Before the first gated release, apply the reviewed runtime/readiness configuration, complete private migrations and provision the matching AgentCore image. This applies to existing stacks too. `Capture development runtime contract` validates feature flags **before** the image pin and ECS rollout; absent runtime features fail there. Actual access/data/worker proof still runs after rollout. Roll back to a reviewed prior image with these runtime prerequisites intact; there is no health-only escape or password reset.

### Adopting an existing verifier group / 기존 검증 그룹 채택

Before the first readiness apply, check whether `deployment-verifiers` already exists in this stack's user pool and whether Terraform already manages it. Do not delete/recreate the group or change passwords to resolve an import conflict. If a separately created group exists, include a reviewed import block in the saved plan before the apply; likewise import an existing managed-demo membership only when that resource's conditions are true. Verify the plan imports the exact intended group/membership, grants no IAM role/admin membership, and does not replace the pool or user. Use the actual pool ID and configured username; examples below are placeholders. If the existing group has an IAM role or unexpected membership, stop for an owner-reviewed adoption decision instead of silently changing its privileges. Remove the temporary import blocks after successful adoption.

```hcl
import {
  to = aws_cognito_user_group.deployment_verifiers[0]
  id = "<pool-id>/deployment-verifiers"
}
# Only when the managed demo membership already exists and its count is enabled:
import {
  to = aws_cognito_user_in_group.demo_readiness[0]
  id = "<pool-id>,deployment-verifiers,<configured-demo-username>"
}
```

The group import ID uses a slash; membership uses comma-separated pool/group/username, per the pinned AWS provider's resource import contracts. Import is a reviewed state adoption, not authorization for additional privileges.

### Collection contention / 수집 경합

The controller reads the complete catalog from the code-checked inventory Lambda, then invokes only the owned CloudFront collector synchronously. It does not enqueue another all-type sweep or run a stale-terminal batch queue. Ledger rows no longer control RPC retry admission. Only the bounded owned probe is retried; all other catalog types still require fresh successful evidence from the existing scheduled collector.

Catalog admission has a 450-second budget and retries only confirmed Lambda throttling. The CloudFront probe has a 900-second budget; each invocation needs at least 450 seconds remaining for the verified function timeout of at most 420 seconds plus transport overhead. Confirmed throttling, `busy`, and the producer's exact superseded result wait ten seconds before another bounded attempt. Denied, uncertain-delivery, partial, failed, and invalid-protocol outcomes fail distinctly. A successful RPC alone is not readiness proof.

The release freshness marker is recorded after catalog discovery and **before** the first CloudFront probe. It is not reset by retries or a delayed response. Every catalog type must have a succeeded ledger row whose start and last success are at or after that marker, with zero unknown attributes; the known CloudFront record must also be fresh after it. Older scheduled results do not pass, even if they are less than thirty minutes old. `expectedQueuedTypes` is the retained wire-field name for the catalog, not a claim that CI dispatched every type.

Release-mode collection polling allows twenty minutes after account/login checks; standalone verification retains ten minutes. The authenticated collection-only summary avoids inventory-wide aggregations. A deadline bounds the start of a poll, and a valid successful response from an admitted request is retained even if it arrives just after that deadline. No new poll begins after expiry. The runtime and both five-minute worker checks remain mandatory.

Capacity is a prerequisite, not a guarantee supplied by a timeout. With N types, C collector slots and a per-type duration T, budget for scheduler wait plus roughly ceil(N/C) waves; using the 420-second maximum for every type gives a conservative capacity bound. Four slots cannot guarantee a 43-type sweep in twenty minutes at that maximum. If full fresh coverage cannot be produced, the gate must fail; inspect throughput, throttling and permissions, then use the existing reviewed Terraform process for any concurrency or query-budget adjustment. Do not accept old rows, omit types, or bypass unknown/partial failures to turn the gate green.

Both verification steps have a 55-minute workflow cap with a fresh one-hour session for the same configured role; the manual job allows 75 minutes including setup. These are outer limits, not promises that every combination of slow calls will fit. Restored Terraform inputs are deleted immediately after capture, with final cleanup retained as a fallback. No schedule, feature flag or infrastructure setting is changed by the verifier.

### Deployer verification permissions / Deployer 검증 권한

The configured dev deployer needs these scopes before the first gated release. They supplement the existing build/pin/roll permissions; this controller does not grant IAM. Replace placeholders with the independently configured account, deployment region and project. Never grant wildcard Lambda invocation to pass the gate.

| Action | Resource / condition |
|---|---|
| `ecr:BatchGetImage` | `arn:aws:ecr:<region>:<account>:repository/<project>-web` |
| `ecs:DescribeServices` | `arn:aws:ecs:<region>:<account>:service/<project>/<project>-web` |
| `ecs:DescribeTasks` | `arn:aws:ecs:<region>:<account>:task/<project>/*` |
| `ecs:ListTasks` | `Resource: "*"`; `ArnEquals` `ecs:cluster` = `arn:aws:ecs:<region>:<account>:cluster/<project>` and deployment `aws:RequestedRegion` |
| `ecs:DescribeTaskDefinition` | `Resource: "*"` with deployment `aws:RequestedRegion`; AWS defines no task-definition resource scope for this action |
| `lambda:GetFunctionConfiguration`, `lambda:InvokeFunction` | `arn:aws:lambda:<region>:<account>:function:<project>-inv-sync` only, for catalog discovery and the bounded CloudFront probe |

ListTasks is constrained by its cluster condition for this Fargate/service query; do not substitute task-definition ARNs for unsupported resource scoping. STS caller verification remains mandatory. An API failure means access is unverified, not permission to broaden grants. Scope references: `https://docs.aws.amazon.com/service-authorization/latest/reference/list_ecs.html` and `https://docs.aws.amazon.com/service-authorization/latest/reference/list_lambda.html`.

## Related / 관련

[CI setup/assets](dev-repo-setup.md) · [SQL reader](agent-sql-reader.md) · [Multi-account](onboard-target-account.md) · [Inventory rollback](steampipe-quota-and-staleness.md).
Sources: `scripts/v2/ci_runtime_policy.py`, `scripts/v2/ci_tf_assets.py`, `scripts/v2/ci/prepare-runtime-host.mjs`, `scripts/v2/ci/runtime-release.mjs`, `terraform/foundation/runtime-read-scope.tf`, `terraform/foundation/controller-readiness.tf`, `.github/workflows/terraform.yml`, `.github/workflows/collect-runtime.yml`, `.github/workflows/deploy-web.yml`.
ADRs: ADR-001, ADR-002, ADR-005, ADR-007, ADR-011, ADR-016, ADR-021. Infrastructure apply is not live readiness proof.
