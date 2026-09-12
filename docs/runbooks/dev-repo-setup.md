# CI/OIDC bring-up (single repo) / CI·OIDC 활성화 (단일 리포)

Related files / 관련 파일: `.github/workflows/{deploy-web,deploy-preview,terraform,deploy-agentcore}.yml`,
`docs/runbooks/branch-strategy.md`, `.github/workflows/pr-review.yml`,
`scripts/v2/ci_review_access.py`

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
- AI review waits for a protected-environment approval or fails `AssumeRoleWithWebIdentity`.

(dev push 런이 자격증명/시크릿/ECR pin 단계에서 실패하는 경우 — 아래 1회성 작업이
아직 안 된 것입니다. AI 리뷰가 보호 환경 승인 대기 또는 역할 인증 실패로 멈추는 경우도 포함합니다.)

## Cause / 원인

The pipeline definitions are complete; four one-time account/infra steps remain
outside what repo automation can do for itself.
(파이프라인 정의는 완성돼 있고, 리포 자동화가 스스로 할 수 없는 1회성 계정/인프라
작업 4개가 남아 있습니다.)

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
The workflow gives every Claude panel lens (L2–L5) two 1200-second attempts,
while Codex retains two 300-second attempts. The panel and chair have a 10-second
hard-kill grace. The job ceiling is 90 minutes. After Git/CLI/prompt preparation,
immediately before the panel and again immediately before chair synthesis, the same OIDC
role obtains a fresh one-hour session; its permissions and maximum session duration
are unchanged. Failed or timed-out chair output cannot supply a successful verdict.
Missing/failed model cells remain blocking; all four lenses need both vendors.

(워크플로에서 Claude 패널의 모든 렌즈(L2–L5)는 1200초씩, Codex는 300초씩 최대 두 번 실행합니다.
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
`TF_VAR_DEMO_PASSWORD` repo secret, exported by terraform.yml as
`TF_VAR_demo_password` on the plan step only). `create_demo_user` defaults to
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
| all stacks (repo-wide) | `TF_PLAN_ENC_KEY` (plan-artifact encryption) / `TF_VAR_DEMO_PASSWORD` (demo user) / role-ARN secrets `AWS_CI_BUILD_ROLE_ARN` · `AWS_CI_BUILD_DEV_ROLE_ARN` · `AWS_CI_DEPLOYER_ROLE_ARN` · `AWS_CI_DEPLOYER_DEV_ROLE_ARN` · `AWS_CI_TERRAFORM_PLAN_ROLE_ARN` · `AWS_CI_REVIEW_ROLE_ARN` (moved from repo variables — public-repo logs never mask variables) |
| production (`main`) | `TF_BACKEND_HCL` / `TF_TFVARS` |
| dev (`awsops-dev.whchoi.net`) | `TF_BACKEND_HCL_DEV` / `TF_TFVARS_DEV` |
| user branch `atomoh`/`ssminji`/`whchoi` (`<user>.awsops-dev.whchoi.net`) | `TF_BACKEND_HCL_PREVIEW_<USER>` / `TF_TFVARS_PREVIEW_<USER>` (uppercased branch name) |

```bash
gh secret set TF_BACKEND_HCL_DEV -R aws-samples/sample-awsops \
  --body "$(base64 -w0 terraform/foundation/backend.hcl)"
gh secret set TF_TFVARS_DEV -R aws-samples/sample-awsops \
  --body "$(base64 -w0 terraform/foundation/terraform.tfvars)"
```

The distinct NAMES are the isolation: a dev/preview job can never fall back to the
production pair. From then on, terraform changes flow through `terraform.yml`
(automatic plan on PR/push; saved-plan apply via dispatch, gated by the branch's
environment — `production` carries the reviewer approval).
(시크릿 이름 분리가 격리 그 자체입니다 — dev/preview 잡은 production 시크릿으로
폴백할 수 없습니다. 이후 변경은 terraform.yml로: PR/push 자동 plan, dispatch
저장-plan apply — main은 production environment 승인 게이트가 추가됩니다.)

### 4. ECR permissions for the pin step / ci-deployer ECR 권한

The deploy jobs re-point `:web-latest` at the approved `web-<sha>` before rolling,
so each deployer role needs `ecr:BatchGetImage` + `ecr:PutImage` scoped to its own
stack's web ECR repository (plus the auth-token action it already has).
(각 deployer 역할에 자기 스택 web ECR 스코프의 `ecr:BatchGetImage`·`ecr:PutImage`
권한이 필요합니다.)

### 5. Deploy while DNS changes are deferred / DNS 변경 보류 상태의 배포

`Terraform` dispatch defaults to `mode=plan` and `allow_dns_changes=false`.
For a new stack, a DNS-free full plan needs two already-issued public ACM
certificates: one in `us-east-1` covering the service and additional aliases,
and one in the stack Region covering the origin hostname. Both must belong to
the deployment account. CI checks validity, hostname coverage and the public CA
chain, then supplies their ARNs to Terraform. Explicit
`existing_cf_certificate_arn` / `existing_alb_certificate_arn` inputs can select
certificates. A missing or unverifiable pair stops a DNS-free full dispatch.

새 스택을 DNS 변경 없이 배포하려면 이미 발급된 인증서 두 개가 필요하다.
CI가 인증서의 계정·리전·유효 기간·호스트 이름·공개 CA 체인을 검증한다.
서비스 A 레코드와 인증서 검증 CNAME은 모두 생성하지 않으며, 계획에 DNS
생성·수정·삭제가 하나라도 있으면 적용을 거부한다. 내부 ALB와 HTTPS 경로는
유지한다. 자동 PR 계획의 인증서 가용성 표시는 읽기 전용 사전 점검이며,
실제 DNS-free 배포 가능 여부는 명시적 dispatch에서 검증한다.

```bash
gh workflow run terraform.yml -R aws-samples/sample-awsops --ref dev \
  -f mode=plan -f plan_scope=full \
  -f allow_dns_changes=false -f publish_service_dns=false
```

Inspect the completed run, its resource changes and commit. Set `PLAN_RUN_ID` to
that successful run's numeric ID, then apply its encrypted saved plan:

완료된 실행의 커밋과 리소스 변경을 확인한 뒤, `PLAN_RUN_ID`에 검토한 성공
실행의 숫자 ID를 지정하고 저장된 계획을 적용한다.

```bash
gh workflow run terraform.yml -R aws-samples/sample-awsops --ref dev \
  -f mode=apply -f plan_run_id="$PLAN_RUN_ID" -f allow_dns_changes=false
```

Apply accepts only a successful Terraform push/dispatch run from the same
repository, stack branch and commit. It checks the live branch again and
rechecks DNS changes after decrypting the plan. A moved branch requires a fresh
plan. `plan_scope=ecr-bootstrap` is available for an initial plan limited to the
web ECR repository; apply a full reviewed plan before rolling the service.

적용은 같은 저장소·스택 브랜치·커밋의 성공한 Terraform push/dispatch 계획만
허용한다. 브랜치가 이동하면 새 계획이 필요하다. ECR 초기 준비만 필요한
경우 `plan_scope=ecr-bootstrap`을 사용하고, 서비스 배포 전에 전체 계획을
별도로 검토·적용한다.

The web rollout smoke test connects to `cloudfront_domain` with curl
`--connect-to` while requesting `public_url`. This preserves the service Host,
SNI and certificate verification before service DNS is published. `/api/health`
checks process liveness; complete the required database migrations and verify
authenticated application routes separately.

웹 배포 스모크 테스트는 `public_url`의 Host·SNI·인증서 검증을 유지하면서
CloudFront 연결 주소로 요청한다. `/api/health`는 프로세스 생존 확인이므로,
필수 DB 마이그레이션과 인증된 실제 기능 검증도 수행해야 한다.

## Verification / 확인

Push a trivial `web/**` change to `dev`: the run should build, pin, roll and pass
the smoke against `awsops-dev.whchoi.net/api/health` end-to-end. For production:
merge `dev → main`, dispatch Deploy Web from main, approve, and watch the smoke
against the `public_url` output.
