# CI/OIDC bring-up (single repo) / CI·OIDC 활성화 (단일 리포)

## Related files / 관련 파일

`.github/workflows/{deploy-web,terraform,deploy-agentcore,deploy-migrations}.yml`,
`docs/runbooks/branch-strategy.md`, `.github/workflows/pr-review.yml`,
`scripts/v2/ci_review_access.py`, `scripts/v2/ci_dns_policy.py`, `scripts/v2/ci_plan_context.py`,
`scripts/v2/ci_db_diagnostics.py`, `scripts/v2/test_ci_db_diagnostics.py`,
`scripts/v2/ci_tf_assets.py`, `scripts/v2/ci/pg8000-requirements.txt`,
`scripts/v2/test_ci_tf_assets.py`, `docs/reference/06-workers.md`,
`scripts/v2/deploy.mjs`, `scripts/v2/deployment-smoke.mjs`,
`scripts/v2/prepare-smoke-credentials.mjs`, `scripts/v2/authenticated-smoke.mjs`,
`terraform/foundation/outputs.tf` (`demo_username`),
`scripts/v2/ci/run-migration.mjs`, `terraform/foundation/ci-migrations.tf`,
`terraform/foundation/tests/dns_deferred.tftest.hcl`, `docs/reference/01-edge-network.md`,
`docs/reference/03-data-aurora.md`

> Historical note: this file previously described the two-repo split
> (`Atom-oh/sample-awsops-dev`). The project consolidated into the single public
> repo `aws-samples/sample-awsops` (all branches public by design — see
> branch-strategy.md); the private repo is retired/archived.
> (과거 2-리포 분리 시절의 문서였으며, 단일 공개 리포로 통합되었습니다. 비공개 dev
> 리포는 은퇴/아카이브 대상입니다.)

## Symptoms / 증상

- A `dev` push run fails at *Configure AWS credentials* with
  `Not authorized to perform sts:AssumeRoleWithWebIdentity`, or
- it fails at *Restore terraform.foundation backend* with
  `this branch's TF backend secrets are not set`, or
- a preview dispatch fails the same way for `TF_*_PREVIEW_<USER>`, or
- the deploy job's *Pin web-latest* step fails with an ECR `AccessDenied`, or
- AI review waits for a protected-environment approval or fails `AssumeRoleWithWebIdentity`, or
- `Deployment preflight refused`, `DNS change prohibited`, or an unavailable certificate stops
  a dispatch (§5), or
- saved-plan apply reports `branch moved` / an advisory push-plan event (§5), or
- the build reports `Cannot access the web ECR repository` (§4–5), or
- `Demo credential preparation` or `Authenticated smoke` fails (see authenticated database
  verification and [optional manual DB diagnostics](#dev-db-diagnostics)).

(dev push 런이 자격증명/시크릿/ECR pin 단계에서 실패하는 경우 — 아래 1회성 작업이
아직 안 된 것입니다. AI 리뷰가 보호 환경 승인 대기 또는 역할 인증 실패로 멈추는 경우도 포함합니다.
`Demo credential preparation`·`Authenticated smoke` 실패는 아래 인증된 DB 검증 절과
[선택적 수동 DB 진단](#dev-db-diagnostics)을 참고합니다.)

## Cause / 원인

The five sections below cover runner/identity/configuration prerequisites, ECR access,
and deployment with DNS deferred. Missing issued certificates, a DNS-changing plan,
or a moved branch intentionally stop the deployment.
(아래 다섯 절은 러너·권한·설정·ECR 및 DNS 보류 배포를 다룹니다. 유효한 인증서 부재,
DNS 변경 계획 또는 브랜치 이동은 의도적으로 배포를 중단합니다.)

## Action / 조치

### 1. Runner / 러너

The `sample-awsops` self-hosted runner is already registered to this repo (it has
been running the main-branch pipelines). Nothing to do unless runs queue forever.
(러너는 이미 이 리포에 등록돼 있습니다 — 런이 무한 대기할 때만 재확인.)

### 2. CI roles + GitHub OIDC trust matrix / CI 역할·신뢰 매트릭스

All roles live in the samples deployment account and trust the GitHub OIDC
provider with a `sub` condition — never the repo-wide `:*` wildcard, which would
let ANY branch (including an experiment branch with an edited workflow) assume the
mutation roles. Role-to-sub matrix:

| Role | Used by | Trust `sub` | Permissions scope |
|---|---|---|---|
| `sample-awsops-ci-build` | main build (no environment) | StringEquals `repo:aws-samples/sample-awsops:ref:refs/heads/main` | prod ECR push |
| `sample-awsops-ci-deployer` | main roll / apply / agentcore (jobs carry `environment: production`) | StringEquals `repo:aws-samples/sample-awsops:environment:production` | prod ECS/ECR-pin/apply |
| `sample-awsops-dev-ci-build` | dev + user-branch builds (no environment) | StringLike, one entry per branch: `...:ref:refs/heads/dev`, `...:ref:refs/heads/atomoh`, `...:ref:refs/heads/ssminji`, `...:ref:refs/heads/whchoi` | dev + user stacks' ECR push |
| `sample-awsops-dev-ci-deployer` | dev + user-branch rolls, dev apply/agentcore (jobs carry `environment: development`) | StringEquals `repo:aws-samples/sample-awsops:environment:development` | dev + user stacks' ECS/ECR-pin/apply — **never production** |
| `sample-awsops-ci-terraform-plan` | plan (PR/push incl. user-branch own-stack plans, read-only) | StringLike: `...:pull_request` + refs `main`, `dev`, `atomoh`, `ssminji`, `whchoi` | ReadOnlyAccess |
| `sample-awsops-ci-review` | AI pr-review | StringEquals: verified subject prefix + environments `ci-review-auto` / `ci-review-recovery`, or legacy refs `main` / `dev`; no bare `pull_request` subject | Bedrock / Mantle policies — inspect actual permissions before approval |

CRITICAL sub rule: **a job that declares `environment:` presents the
`repo:<owner>/<repo>:environment:<name>` sub — NOT its branch ref.** Deployer
roles must therefore trust the environment sub (pinning them to a branch ref
makes every deploy fail AssumeRoleWithWebIdentity). Which branches can reach an
environment is enforced by the environment's own deployment branch policy
(`production` → main only; `development` → dev, atomoh, ssminji, whchoi).
Build/plan jobs carry no environment and present branch-ref subs. Fork PRs can
never mint tokens (GitHub withholds id-token from forks) and `terraform.yml`
skips non-same-repo PRs outright.
(`environment:`가 선언된 잡의 OIDC sub는 브랜치 ref가 아니라 `environment:<이름>`
입니다 — deployer 역할 신뢰는 environment sub로, 브랜치 제한은 environment의
deployment branch policy로 거는 것이 올바른 구성입니다.)

The former `sample-awsops-dev-ci-preview` role and `deploy-preview.yml` are
RETIRED — user branches are standing branches with continuous deploy, covered by
the dev-tier roles above. (구 preview 역할·워크플로는 은퇴 — 사용자 브랜치가 상시
브랜치가 되면서 dev-tier 역할이 담당합니다.)

#### Review CI protection and recovery / 리뷰 CI 보호·복구

Recovery approval is enforced by GitHub environments, outside PR-controlled code. A
`ci-review:<full HEAD SHA>` label only selects a commit; it is not authorization by itself.

| Environment | Required control | Allowed execution refs |
|---|---|---|
| `ci-review-auto` | Custom branch policy; admin bypass disabled | `dev`, `main` |
| `ci-review-recovery` | A named repository operator as required reviewer; admin bypass disabled | The specific recovery PR, e.g. `refs/pull/41/merge` |

GitHub evaluates environment branch rules against the actual execution ref. A
`pull_request` job uses `refs/pull/<number>/merge`; a `pull_request_target` job uses the
trusted default-branch ref. A feature PR cannot select `ci-review-auto` to avoid approval.
The recovery job must wait for a listed reviewer before checkout or credential issuance.
Self-review prevention is false so a designated operator may initiate and explicitly
approve their own repair; an ordinary PR author who is not that reviewer cannot approve it.

The AWS trust policy must allow only the exact repository's protected environment
subjects (plus the trusted legacy `dev`/`main` ref subjects). Remove coarse
`...:pull_request` and wildcard repository subjects: otherwise head code could omit the
environment and request credentials directly. This role is managed outside the application
Terraform root; coordinate its trust update with that owner rather than importing a second
copy of the resource into application state. Permission policies are a separate boundary:
inspect inline policies, attachments, and any permissions boundary, including Mantle
permissions; do not infer privileges from the policy's name.

**Merge prerequisite — complete the external rollout before merging or enabling this
workflow. GitHub automatically creates a referenced missing environment with no protection
rules. A workflow reference or a successful YAML check is not proof of protection.**
Read back both environments, reviewers, exact allowed refs and disabled bypass; compare
the live IAM trust with the reviewed plan immediately before merge. Stop the merge if any
control is absent or different. Head-controlled workflow checks cannot replace this step.

**머지 선행 조건 — 워크플로 머지·활성화 전에 외부 보호 설정을 완료해야 합니다.**
GitHub는 참조된 환경이 없으면 보호 규칙 없는 환경을 자동 생성합니다. YAML에 환경 이름이
있다는 것만으로 보호가 보장되지 않습니다. 머지 직전에 두 환경·승인자·정확한 실행 ref·우회
금지와 실제 IAM 신뢰를 다시 읽어 계획과 대조하고, 누락·차이가 있으면 머지를 중단합니다.

**Prepare and verify the external controls:**

1. Read the current role trust/permission policies and GitHub OIDC configuration. Keep the
   originals private for comparison and rollback. Use the API's `sub_claim_prefix` when
   immutable subjects are enabled — the prefix contains owner/repository IDs. Do not turn
   off immutable subjects or replace the IDs with a broad wildcard. The planner requires
   explicit boolean `use_immutable_subject` and string `sub_claim_prefix` fields from the
   API readback. If they are absent, this planner procedure is unsupported on that
   installation: stop before generating/applying a plan and obtain a supported API
   readback from the GitHub administrator. Do not manually complete or edit `oidc.json`,
   infer a legacy format, or continue with an older saved plan. The apply-time equality
   check deliberately requires the original, unmodified API response.
2. Generate a local plan with `scripts/v2/ci_review_access.py`. It makes no API writes,
   preserves existing explicit denies, and refuses unrecognized trust relationships or
   additional restrictions instead of silently dropping them. Review the complete plan.
3. Apply both environment settings and their exact branch policies. Read them back and
   verify the reviewer, disabled bypass, and allowed refs. Only then apply the generated
   trust policy to the dedicated CI review role; keep permission policies unchanged.
4. Read back the IAM policy and compare it with the plan. Verify there is no direct
   `pull_request` or wildcard-repository allow. Validate the policy with IAM Access Analyzer.

(아래 명령은 한 셸에서 순서대로 실행합니다. OIDC 형식 필드가 누락된 설치는 이 계획
절차의 지원 대상이 아니므로 적용 전에 중단합니다. GitHub 관리자에게 지원되는 API 응답을
확보하며, `oidc.json`을 수작업으로 보완하거나 이전 계획을 재사용하지 않습니다. 적용 단계는
원본 API 응답이 그대로 유지되는지 의도적으로 검사합니다.)

```bash
set -euo pipefail
umask 077
# These files are private operator artifacts, not committed credentials/config dumps.
CI_ACCESS_DIR=$(mktemp -d)
chmod 700 "$CI_ACCESS_DIR"
aws --profile samples iam get-role --role-name sample-awsops-ci-review --query Role.AssumeRolePolicyDocument --output json > "$CI_ACCESS_DIR/trust.json"
aws --profile samples iam list-role-policies --role-name sample-awsops-ci-review
aws --profile samples iam list-attached-role-policies --role-name sample-awsops-ci-review
# Inspect every returned permission document (get-role-policy/get-policy-version).
gh api repos/aws-samples/sample-awsops/actions/oidc/customization/sub > "$CI_ACCESS_DIR/oidc.json"
read -r -p "Designated GitHub reviewer numeric ID: " CI_REVIEWER_ID
read -r -p "Recovery PR number: " REVIEW_PR
python3 scripts/v2/ci_review_access.py --trust-file "$CI_ACCESS_DIR/trust.json" --repository aws-samples/sample-awsops --oidc-config-file "$CI_ACCESS_DIR/oidc.json" --reviewer-id "$CI_REVIEWER_ID" --recovery-pr "$REVIEW_PR" --output "$CI_ACCESS_DIR/plan.json"
```

**Apply and read back the reviewed plan. Never update IAM trust before both environments
exist with the exact protections.** This procedure replaces stale branch-policy entries;
repeat it with a newly generated plan for each later recovery PR. It makes no permission-
policy changes. Coordinate with other operators before running it.

**검토한 계획을 적용하고 재확인합니다. 두 환경의 정확한 보호 설정을 검증하기 전에는
IAM 신뢰를 변경하지 않습니다.** 이전 복구 PR의 브랜치 규칙은 교체되므로, 다음 장애 때도
새 PR 번호로 계획을 다시 생성·검토하고 이 절차를 반복합니다. 권한 정책은 변경하지 않습니다.

```bash
python3 - "$CI_ACCESS_DIR" <<'PYAPPLY'
import json, subprocess, sys, time
from pathlib import Path
root = Path(sys.argv[1])
plan = json.loads((root / "plan.json").read_text())
original = json.loads((root / "trust.json").read_text())
repo, role = "aws-samples/sample-awsops", "sample-awsops-ci-review"
def call(command, body=None):
    result = subprocess.run(command, input=json.dumps(body) if body is not None else None,
                            text=True, capture_output=True, check=True)
    return json.loads(result.stdout) if result.stdout.strip() else None
def gh(path, method=None, body=None):
    args = ["gh", "api", path]
    if method: args += ["--method", method]
    if body is not None: args += ["--input", "-"]
    return call(args, body)
def aws(*args):
    return call(["aws", "--profile", "samples", *args, "--output", "json"])
def trust_now():
    return aws("iam", "get-role", "--role-name", role)["Role"]["AssumeRolePolicyDocument"]
assert trust_now() == original, "Trust changed after planning; regenerate and review"
assert gh(f"repos/{repo}/actions/oidc/customization/sub") == json.loads((root / "oidc.json").read_text())
assert set(plan["environments"]) == {"ci-review-auto", "ci-review-recovery"}
for name, spec in plan["environments"].items():
    path = f"repos/{repo}/environments/{name}"
    gh(path, "PUT", spec["settings"])
    desired = {(item["name"], item["type"]) for item in spec["branch_policies"]}
    current = gh(path + "/deployment-branch-policies")["branch_policies"]
    for old in current:
        if (old["name"], old["type"]) not in desired:
            gh(path + f"/deployment-branch-policies/{old['id']}", "DELETE")
    existing = {(item["name"], item["type"]) for item in current}
    for item in spec["branch_policies"]:
        if (item["name"], item["type"]) not in existing:
            gh(path + "/deployment-branch-policies", "POST", item)
    env = gh(path)
    branches = gh(path + "/deployment-branch-policies")["branch_policies"]
    assert env.get("can_admins_bypass") is False
    assert env["deployment_branch_policy"] == spec["settings"]["deployment_branch_policy"]
    assert {(item["name"], item["type"]) for item in branches} == desired
    rules = [r for r in env["protection_rules"] if r["type"] == "required_reviewers"]
    expected = spec["settings"].get("reviewers", [])
    if expected:
        assert len(rules) == 1 and rules[0]["prevent_self_review"] is False
        assert {(r["type"], r["reviewer"]["id"]) for r in rules[0]["reviewers"]} == {(r["type"], r["id"]) for r in expected}
    else:
        assert not rules
    (root / f"{name}-readback.json").write_text(json.dumps(env, indent=2))
# Only after all external GitHub protections were read back successfully:
assert trust_now() == original, "Concurrent trust change; do not overwrite it"
policy_file = root / "desired-trust.json"
policy_file.write_text(json.dumps(plan["trust_policy"], indent=2))
validation = aws("accessanalyzer", "validate-policy", "--region", "us-east-1",
                 "--policy-document", f"file://{policy_file}", "--policy-type", "RESOURCE_POLICY",
                 "--validate-policy-resource-type", "AWS::IAM::AssumeRolePolicyDocument")
assert not any(f["findingType"] in ("ERROR", "SECURITY_WARNING") for f in validation["findings"]), validation
# Review other warnings; environment subjects rely on the verified GitHub branch rules.
(root / "policy-validation.json").write_text(json.dumps(validation, indent=2))
aws("iam", "update-assume-role-policy", "--role-name", role,
    "--policy-document", f"file://{policy_file}")
for attempt in range(5):
    after = trust_now()
    if after == plan["trust_policy"]: break
    time.sleep(2)
else:
    raise RuntimeError("Readback differs; investigate before running CI")
(root / "trust-readback.json").write_text(json.dumps(after, indent=2))
print("Environment protections and exact IAM trust verified; originals retained locally.")
PYAPPLY
```

After the controls are verified, independently review the exact recovery commit before
labeling. A recovery run executes that commit's CI scripts with model and PR-comment
permissions; it cannot independently certify its own script integrity. A listed operator
must also approve the pending `ci-review-recovery` environment in GitHub, after checking the
run and live PR still refer to the reviewed SHA. Use the normal required-review approval,
never an administrator bypass. One-time authorization belongs in the PR/audit trail,
not in this runbook as standing approval.

```bash
read -r -p "Full commit SHA you independently reviewed: " REVIEW_HEAD
[[ "$REVIEW_HEAD" =~ ^[0-9a-f]{40}$ ]] || exit 1
LIVE_HEAD=$(gh pr view "$REVIEW_PR" -R aws-samples/sample-awsops --json headRefOid --jq '.headRefOid')
[ "$LIVE_HEAD" = "$REVIEW_HEAD" ] || { echo "HEAD changed; review the new commit first"; exit 1; }
printf 'Execute reviewed CI code at %s for PR %s\n' "$REVIEW_HEAD" "$REVIEW_PR"
read -r -p "Type approve to select this exact commit: " REVIEW_APPROVAL
[ "$REVIEW_APPROVAL" = approve ] || exit 1
if ! gh api "repos/aws-samples/sample-awsops/labels/ci-review:$REVIEW_HEAD" >/dev/null 2>&1; then
  gh label create "ci-review:$REVIEW_HEAD" -R aws-samples/sample-awsops --color 1D76DB --description 'Select this reviewed CI recovery commit'
fi
gh pr edit "$REVIEW_PR" -R aws-samples/sample-awsops --add-label "ci-review:$REVIEW_HEAD"
# In Actions, approve the pending ci-review-recovery environment for this exact run/SHA.
```

The prefix plus SHA reaches GitHub's 50-character label limit. A new commit needs a new
matching label and environment approval. After merging the repair, update dependent PRs
against `dev`; normal reviews run through `ci-review-auto` without manual approval.


After merging or abandoning a recovery PR, remove its SHA label from that PR. For another
incident, regenerate the access plan for the new PR and replace the recovery branch rule;
do not accumulate allowed PR refs. Retain the environment/reviewer gate and exact IAM
subjects. Remove a repository label only after confirming no other PR uses it.

복구 PR을 머지하거나 중단한 뒤 해당 SHA 라벨을 제거합니다. 다음 장애는 새 PR 번호로
계획을 다시 생성하고 이전 실행 ref를 교체합니다. 허용 PR ref를 누적하거나 보호 환경을
해제하지 않습니다. 저장소 라벨 삭제 전에는 다른 PR에서 사용하지 않는지 확인합니다.

```bash
gh pr edit "$REVIEW_PR" -R aws-samples/sample-awsops --remove-label "ci-review:$REVIEW_HEAD"
gh pr list -R aws-samples/sample-awsops --state all --label "ci-review:$REVIEW_HEAD"
# Only when unused:
# gh label delete "ci-review:$REVIEW_HEAD" -R aws-samples/sample-awsops --yes
```

Automatic CI code is selected from immutable `github.sha`, while the panel and chair read source
context from a separate target-base worktree. Since **2025-12-08**, `pull_request_target`
uses the default branch for its workflow, `GITHUB_REF`, and `GITHUB_SHA` regardless of PR
target. See [GitHub's platform announcement](https://github.blog/changelog/2025-11-07-actions-pull_request_target-and-environment-branch-protections-changes/),
[environment protection rules](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments), and
[immutable OIDC subjects](https://docs.github.com/en/actions/reference/security/oidc).
The workflow gives every Codex and Claude panel lens (L2–L5) two 1200-second attempts.
The panel and chair have a 10-second hard-kill grace. The job ceiling is 90 minutes.
After Git/CLI/prompt preparation,
immediately before the panel and again immediately before chair synthesis, the same OIDC
role obtains a fresh one-hour session; its permissions and maximum session duration
are unchanged. Failed or timed-out chair output cannot supply a successful verdict.
Missing/failed model cells remain blocking; all four lenses need both vendors.

(워크플로에서 Codex와 Claude 패널의 모든 렌즈(L2–L5)는 1200초씩 최대 두 번 실행합니다.
패널과 종합 판정에는 10초의 강제 종료 유예를 적용하며 작업 전체 한도는 90분입니다.
Git·CLI·프롬프트 준비가 끝난 뒤 패널 직전과 종합 판정 직전에 각각 같은 OIDC 역할의
1시간 세션을 새로 발급하고 역할 권한·최대 세션 기간은
변경하지 않습니다. 실패하거나 시간 초과된 종합 응답은 성공 판정으로 인정하지 않으며,
모든 렌즈에서 두 공급자의 검토가 완료되어야 합니다.)

(복구 라벨은 커밋 선택이며 권한 승인은 GitHub 보호 환경에서 강제합니다. 자동 환경은
`dev`·`main`만 허용하고 복구 환경은 해당 PR 실행 ref와 지정 리뷰어만 허용합니다.
OIDC 불변 ID를 보존한 정확한 환경 주체만 AWS 역할에 허용하며, 환경을 생략한 PR이
역할을 얻지 못하도록 포괄 `pull_request` 신뢰를 제거합니다. 설정·권한을 실행 시점에
확인하고, 독립 검토한 SHA의 환경 승인을 정상 절차로 수행합니다.)

### 3. Per-stack terraform secrets / 스택별 TF 시크릿

Each stack pair is provisioned under the repo's terraform discipline — a saved plan
applied verbatim, never `-auto-approve`:

```bash
terraform -chdir=terraform/foundation init -backend-config=backend.hcl
terraform -chdir=terraform/foundation plan -out tfplan   # review the plan
terraform -chdir=terraform/foundation apply tfplan       # apply EXACTLY that plan
```

Sensitive-value policy (public repo — Actions LOGS are public): role ARNs and
anything carrying the account id live in repo **secrets** (auto-masked in
logs), never variables; every credentials step sets `mask-aws-account-id`.
Cognito users: dev/preview stacks get the shared regular **demo user**
(`demo_email` defaults to `demo@awsops.local`; its password rides as the
`TF_VAR_DEMO_PASSWORD` repo secret, bound as `TF_VAR_demo_password` only in
Terraform's plan step and Deploy Web's opt-in private credential-preparation step).
`create_demo_user` defaults to
**false** (fail-closed): a dev-tier stack opts in with `create_demo_user =
true` in its tfvars blob, so the shared credential can never reach a stack —
production foremost — by omission. A stack may instead override
`demo_password` in its own blob (the blob is itself a secret; tfvars outranks
env, so the override is the sanctioned per-stack path). **Admin users are not
Terraform-managed at all** (a TF-managed admin would need a password channel
through CI plans, and a locally-applied one would ping-pong into a destroy on
the next CI plan via the shared remote state). Provision an admin per stack
out-of-band, with per-stack credentials — never a repo-wide shared pair:

```bash
aws cognito-idp admin-create-user --user-pool-id <pool-id> \
  --username <email> --user-attributes Name=email,Value=<email> Name=email_verified,Value=true \
  --message-action SUPPRESS
aws cognito-idp admin-set-user-password --user-pool-id <pool-id> \
  --username <email> --password '<per-stack password>' --permanent
aws cognito-idp admin-add-user-to-group --user-pool-id <pool-id> \
  --username <email> --group-name admins
```

Only admins (the Cognito `admins` group, or the SSM email allowlist) see
IAM-related views. `admin_password` must NOT sit in any registered tfvars
blob — the restore step hard-fails on it (`admin_email` alone is fine: it is
not a secret, and `k8sgpt_enabled` stacks need it in tfvars for the budget
alarm subscriber). Stacks provisioned before this policy carried a TF-managed
admin user: the first post-merge plan proposes destroying it — that removal
is intentional (recreate via the CLI above when the stack actually needs an
admin).

⚠️ Identity caveat: app ownership (reports, chat threads, …) is keyed by the
Cognito `sub`, which is minted per user object — deleting and recreating a
user yields a NEW `sub`, so rows owned by the old identity do not follow it.
Only the legacy verified-email read path bridges some tables. Two distinct
situations:

- **TF-managed admin about to be destroyed by the config removal above**: the
  apply WILL delete the user object; disabling cannot stop a planned destroy.
  To keep the identity (and its `sub`) alive on a stack with real user-owned
  data, detach it from state BEFORE the first post-merge apply:
  `terraform -chdir=terraform/foundation state rm 'aws_cognito_user.admin'` —
  Terraform then forgets the
  resource without touching the live user. Skip this on stacks with nothing
  to preserve and let the apply delete it.
- **Manually-provisioned users** (the CLI flow above): to revoke access,
  prefer `admin-disable-user` over delete/recreate — deletion is identity
  loss.

(TF-관리 admin은 다음 apply가 반드시 삭제합니다 — 보존하려면 apply 전에
`terraform -chdir=terraform/foundation state rm 'aws_cognito_user.admin'`으로
상태에서만 떼어냅니다.
disable은 삭제를 막지 못하며, 수동 생성 사용자에 대한 접근 차단 수단입니다.)
The plan artifact is a covered channel too: a tfplan embeds every variable
value in plaintext and public-repo artifacts are downloadable by anyone, so
the plan job encrypts it with the `TF_PLAN_ENC_KEY` secret (fail-closed) and
the apply job decrypts before applying.
(공개 리포는 Actions 로그도 공개 — 역할 ARN 등 계정 ID 포함 값은 변수 금지·시크릿
전용. demo 사용자 비밀번호는 `TF_VAR_DEMO_PASSWORD` 시크릿으로 공급하되 production은
`create_demo_user=false` 또는 자체 tfvars 블롭의 `demo_password` override로 공유
자격을 거부합니다. admin 사용자는 Terraform 관리 밖입니다 — 스택별로 위
`admin-create-user` CLI 3종으로 만들고 `admins` 그룹에 넣습니다. 기존 스택의
TF-관리 admin은 머지 후 첫 plan에서 삭제로 표시되며, 이는 의도된 제거입니다.)

Then register the generated files (base64) as repo secrets:

| Stack | Secrets |
|---|---|
| all stacks (repo-wide) | `TF_PLAN_ENC_KEY` (plan-artifact encryption and private asset HMAC; rotation invalidates signed bundles) / `TF_VAR_DEMO_PASSWORD` (demo user) / role-ARN secrets `AWS_CI_BUILD_ROLE_ARN` · `AWS_CI_BUILD_DEV_ROLE_ARN` · `AWS_CI_DEPLOYER_ROLE_ARN` · `AWS_CI_DEPLOYER_DEV_ROLE_ARN` · `AWS_CI_TERRAFORM_PLAN_ROLE_ARN` · `AWS_CI_REVIEW_ROLE_ARN` (moved from repo variables — public-repo logs never mask variables) |
| production (`main`) | `TF_BACKEND_HCL` / `TF_TFVARS` |
| dev (`awsops-dev.whchoi.net`) | `TF_BACKEND_HCL_DEV` / `TF_TFVARS_DEV` / `AWS_ACCOUNT_ID_DEV` (required configured account for migrations, runtime image builds and provisioning; secret, not variable) |
| user branch `atomoh`/`ssminji`/`whchoi` (`<user>.awsops-dev.whchoi.net`) | `TF_BACKEND_HCL_PREVIEW_<USER>` / `TF_TFVARS_PREVIEW_<USER>` (uppercased branch name) |

```bash
gh secret set TF_BACKEND_HCL_DEV -R aws-samples/sample-awsops \
  --body "$(base64 -w0 terraform/foundation/backend.hcl)"
gh secret set TF_TFVARS_DEV -R aws-samples/sample-awsops \
  --body "$(base64 -w0 terraform/foundation/terraform.tfvars)"
```

The secret `AWS_ACCOUNT_ID_DEV` is required for configured development and preview stacks.
The configured role and STS caller must match it before AWS reads/writes. A missing backend
may skip an advisory plan; missing account verification on a configured stack fails.
개발·preview 스택이 구성되어 있으면 `AWS_ACCOUNT_ID_DEV` 시크릿이 필수입니다.
backend 미설정 계획은 생략할 수 있지만 구성된 스택의 계정 검증 누락은 실패합니다.

#### Development variable catalog / 개발 변수 목록

Nonsecret dev repository variables are `DOMAIN_NAME_DEV` / `HOSTED_ZONE_NAME_DEV` (paired names),
`CERTIFICATE_MODE_DEV` (`preserve` by default), `CI_MIGRATIONS_ENABLED_DEV` (`false` by default),
and `CI_DB_DIAGNOSTICS_DEV` (`false`/unset by default; manual advisory read-only diagnostics only).
Runtime activation also uses default-off `CI_READONLY_RUNTIME_DEV` and verified
`STEAMPIPE_IMAGE_DIGEST_DEV` / `WORKER_IMAGE_DIGEST_DEV`. These select reviewed deployment
behavior; account identifiers and credentials stay in secrets. Full activation requires
real login/DB/host-registry preflight. Verifier-group provisioning belongs to the later
full-release integration and is not granted by this foundation change.
런타임 활성화에는 기본 비활성 `CI_READONLY_RUNTIME_DEV`와 검증된 두 이미지 digest
변수를 추가로 사용하며 계정 식별자와 자격증명은 시크릿에 둡니다.
dev의 일반 저장소 변수는 도메인/존 이름 쌍, 기본 `preserve`인 인증서 모드, 기본 `false`인
`CI_MIGRATIONS_ENABLED_DEV`, 기본 `false`/미설정인 참고용 읽기 전용 진단 변수
`CI_DB_DIAGNOSTICS_DEV`이다. 배포·관측 선택값이며 자격증명은 위 시크릿에 유지한다.
`AWS_ACCOUNT_ID_DEV` is a required repository **secret** for both migration jobs,
runtime image builds and dev AgentCore provisioning. No variable/default-account fallback exists.
It must match the configured role accounts and actual STS callers; this agreement is not proof
of effective permissions or an independent classification of the account as development.
`AWS_ACCOUNT_ID_DEV`는 migration 양쪽 job·런타임 이미지 빌드·dev AgentCore provisioning의
필수 저장소 **시크릿**이다. 변수나 기본 계정으로 대체하지 않는다. 설정 역할과 실제 STS
계정이 일치해야 하며, 일치 자체가 유효 권한이나 개발 계정 여부를 증명하지는 않는다.

The distinct NAMES are the isolation: a dev/preview job can never fall back to the
production pair. From then on, terraform changes flow through `terraform.yml`.
Automatic PR/push plans are advisory. Apply requires a successful explicit `mode=plan`
dispatch at the same repository, branch and SHA, followed by `mode=apply` with its run ID,
gated by the branch's environment (`production` carries the reviewer approval). See §5
for DNS restrictions; the manual Terraform commands above alone do not enforce them.
(시크릿 이름 분리가 격리 그 자체입니다 — dev/preview 잡은 production 시크릿으로
폴백할 수 없습니다. 이후 변경은 terraform.yml로: PR/push 자동 plan, dispatch
계획은 참고용이며, 적용은 같은 브랜치·SHA의 성공한 명시적 plan dispatch만 허용합니다.
main은 production environment 승인 게이트가 추가됩니다. DNS 제한은 §5를 따릅니다.)

<a id="dev-db-diagnostics"></a>

#### Optional database diagnostics / 선택적 DB 진단

For a failed authenticated DB check, temporarily set `CI_DB_DIAGNOSTICS_DEV=true` and manually
dispatch the Terraform workflow (`workflow_dispatch`, `mode=plan`, branch `dev`).
Automatic PR/push plans never run diagnostics. The step and helper require the manual event,
the literal flag value `true`, and `--target dev`; the supported region is `ap-northeast-2`.
Comparing the persisted-state account with STS is a consistency check: it does not detect
a wrong stack in the same account or provide authorization. The helper uses
the existing read-only plan role and a fixed CLI operation allowlist, with no new IAM grants,
resource writes, database connection, or apply step. It runs **after encrypted plan upload**,
when the plaintext plan has been removed. Only this advisory step has
`continue-on-error` and an eight-minute timeout. Its failure does not fail an otherwise valid
plan; the Terraform plan, DNS checks, artifact protection, CI and readiness gates remain required.
Enabling the flag and dispatching the plan publishes the safe JSON projection, including
configuration booleans, in the **public Actions job log and fenced step summary**.
Unset the variable or set it to `false` after diagnosis.
Interpreting the sample requires a known authenticated DB probe within its returned one-hour
window. Dispatch within one hour of that probe and check its timestamp against the returned
bounds; otherwise repeat the existing authorized probe before collecting a new sample.

인증된 DB 검사 실패 시 `CI_DB_DIAGNOSTICS_DEV=true`를 임시로 설정하고 Terraform workflow를
수동 실행한다(`workflow_dispatch`, `mode=plan`, `dev` 브랜치). 자동 PR/push plan은 진단을 실행하지
않는다. 단계와 helper 모두 수동 이벤트·정확한 `true`·`--target dev`를 요구하며 지원 리전은
`ap-northeast-2`다. 저장된 상태 계정과 STS 비교는 일관성 검사이며 같은 계정의 잘못된 스택을
식별하거나 권한을 부여하지 않는다. 기존 읽기 전용 plan 역할과 고정 CLI 허용 목록만 사용한다.
새 IAM 권한·리소스 변경·DB 연결·apply 단계는 없다. **암호화 plan 업로드 후** 평문 plan이 삭제된
상태에서 실행한다. 이 참고용 단계에만 `continue-on-error`와
8분 제한을 적용하므로 진단 실패가 유효한 plan을 실패시키지 않는다. Terraform plan, DNS 검사,
아티팩트 보호, CI·준비 상태 검사는 계속 필수다. 플래그를 켜고 수동 실행하면 구성 boolean을 포함한
안전한 JSON을 **공개 Actions 작업 로그와 코드 블록 형식의 step summary**에 게시한다.
진단 후 변수를 지우거나 `false`로 바꾼다.
표본을 해석하려면 반환된 1시간 범위 안에 수행한 인증된 DB probe가 있어야 한다. probe 후 1시간
안에 수동 실행하고 시각이 반환된 범위에 포함되는지 확인한다. 범위 밖이면 기존 승인된 probe를
다시 수행한 뒤 새 표본을 수집한다.

The output has independent `logs`, `configuration`, `server_logs`, and `rds_metrics` sections.
Each reports `status=available|partial|unavailable`; a missing log group, cluster, service,
or inline role policy does not discard other successful reads. A truncated/failed read with
retained data is partial; malformed web records/timings also mark that sample partial.
Configuration fields with missing inputs are `null`. `sources_unavailable` describes source
reads, while `derived_unavailable` marks comparisons/counts that cannot be computed, even if
one of their source reads succeeded. Zero counts in **any status, including available,**
are not proof of no errors or a healthy database. `logs.no_matching_events` means no accepted
matching events in the returned pages (`null` if no page was read).
`logs.no_error_inference=true` explicitly prohibits an error-free/healthy inference.
Only fixed labels, booleans, bounded metric values,
counts and timestamps are published; raw messages, resource names/ARNs, host details and
credentials are withheld. Terraform stderr is discarded for this step; AWS error details
are captured and replaced with safe availability indicators.
An early source/flag/target, input, region or identity failure instead returns only
`{"status":"unavailable"}` and a nonzero helper exit; the four sections are absent.
Invalid invocation context or region is rejected before the helper calls AWS.
A programming violation of the read-only allowlist instead adds the fixed
`reason="read_only_violation"` and exits nonzero; partial-read handlers do not swallow it.

출력의 `logs`, `configuration`, `server_logs`, `rds_metrics`는 독립적이며 각각
`status=available|partial|unavailable`을 표시한다. 로그 그룹·클러스터·서비스·inline 역할
정책이 없더라도 다른 성공 결과는 유지한다. 일부 데이터가 남은 조회 제한/실패는 partial이며
잘못된 웹 기록/timing도 해당 표본을 partial로 표시한다. 입력이 부족한 구성 필드는 `null`이다.
`sources_unavailable`은 소스 조회를, `derived_unavailable`은 일부 조회가 성공했더라도
계산할 수 없는 비교/건수를 구분한다. **available을 포함한 모든 상태**에서 0건은 오류가 없거나
DB가 정상이라는 증거가 아니다. `logs.no_matching_events`는 읽은 페이지에 유효한 대상 이벤트가
없다는 뜻이며 페이지를 읽지 못했으면 `null`이다. `logs.no_error_inference=true`는 오류 없음/정상
추론을 명시적으로 금지한다. 고정 분류·boolean·범위가 제한된 지표 값·건수·시각만 공개하며 로그 원문·리소스 이름/ARN·호스트 상세·자격증명은
숨긴다. 이 단계의 Terraform stderr는 폐기하고 AWS 오류 상세는 안전한 가용성 표시로 대체한다.
초기 이벤트/플래그/대상·입력·리전·identity 실패는 네 절 없이 `{"status":"unavailable"}`만
출력하며 helper는 nonzero로 종료한다. 잘못된 실행 맥락이나 리전은 helper의 AWS 호출 전에 거부한다.
읽기 전용 허용 목록을 위반한 코드 오류는 고정 `reason="read_only_violation"`을 추가하고
nonzero로 종료하며 부분 조회 처리기가 이를 숨기지 않는다.

**Web logs:** `logs` uses a JSON `evt` OR filter for `db_ping_failed` and
`db_connection_failed` in the selected web log group over
`[window_start_ms, window_end_ms)`: a fixed one-hour window ending when collection starts.
All `_ms` timestamps are Unix milliseconds. CloudWatch returns oldest-first results; the
helper reads at most three pages of 100, retaining `--next-token` / `--limit`.
`truncated=true` means a remaining page or a failed read; the sample may omit the newest
failure, and retained results have `status=partial`. `pages_read` counts successful pages.
`earliest_timestamp_ms` / `latest_timestamp_ms` bound only the matching events
actually read. `events` counts accepted in-window events and `event_counts` separates the
two types; `category_counts` counts fixed ping-error labels, and one ping can match multiple
labels. `ignored` counts parsed non-target, out-of-window or invalid timing records;
`unparsed` counts malformed records/JSON/timestamps.
Unrecognized errors become `unclassified`. `timeout exceeded when trying to connect` is
`connection_timeout` (pool acquisition can time out for several causes); `Connection terminated
unexpectedly` is `connection_lost`, which does not establish a timeout. PostgreSQL “too many
clients already” and “remaining connection slots are reserved” map to `connection_limit`.
`no pg_hba.conf entry` is `database_hba`, including “SSL off”; it is not automatically `tls`.

**웹 로그:** JSON `evt` OR 필터로 선택한 웹 로그 그룹의 `db_ping_failed`와
`db_connection_failed`를 수집 시작 시각까지 고정된 최근 1시간
`[window_start_ms, window_end_ms)`에서 조회한다. `_ms` 시각은 모두 Unix 밀리초다.
CloudWatch의 오래된 순서로 최대 100개씩 3페이지를 읽으며 `--next-token` / `--limit`를 유지한다.
`truncated=true`는 남은 페이지 또는 조회 실패를 뜻하므로 최신 실패가 표본에 없을 수 있으며
유지된 결과는 `status=partial`이다. `pages_read`는 성공한 페이지 수다.
`earliest_timestamp_ms` / `latest_timestamp_ms`는 실제 읽은 대상 이벤트의 시각 범위다.
`events`는 시간 범위 안의 유효한 대상 이벤트 수이며 `event_counts`가 두 종류를 구분한다.
`category_counts`는 ping 오류의 고정 분류별 건수이며 한 ping이 여러 분류에 해당할 수 있다.
`ignored`는 파싱됐으나 대상/시간 범위 밖이거나 잘못된 timing 기록,
`unparsed`는 잘못된 기록·JSON·시각의 수다. 알 수 없는 오류는 `unclassified`다.
`timeout exceeded when trying to connect`는 `connection_timeout`이며 pool 획득 지연의
원인은 다양하다. `Connection terminated unexpectedly`는 timeout을 단정하지 않는
`connection_lost`다. PostgreSQL의 “too many clients already”·“remaining connection slots
are reserved”는 `connection_limit`이다. “SSL off”가 포함돼도 `no pg_hba.conf entry`는
`database_hba`이며 자동으로 `tls`가 되지 않는다.

**Connection timing:** `phase_counts` counts accepted `db_connection_failed` events.
`latest_connection` contains the latest valid timing event within the returned sample:
an allowed phase, its event timestamp, `elapsed_ms`, and allowed `milestones_ms`.
Durations must be finite numbers in `[0, 3600000]` milliseconds (at most one hour);
booleans/strings are rejected, and milestones later than elapsed time are omitted.
Unknown phase values are ignored; unknown/invalid milestone entries are omitted without
echoing them. No timing event means `latest_connection=null`. These observations may be
absent until the application observer is deployed and do not prove the live root cause.
`invalid_timing` separates rejected timing records within `ignored`; `discarded_milestones`
counts omitted milestone entries (or one malformed non-object milestone container).
Discarded milestones alone make the sample partial.

**연결 timing:** `phase_counts`는 유효한 `db_connection_failed` 이벤트를 센다.
`latest_connection`은 반환된 표본 중 최신 유효 timing의 허용 phase·이벤트 시각·
`elapsed_ms`·허용 `milestones_ms`를 담는다. duration은 `[0, 3600000]` 밀리초(최대 1시간)의
유한 숫자여야 한다. boolean/문자열은 거부하며 elapsed보다 늦은 milestone은 제외한다.
알 수 없는 phase는 무시하고 알 수 없거나 잘못된 milestone도 원문 출력 없이 제외한다.
유효 timing이 없으면 `latest_connection=null`이다. 앱 observer 배포 전에는 관측이 없을 수
있으며 이 정보만으로 실제 장애 원인을 증명하지 않는다.
`invalid_timing`은 `ignored` 중 거부한 timing을 따로 세며 `discarded_milestones`는 제외한
milestone 항목 수다(객체가 아닌 잘못된 milestone container는 1건).
milestone을 제외한 경우에도 표본을 partial로 표시한다.

| Timing allowlist / timing 허용 목록 | Fixed values / 고정 값 |
|---|---|
| Phase | `dns_tcp_connect`, `tcp_connect`, `tls_negotiation`, `tls_handshake`, `postgres_startup`, `iam_token`, `postgres_authentication` |
| Milestone | `dns_resolved`, `tcp_connected`, `ssl_accepted`, `tls_connected`, `password_requested`, `token_started`, `token_ready`, `authenticated` |

**RDS server tail:** `server_logs` reads the configured `<project>-aurora-1` instance directly.
It lists filenames containing `postgresql` (up to three pages of 100), selects at most the two
greatest `LastWritten` candidates, then requests the newest 500 lines **per file** without a
download marker (API maximum 1 MiB per file; at most two downloads). It never prints filenames.
Only `FATAL:`/`ERROR:`/`PANIC:` severity lines mentioning `awsops_web` contribute to fixed
`category_counts` / `matching_lines`. `benign_role_mentions` counts exactly non-error-severity
lines mentioning `awsops_web`; lines for other database roles are ignored.
`lines_examined` includes all downloaded lines.
`listing_pages_read`, `files_selected`, `files_downloaded` and `tail_line_limit` disclose scope.
`listing_truncated` means a capped/failed listing, so the selected candidates may not be the
newest overall. `tail_unavailable` flags missing/unreadable tails; listing metadata survives a
download failure with `status=partial`. `tail_truncated` is `null` with no readable tail,
otherwise flags pending data or a reached cap in any downloaded tail. Even a false flag
describes only those requested tails. `selected_last_written_ms` is the newest selected file's
metadata, not an event timestamp or download-success indicator. These tails have no one-hour
filter and is independent of CloudWatch exports; absence of a matching line cannot rule out
authentication, TCP or TLS problems.

**RDS 서버 tail:** 설정된 `<project>-aurora-1` 인스턴스를 직접 조회한다. `postgresql`이 포함된
파일을 최대 100개씩 3페이지 읽고 `LastWritten`이 가장 큰 후보 2개까지 선택한다.
**파일당** 최신 500줄을 download marker 없이 요청한다(파일당 최대 1 MiB, 최대 2회 download).
파일 이름은 출력하지 않는다. `awsops_web`이 언급된 `FATAL:`/`ERROR:`/`PANIC:` severity 줄만
고정 `category_counts` / `matching_lines`에 포함한다. `benign_role_mentions`는 `awsops_web`을
언급하는 비오류 severity 줄만 세며 다른 DB 역할의 줄은 무시한다.
`lines_examined`는 내려받은 전체 줄 수다.
`listing_pages_read`·`files_selected`·`files_downloaded`·`tail_line_limit`는 조회 범위를 표시한다.
`listing_truncated`는 목록 제한/실패이므로 선택한 후보가 전체 중 최신이라는 보장은 없다.
`tail_unavailable`은 tail 부재/읽기 실패이며 download 실패에도 목록 메타데이터와
`status=partial`을 유지한다. `tail_truncated`는 읽은 tail이 없으면 `null`, 있으면 어느 tail이든
추가 데이터/제한 도달 여부다. false여도 요청한 tail들만 설명한다.
`selected_last_written_ms`는 최신 선택 파일의 메타데이터이며 이벤트 시각이나 download 성공
표시가 아니다. 이 tail들에는 1시간 필터가
없으며 CloudWatch export와 독립적이다. 대상 줄이 없다는 이유로 인증·TCP·TLS 문제를 배제하지 않는다.

Regex inspection is limited to the first 4,096 characters of each ping error/server-log line.
Shortening marks `logs.classification_truncated` or `server_logs.tail_truncated` and makes
that sample partial; counters describe only the inspected prefixes.
정규식 검사는 ping 오류/서버 로그 줄의 처음 4,096자로 제한한다. 줄이면
`logs.classification_truncated` 또는 `server_logs.tail_truncated`와 partial을 표시하며
건수는 검사한 접두 구간만 설명한다.

`server_logs.lifecycle_counts` separately observes fixed PostgreSQL message starts:
`authenticated`, `authorized`, `client_disconnected_during_auth`, `broken_pipe`, and
`connection_reset`. Every category requires the web user in a recognized RDS-shaped prefix;
authentication/authorization also needs an exact web identity in a LOG message. These filters
reject bare and mid-line keyword matches, but **a full synthetic prefix in multiline SQL or
`RAISE LOG` can forge the same text**. Accordingly, `lifecycle_source_integrity=unverified_text`
and `lifecycle_injection_possible=true` always accompany the counts. They remain advisory;
`probe_outcome` is always `unknown`. Counts can overlap error/non-error counters; do not sum them.

The `authenticated`/`authorized` messages require `log_connections` to be enabled. PostgreSQL
defaults it off, and this repository does not enable it. The helper does not inspect the
effective setting: `log_connections_enabled=null` explicitly means unknown. Zero counts do
not prove absent connections or failed/successful authentication. No logging parameter is changed.

`server_logs.lifecycle_counts`는 PostgreSQL 메시지 시작 부분의 고정 패턴을 별도로 관측한다:
`authenticated`, `authorized`, `client_disconnected_during_auth`, `broken_pipe`,
`connection_reset`. 모든 분류에 RDS 형태 접두부의 web 사용자가 필요하며 인증/인가 LOG에는
메시지에도 정확한 web identity가 있어야 한다. 접두부 없는 줄·중간 키워드는 거부하지만
**여러 줄 SQL의 완전한 가짜 접두부나 `RAISE LOG`는 같은 텍스트를 위조할 수 있다**.
따라서 `lifecycle_source_integrity=unverified_text`·`lifecycle_injection_possible=true`를 항상
표시하며 건수는 참고용이고 `probe_outcome`은 항상 `unknown`이다. 오류/비오류 건수와 겹칠 수
있으므로 합산하지 않는다.

`authenticated`/`authorized` 메시지는 `log_connections` 활성화가 필요하다. PostgreSQL 기본값은
off이며 이 저장소는 이를 활성화하지 않는다. helper는 실제 설정을 조회하지 않으므로
`log_connections_enabled=null`로 미확인을 명시한다. 0건은 연결 부재나 인증 성공/실패의 증거가
아니며 로깅 파라미터를 변경하지 않는다.

**Configured-instance metrics:** one read-only `GetMetricData` request selects the configured
`<project>-aurora-1` using `AWS/RDS` / `DBInstanceIdentifier`. The ten fixed IDs below share
60-second buckets over the hour ending at the last completed minute when diagnostics starts.
`window_start_ms` / `window_end_ms` expose that `[start,end)` range; the current incomplete
minute and later publications may be missing. The request permits at most 1,000 datapoints,
does not follow `NextToken`, and publishes at most 60 timestamp/value pairs per series.

**설정된 인스턴스 지표:** 읽기 전용 `GetMetricData` 한 번으로 `AWS/RDS` / `DBInstanceIdentifier`의
설정된 `<project>-aurora-1`을 선택한다. 아래 고정 ID 10개는 진단 시작 시 마지막으로 완료된 분까지
최근 1시간을 60초 bucket으로 조회한다. `window_start_ms` / `window_end_ms`가 `[start,end)`를
표시하며 진행 중인 분이나 늦게 게시된 데이터는 없을 수 있다. 요청은 최대 1,000 datapoint이며
`NextToken`을 따라가지 않고 series당 최대 60개 시각/값 쌍만 공개한다.

| ID | AWS/RDS metric / 지표 | Statistic / 통계 |
|---|---|---|
| `iam_requests` | `IamDbAuthConnectionRequests` | Sum |
| `iam_success` | `IamDbAuthConnectionSuccess` | Sum |
| `iam_failure` | `IamDbAuthConnectionFailure` | Sum |
| `iam_invalid_token` | `IamDbAuthConnectionFailureInvalidToken` | Sum |
| `iam_permissions` | `IamDbAuthConnectionFailureInsufficientPermissions` | Sum |
| `iam_throttling` | `IamDbAuthConnectionFailureThrottling` | Sum |
| `iam_server_error` | `IamDbAuthConnectionFailureServerError` | Sum |
| `cpu` | `CPUUtilization` | Average |
| `free_memory` | `FreeableMemory` | Minimum |
| `capacity` | `ServerlessDatabaseCapacity` | Average |

`series` preserves each requested ID, its fixed metric/statistic, allowed `status_code`
(`Complete`, `PartialData`, `InternalError`, `Forbidden`; null if absent, `Unknown` if invalid),
and validated `points`. `missing` means no valid points, not zero activity. A genuine numeric
zero stays zero. `invalid_data`, `messages_present`, `unexpected_results`, and `truncated`
retain degradation without remote labels, messages or pagination tokens. Unpaired arrays are
rejected; duplicates/invalid/out-of-window points cannot establish completeness. `Complete`
means returned published data, not continuous minute coverage or success of this probe.
`read_ok` records receipt of a valid response envelope, independently of data presence.
Series `status` is available for clean `Complete` (including empty), unavailable for absent,
`Forbidden` or `InternalError` results, and partial for `PartialData` or malformed/degraded
results. The summary is available when all series reads are available without global degradation,
unavailable when all are unavailable, and partial otherwise. Ten clean empty results therefore
mean available reads with `missing=true`, not a healthy database. Emptiness can also mean an
unpublished metric, unsupported dimension, or delayed publication; absence is never filled with zero.

`series`는 요청 ID, 고정 지표/통계, 허용 `status_code`와 검증한 `points`를 유지한다.
상태는 `Complete`, `PartialData`, `InternalError`, `Forbidden`이며 누락 시 null, 잘못된 값은
`Unknown`이다. `missing`은 유효한 point가 없다는 뜻이지 활동 0이 아니다. 실제 숫자 0은 유지한다.
`invalid_data`·`messages_present`·`unexpected_results`·`truncated`로 불완전성을 알리되 원격
라벨·메시지·페이지 토큰은 출력하지 않는다. 길이가 다른 배열은 거부하며 중복/잘못된/범위 밖 point로
완전성을 주장하지 않는다. `Complete`도 게시된 데이터 반환 상태이며 매분 coverage나 이 probe의 성공이 아니다.
`read_ok`는 데이터 존재와 별개로 유효한 응답 envelope 수신을 기록한다. Series `status`는 정상
`Complete`이면 빈 결과도 available, 누락·`Forbidden`·`InternalError`이면 unavailable,
`PartialData`나 잘못된/불완전한 결과이면 partial이다. 전부 available이고 전체 응답의 불완전성이
없으면 요약도 available, 전부 unavailable이면 unavailable, 그 외는 partial이다.
정상 빈 결과 10개는 available 조회와 `missing=true`를 뜻하며 DB 정상 판정이 아니다.
미게시 지표·지원되지 않는 dimension·게시 지연으로도 비어 있을 수 있고 누락을 0으로 채우지 않는다.

IAM counters aggregate all IAM clients on the configured instance. Positive failure-category
points identify observed instance-level failures, but `probe_outcome=unknown` and
`no_error_inference=true` prohibit attributing them to one connection or treating missing/zero
data as healthy. CPU is percent, memory bytes and capacity ACUs. Configuration additionally
projects numeric `serverless_min_acu` / `serverless_max_acu`, or null when unavailable/invalid.
Pressure is a hypothesis to compare with the known probe window, not authority to change capacity,
timeouts or authentication. The existing readiness gates remain required.

IAM 건수는 설정된 인스턴스의 모든 IAM client를 집계한다. 양의 실패 분류 point는 인스턴스에서 관측된
실패지만 `probe_outcome=unknown`·`no_error_inference=true`이므로 개별 연결에 귀속하거나 누락/0을
정상으로 판정하지 않는다. CPU는 %, 메모리는 byte, 용량은 ACU다. 구성의 `serverless_min_acu` /
`serverless_max_acu`는 검증된 숫자이며 없거나 잘못되면 null이다. 부하는 알려진 probe 시간과 비교할
가설이며 용량·timeout·인증 변경 권한이 아니다. 기존 준비 상태 검사는 계속 필수다.

Sources / 출처: [IAM-auth metrics](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/UsingWithRDS.IAMDBAuth.Troubleshooting.html),
[Aurora dimensions](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/dimensions.html),
[instance metrics](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.AuroraMonitoring.Metrics.html),
[GetMetricData status and bounds](https://docs.aws.amazon.com/AmazonCloudWatch/latest/APIReference/API_GetMetricData.html).

**Configuration:** comparisons describe the ECS service's target task definition, not every
running revision. `service_running_count` can include old and new revisions during deployment.
`definition_basis=service_target_not_running_tasks` and
`credential_check_basis=declarations_only_not_runtime` label these limits.
Credential indicators inspect declared `environment` and `secrets` names, including
`AWS_SESSION_TOKEN`; `environment_files_declared` reports only the presence of environment
files, without reading them. These are declarations, not runtime credential proof.
After a successful task-definition read, a missing/malformed web container leaves
`sources_unavailable.service_target_definition=false`. `web_container_found` is false when
absent, true when identified, or null when undeterminable; affected fields remain derived-unknown.
Endpoint/user/region/task-role, IAM-auth, DB security-group ingress and inline connect-Allow
matches provide hypotheses only. They do not evaluate effective access under service control
policies (SCPs), permission boundaries, other denies, or end-to-end networking. No diagnostic
result waives the authenticated DB/login readiness checks.
The inline-Allow check looks for the exact action/resource only; false does not exclude a
wildcard or another policy grant.

**구성:** 비교 대상은 ECS 서비스가 지정한 task definition이며 모든 실행 중 revision이 아니다.
배포 중 `service_running_count`에는 이전·새 revision이 함께 포함될 수 있다.
`definition_basis=service_target_not_running_tasks`·
`credential_check_basis=declarations_only_not_runtime`가 이 한계를 명시한다.
자격증명 표시는 `AWS_SESSION_TOKEN` 등을 포함한 `environment`·`secrets` 선언 이름을 확인한다.
`environment_files_declared`는 파일 존재만 표시하고 내용을 읽지 않는다. 선언 검사이므로 런타임
자격증명을 증명하지 않는다. endpoint·사용자·리전·태스크 역할·IAM 인증·DB 보안 그룹 ingress·
inline connect-Allow 일치는 가설용 근거다. SCP(Service Control Policy)·권한 경계·다른 Deny·
종단 간 네트워크를 포함한 실제 접근 권한을 판정하지 않으며 인증된 DB/login 준비 상태 검사를 면제하지 않는다.
inline-Allow 검사는 정확한 action/resource만 찾으므로 false여도 wildcard나 다른 정책의 허용을
배제하지 않는다.
Task definition 조회가 성공했다면 web container 부재/형식 오류여도
`sources_unavailable.service_target_definition=false`다. `web_container_found`는 없으면 false,
식별했으면 true, 판단할 수 없으면 null이며 영향을 받는 파생 필드는 미확인으로 유지한다.

### 4. ECR permissions for the pin step / ci-deployer ECR 권한

The deploy jobs re-point `:web-latest` at the approved `web-<sha>` before rolling,
so each deployer role needs `ecr:BatchGetImage` + `ecr:PutImage` scoped to its own
stack's web ECR repository (plus the auth-token action it already has).
(각 deployer 역할에 자기 스택 web ECR 스코프의 `ecr:BatchGetImage`·`ecr:PutImage`
권한이 필요합니다.)

Build checks repository availability **before** QEMU/Buildx and the image build using
`ecr:BatchCheckLayerAvailability`, already part of its scoped push permissions, with an
intentionally absent but valid layer digest. `LayerNotFound` is normal for this probe;
repository-not-found or access-denied stops the build. Review/apply an `ecr-bootstrap`
plan for a missing repository; do not disable this check or expand the role.

빌드 전에 기존 push 권한으로 ECR 저장소 존재·접근을 확인합니다. 테스트용 레이어 부재는
정상이나 저장소 부재·권한 거부는 중단 사유입니다. 저장소가 없으면 §5의 ECR 초기 계획을
검토·적용하고, 검사나 권한 제한을 해제하지 않습니다.

### 5. Deploy while DNS changes are deferred / DNS 변경 보류 상태의 배포

`Terraform` dispatch defaults to `mode=plan`, `allow_dns_changes=false` and
`domain_rollout=false`, `runtime_rollout=false`; manual dev/preview core teardown remains blocked (no retirement mode). See [runtime activation](runtime-foundation.md)
for the separate dev private-DNS profile. Ordinary full plans keep the existing broad DNS policy:
Cloud Map/registered ECS changes require explicit DNS permission on both plan and apply.
For a dev service-domain rollout, use the [staged domain runbook](dev-domain-rollout.md)
and set **`domain_rollout=true` on every domain-stage plan dispatch** (`dev` / `full` only).
The declared default-false Terraform metadata variable `ci_domain_rollout` is embedded
in the saved plan; apply derives scoping from that marker, not current repository
variables or an apply input. The scoped policy allows only the selected zone's configured
service A/ACM CNAME records; it does not authorize old/parent DNS or Cloud Map changes.

dispatch 기본값은 `mode=plan`, DNS 허용 false, `domain_rollout=false`,
`runtime_rollout=false`다. 사설 DNS 활성화는 별도 runtime 런북을 따른다. 일반 full 계획의
Cloud Map/등록된 ECS 변경에는 plan/apply 양쪽의 DNS 승인이 필요하다. dev 도메인 전환은
연결된 런북을 따라 모든 도메인 단계 plan에서 `domain_rollout=true`로 설정한다.
범위는 저장된 `ci_domain_rollout` 메타데이터로 결정하며 apply 입력으로 바뀌지 않는다.
범위 제한 전환은 선택 존의 서비스 A/ACM CNAME만 허용하며 이전/상위 DNS 권한은 포함하지 않는다.

For a new stack, a DNS-free full plan needs two already-issued public ACM
certificates: one in `us-east-1` covering the service and additional aliases,
and one in the stack Region covering the origin hostname. Both must belong to
the deployment account. CI checks validity (more than 24 hours remaining), hostname
coverage and the public CA chain, then supplies their ARNs to Terraform. Explicit
`existing_cf_certificate_arn` / `existing_alb_certificate_arn` inputs must identify the
operator-selected certificates for a new DNS-free stack; the only implicit external choice
is the certificate already attached to that stack's CloudFront/ALB. CI never lists the
account's certificates or selects one by expiry. Explicit ARNs are verified even for
DNS-allowed or ECR-bootstrap plans. A missing or unverifiable pair stops a DNS-free full
dispatch; waiting for the operator's ARNs is not permission to create validation DNS.

For an existing stack, CI first reads state with `terraform show -json`, without
refresh/write/lock operations. Each certificate owned by this stack remains managed:
CI validates it and writes **JSON null** to its external-ARN input. Never copy its ARN
into `existing_*_certificate_arn`; that would remove its Terraform resource.
External selection excludes all managed certificates in this state, including child modules.
Routine CI refuses to externalize a currently managed certificate to **any** external ARN,
even with `allow_dns_changes=true` or `plan_scope=ecr-bootstrap`. A new DNS-authorized stack
can still create managed certificates, and ordinary managed rotations keep null inputs.
No-DNS mode preserves `publish_service_dns=true` when service aliases already exist,
and false for a fresh/deferred stack. It does not force existing aliases toward deletion.
Changes in alias membership/targets or validation CNAMEs still fail the plan gate.
The typed overrides live in `ci-deployment.tfvars.json` for dispatch and dev advisory
plans and are removed after planning; string `"null"` and `-var=...=null` are not JSON null.
Optional repo variables `DOMAIN_NAME_DEV` / `HOSTED_ZONE_NAME_DEV` feed a gitignored
`ci-domain.auto.tfvars.json` before both console and plan (only dev reads the name overrides).
Generation rejects a tracked override instead of deleting it. `CERTIFICATE_MODE_DEV`
defaults to `preserve`; `managed` retains null external inputs and refuses conflicting
ARNs in tfvars/dispatch. The domain runbook defines supported transitions.
The public summaries report `managed` or `external:<8-character suffix>`, the publication
flag, resource-change counts/addresses, and, for active domain rollout, `public_zone`
(`name`, `zone_id`, `name_servers`). This public delegation projection is intentional.
Full ARNs, account IDs, raw configuration/overrides/state/plan JSON remain excluded.

The plan gate also rejects deletion/replacement of owned `aws_route53_record.cf_validation`
records **even when DNS is allowed**, and rejects retirement of the managed CF/ALB certificate
outside a replacement. Validation tokens can be shared across certificates and needed for
renewal after a cutover. Ownership migration and validation-record retirement need separate
reviewed procedures with the certificate/DNS owners: preserve all still-required tokens,
establish that no current or renewed certificate needs a token before retiring it, and
obtain separate authorization. Routine deployment is not that procedure. No-op validation
records, new CNAME creation and service A-record updates remain valid when DNS is authorized.

Live certificate validation runs only for dispatch. Dev PR/push plans use an offline
ownership/publication preflight reading existing state and configuration: no STS/ACM
lookup, SAN, expiry or trust-chain gate during bootstrap/rollout. Their DNS allowance is
reporting only; ownership/retirement checks still run and the artifacts cannot be applied.
The preflight does not receive the demo password secret.
`terraform console` reads configuration/current state without refreshing or locking it;
it has **no `-lock=false` option**. Offline backend tests verify these read-only semantics.

새 스택을 DNS 변경 없이 배포하려면 이미 발급된 인증서 두 개가 필요하다.
CI가 인증서의 계정·리전·유효 기간·호스트 이름·공개 CA 체인을 검증한다.
서비스 A 레코드와 인증서 검증 CNAME은 모두 생성하지 않으며, 계획에 DNS
생성·수정·삭제가 하나라도 있으면 적용을 거부한다. 내부 ALB와 HTTPS 경로는
유지한다. 기존 스택은 상태를 읽어 관리 인증서를 JSON null로 보존하고 기존 서비스
레코드 게시 상태도 유지한다. 새 스택은 운영자가 외부 ARN을 지정해야 하며 암묵적 재사용은
이미 연결된 외부 인증서에 한한다. 계정 전체 검색·만료일 기준 선택은 하지 않는다.
일반 CI는 DNS 허용 여부·계획 범위와 무관하게 관리 인증서의 외부화와 검증 CNAME 삭제·교체를
거부한다. 소유권 이전 및 검증 레코드 폐기는 인증서·DNS 소유자와 별도로 검토·승인해야 하며,
기존/갱신 인증서에 필요한 토큰을 보존해야 한다. 정상 관리 인증서 교체와 새 스택 생성은 유지된다.
DNS 허용 시 CNAME 신규 생성, 서비스 A 레코드 갱신, 무변경 레코드는 허용한다.
dev 저장소 이름 변수는 console과 plan이 함께 읽는 gitignored 자동 tfvars에 반영된다.
추적된 자동 파일은 덮어쓰지 않고 거부한다. `managed` 모드는 충돌 ARN을 거부하고 null을 유지한다.
공개 요약은 인증서 관리 여부/외부 ARN 마지막 8자리, 게시 플래그, 변경 수/주소와 활성 전환의
public 존 이름·ID·NS만 포함한다. 전체 ARN·계정 ID·원본 설정/상태/계획은 공개하지 않는다.
실제 인증서 검증은 dispatch에서만 실행한다. dev PR/push는 상태 기반 소유권·게시를 보존하되
STS/ACM·SAN·만료·신뢰 체인 검증 없이 참고 계획을 만든다. 적용할 수 없으며 demo 비밀번호도 받지 않는다.

```bash
gh workflow run terraform.yml -R aws-samples/sample-awsops --ref dev \
  -f mode=plan -f plan_scope=full \
  -f allow_dns_changes=false
```

In this no-DNS example, `publish_service_dns` is derived from state, not the dispatch input.
For a fresh stack, also supply the operator's `existing_cf_certificate_arn` and
`existing_alb_certificate_arn` inputs (or their reviewed stack tfvars); otherwise it stops.
이 예제의 게시 상태는 dispatch 입력 대신 기존 상태로 결정된다. 새 스택에는 운영자가 지정한
두 외부 ARN 입력(또는 검토된 스택 tfvars)이 추가로 필요하며 없으면 중단한다.

Inspect the completed run, its resource changes and commit. Set `PLAN_RUN_ID` to
that successful run's numeric ID, then apply its encrypted saved plan:

완료된 실행의 커밋과 리소스 변경을 확인한 뒤, `PLAN_RUN_ID`에 검토한 성공
실행의 숫자 ID를 지정하고 저장된 계획을 적용한다.

```bash
gh workflow run terraform.yml -R aws-samples/sample-awsops --ref dev \
  -f mode=apply -f plan_run_id="$PLAN_RUN_ID" -f allow_dns_changes=false
```

Apply accepts only a successful explicit Terraform plan dispatch from the same
repository, stack branch and commit. It checks the live branch again and
rechecks DNS changes after decrypting the plan. A moved branch requires a fresh
plan. `plan_scope=ecr-bootstrap`, with `domain_rollout=false`, is available for an initial plan limited to the
web ECR repository; the JSON gate also rejects unrelated mutations in that scope.
Dev `plan_scope=runtime-ecr-bootstrap` targets only three runtime repositories; it needs no
images yet. Repeat the same scope on apply. Saved plans now require both encrypted `tfplan.enc`
and `tfassets.enc`, with asset hashes bound to that plan/SHA/scope. Old or missing bundles require
a fresh reviewed plan; never rebuild assets during apply.
dev runtime ECR bootstrap은 저장소 세 개만 대상으로 하며 이미지가 아직 없어도 됩니다.
apply에도 같은 scope를 쓰고 두 암호화 artifact를 함께 전달합니다. 이전 형식·누락
bundle은 새 계획으로 대체하며 apply 중 재빌드하지 않습니다.
It needs no certificates unless external ARNs are explicitly configured.
Apply a full reviewed plan before rolling the service.

적용은 같은 저장소·스택 브랜치·커밋의 성공한 명시적 Terraform plan dispatch만
허용한다. 브랜치가 이동하면 새 계획이 필요하다. ECR 초기 준비만 필요한
경우 `plan_scope=ecr-bootstrap`을 사용하고, 서비스 배포 전에 전체 계획을
별도로 검토·적용한다.

**PR/push plans are advisory and cannot be applied.** They read stored stack tfvars;
dev also loads repo domain overrides and state-preserving certificate/publication inputs.
`CERTIFICATE_MODE_DEV=managed` is reflected without live certificate validation. Other
targets keep the stored tfvars behavior. DNS changes are reported without requiring a
dispatch permission toggle; this grants no apply authority. Use a new explicit dispatch
for any cutover or deployment.

All DNS changes remain forbidden during deferral, including **certificate-validation
CNAMEs, private namespaces and `aws_service_discovery_service`** records. First-time
Steampipe/Cloud Map creation and steady-state Steampipe ECS changes are blocked: task
replacement registers/deregisters private DNS even when registry configuration is unchanged.
This includes limiter tuning, hydrate-fallback `fill_rate` remediation and rollback/disable;
see [the quota/staleness runbook](steampipe-quota-and-staleness.md). There is no private-DNS
exception. The HTTPS/private edge stays intact. If no trusted matching certificate
is available, stop or perform only ECR bootstrap; there is no HTTP/public-ALB workaround.

A later cutover requires separate, explicit DNS authorization. For dev, keep domain/mode
in the repo variables and follow the domain runbook's unpublished/same-domain stages;
do not rewrite protected tfvars to defeat those overrides. Other targets use reviewed
stack tfvars. Review every DNS/certificate change in a fresh full dispatch plan and apply
that exact successful run at the same SHA. **Both plan and apply must explicitly set
`allow_dns_changes=true`;** apply does not inherit permission. Routine deployment cannot
externalize managed certificates or retire validation records. Published old-domain
retirement requires a separate expressly authorized plan under the old configuration;
the new-domain rollout does not authorize it. Follow ADR-016 for alias transfer/rollback.

자동 PR/push 계획은 참고용이며 적용할 수 없다. dev는 저장 tfvars에 저장소 이름/모드와
상태 기반 인증서·게시 입력도 반영하며 실시간 인증서 검증 없이 DNS 변경을 보고한다.
배포에는 명시적 dispatch를 사용한다. DNS 보류 중 사설 Cloud Map과 인증서 CNAME도 금지하며,
이미 운영 중인 Steampipe의 튜닝·hydrate 폴백 대응·롤백/비활성화도 ECS task 변경으로
사설 DNS를 바꿀 수 있어 차단된다.
인증서가 없으면 dispatch를 중단하거나 ECR만 준비한다. 별도 승인된 dev 전환은 저장소 변수와
미게시/동일 도메인 런북을 사용하고 다른 대상은 검토된 tfvars를 사용한다. 이전 도메인 삭제는
이전 설정의 별도 명시적 승인 계획이 필요하며 새 도메인 권한에 포함되지 않는다.
계획과 적용 dispatch **양쪽에** `allow_dns_changes=true`를 명시해야 한다.
아래는 향후 별도 승인 후의 예제이며 현재의 DNS 금지를 해제하지 않는다.

```bash
# FUTURE domain rollout ONLY: separate DNS authorization required; unpublished/same-domain cases.
gh workflow run terraform.yml -R aws-samples/sample-awsops --ref dev \
  -f mode=plan -f plan_scope=full -f domain_rollout=true \
  -f publish_service_dns=true -f allow_dns_changes=true
# After review, set PLAN_RUN_ID to that successful same-SHA plan dispatch.
gh workflow run terraform.yml -R aws-samples/sample-awsops --ref dev \
  -f mode=apply -f plan_scope=full -f plan_run_id="$PLAN_RUN_ID" -f allow_dns_changes=true
```

External certificate owners must monitor expiry and renew/reimport ahead of time.
CI validates availability but does not manage an external certificate's lifecycle.
Do not remove existing validation CNAMEs or add new ones during DNS deferral.
The supported key set is RSA 2048/3072/4096 and ECDSA P-256/P-384; see
[AWS's certificate requirements](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cnames-and-https-requirements.html).
외부 인증서는 소유자가 만료 감시·갱신을 담당하며, DNS 보류 중 검증 CNAME을 변경하지 않는다.

[Deploy Web's `deploy` / `Smoke test`](../../.github/workflows/deploy-web.yml) and manual
`make deploy` invoke the shared [deployment-smoke.mjs](../../scripts/v2/deployment-smoke.mjs) CLI,
which validates destinations and passes curl arguments without shell interpolation.
They connect to `cloudfront_domain` with curl
`--connect-to` while requesting `public_url`. This preserves the service Host,
SNI and certificate verification before service DNS is published. `/api/health`
checks process liveness; complete the required database migrations and verify
authenticated application routes separately.
For an authorized AgentCore deployment, [Deploy AgentCore](../../.github/workflows/deploy-agentcore.yml)
first runs the private reusable migration workflow on `dev`; other branches retain
`make migrate`. Optional `smoke=true` runs after provisioning. On dev it requires the matching
readiness producer, `runtime_deployment`, enabled inventory and producer-classified freshness.
The applied `agentcore.deployment_readiness_enabled` output must be boolean true; the
provisioner keeps the runtime probe disabled for missing/false values, ignoring ambient overrides.
Missing prerequisites fail the optional dev smoke with a fixed code, not before provisioning.
Other stacks retain advisory invocation behavior when readiness is unavailable; structured
checks are advisory there when available, while invocation transport failures still fail.
Neither AgentCore smoke nor `/api/health` substitutes for a web-role
permission, login/database or full collection/worker check.

웹 배포 스모크 테스트는 `public_url`의 Host·SNI·인증서 검증을 유지하면서
CloudFront 연결 주소로 요청한다. `/api/health`는 프로세스 생존 확인이므로,
필수 DB 마이그레이션과 인증된 실제 기능 검증도 수행해야 한다.
웹 워크플로와 `make deploy` 모두 공통 CLI로 주소를 검증하며 셸 문자열 대신 인자 배열을 사용한다.
dev AgentCore는 사설 재사용 migration workflow를 먼저 실행하며 다른 브랜치는
`make migrate`를 유지한다. 선택적 `smoke=true`는 provisioning 후 실행한다. dev에서는
대응 producer·`runtime_deployment`·활성 inventory와 producer의 freshness 판정이 필수다.
적용된 `agentcore.deployment_readiness_enabled` 출력도 boolean true여야 하며, 누락·false이면
주변 환경변수와 무관하게 runtime 검증 모드를 비활성화한다.
누락은 provisioning 이전 차단이 아니라 dev smoke의 고정 오류 코드로 보고한다.
다른 스택은 readiness가 없으면 기존 참고용 호출을 유지하며, 사용 가능한 구조화 검사도
참고용이다. 호출 전송 실패는 계속 실패한다. 웹 역할·로그인·DB·전체 수집·워커 검증을 대체하지 않는다.

The DNS/provenance scripts run from the deployment ref. They are safety checks for reviewed
code, not a security boundary against changes to that ref; normal review and environment
protections remain required.
DNS·출처 검사도 배포 ref의 코드이므로 코드 변경에 대한 보안 경계를 대신하지 않는다.
기존 리뷰·보호 환경 절차를 계속 적용한다.

#### Runtime images / 런타임 이미지

After the reviewed Terraform ECR bootstrap, dispatch **Build Development Runtime Image**
(`build-runtime-images.yml`) on `dev` with `component=steampipe` or `component=worker`.
The repository must already exist: `steampipe_enabled`, `workers_enabled` and `agentcore_enabled`
gate the respective `-steampipe`, `-worker` and `-agentcore` repositories.
The helper checks the independently configured secret account,
configured CI role and actual STS identity before writes; it never creates repositories.
It builds one Linux/ARM64 manifest, verifies the uploaded configuration and manifest hashes,
and returns the project and immutable digest. Record those verified digests for the full
infrastructure plan; the build itself deploys no service.
Repository preflight uses the already-required `ecr:BatchGetImage`; an expected ImageNotFound
for the commit tag is acceptable. Repository-not-found and access denial fail; no
DescribeRepositories grant or automatic repository creation is added.

검토된 Terraform ECR bootstrap 후 dev에서 **Build Development Runtime Image**를
`component=steampipe` 또는 `component=worker`로 실행한다. 저장소는 미리 존재해야 한다.
helper는 쓰기 전에 독립 설정 계정·CI 역할·실제 STS 식별자를 검증하며 저장소를 생성하지
않는다. Linux/ARM64 단일 manifest와 업로드 해시를 검증하고 project·digest를 반환한다.
이 digest를 전체 인프라 계획에 사용하며 이미지 빌드만으로 서비스가 배포되지는 않는다.
각 저장소는 해당 `steampipe_enabled`·`workers_enabled`·`agentcore_enabled`에 의해 생성된다.
사전 검사는 기존 `ecr:BatchGetImage` 권한만 사용한다. 커밋 태그의 ImageNotFound는 허용하지만
저장소 부재·접근 거부는 실패하며 DescribeRepositories 권한이나 자동 생성을 추가하지 않는다.

Dev AgentCore follows the same account/digest checks using an `agent-<commit SHA>` tag.
After setup, the workflow obtains a fresh one-hour session for `--build-only`. It then
refreshes the SAME deployer role before `--provision-only`, passing only the verified
project/digest outputs. Provision-only repeats identity checks, rereads the commit tag
and verifies that its immutable digest still matches; it never rebuilds or selects latest.
The old combined dev CLI path is rejected; main/preview retain their existing CLI path.
Docker credential
scratch is private and cleaned. Leave optional AgentCore smoke off during first provisioning
until inventory has been collected and the applied readiness flag is enabled, then run the full application release verification.
Never count successful provisioning alone as application readiness.
Short CLI/Terraform operations have a two-minute process limit; dev build, image push and
provisioning have separate 35/10/45-minute limits. Aggregate deadlines also cap the build
helper at 48 minutes and each agent CLI phase at 50 minutes, including reads. Fresh-role
verification is capped at two minutes and phase workflow steps at 52 minutes, within each
fresh one-hour session. The dev job allows 120 minutes for setup plus both phases. Manual runtime image builds
obtain credentials only after QEMU/buildx setup and use a 50-minute build step. No custom
credential process, role-session maximum change or IAM grant is introduced.
Public diagnostics retain fixed stages/codes, catalog keys and status counts, at most 240
resource events with an explicit dropped count. Child failure exit codes are preserved;
ARNs, credentials, endpoints and raw SDK errors are not relayed.

dev AgentCore도 `agent-<commit SHA>` 태그와 같은 계정·digest 검증을 사용한다.
setup 후 새 1시간 세션으로 `--build-only`를 실행하고, 동일 deployer 역할을 다시 갱신한 뒤
검증된 project/digest만 `--provision-only`에 전달한다. 계정과 커밋 태그/digest를 다시
검증하며 재빌드나 latest 선택은 하지 않는다. 기존 단일 dev CLI 경로는 거부하고
main/preview의 CLI 경로는 유지한다. Docker 자격증명
임시 파일은 비공개로 만들고 정리한다. 최초 provisioning에서는 수집·readiness flag 적용 전 선택적 AgentCore
smoke를 끄고, 수집 후 전체 앱 배포 검증을 실행한다. provisioning 성공만으로 앱을
정상 판정하지 않는다.
짧은 CLI/Terraform 호출은 2분, dev 빌드·push·provisioning은 각각 35/10/45분으로 제한한다.
조회 시간을 포함한 전체 build helper는 48분, agent CLI 단계는 각각 50분이며,
갱신한 역할 확인은 2분·workflow 단계는 52분 이내로 새 1시간 세션 안에 묶는다.
dev job은 setup과 두 단계를 포함해 120분이고 수동 이미지 빌드는 QEMU/buildx setup 후 자격을 받아 50분 안에 끝낸다.
별도 credential process·역할 최대 세션 시간 변경·새 IAM 권한은 없다.
공개 진단은 고정 단계/코드·catalog key·상태별 개수를 보존하고
resource event 240개 초과는 dropped 개수로 알린다. 자식 종료 코드는 보존하며 ARN·자격증명·
endpoint·SDK 오류 원문은 전달하지 않는다.

## Private development database migration / 비공개 개발 DB 마이그레이션

**Symptom / 증상:** a newly provisioned private Aurora has no application tables, or the
external Actions runner cannot connect to its private endpoint. Deploy Web does not initialize
the database. Use **Migrate Development Database** (`deploy-migrations.yml`), a manual-only
workflow restricted to this samples repository's `dev` branch, also reusable by a manual
dev AgentCore dispatch. It builds an ARM64 image and
runs one Fargate task in the existing private subnets with the existing service security group.

새 Aurora에 앱 테이블이 없거나 외부 Actions runner가 비공개 endpoint에 연결하지 못하면
`dev` 전용 **Migrate Development Database**를 사용한다. Deploy Web은 DB 초기화를 하지 않는다.
수동 dev AgentCore workflow에서도 같은 migration을 재사용한다.
마이그레이션은 기존 private subnet·서비스 SG를 재사용하는 일회성 ARM64 Fargate task에서 실행한다.

**Preparation / 준비:**

1. After reviewing the migration change, set the **nonsecret repository variable**
   `CI_MIGRATIONS_ENABLED_DEV` to the literal `true`. Its default is `false`.
   Terraform plans use `github.base_ref` for PRs and the current branch otherwise;
   only a `dev` target reads this variable. Other targets explicitly use `false`.
   The plan passes the value as `-var` as well as `TF_VAR_ci_migrations_enabled`, so
   a restored tfvars assignment cannot override the repository setting. Apply uses
   the value already captured in the approved saved plan.
2. Dispatch the existing **Terraform** workflow in `plan` mode on the reviewed `dev`
   commit, with DNS changes prohibited. Review that only the intended gated migration
   resources are added, then use its existing saved-plan `apply` dispatch. Keep the
   current DNS, edge, authentication, web task image and desired count intact.
3. Configure repository secret **`AWS_ACCOUNT_ID_DEV`** and confirm the existing dev
   build/deployer OIDC roles and backend secrets. The account secret is mandatory for
   both build and migrate jobs, including reusable AgentCore invocation.
   `TF_TFVARS_DEV` accepts at most one literal, single-line `project = "…"` assignment.
   If absent (including `make configure` output), the foundation default `awsops-v2` is used;
   the applied migration output must still match that project/account/region.
   This workflow accepts the existing `ap-northeast-2` deployment region only, without
   cross-stack fallback. The SQL reader sync is enabled only when AgentCore is enabled.
4. Dispatch **Migrate Development Database** from the current `dev` HEAD. It accepts no
   image, role, task, template or repository override. If the branch moves before launch,
   dispatch again from the new reviewed HEAD.

리뷰 후 일반 저장소 변수 `CI_MIGRATIONS_ENABLED_DEV=true`를 설정하고 기존 Terraform의
명시적 plan → 저장된 plan apply 절차로만 인프라를 준비한다. PR은 base branch가 `dev`일 때만
해당 변수를 읽고 다른 스택에는 전달하지 않는다. tfvars보다 CI 플래그가 우선하며 apply는 저장된
값을 사용한다. DNS·edge·인증·웹 이미지·desired count를 유지한다. 개발 OIDC 역할과 backend
secret과 필수 저장소 시크릿 `AWS_ACCOUNT_ID_DEV`를 준비한다. 재사용 AgentCore 호출을
포함해 build/migrate 양쪽 job 모두 이 계정 시크릿을 요구한다.
`TF_TFVARS_DEV`의 project 문자열은 최대 한 번만 지정하며,
생략하면 `make configure`와 동일하게 foundation 기본값 `awsops-v2`를 사용한다.
적용된 output의 프로젝트·계정·리전 일치는 계속 필수다.
이후 현재 `dev` HEAD에서 마이그레이션을 dispatch한다. 브랜치가 이동하면 새 HEAD로 다시 실행한다.

For a controller reviewing a local Terraform plan, the equivalent opt-in is:

```bash
TF_VAR_ci_migrations_enabled=true terraform -chdir=terraform/foundation plan -out=tfplan
```

The `TF_VAR_` local form follows normal Terraform variable precedence; remove conflicting
local tfvars entries or pass `-var=ci_migrations_enabled=true` explicitly. The new migration
workflow itself only initializes the dev backend and reads `migration_job`; it never plans
or applies infrastructure. The gated resources are one task role/policy, one log group, and
one task-definition template. `migration_job` is absent/null while disabled.

로컬 plan 검토 시 위 환경변수로 동일 기능을 선택할 수 있다. 로컬 tfvars에 충돌 값이 있으면
제거하거나 명시적 `-var`를 사용한다. 새 워크플로는 backend 초기화·`migration_job` 읽기만 하며
Terraform plan/apply를 수행하지 않는다. 비활성 상태에는 해당 출력과 마이그레이션 리소스가 없다.

The migration workflow uses the existing `AWS_CI_BUILD_DEV_ROLE_ARN` and
`AWS_CI_DEPLOYER_DEV_ROLE_ARN` secrets, plus required account secret `AWS_ACCOUNT_ID_DEV`.
Role names in the setup matrix are conventions;
operators do not need to rename an existing role. Valid IAM paths and surrounding input
whitespace are supported. Both selected roles must belong to that configured account. The workflow
checks the actual build STS identity before ECR access, and the controller checks the exact
configured deploy role identity before ECR/ECS access and cleanup. Account/region/backend,
private-network, task-family, digest and current-commit checks still apply. There is no
production-secret fallback, new role input or IAM permission change.
마이그레이션은 기존 개발용 역할 ARN 시크릿과 필수 `AWS_ACCOUNT_ID_DEV` 시크릿을 사용한다.
설정 표의 역할명은 명명 관례이며
기존 역할을 바꿀 필요가 없다. IAM 경로와 입력 앞뒤 공백을 지원하되 두 역할의 계정은 같아야
하며 필수 계정 시크릿과도 같아야 한다. ECR 접근 전 실제 build STS 주체를, 실행·정리 전 설정된 deploy 역할과 실제 주체를
대조한다. 계정·리전·backend·사설 네트워크·태스크 family·digest·커밋 검증은 유지하며
production 시크릿 폴백, 추가 역할 입력, IAM 권한 변경은 없다.

**Privilege review / 권한 검토:** CI roles are existing, separately managed prerequisites;
this feature does not broaden them automatically. Verify the following grants before execution.
An access denial is a failed run, never permission to substitute a more privileged role.

| Principal / 주체 | Required scope / 필요한 범위 |
|---|---|
| Dev build role | Push only to the selected project's existing private `-web` ECR repository; retain the existing ECR login permission. Only `migration-<full commit SHA>` is written. |
| Dev deployer role | Read the dev state backend and selected ECR image; register/describe the project's `-migration` family; run only that family on the project's cluster. Where an ECS API requires wildcard resource access, constrain the requested region and use supported action-specific conditions. |
| Dev deployer `iam:PassRole` | Exactly the project's `-task-execution` and `-migration-task` roles, with `iam:PassedToService = ecs-tasks.amazonaws.com`; no arbitrary role pass. |
| Dev deployer cleanup | `ecs:DescribeTasks` / `ecs:StopTask` limited to the project's task ARN prefix and cluster; `ecs:ListTasks` constrained to that cluster. The controller additionally checks run identity, exact registered revision and task ARN before stopping. |
| Optional failure-log reader | `logs:GetLogEvents` only for `/ecs/<project>-migration`, stream prefix `migration/migration/`. No log-wide search is needed. |
| Migration task role | `secretsmanager:GetSecretValue` for this Aurora master secret, plus the project's SQL reader secret only when AgentCore is enabled. Aurora CMK `kms:Decrypt` requires Secrets Manager and the master secret's encryption context. No AWS-side mutation permissions (ECS/ECR/IAM/DNS/secret writes); schema DDL uses the database credentials. |
| Existing execution role | Existing private ECR pull and CloudWatch log delivery. Database credentials are fetched by the task role at runtime, never through ECS environment/secrets injection. |

기존 CI 역할의 ECR·ECS·PassRole·backend·로그 권한을 위 범위로 확인한다. 거부되면 실행 실패로
처리하며 다른 고권한 역할로 대체하지 않는다. DB task 역할은 해당 secret 읽기와 제한된 KMS
복호화만 가능하다. 암호는 컨테이너 메모리에서 읽으며 환경변수나 공개 로그에 넣지 않는다.

**Verification and recovery / 확인·복구:** the controller refuses the `migration-unbuilt`
template image and clones only approved fields using this run's immutable build digest.
Only project and digest cross the build-job boundary; a masked registry/account value is
not a job output. The controller verifies the digest in the expected ECR repository,
checks current `dev` SHA immediately before `RunTask`, and requires task **STOPPED**,
the same running-image digest, and the migration container's **numeric `exitCode: 0`**.
Missing/string/null exit codes cannot pass.

Migration logs retain 14 days; disabling the flag destroys the log group and its retained history.
After changing AgentCore/reader settings, review and apply the migration template before dispatch.
로그 보존은 14일이며 플래그 비활성화 시 로그 그룹과 이력이 삭제된다. AgentCore/reader 설정을
바꾸면 migration 템플릿을 검토·적용한 후 dispatch한다.

The migration wait is at most 20 minutes plus a bounded in-flight API request. Each CLI call
is capped at 20 seconds; cleanup polls for at most two minutes plus bounded in-flight calls.
Timeout/cancellation cleanup checks only this run's recorded task; if a launch response was
lost, it discovers by this run's unique `startedBy` and verifies the exact clone before stopping.
Temporary config, Terraform backend data and the run journal are removed by workflow cleanup.
If the runner is killed or cleanup cannot verify STOPPED, inspect that run's task before retrying;
do not stop other tasks. Registered clone revisions are retained for audit; no service is updated.

Failure-log reads are best effort and do not replace the primary error. Public output contains
fixed diagnostic categories only. In the private migration log stream, inspect the retained
operation/purpose, SDK code and HTTP status, SQLSTATE and role booleans described in the
[safe diagnostic table](agent-sql-reader.md#안전한-오류-진단--safe-failure-diagnostics).
Raw remote error text is discarded before logging. Empty-DB bootstrap and ULID migrations run under the migration advisory lock;
an occupied database without a ledger is refused. Retry only after identifying the failure,
and preserve all existing migration checksums and `-- since:` headers.

컨트롤러는 템플릿을 직접 실행하지 않고 이번 빌드 digest로 제한된 필드만 복제한다. ECR·브랜치
SHA·실행 이미지 digest를 검증하며 실제 STOPPED와 숫자 0 종료 코드가 모두 필요하다.
대기는 20분, 정리는 2분에 진행 중인 제한된 API 호출 시간을 더한 범위 안에서 종료한다.
취소·시간초과 시 이번 실행 소유 task만 검증 후 중지한다. 응답 유실 시에도 run별 `startedBy`와
정확한 revision을 검사한다. runner 강제 종료나 정리 실패 시 다른 task를 중지하지 말고 해당
task 상태를 확인한 뒤 재시도한다. 비공개 로그에서는 보존된 작업·목적, SDK 코드·HTTP 상태,
SQLSTATE·롤 속성을 [안전한 진단 표](agent-sql-reader.md#안전한-오류-진단--safe-failure-diagnostics)와 대조한다.
원격 오류 원문은 로그에 남기지 않으며 공개 로그에는 고정된 분류만 표시한다.
기존 schema·ULID checksum·since 헤더는 변경하지 않는다.

After a successful migration, deploy the reviewed web image and verify authenticated database access before publishing service DNS.
마이그레이션 성공 후 검토한 웹 이미지를 배포하고 인증된 DB 접근을 확인한 뒤 서비스 DNS를 게시한다.

Offline controller checks require Node 20, Python 3 with PyYAML and boto3/botocore,
Terraform 1.15.7 and cached providers (`pip install -r agent/requirements.txt` supplies the SDK):
오프라인 controller 검사는 Node 20·Python 3/PyYAML·boto3/botocore·Terraform 1.15.7·캐시된
provider가 필요하다. SDK는 `pip install -r agent/requirements.txt`로 설치한다.

```bash
node --test scripts/v2/ci/run-migration*.test.mjs
```

Merge Verify also runs the required runtime tests and disposable PostgreSQL integration suite.
The manual controller adds no product autonomy or DNS exception.
필수 runtime·PostgreSQL 통합 검사도 Merge Verify에서 실행하며 제품 자율 실행·DNS 예외는 추가하지 않는다.

## Verification / 확인

For a provisioned dev stack, the web workflow should build, pin, roll and pass the
Host/SNI-preserving smoke through `cloudfront_domain`, even before `public_url` resolves.
For production, dispatch Deploy Web from the reviewed main commit through the normal
environment approval. Health is process liveness, not proof that migrations/authenticated
routes work. Inspect certificate preflight and plan-gate output; a DNS refusal or moved
branch requires investigation and a fresh plan, never bypassing checks.

이미 준비된 스택은 서비스 DNS 없이 CloudFront 연결 스모크를 검증할 수 있다. 실제 기능은
마이그레이션·인증 경로까지 별도로 확인한다. DNS 차단·브랜치 이동 시 검사를 우회하지 않는다.

### Runtime probe capability / 런타임 검증 기능

For verify, apply `agentcore_enabled=true` and `ci_readiness_enabled=true`, then provision AgentCore.
Only applied output sets `DEPLOYMENT_READINESS_ENABLED`; false/missing yields `runtime_disabled`, ignoring shell overrides.
Also enable `steampipe_enabled=true`, `workers_enabled=true` and dispatch, and deploy inventory/ARM64
worker images as described in [worker deployment](../reference/06-workers.md).
검증 전 두 플래그를 적용하고 프로비저닝합니다. 환경변수 덮어쓰기나 그룹 권한은 부여하지 않습니다.
수집·워커 플래그와 디스패치를 활성화하고 인벤토리·ARM64 워커 이미지를 먼저 배포해야 합니다.

Runtime requests the exact CloudFront ID and an identity-only row; deploy Lambda and gateway schema first.
The web API scan remains capped at 500 rows. Failures distinguish `known_resource_unverified`,
`collection_partial`, `collection_failed`, `collection_missing` after waiting, and `inventory_incomplete`.
Degraded inventory never passes release readiness. 미발견은 부재 증명이 아니며 런타임은 지정 ID만 조회합니다.
웹 표본은 500행 제한이고 모든 수집 타입의 부분 실패·원장 누락·속성 미확인을 통과시키지 않습니다.

`SMOKE_RUNTIME_CONFIG_FILE` is an absolute 0600 JSON file beside credentials in the same 0700 directory;
cleanup covers both. Its 16 KiB cap, 30-minute verify window and unique type list including cloudfront are required.
The release controller must supply actual deployment/dispatch evidence; current Deploy Web remains DB-only.

`schemaVersion: 1`, `mode: "prepare"` and `expectedAccountId` check login/DB and the enabled host.
Optional `hostOnly: true` also rejects enabled members. Verify adds `expectedCloudfrontId`,
all acknowledged `expectedQueuedTypes` and the pre-dispatch `collectionStartedAt`, from applied
deployment and owned Lambda evidence. It requires fresh complete collection, web SSM/runtime calls
and succeeded Lambda/Fargate jobs. Missing/partial/stale is never healthy zero; deploy the updated
inventory-reader Lambda so legacy NULL attribute coverage is disclosed as incomplete.

`POST /api/deployment/readiness` requires an administrator or separately provisioned `deployment-verifiers`.
Release infrastructure grants the CI identity only verifier membership, never admin/IAM authority.
Use a fresh login after membership changes; one in-flight call and a 60-second process cooldown apply.

스모크 도구는 자격증명 파일과 같은 0700 디렉터리의 0600 JSON을
`SMOKE_RUNTIME_CONFIG_FILE`로 받으며 함께 정리합니다. 현재 Deploy Web은 DB 검증만
연결합니다. 전체 검증 controller가 실제 배포·Lambda 응답으로 파일을 생성해야 합니다.
prepare는 로그인·DB·활성 호스트를 확인하고 `hostOnly: true`일 때 외부 활성 계정을
거부합니다. verify는 위 추가 필드로 최신 수집·실제 SSM/runtime·두 워커 완료를 검증합니다.
검증 API는 관리자 또는 전용 verifier 그룹만 허용합니다. 이 앱 변경은 그룹을 만들지 않습니다. 배포 인프라가 CI 사용자를 verifier에만
연결해야 하며 관리자·IAM 역할을 주지 않습니다. 그룹 변경 후 새 로그인과 호출 간격이 필요합니다.

### Authenticated database verification / 인증된 DB 검증

After the required database migrations succeed, run **Deploy Web** on `dev` with
`verify_database=true`. Before dispatch, ensure the reviewed Terraform saved-plan apply
has persisted the new **`demo_username` output** in dev state. A plan alone does not
persist it. The restored `TF_TFVARS_DEV` must enable `create_demo_user=true`, and its
effective `demo_email` must exactly match that applied username.

The credential must match the existing user's deployed password. Deploy Web uses
Terraform **1.15.7** to evaluate the restored configuration: the repository secret
`TF_VAR_DEMO_PASSWORD` is supplied as the lowercase environment variable
`TF_VAR_demo_password`, a shared **default**. A protected per-stack `demo_password`
assignment in `TF_TFVARS_DEV` takes precedence, including when the shared secret is
absent. With no override, the shared default is used. An explicitly empty override
does not fall back to the shared secret.

Before image pinning or ECS rollout, preparation rejects missing/malformed configuration,
disabled demo users, missing/invalid applied output, identity mismatch and empty/invalid
credentials. Terraform stdout/stderr stay private; inherited `TF_LOG*` and `TF_CLI_ARGS*`
are removed from preparation subprocesses. Only a path crosses steps: the credential
file is `0600` inside a `0700` directory under `RUNNER_TEMP` and is removed after use or by
always-run cleanup if rollout fails or is cancelled. The CLI creates its login-body, cookie and
response scratch files inside that same directory, so the cleanup also covers a killed smoke.
Standalone smoke calls prefer `RUNNER_TEMP` as well. Only validated numeric HTTP statuses
may accompany phase errors; response bodies, cookies and Terraform diagnostics stay private.

```bash
# After successful migration; use the already-built image for this reviewed dev HEAD:
gh workflow run deploy-web.yml -R aws-samples/sample-awsops --ref dev -f verify_database=true
# If this HEAD's web image still needs building, use this instead:
gh workflow run deploy-web.yml -R aws-samples/sample-awsops --ref dev -f build=true -f verify_database=true
```

Require ECS stability and the normal `/api/health` smoke, then **POST `/api/auth/login`**
with HTTP **200**, boolean **`ok: true`** and a usable secure host-specific
**`awsops_token`** cookie. The subsequent authenticated **GET `/api/db`** must return HTTP
**200**, **`status: "ok"`** and a **positive safe-integer `public_tables`**. Both requests
retain service Host/SNI and TLS verification through CloudFront; neither follows
redirects. These checks verify login and the BFF's database connection/table presence,
not the entire migration ledger. `verify_database=false` retains the ordinary health-only
deployment path.

A configured credential can still be stale: only the post-rollout login validates the
actual password. If login fails, inspect the existing identity and protected credential
source without exposing response bodies, passwords or cookies. **Never reset an existing
user's password to make this smoke pass.** This workflow does not create users or set
passwords.

필수 DB 마이그레이션 성공을 확인한 후 `dev`의 **Deploy Web**을
`verify_database=true`로 실행한다. 먼저 검토한 Terraform 저장 plan을 실제 apply하여
개발 state에 `demo_username` 출력을 저장해야 한다. plan만으로는 저장되지 않는다.
복원되는 `TF_TFVARS_DEV`는 `create_demo_user=true`여야 하며 유효 `demo_email`이
적용된 사용자명과 정확히 같아야 한다. 사용할 암호는 기존 사용자의 실제 암호와 일치해야 한다.

Terraform **1.15.7**이 변수 우선순위를 직접 평가한다. 저장소 시크릿
`TF_VAR_DEMO_PASSWORD`는 소문자 환경변수 `TF_VAR_demo_password`로 공유 기본값을
전달하며, 보호된 스택별 tfvars의 `demo_password`가 우선한다. 공유 시크릿 없이 override만
있는 구성과 override 없이 공유 기본값만 있는 구성을 모두 지원한다. 빈 override는 공유값으로
대체하지 않는다. 설정 오류·demo 비활성·적용 출력 누락·사용자 불일치·빈/잘못된 암호는 이미지
pin·ECS rollout 전에 실패한다. Terraform 출력과 오류는 비공개로 처리하고 `TF_LOG*`·
`TF_CLI_ARGS*`를 제거한다. 단계 간에는 경로만 전달하며 `0700` 디렉터리의 `0600` 암호 파일은
사용 후 또는 실패·취소 시 항상 실행되는 cleanup으로 삭제한다. CLI의 로그인 본문·쿠키·응답
임시 파일도 같은 디렉터리 안에 두므로 smoke가 강제 종료돼도 해당 정리 범위에 포함된다.
독립 smoke 실행도 `RUNNER_TEMP`를 우선하며 공개 오류에는 단계와 검증된 HTTP 상태만 표시한다.

ECS 안정화와 `/api/health` 성공에 이어 실제 `POST /api/auth/login`의 HTTP 200,
`ok: true`, 유효한 secure·호스트 전용 `awsops_token` cookie를 요구한다. 그 cookie로
`GET /api/db`가 HTTP 200, `status: "ok"`, 양의 안전 정수 `public_tables`를 반환해야
완료된다. CloudFront 연결에서도 Host/SNI·TLS 검증을 유지하며 redirect를 따라가지 않는다.
전체 migration ledger 검증은 아니며 기본 `verify_database=false` 배포는 기존 health 검사만
수행한다. 실제 암호의 유효성은 rollout 후 로그인에서 확인한다. 실패하면 기존 사용자와 보호된
암호 공급원을 비공개로 확인하고, **검사를 통과시키려고 기존 사용자 암호를 재설정하지 않는다.**
이 워크플로는 사용자를 생성하거나 암호를 설정하지 않는다.

Troubleshoot by phase and safe status: login 401 points to the configured credential; 403 to
Cognito user/challenge state; 502 to its upstream connection. Database 503 points to missing
service configuration; 500 to database credentials, IAM or connectivity. A transport/TLS failure
may have no HTTP response. Inspect private application logs; never print response bodies or
reset a password to make a check pass. Opt-in preparation performs its own bounded private
Terraform init (10 minutes) before output/console (2 minutes each); it must finish before
image pinning or rollout.
로그인 401은 설정된 자격증명, 403은 Cognito 사용자/인증 상태, 502는 상위 연결을 확인한다.
DB 503은 서비스 설정, 500은 DB 자격증명·IAM·연결을 확인한다. 전송/TLS 오류에는 HTTP
응답이 없을 수 있다. 비공개 앱 로그로 조사하고 응답 본문을 출력하거나 암호를 재설정하지 않는다.
선택적 준비 단계는 비공개 Terraform init을 10분 내 완료한 뒤 output/console을 각각 2분 내 읽으며,
이미지 pin·rollout은 그 이후에만 진행한다.

Offline checks for this path (Node 20, curl, OpenSSL, Python 3 with PyYAML, and Terraform 1.15.7):

```bash
node --test scripts/v2/deployment-smoke.test.mjs
```

The deployment smoke suite evaluates a small offline Terraform variable fixture;
its backend/state and HTTP boundaries are substituted, with no AWS/provider calls.
배포 smoke 테스트는 작은 오프라인 Terraform 변수 fixture를 실제 평가하며 backend/state·
HTTP 경계를 대체하므로 AWS·provider 호출을 수행하지 않는다.

### Offline deployment checks / 오프라인 배포 검사

Install test dependencies once with `python3 -m pip install -r scripts/v2/requirements-test.txt`.
Use Node.js 20, OpenSSL, and Terraform **1.15.7**. For offline provider initialization, set
`TF_CLI_CONFIG_FILE` to a filesystem-mirror configuration with the locked providers and no
`direct` fallback. The checks use mocked providers and a localhost-only HTTP state backend.
`terraform-test.sh` copies **tracked working-tree files only** into a disposable directory
(including relative archive sources), creates a fresh `TF_DATA_DIR`, and executes
`terraform init -backend=false -input=false -lockfile=readonly`, `validate`, then the mock
test. It strips deployment credentials/TF variables and never copies local backend config,
state or `.terraform`. Run these commands from the repository root:

```bash
CHECKPOINT_DISABLE=1 python3 -m pytest -q scripts/v2/test_ci_*.py
node --test scripts/v2/deployment-smoke.test.mjs
bash scripts/v2/terraform-test.sh
```

테스트 의존성은 `python3 -m pip install -r scripts/v2/requirements-test.txt`로 설치한다.
Node.js 20·OpenSSL·Terraform 1.15.7을 사용하며, 완전 오프라인 환경은 잠긴 provider가 있는
filesystem mirror와 direct 폴백 없는 `TF_CLI_CONFIG_FILE`을 준비한다. 위 명령은 provider mock과
localhost 상태 서버만 사용한다. Terraform 도우미는 추적된 작업 파일만 임시 디렉터리에 복사하고
새 `TF_DATA_DIR`에서 `init -backend=false`·validate·test를 실행한다. 배포 자격증명·TF 변수와
로컬 backend 설정·상태·`.terraform`을 사용하지 않는다.

### Saved-plan asset utility / 저장 계획 asset 도구

**Symptom / 증상:** a saved plan references Lambda ZIPs missing from the apply runner.
Plan-time archive-file outputs may not be recreated under a saved-plan apply. 저장 계획의 ZIP이 새
runner에 없으면 apply 중 자동 재빌드를 기대하지 말고 준비·전달 경로를 점검합니다.

Both Terraform layer builds and CI preparation use the same hash-locked installer; CI-prepared
layers are checked without reinstalling when `CI_ASSETS_READY=true`. Prepare invalidates its old
marker and removes stale ZIP files before planning, rejecting ZIP symlinks. Validation checks
the fixed required-import list and all installed file hashes.
Pack requires every ZIP with a known hash inside `terraform show -json tfplan`, verifies its bytes,
then authenticates plan/SHA/scope, paths, modes and hashes with `TF_PLAN_ENC_KEY` HMAC.
Missing planned ZIPs and unknown ZIP hashes fail closed; deferred archives without known hashes
are excluded. Pack/restore accept only push, pull_request and workflow_dispatch GitHub events,
including when called as Python APIs; local callers supply an explicit commit without an event.
Other events fail before work. Existing explicit plan/apply dispatches retain their SHA binding.
Real targeted plans omit untargeted Lambda resources from planned_values even when prior_state
retains them; their old ZIPs are not required. Keep the known-planned-ZIP completeness check.
The 0600 `tfassets.tar.gz` is private scratch, like the plaintext plan. It can contain rendered
Cognito signing keys and **must never be uploaded**. The utility has no upload path; the integrating
Terraform workflow encrypts it and cleans plaintext scratch; plan/apply now wire pack/restore,
and Terraform layer provisioners use the locked installer.
Terraform과 CI는 같은 해시 고정 설치기를 사용하며 CI asset은 재설치 없이 검사합니다.
기존 marker는 변경 전에 무효화하고 이전 ZIP을 제거하며 ZIP 심볼릭 링크를 거부합니다.
설치 파일 해시와 고정 import 목록을 검증합니다.
계획 내부 해시가 알려진 ZIP은 모두 존재하고 일치해야 하며, 해시 미확정 지연 archive는 제외합니다.
GitHub에서는 push·pull_request·workflow_dispatch만 허용하며 Python API에도 같은 규칙을 적용합니다.
로컬 호출은 이벤트 없이 명시적 커밋을 전달합니다. 타깃 계획의 planned_values에 없는 기존 Lambda의
ZIP은 요구하지 않으며, 실제 계획에 알려진 ZIP의 누락 검사는 유지합니다.
ZIP을 확인한 뒤 HMAC을 계산합니다. 평문 tar에는 렌더링된 서명키가 포함될
수 있으므로 0600 비공개 임시 파일로만 취급하고 호출 workflow가 암호화·정리해야 합니다.
Terraform plan/apply가 pack/restore를 연결하며 레이어 설치기도 같은 lock을 사용합니다.

From the repository root, test with `python3 -m pytest scripts/v2/test_ci_tf_assets.py -q`.
The Terraform workflow supplies the secret without CLI arguments. Run from the foundation root,
with a reviewed plan/source SHA and trusted flags; pack happens after Terraform creates ZIPs:
루트에서 테스트합니다. 통합 CI가 시크릿을 공급하고 plan이 ZIP을 만든 뒤 pack해야 합니다.

```bash
cd terraform/foundation
# Trusted configuration, before plan:
printf '%s' '{"steampipe_enabled":true,"workers_enabled":true}' | python3 ../../scripts/v2/ci_tf_assets.py prepare --scope full
# After a reviewed tfplan exists; GITHUB_SHA and TF_PLAN_ENC_KEY must already be set:
python3 ../../scripts/v2/ci_tf_assets.py pack --scope full
# After the Terraform workflow encrypts/transports/decrypts both private files:
python3 ../../scripts/v2/ci_tf_assets.py restore --scope full
python3 ../../scripts/v2/ci_tf_assets.py check-layer --layer inv_layer # only if inventory is enabled
python3 ../../scripts/v2/ci_tf_assets.py check-layer --layer pg8000_layer # only if workers are enabled
# Controller only, after the existing identity/review/DNS gates approve this saved plan:
CI_ASSETS_READY=true terraform apply -input=false tfplan
# The Terraform workflow's always-cleanup removes its own plaintext plan/bundle/staging.
```

Missing/mismatched authentication, plan or content requires a fresh reviewed plan/bundle,
not rebuilding under an old approval. See `scripts/v2/ci_tf_assets.py`,
`scripts/v2/ci/pg8000-requirements.txt` and `scripts/v2/test_ci_tf_assets.py`.
Key rotation also invalidates existing signed bundles. Dependency updates must change the lock,
its verified wheel hashes and the four shared-layer pins in
`scripts/v2/{workers,steampipe,incident,remediation}/requirements.txt`; the validator checks all five.
The separate `scripts/v2/steampipe/Dockerfile` image pin/installer is outside the Lambda lock.
See [worker build inputs](../reference/06-workers.md).
Check `LAYER_IMPORTS` when updating wheels. A killed restore may retain a private previous-build
directory; retrying a verified restore is safe. Its integrating job owns later cleanup, after
the retained copy is no longer needed. Never blindly delete another job's staging directory.
시크릿 교체 시 기존 bundle도 무효화됩니다. 의존성 변경은 lock·wheel 해시와
workers/steampipe/incident/remediation의 네 requirements pin을 함께 갱신하며 다섯 pin을 검사합니다.
별도 Steampipe Dockerfile의 이미지 pin·설치기는 Lambda lock 밖입니다.
불일치는 새 검토 계획/bundle로 해결합니다. 제품 변경 경계는 ADR-005를 따릅니다.
wheel 변경 때 LAYER_IMPORTS도 확인합니다. 중단된 복원의 비공개 백업은 검증된 재시도로 복구할 수
있으며, 더 이상 필요 없을 때 해당 작업이 정리합니다. 다른 작업의 staging은 임의로 삭제하지 않습니다.

Related ADRs / 관련 ADR: **ADR-002** (edge authentication/private HTTPS boundaries),
**ADR-005** (operator CI migration versus product AWS-resource mutation/autonomy), and
**ADR-016** (domain/certificate cutover). Manual CI writes the database schema using its
scoped credentials; it enables no product AWS-resource mutation/autonomy or DNS exception.
수동 CI는 제한된 자격증명으로 DB schema를 변경하며 제품의 AWS 리소스 변경·자율 실행이나
DNS 예외를 활성화하지 않는다.
The separately opted-in manual diagnostics step is read-only under ADR-005: no database
connection, AWS-resource mutation, autonomous remediation, or relaxation of readiness gates.
별도로 선택한 수동 진단은 ADR-005의 읽기 전용 범위이며 DB 연결·AWS 리소스 변경·자율 복구나
준비 상태 검사 완화를 허용하지 않는다.
