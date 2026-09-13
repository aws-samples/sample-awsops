# Runtime foundation / 런타임 기반 구성

## Symptoms / 증상

A healthy web endpoint does not prove inventory, SSM, AgentCore or worker readiness.
Disabled backends, pending parameters or failed collection can leave the dashboard empty.
웹 health 성공은 수집·SSM·AgentCore·워커 정상 동작을 증명하지 않습니다.
백엔드 비활성·파라미터 준비 미완료·수집 실패를 각각 확인합니다.

## Verify / 검증

Use Terraform 1.15.7 and both `scripts/v2/requirements-test.txt` and
`scripts/v2/steampipe/requirements.txt`. These checks use mocked providers:
위 도구와 의존성을 설치하고 루트에서 mock 검사를 실행합니다.

```bash
python3 -m pytest -q scripts/v2/test_ci_*.py
bash scripts/v2/terraform-test.sh
python3 -m pytest -q scripts/v2/steampipe/test_host_scope.py
```

## Activation / 활성화

1. Configure the **secret** `AWS_ACCOUNT_ID_DEV` and the branch's existing backend/roles.
   Identity checks establish account/role consistency, not dev-versus-production isolation.
   대상 계정은 시크릿에 두며 계정·역할 일치를 스택 간 격리 보장으로 해석하지 않습니다.
2. A fresh inactive stack needs foundation, migration and a working login first.
   `CI_READONLY_RUNTIME_DEV=true` enables the core runtime profile. Full plans must pass
   actual login/DB/host-registry preparation; missing or enabled foreign rows block activation.
   신규 스택은 기반 인프라·migration·로그인을 먼저 준비합니다. 전체 계획 전에 실제
   호스트 검증을 수행하며 누락·활성 외부 계정이 있으면 진행하지 않습니다.
3. `runtime-ecr-bootstrap` targets only three repositories. Build ARM64 images and set
   verified `STEAMPIPE_IMAGE_DIGEST_DEV` / `WORKER_IMAGE_DIGEST_DEV` before a full plan.
   ECR bootstrap은 저장소 세 개만 준비하며 전체 계획에는 검증된 ARM64 digest가 필요합니다.
4. Dev/preview private discovery changes require `runtime_rollout=true` on a full plan;
   dev also requires the profile. Keep `domain_rollout=false` and explicitly allow DNS.
   Profile metadata requires remediation, RCA write-back, integrations write and diagnosis
   notifications off; this does not reclassify governed external writes as frozen.
   사설 DNS 전환은 full 계획에 runtime marker와 DNS 허용을 명시합니다. 이 프로필의
   쓰기·알림 플래그는 끄지만 외부 쓰기 정책 자체를 FROZEN으로 바꾸지는 않습니다.
5. Review all changes and apply the same branch/SHA plan. Public DNS/certificates/network
   remain protected. Owned unchanged ECS registration updates still need DNS permission.
   CI binds encrypted Lambda assets to the plan; missing bundles require a new plan.
   Plan/apply export `CI_ASSETS_READY=true`, selecting layer verification instead of rebuilding.
   같은 브랜치·SHA 계획과 암호화 asset을 적용하며 공용 DNS·인증서·네트워크는 보존합니다.
   두 단계는 위 플래그로 레이어 재빌드 대신 검증 경로를 선택합니다.

```bash
# Once the profile, base application and verified image digests are configured:
gh workflow run terraform.yml -R aws-samples/sample-awsops --ref dev -f mode=plan -f plan_scope=full -f runtime_rollout=true -f allow_dns_changes=true
```

Host-only mode removes only collector AssumeRole; Agent MCP grants remain. IAM region scope
reflects enabled regions at apply time: apply updated IAM before new region collection.
호스트 모드는 수집기 AssumeRole만 제외합니다. 새 리전 수집 전에는 IAM을 다시 적용합니다.

## Retirement / 종료

Rollback normally keeps runtime enabled and restores reviewed prior digests/settings.
Full dev retirement is destructive: turn the profile off, use a full plan with
`runtime_retire=true` and DNS permission, and review queue contents, images/data and every
deletion. Replacements/forget and public/shared infrastructure changes remain prohibited.
일반 롤백은 런타임을 유지합니다. 전체 종료는 프로필을 끄고 명시적 retirement 계획으로
큐·이미지·데이터 삭제를 검토해야 하며 교체·forget·공용/공유 인프라 변경은 금지됩니다.

```bash
# Only after the owner explicitly chooses runtime retirement:
gh workflow run terraform.yml -R aws-samples/sample-awsops --ref dev -f mode=plan -f plan_scope=full -f runtime_retire=true -f allow_dns_changes=true
# After reviewing that successful same-SHA plan:
gh workflow run terraform.yml -R aws-samples/sample-awsops --ref dev -f mode=apply -f plan_scope=full -f plan_run_id="$PLAN_RUN_ID" -f allow_dns_changes=true
```

## Related / 관련

[CI setup and assets](dev-repo-setup.md) · [SQL reader](agent-sql-reader.md) ·
[Multi-account](onboard-target-account.md) · [Inventory rollback](steampipe-quota-and-staleness.md).
Sources: `scripts/v2/ci_runtime_policy.py`, `scripts/v2/ci_tf_assets.py`,
`scripts/v2/ci/prepare-runtime-host.mjs`,
`terraform/foundation/runtime-read-scope.tf`, `.github/workflows/terraform.yml`.
ADRs: 001, 005, 007, 011, 016. Infrastructure apply is not live readiness proof.
인프라 apply만으로 실제 권한·수집·워커 검증을 통과한 것으로 처리하지 않습니다.
