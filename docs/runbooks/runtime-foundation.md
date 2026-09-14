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
node --test scripts/v2/ci/prepare-runtime-host.test.mjs
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

## Related / 관련
[Manual deployment observations](deployment-audit.md) separate deployed resources, schedule execution and observed inventory after provisioning.
[CI setup/assets](dev-repo-setup.md) · [SQL reader](agent-sql-reader.md) · [Multi-account](onboard-target-account.md) · [Inventory rollback](steampipe-quota-and-staleness.md).
Sources: `scripts/v2/ci_runtime_policy.py`, `scripts/v2/ci_tf_assets.py`, `scripts/v2/ci/prepare-runtime-host.mjs`, `terraform/foundation/runtime-read-scope.tf`, `.github/workflows/terraform.yml`.
ADRs: 001, 005, 007, 011, 016. Infrastructure apply is not live readiness proof. 인프라 적용만으로 실제 권한·수집·워커 검증을 통과한 것으로 처리하지 않는다.
