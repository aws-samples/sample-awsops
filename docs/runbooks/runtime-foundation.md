# Runtime foundation / 런타임 기반 구성

## Symptoms / 증상

The dashboard can be empty while `/api/health` succeeds. An AgentCore SSM
`GetParameter` denial can also occur when a web task advertises a runtime path
but the runtime feature and its IAM policy are disabled.

`/api/health`가 성공해도 대시보드는 비어 있을 수 있습니다. 웹 태스크에
AgentCore SSM 경로가 설정되어 있지만 런타임 기능과 IAM 정책이 비활성화되어
있으면 `GetParameter` 권한 오류도 발생할 수 있습니다.

## Candidate causes / 원인 후보

- Inventory, AgentCore or worker resources were never enabled.
- The task role lacks the exact configured SSM reads, or parameters remain `PENDING`.
- Inventory has no enabled host account or a collection dependency is unavailable.
- A saved plan references generated Lambda ZIPs absent from the apply runner.

- 인벤토리·AgentCore·워커 리소스가 활성화되지 않았습니다.
- 태스크 역할에 설정된 SSM 경로 읽기 권한이 없거나 값이 `PENDING`입니다.
- 인벤토리 호스트 계정이 활성화되지 않았거나 수집 의존성이 실패했습니다.
- 저장 계획이 참조하는 Lambda ZIP이 apply runner에 없습니다.

## Verify before activation / 활성화 전 검증

Run these offline checks from the repository root:

저장소 루트에서 다음 오프라인 검사를 실행합니다.

```bash
python3 -m pytest -q scripts/v2/test_ci_*.py
bash scripts/v2/terraform-test.sh
python3 -m pytest -q scripts/v2/steampipe/test_host_scope.py
```

Use Terraform 1.15.7 and the dependencies in `scripts/v2/requirements-test.txt`.
The Terraform helper uses mocked providers with no backend. Inspect the reviewed
`runtime_deployment` output privately; do not publish raw state, credentials or
account identifiers. A policy document or configured resource is not evidence of
an actual successful API call.

Terraform 1.15.7과 `scripts/v2/requirements-test.txt` 의존성이 필요합니다.
Terraform 검사는 backend 없이 mock provider를 사용합니다.
검토한 `runtime_deployment` output은 비공개로 확인하며 원본 상태·자격증명·
계정 식별자를 게시하지 않습니다. 정책과 리소스 설정만으로 실제 API 호출
성공을 판정하지 않습니다.

## Action / 조치

1. Set the expected dev account in `AWS_ACCOUNT_ID_DEV`. Keep the configured
   development CI role in the same account; the workflow checks it before OIDC
   and checks the resulting STS identity afterwards.
2. Set `CI_READONLY_RUNTIME_DEV=true` only for an authorized activation.
   `plan_scope=runtime-ecr-bootstrap` permits only the AgentCore, Steampipe and
   worker ECR repositories. It enables no services by itself.
3. Build and inspect ARM64 images before a full plan. Set
   `STEAMPIPE_IMAGE_DIGEST_DEV` and `WORKER_IMAGE_DIGEST_DEV` to verified
   `sha256:` digests. The full activation fails without them.
4. Prepare the enabled host-account registry before starting host-only inventory.
   The renderer verifies STS and rejects a missing/disabled host or enabled
   foreign account. Collection retains all enabled AWS regions and global services.
5. Dispatch a full plan with `runtime_rollout=true`, `domain_rollout=false` and
   `allow_dns_changes=true`. Review all changes. Runtime rollout permits only the
   owned private namespace, its service and registered ECS task changes; it rejects
   public DNS/certificate changes and network replacements.
6. Apply that explicit same-branch, same-commit saved plan with DNS permission.
   Encrypted assets travel with the plan and are checked before restoration.
   Never use `-auto-approve` or rebuild missing assets during apply.
7. Complete image deployment, private database migration and AgentCore provisioning.
   Verify actual web-role SSM reads, fresh inventory and completed worker jobs.
   Infrastructure apply alone does not establish release readiness.

1. `AWS_ACCOUNT_ID_DEV`에 대상 개발 계정을 설정합니다. 개발 CI 역할도 같은
   계정이어야 합니다. workflow는 OIDC 전 역할과 인증 후 STS 식별자를 검사합니다.
2. 승인된 활성화에서만 `CI_READONLY_RUNTIME_DEV=true`를 설정합니다.
   `plan_scope=runtime-ecr-bootstrap`은 AgentCore·Steampipe·워커 ECR 저장소만
   허용하며 서비스를 활성화하지 않습니다.
3. 전체 계획 전에 ARM64 이미지를 빌드·검증합니다.
   `STEAMPIPE_IMAGE_DIGEST_DEV`와 `WORKER_IMAGE_DIGEST_DEV`에 검증된 `sha256:`
   digest를 설정합니다. 값이 없으면 전체 활성화는 실패합니다.
4. 호스트 전용 인벤토리를 시작하기 전에 호스트 계정 레지스트리를 활성화합니다.
   renderer는 STS를 확인하고 누락·비활성 호스트나 활성 외부 계정을 거부합니다.
   수집 범위는 활성 AWS 리전 전체와 글로벌 서비스를 유지합니다.
5. `runtime_rollout=true`, `domain_rollout=false`, `allow_dns_changes=true`로
   전체 계획을 실행하고 모든 변경을 검토합니다. 런타임 배포는 소유한 사설
   namespace·서비스·등록 ECS 태스크 변경만 허용하며 공용 DNS·인증서 변경과
   네트워크 교체를 거부합니다.
6. DNS 허용을 명시하고 같은 브랜치·커밋의 저장 계획을 적용합니다. 암호화된
   asset은 계획과 함께 전달되며 복원 전에 검사합니다. `-auto-approve`나
   apply 중 누락 asset 재빌드는 사용하지 않습니다.
7. 이미지 배포·사설 DB migration·AgentCore provisioning을 마친 뒤 실제 웹
   역할의 SSM 조회, 최신 인벤토리와 완료된 워커 작업을 확인합니다.
   인프라 apply만으로 배포 정상 동작을 확정하지 않습니다.

## Related files / 관련 파일

- `.github/workflows/terraform.yml`
- `scripts/v2/ci_runtime_policy.py`, `scripts/v2/ci_tf_assets.py`
- `terraform/foundation/runtime-read-scope.tf`
- [Private SQL reader / 사설 SQL reader](agent-sql-reader.md)
- [DNS controls / DNS 제어](dev-repo-setup.md)
- ADR-001, ADR-005, ADR-007, ADR-016 (private upstream decision records)
