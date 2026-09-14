# Dev domain rollout / 개발 도메인 전환

## Symptoms and scope / 증상과 범위

Use this procedure for an **unpublished dev stack** (no owned service A aliases),
or maintenance of the **same domain**. It does not cover renaming a published domain.
Keep certificate ownership and DNS publication explicit. The parent
operator performs all live checks and dispatches. Examples below use reserved
names; substitute the approved deployment values. This procedure does not grant
permission to change any other domain or parent-zone delegation.

서비스 A 별칭이 없는 **미게시 dev 스택** 또는 **동일 도메인** 유지보수에 사용한다.
게시된 기존 도메인의 이름 변경 절차가 아니다. 실제 조회와 실행은 상위
운영자가 수행한다. 아래 예약 도메인을 승인된 배포 값으로 바꾼다. 다른 도메인이나
상위 존의 NS 위임 변경 권한은 포함하지 않는다.

Dev full dispatches reject an existing published old-domain alias before certificate
lookup, even with `domain_rollout=false`. This also covers a same-name hosted-zone
change. Plan/apply checks use the saved domain/zone inputs and old alias identities,
not current repo overrides or apply toggles. Advisory plans remain report-only;
ordinary same-domain maintenance and certificate-neutral ECR bootstrap remain valid.
Retiring it requires a **separate expressly authorized plan under the old
configuration**, reviewed by that domain's owner. Do not authorize old/parent DNS
changes as a workaround, extend this rollout's allowlist, or force an unknown plan
through the gate. Owned validation-record retirement remains separately governed.

dev full dispatch는 `domain_rollout=false`여도 게시된 이전 도메인 별칭을 인증서 조회
전에 거부하며, 동일 이름의 hosted zone 변경도 포함한다. plan/apply 검사는 저장된
도메인/존 입력과 기존 별칭 식별자를 사용하므로 현재 저장소 변수나 apply 토글로 바뀌지
않는다. 참고 계획은 보고 전용이며, 일반 동일 도메인 유지보수와 인증서에 영향 없는
ECR bootstrap은 계속 가능하다. 삭제하려면 해당 소유자의
**별도 명시적 승인과 이전 설정의 계획**이 필요하다. 이름 변경을 위해 이전/상위 DNS
권한을 넓히거나 미확정 계획을 강제로 통과시키지 않는다. 검증 레코드 폐기도 별도 절차다.

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
The domain must be in the selected zone; active rollout additionally requires every
`extra_domain_aliases` entry to be in that zone. An empty pair keeps names from
protected tfvars. `managed` can also be used with that empty pair.

두 이름은 함께 지정하거나 모두 비운다. 와일드카드, URL, 공백, 포트, 마지막 점이
없는 ASCII 호스트명만 허용한다. 도메인은 지정 존에 속해야 하며 활성 전환에서는
`extra_domain_aliases`도 그 존에 속해야 한다. 두 변수가 없으면 보호된 tfvars의 이름을
유지한다. 이 경우에도 `managed`를 선택할 수 있다.

Only target `dev`, including a PR whose **base** is `dev`, reads these variables.
Main and preview targets ignore them. The workflow rejects a **tracked**
`ci-domain.auto.tfvars.json` before generation; the file is gitignored. It generates
`ci-domain.auto.tfvars.json` before console; both console and plan automatically
load it. Preflight produces `ci-deployment.tfvars.json`, passed explicitly to plan
for certificate nulls/ARNs and the publication flag on dispatch and dev advisory
plans. Generated files are removed even on failure; a rejected tracked override
is preserved for diagnosis. Protected tfvars are never rewritten by this path.

PR의 **대상 브랜치**를 포함하여 `dev`일 때만 적용한다. main/preview에는 적용하지
않는다. 자동 tfvars가 Git 추적 중이면 생성 전에 거부한다. console과 plan은 동일 파일을
읽으며 dispatch와 dev 참고 계획은 인증서·게시 입력 파일도 읽는다. 실패 시 생성 파일은
정리하지만 거부된 추적 파일은 보존한다. 이 경로에서 보호된 tfvars를 재작성하지 않는다.

`domain_rollout` is a **plan-dispatch input**, default `false`. Set it to `true` for
**every domain stage below**; it is accepted only for `dev` / `full`. CI writes the
declared, default-false Terraform metadata variable `ci_domain_rollout` into the
saved plan. Plan and apply derive DNS scoping from that saved boolean, never from
current repo variables or the apply dispatch's `domain_rollout` input.

`domain_rollout`은 기본 `false`인 **plan dispatch 입력**이다. 아래 **모든 도메인 단계**에서
`true`로 지정하며 `dev` / `full`만 허용한다. 기본 false인 Terraform 메타데이터 변수
`ci_domain_rollout`으로 계획에 저장한다. plan/apply 범위 검사는 이 저장값만 사용하며
현재 저장소 변수나 apply의 `domain_rollout` 입력으로 바뀌지 않는다.

## Verify first / 먼저 확인

For an existing domain with issued certificates, DNS registration and a successful
TLS/health check do not establish database, AgentCore, collection or worker readiness.
Complete those separate release checks before claiming deployment completion. The tools
below inspect existing deployment artifacts; they do not add a certless bootstrap mode.

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
   Use `domain_rollout=true`, `allow_dns_changes=false`, `publish_service_dns=false`
   for the initial test on an unpublished stack. A certless stack cannot pass this
   dispatch; first issuance needs the expressly authorized issuance stage below.
   There is no account-wide certificate scan or fallback selection.
   먼저 `preserve`를 선택하고 외부 소유 인증서만 기존 연결 ARN을 명시한다.
   Terraform이 이미 관리하는 인증서는 외부 ARN 입력을 비워 두어 소유권을 유지하며 검증한다.
   미게시 스택의 초기 검증은 `domain_rollout=true`, DNS 허용/게시 false로 실행한다.
   인증서가 없으면 이 dispatch는 실패하며 별도 승인된 최초 발급 단계가 필요하다.
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
Any non-null existing ARN input in protected tfvars, including `""`, also blocks
this mode; an operator must resolve that input separately without exposing the secret.

기존 인증서가 통과하면 `preserve`를 유지한다. 상위 운영자가 SAN 실패를 확인하고
새 발급을 선택하면 `managed`로 전환하고 기존 ARN 입력을 제거한다. 보호된 tfvars에
기존 ARN 입력이 JSON null이 아니면 빈 문자열 `""`도 거부한다. 운영자가 별도로 입력을 정리하되 비밀 내용을
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

An `ecr-bootstrap` plan with **`domain_rollout=false`** and null external-ARN inputs remains certificate-neutral in
either mode, including a fresh stack. It needs no DNS permission and cannot create or
change certificates: the saved-plan check permits only `aws_ecr_repository.web`.
External-ARN conflicts and ownership guards still apply. See the
[ECR bootstrap procedure](dev-repo-setup.md).

`domain_rollout=false`이고 외부 ARN 입력이 비어 있는 `ecr-bootstrap`은 새 스택에서도 두 모드 모두 인증서와 무관하게
실행할 수 있다. DNS 허용이 필요 없으며 저장 계획은 `aws_ecr_repository.web`만 변경할 수
있으므로 인증서를 생성·변경하지 않는다. 외부 ARN 충돌·소유권 검사는 그대로 적용된다.

The table assumes no existing service A aliases. For same-domain maintenance with
published aliases, keep `publish_service_dns=true`; false would request their deletion
when DNS is allowed. Do not use these stages to retire a published old hostname.

아래 표는 서비스 A가 없는 상태를 전제로 한다. 동일 도메인의 기존 게시를 유지하려면
`publish_service_dns=true`를 유지한다. DNS 허용 시 false는 삭제 요청이다.
이 단계로 게시된 이전 호스트를 폐기하지 않는다.

| Stage / 단계 | `plan_scope` | `domain_rollout` (plan only) | `allow_dns_changes` | `publish_service_dns` |
| --- | --- | --- | --- | --- |
| Verify available certificates / 보유 인증서 검증 | `full` | `true` | `false` | `false` |
| Issue/attach certificates, keep A absent / 인증서 발급·연결, A 미게시 | `full` | `true` | `true` | `false` |
| After DB/auth smoke, publish A / DB·인증 검증 후 A 게시 | `full` | `true` | `true` | `true` |

For external reuse, the exact dispatch input names are `existing_cf_certificate_arn`
and `existing_alb_certificate_arn`. Leave both unset for Terraform-owned certificates
or `managed` mode; do not put their ARNs into those inputs.

외부 인증서 재사용 입력은 `existing_cf_certificate_arn`, `existing_alb_certificate_arn`이다.
Terraform 소유 또는 `managed` 모드에서는 두 입력을 비우며 관리 인증서 ARN을 넣지 않는다.

For each stage, dispatch **plan** from `dev`, review its summary and exact saved
plan, then dispatch **apply** from the same branch/SHA with that successful
`plan_run_id` and matching DNS permission/scope. The encrypted saved plan contains
the publication setting; changing inputs or repository variables on the apply
dispatch does not alter it. Create a fresh plan after any intended input change.
PR/push plans remain read-only and **never apply-eligible**. Their DNS allowance is
reporting only, with `ci_domain_rollout=false`. Dev advisory preflight preserves
ownership/publication from state without live ACM, SAN or trust validation, so
bootstrap or a hostname change alone does not require live certificates to plan.
Ownership/retirement guards still apply. Dispatch performs the live validation.

각 단계에서 dev의 plan을 검토한 뒤 같은 브랜치/SHA에서 성공한 `plan_run_id`로
apply한다. apply의 DNS 허용·scope도 일치시킨다. 게시 플래그는 암호화된 저장 plan에
포함되므로 apply 입력이나 저장소 변수 변경으로 plan을 바꾸지 않는다. 입력 변경
시 새 plan을 만든다. PR/push는 읽기 전용이고 **적용할 수 없다**. DNS 허용은 보고용이며
`ci_domain_rollout=false`다. dev 참고 계획은 상태의 소유권·게시를 보존하되 ACM·SAN·신뢰 체인을
실시간 검증하지 않는다. 소유권·폐기 제한은 유지하며 실제 인증서 검증은 dispatch에서 수행한다.

The issuance stage changes validation CNAMEs/TLS consumers while A remains absent.
A standalone [deployment-smoke.mjs](../../scripts/v2/deployment-smoke.mjs) request
checks `/api/health` through CloudFront with service Host/SNI/TLS preserved; that
request alone proves liveness only. Dev [Deploy Web](../../.github/workflows/deploy-web.yml)
requires the [full authenticated runtime gate](runtime-foundation.md#required-development-release-check--개발-배포-필수-검증), not health alone.
Before A publication, complete that guide's runtime adoption, explicit readiness opt-in, migrations
and full verification; `CI_READONLY_RUNTIME_DEV` alone never enables the billed probe.
Its `collect-runtime.yml` prepare mode validates existing web/login/host registration;
it neither bootstraps first web nor proves readiness. New stacks need a separate
reviewed bootstrap procedure; there is no health-only bypass, password reset or admin promotion.
[Deploy AgentCore](../../.github/workflows/deploy-agentcore.yml) runs the reusable
private migration on dev; main/preview retain `make migrate`. Optional
post-provision `smoke=true` requires deployed readiness/inventory dependencies on
dev and remains advisory elsewhere; it is not a web-login test. Follow existing
operator authorization for these actions.

## Inspecting saved artifacts

The branch-independent [exact-plan inspector](dev-repo-setup.md#private-exact-plan-inspection)
and [encrypted failure recovery](dev-repo-setup.md#encrypted-failure-recovery) apply to
main, dev and supported user branches. Use those procedures to review this rollout's
saved artifacts; they do not extend the dev-only domain stages or grant apply authority.

## Boundaries and recovery / 제한과 복구

- **Active domain-rollout** DNS permission covers only canonical `alias` A and `cf_validation` CNAME
  resources for the configured domain/in-zone aliases in the selected child zone.
  It never covers parent NS, unrelated records, new zones, or Cloud Map/registered
  ECS DNS changes. Both before and after values are checked.
  **활성 도메인 전환** DNS 권한은 선택 존의 지정 도메인/별칭 A 및 검증 CNAME에만 적용한다.
  상위 NS, 다른 레코드, 새 존, Cloud Map/등록된 ECS 변경은 허용하지 않는다.
- Ordinary `domain_rollout=false` full plans retain the broad DNS policy, including
  Cloud Map, **only with explicit `allow_dns_changes=true` on plan and apply**.
  The published old-name/old-zone retirement guard still applies to dev plans.
  That option does not authorize old/parent DNS under this runbook.
  일반 full 계획은 `domain_rollout=false`에서 plan/apply 양쪽의 명시적 DNS 허용이 있어야
  Cloud Map을 포함한 기존 광범위 DNS 정책을 사용한다. dev의 게시된 이전 이름/존 삭제
  차단은 계속 적용된다. 이 문서는 이전/상위 DNS를 승인하지 않는다.
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

## Rollback / 롤백

Before A publication, leave A absent and stop the rollout if TLS or required runtime checks
fail. Prepare a fresh same-SHA reviewed plan to restore a supported same-domain
configuration. After publication, unpublishing the **new** service A needs explicit
DNS permission and a scoped reviewed plan. Preserve all Terraform-owned validation
CNAMEs and managed certificate ownership; setting old external ARNs is not a safe
rollback after managed issuance. Any required managed-certificate externalization,
token retirement or old-domain restoration needs a separate expressly authorized
procedure under the appropriate configuration. Never remove resources from state
or accept unknown DNS identities to make rollback pass.

Related: `.github/workflows/terraform.yml`, `scripts/v2/ci_plan_inspect.py`, `scripts/v2/ci_failure_diagnostics.py`, `scripts/v2/ci_dns_policy.py`,
`scripts/v2/ci_dev_domain.py`, `terraform/foundation/edge.tf`;
ADR-005 (AWS-resource mutation + autonomy freeze / AWS 리소스 변경·자율 실행 동결),
ADR-016 (v1 decommission / domain-certificate cutover / v1 폐기·도메인/인증서 전환).
