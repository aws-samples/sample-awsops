# Runtime foundation / 런타임 기반 구성

## Symptoms and causes / 증상과 원인

A healthy `/api/health` can coexist with empty inventory or denied AgentCore SSM
reads: the backends may be disabled, parameters pending, or collection failing.
A saved plan can also reference Lambda ZIPs absent from a new apply runner.

`/api/health`가 성공해도 백엔드 비활성·SSM 준비 미완료·수집 실패로 인벤토리가
비어 있을 수 있습니다. 새 apply runner에 저장 계획의 Lambda ZIP이 없을 수도 있습니다.

## Offline verification / 오프라인 검증

Use Terraform 1.15.7 and install both `scripts/v2/requirements-test.txt` and
`scripts/v2/steampipe/requirements.txt`. Run from the repository root:

Terraform 1.15.7과 위 두 requirements 파일의 의존성을 설치하고 루트에서 실행합니다.

```bash
python3 -m pytest -q scripts/v2/test_ci_*.py
bash scripts/v2/terraform-test.sh
python3 -m pytest -q scripts/v2/steampipe/test_host_scope.py
```

These use mocked providers, not a live backend. Configuration is not effective
permission or collection proof. Inspect deployment output privately.

mock 검사는 실제 backend를 사용하지 않습니다. 설정은 실제 권한·수집 성공의
증거가 아니며 배포 output은 비공개로 확인합니다.

## Activation / 활성화

1. Configure the **secret** `AWS_ACCOUNT_ID_DEV`. Configured development/preview roles
   and actual STS callers must match it. Missing backend config may skip an advisory
   plan; a configured stack without the expected account fails before AWS access.
2. For an authorized dev activation, set `CI_READONLY_RUNTIME_DEV=true`.
   `runtime-ecr-bootstrap` sets the core flags in generated inputs but targets only
   three ECR repositories. Full activation also enables `ci_readiness_enabled`, assigning
   the managed demo identity only to deployment-verifiers (no admin/IAM role).
   Build verified ARM64 images before setting
   `STEAMPIPE_IMAGE_DIGEST_DEV` and `WORKER_IMAGE_DIGEST_DEV` to their digests.
3. Prepare exactly one enabled, real-ID host registry row before host-only collection.
   The renderer verifies STS; Terraform removes only the collector's cross-account
   grant. Agent MCP read grants retain their existing multi-account behavior.
   Host reads cover regions enabled at apply time plus global endpoints; apply updated
   IAM before collecting from newly opted-in regions. See ADR-011 onboarding below.
4. Plan with `runtime_rollout=true`, `domain_rollout=false`, `allow_dns_changes=true`.
   Activation requires remediation, RCA write-back, integrations write and diagnosis
   notification flags off for this requested profile; this does not reclassify governed
   external writes as frozen. Among DNS changes, permit only the owned private namespace,
   discovery service and ECS service registration; preserve public DNS/certificates.
   Ordinary owned ECS updates with unchanged registration still need DNS permission.
5. Review and apply the same branch/SHA saved plan. CI hash-locks pg8000 layers and
   binds encrypted Lambda assets to the plan; local legacy builds are not hash-locked.
   Missing/mismatched bundles require a fresh plan, never an apply-time rebuild.
6. Finish migration, images and AgentCore provisioning, then verify actual web-role
   SSM calls, fresh inventory and completed workers. Infrastructure apply is not readiness.

1. `AWS_ACCOUNT_ID_DEV`를 **시크릿**으로 설정합니다. 개발·preview 역할과 실제 STS가
   일치해야 합니다. backend 미설정 계획은 생략할 수 있지만 계정 검증 누락은 거부합니다.
2. 승인된 dev 활성화에서만 `CI_READONLY_RUNTIME_DEV=true`를 설정합니다. runtime ECR
   bootstrap은 입력의 기능 플래그를 켜되 저장소 세 개만 대상으로 합니다. ARM64 빌드 후
   두 이미지 digest 변수를 검증된 값으로 설정합니다. 전체 활성화는 demo에 검증
   전용 그룹만 연결하며 관리자·IAM 역할을 부여하지 않습니다.
3. 실제 계정 ID의 활성 호스트 행 하나를 준비합니다. renderer는 STS를 검증하고
   Terraform은 수집기 AssumeRole만 제외합니다. Agent MCP의 기존 다중 계정 읽기는
   유지합니다. 새 리전 opt-in 후에는 수집 전에 IAM을 다시 적용합니다.
4. 위 runtime/DNS 입력으로 계획합니다. 이 활성화에서는 remediation·RCA write-back·
   integrations write·diagnosis notify를 끄며, 외부 쓰기 자체를 FROZEN으로 바꾸지는
   않습니다. DNS 변경은 소유 사설 namespace·service·ECS 등록만 허용합니다.
   등록이 같은 일반 ECS 갱신에도 DNS 허용은 필요합니다.
5. 같은 브랜치·SHA의 계획을 검토·적용합니다. CI만 pg8000을 hash-lock하며 asset이
   없거나 다르면 새 계획을 만듭니다. apply 중 재빌드와 `-auto-approve`는 사용하지 않습니다.
6. migration·이미지·AgentCore 배포 후 실제 SSM·최신 수집·워커 완료를 검증합니다.

## Related / 관련

[CI setup](dev-repo-setup.md) · [SQL reader](agent-sql-reader.md) ·
[Multi-account onboarding](onboard-target-account.md).
Sources: `ci_runtime_policy.py`, `ci_tf_assets.py` under `scripts/v2/`,
`terraform/foundation/runtime-read-scope.tf`, `.github/workflows/terraform.yml`.
ADRs: 001, 005, 007, 011, 016 (private upstream).
