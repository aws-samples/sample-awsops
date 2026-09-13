# Dev domain rollout / 개발 도메인 전환

## Symptoms and scope / 증상과 범위

Use this procedure when the dev stack must serve a newly delegated child domain
while keeping certificate ownership and DNS publication explicit. The parent
operator performs all live checks and dispatches. Examples below use reserved
names; substitute the approved deployment values. This procedure does not grant
permission to change any other domain or parent-zone delegation.

위임된 새 하위 도메인을 dev 스택에 연결할 때 사용한다. 실제 조회와 실행은 상위
운영자가 수행한다. 아래 예약 도메인을 승인된 배포 값으로 바꾼다. 다른 도메인이나
상위 존의 NS 위임 변경 권한은 포함하지 않는다.

Possible blockers include a missing/duplicate public hosted zone in the assumed
account, mismatched delegation, an out-of-zone alias in protected tfvars, or a
selected certificate that fails SAN, validity, Region/account, or public-trust
checks. Do not infer SAN coverage from the old certificate's domain label.

대상 계정의 public hosted zone 누락/중복, NS 불일치, 보호된 tfvars의 존 외부 별칭,
인증서 SAN·유효기간·리전/계정·공개 신뢰 체인 검증 실패를 구분한다. 기존 인증서의
대표 도메인만으로 새 호스트의 SAN 포함 여부를 판단하지 않는다.

## Persistent inputs / 영구 입력

Set **repository-level variables**, not secrets or environment-scoped variables:

환경별 변수가 아닌 **저장소 수준 변수**를 설정한다. 보호된 `TF_TFVARS_DEV`를
재작성하거나 공개 로그에 출력하지 않는다.

| Variable / 변수 | Meaning / 의미 |
| --- | --- |
| `DOMAIN_NAME_DEV` | Service FQDN, e.g. `dev.example.com` / 서비스 FQDN |
| `HOSTED_ZONE_NAME_DEV` | Delegated child zone, e.g. `dev.example.com` / 위임된 하위 존 |
| `CERTIFICATE_MODE_DEV` | `preserve` (default / 기본값) or `managed` |

Set the two names together or leave both unset. Names must be plain ASCII
hostnames with valid labels, no wildcard, URL, whitespace, port, or trailing dot.
The domain and every existing `extra_domain_aliases` entry must be in the selected
zone. An empty pair keeps names from protected tfvars. `managed` can also be used
with that empty pair; it still uses and validates the configured zone.

두 이름은 함께 지정하거나 모두 비운다. 와일드카드, URL, 공백, 포트, 마지막 점이
없는 ASCII 호스트명만 허용한다. 도메인과 기존 `extra_domain_aliases` 모두 지정
존에 속해야 한다. 두 변수가 없으면 보호된 tfvars의 이름을 유지한다. 이 경우에도
`managed`를 선택할 수 있으며, 기존 존 설정을 검증한다.

Only target `dev`, including a PR whose **base** is `dev`, reads these variables.
Main and preview targets ignore them. The workflow cleans and generates
`ci-domain.auto.tfvars.json` before console; both console and plan automatically
load it. Preflight produces `ci-deployment.tfvars.json`, passed explicitly to plan
for certificate nulls/ARNs and the publication flag. Both generated files are
removed even on failure. Keep independent migration flags additive in the plan
argument array; do not replace either input path.

PR의 **대상 브랜치**를 포함하여 `dev`일 때만 적용한다. main/preview에는 적용하지
않는다. console과 plan은 같은 자동 tfvars 파일을 읽고, plan은 인증서 및 게시
플래그를 담은 별도 검증 파일도 읽는다. 실패 시에도 생성 파일을 정리한다. 독립된
마이그레이션 플래그는 plan 인자 배열에 추가하며 기존 입력 경로를 대체하지 않는다.

## Verify first / 먼저 확인

1. Confirm the assumed dev identity, Region, backend, and current branch/commit.
   A delegated child NS set does **not** establish that the zone exists in that
   AWS account. Run the account check with the intended dev credentials and
   compare with the separately recorded expected account.
   dev 자격 증명으로 계정·리전·backend·브랜치/커밋을 확인한다. NS 위임 사실만으로
   해당 계정에 존이 있다고 판단하지 않는다.

   ```bash
   aws sts get-caller-identity --query Account --output text
   ```

2. First select `preserve`. For **externally owned** certificates, supply the
   currently attached, operator-selected CloudFront and ALB ARNs to a full plan dispatch.
   For certificates already managed by this Terraform state, leave external-ARN inputs
   null/unset; preflight verifies the owned certificates without externalizing them. With the new name variables
   already set, preflight verifies the new hostname against both selected public
   certificates (CloudFront: us-east-1 plus all aliases; ALB: configured Region).
   `allow_dns_changes=false`, `publish_service_dns=false` is the initial test.
   There is no account-wide certificate scan or fallback selection.
   먼저 `preserve`를 선택하고 외부 소유 인증서만 기존 연결 ARN을 명시한다.
   Terraform이 이미 관리하는 인증서는 외부 ARN 입력을 비워 두어 소유권을 유지하며 검증한다.
   계정 전체 검색이나 대체 인증서 자동 선택은 하지 않는다.

3. Inspect the safe `public_zone` plan summary: `name`, `zone_id`, `name_servers`.
   Compare its four normalized NS names as a set with the delegated public NS set.
   The existing exact-name, public-only Terraform data lookup must resolve one
   zone. Missing, ambiguous, private, mismatched, or unknown zone data blocks CI.
   요약의 존 이름/ID/NS 네 개를 공개 위임 결과와 비교한다. 정확히 한 public zone을
   찾지 못하거나 값이 불명확하면 진행하지 않는다.

   ```bash
   CHILD_ZONE=dev.example.com
   dig +short NS "$CHILD_ZONE"
   ```

   If inspecting an already saved plan locally, project only the public fields;
   never print/upload the complete JSON plan or state:
   로컬 저장 plan에서도 public 필드만 추출하고 전체 plan/state를 출력하지 않는다.

   ```bash
   set -o pipefail
   terraform -chdir=terraform/foundation show -json tfplan |
     python3 scripts/v2/ci_dev_domain.py zone-summary
   ```

## Staged action / 단계별 실행

If both old certificates pass, retain `preserve` and their selected/attached reuse.
If the parent establishes that SAN coverage fails and elects issuance, set
`CERTIFICATE_MODE_DEV=managed` and remove supplied existing-ARN inputs.
Conflicting nonempty existing ARNs in protected tfvars also block this mode; an
operator must resolve that input separately without exposing the secret.

기존 인증서가 통과하면 `preserve`를 유지한다. 상위 운영자가 SAN 실패를 확인하고
새 발급을 선택하면 `managed`로 전환하고 기존 ARN 입력을 제거한다. 보호된 tfvars에
충돌하는 ARN이 있어도 거부한다. 운영자가 별도로 입력을 정리하되 비밀 내용을
노출하지 않는다.

`managed` selects JSON null for both external-ARN overrides, using the existing
Terraform ACM/validation resources. First creation or conversion from attached
external certificates requires **a full plan and explicit DNS permission**.
The old external certificates remain externally owned; no import, deletion, or
revocation is performed. Already managed certificates retain ownership in either
mode. Do not use managed mode to bypass other trust/validity failures.

`managed`는 기존 외부 ARN 변수 두 개에 JSON null을 전달하여 Terraform ACM/검증
리소스를 사용한다. 최초 생성/외부 연결 인증서에서의 전환에는 **full plan과 명시적
DNS 허용**이 필요하다. 이전 외부 인증서를 가져오거나 삭제/폐기하지 않는다. 이미
관리 중인 인증서의 소유권은 두 모드 모두 유지한다. 다른 검증 실패를 우회하지 않는다.

An `ecr-bootstrap` plan with null external-ARN inputs remains certificate-neutral in
either mode, including a fresh stack. It needs no DNS permission and cannot create or
change certificates: the saved-plan check permits only `aws_ecr_repository.web`.
External-ARN conflicts and ownership guards still apply. See the
[ECR bootstrap procedure](dev-repo-setup.md).

외부 ARN 입력이 비어 있는 `ecr-bootstrap`은 새 스택에서도 두 모드 모두 인증서와 무관하게
실행할 수 있다. DNS 허용이 필요 없으며 저장 계획은 `aws_ecr_repository.web`만 변경할 수
있으므로 인증서를 생성·변경하지 않는다. 외부 ARN 충돌·소유권 검사는 그대로 적용된다.

| Stage / 단계 | `plan_scope` | `allow_dns_changes` | `publish_service_dns` |
| --- | --- | --- | --- |
| Test old certificates / 기존 인증서 검증 | `full` | `false` | `false` |
| New certificates/domain / 인증서·도메인 전환 | `full` | `true` | `false` |
| After DB/auth smoke / DB·인증 검증 후 서비스 A 게시 | `full` | `true` | `true` |

For each stage, dispatch **plan** from `dev`, review its summary and exact saved
plan, then dispatch **apply** from the same branch/SHA with that successful
`plan_run_id` and matching DNS permission/scope. The encrypted saved plan contains
the publication setting; changing inputs or repository variables on the apply
dispatch does not alter it. Create a fresh plan after any intended input change.
PR/push plans remain advisory; a dev advisory plan never grants DNS permission.
Before initial managed issuance, automatic preflight can therefore refuse the
plan; use the explicit authorized dispatch to prepare the rollout.

각 단계에서 dev의 plan을 검토한 뒤 같은 브랜치/SHA에서 성공한 `plan_run_id`로
apply한다. apply의 DNS 허용·scope도 일치시킨다. 게시 플래그는 암호화된 저장 plan에
포함되므로 apply 입력이나 저장소 변수 변경으로 plan을 바꾸지 않는다. 입력 변경
시 새 plan을 만든다. PR/push는 참고용이며 dev 자동 plan은 DNS 권한을 부여하지
않는다. 최초 managed 발급 전 자동 검증이 거부되면 명시적 허용 dispatch를 사용한다.

The first rollout stage retains service A absence while validation CNAMEs and TLS
consumers change. The parent must then complete DB/auth smoke using the existing
Host/SNI-preserving smoke workflow before the final A-publication stage. This
runbook does not replace the migration or smoke procedures.

첫 전환 단계에서는 서비스 A를 게시하지 않고 검증 CNAME과 TLS 구성을 변경한다.
이후 상위 운영자가 기존 Host/SNI 유지 smoke 절차로 DB·인증을 검증한 뒤 최종 A를
게시한다. 이 문서는 마이그레이션·smoke 절차를 대체하지 않는다.

## Boundaries and recovery / 제한과 복구

- Dev DNS permission covers only canonical `alias` A and `cf_validation` CNAME
  resources for the configured domain/in-zone aliases in the selected child zone.
  It never covers parent NS, unrelated records, new zones, or Cloud Map/registered
  ECS DNS changes. Both before and after values are checked.
  dev DNS 권한은 선택 존의 지정 도메인/별칭 A 및 검증 CNAME에만 적용한다.
  상위 NS, 다른 레코드, 새 존, Cloud Map/등록된 ECS 변경은 허용하지 않는다.
- On first ACM creation, validation token fields can be unknown in the plan;
  the canonical resource/domain key and selected zone must be known. These tokens
  come from the existing reviewed ACM validation configuration. Known token names
  must match the configured hostname, with ACM validation destinations.
  최초 발급 시 토큰 값은 미정일 수 있지만 리소스/도메인 키와 존은 확정되어야 한다.
  확정된 토큰은 지정 호스트 및 ACM 검증 대상과 일치해야 한다.
- `allow_dns_changes=false` still blocks all DNS mutations and preserves current
  service publication. Every validation-CNAME retirement/replacement and managed
  certificate retirement/externalization block remains, even with DNS permission.
  A previously owned old-domain record can therefore block a rename; stop for a
  separate ownership/retirement review instead of removing it from state.
  DNS 금지 시 모든 DNS 변경을 차단하고 기존 게시 상태를 유지한다. DNS 허용 여부와
  관계없이 검증 CNAME 폐기/교체 및 관리 인증서 소유권 이전 제한은 유지한다.
- Do not guess a different zone, change delegation, revoke old external certs,
  use self-signed/TLS-bypass options, disable checks, or apply with `-auto-approve`.
  Rollback also needs a reviewed fresh plan that satisfies the same boundaries.
  다른 존 추정, 위임 변경, 기존 외부 인증서 폐기, 자체 서명/TLS 우회, 검사 해제,
  자동 승인을 하지 않는다. 롤백도 같은 제한을 충족하는 새 plan을 검토한다.

Related / 관련: `.github/workflows/terraform.yml`, `scripts/v2/ci_dns_policy.py`,
`scripts/v2/ci_dev_domain.py`, `terraform/foundation/edge.tf`;
ADR-005 (product mutation freeze / 제품 변경 기능 동결), ADR-016 (v2 topology / v2 구성).
