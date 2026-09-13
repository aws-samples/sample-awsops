# CI/OIDC bring-up (single repo) / CI·OIDC 활성화 (단일 리포)

Related files / 관련 파일: `.github/workflows/{deploy-web,terraform,deploy-agentcore,deploy-migrations}.yml`,
`docs/runbooks/branch-strategy.md`, `.github/workflows/pr-review.yml`,
`scripts/v2/ci_review_access.py`, `scripts/v2/ci_dns_policy.py`, `scripts/v2/ci_plan_context.py`,
`scripts/v2/deploy.mjs`, `scripts/v2/deployment-smoke.mjs`,
`scripts/v2/ci/run-migration.mjs`, `terraform/foundation/ci-migrations.tf`,
`terraform/foundation/tests/dns_deferred.tftest.hcl`, `docs/reference/01-edge-network.md`

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
- the build reports `Cannot access the web ECR repository` (§4–5).

(dev push 런이 자격증명/시크릿/ECR pin 단계에서 실패하는 경우 — 아래 1회성 작업이
아직 안 된 것입니다. AI 리뷰가 보호 환경 승인 대기 또는 역할 인증 실패로 멈추는 경우도 포함합니다.)

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

Nonsecret dev repository variables are `DOMAIN_NAME_DEV` / `HOSTED_ZONE_NAME_DEV` (paired names),
`CERTIFICATE_MODE_DEV` (`preserve` by default), and `CI_MIGRATIONS_ENABLED_DEV` (`false` by default).
These select reviewed deployment behavior; credentials stay in the secrets above.
dev의 일반 저장소 변수는 도메인/존 이름 쌍, 기본 `preserve`인 인증서 모드, 기본 `false`인
`CI_MIGRATIONS_ENABLED_DEV`이다. 배포 선택값이며 자격증명은 위 시크릿에 유지한다.

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
`domain_rollout=false`. Ordinary full plans keep the existing broad DNS policy:
Cloud Map/registered ECS changes require explicit DNS permission on both plan and apply.
For a dev service-domain rollout, use the [staged domain runbook](dev-domain-rollout.md)
and set **`domain_rollout=true` on every domain-stage plan dispatch** (`dev` / `full` only).
The declared default-false Terraform metadata variable `ci_domain_rollout` is embedded
in the saved plan; apply derives scoping from that marker, not current repository
variables or an apply input. The scoped policy allows only the selected zone's configured
service A/ACM CNAME records; it does not authorize old/parent DNS or Cloud Map changes.

dispatch 기본값은 `mode=plan`, DNS 허용 false, `domain_rollout=false`다. 일반 full 계획의
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
Repeat the same `plan_scope` on apply; the apply gate checks that scope too.
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
runs `make migrate` first and offers `smoke=true` for an agent invocation; neither that
invocation nor `/api/health` substitutes for a web-login/database check before service A publication.

웹 배포 스모크 테스트는 `public_url`의 Host·SNI·인증서 검증을 유지하면서
CloudFront 연결 주소로 요청한다. `/api/health`는 프로세스 생존 확인이므로,
필수 DB 마이그레이션과 인증된 실제 기능 검증도 수행해야 한다.
웹 워크플로와 `make deploy` 모두 공통 CLI로 주소를 검증하며 셸 문자열 대신 인자 배열을 사용한다.

The DNS/provenance scripts run from the deployment ref. They are safety checks for reviewed
code, not a security boundary against changes to that ref; normal review and environment
protections remain required.
DNS·출처 검사도 배포 ref의 코드이므로 코드 변경에 대한 보안 경계를 대신하지 않는다.
기존 리뷰·보호 환경 절차를 계속 적용한다.

## Private development database migration / 비공개 개발 DB 마이그레이션

**Symptom / 증상:** a newly provisioned private Aurora has no application tables, or the
external Actions runner cannot connect to its private endpoint. Deploy Web does not initialize
the database. Use **Migrate Development Database** (`deploy-migrations.yml`), a manual-only
workflow restricted to this samples repository's `dev` branch. It builds an ARM64 image and
runs one Fargate task in the existing private subnets with the existing service security group.

새 Aurora에 앱 테이블이 없거나 외부 Actions runner가 비공개 endpoint에 연결하지 못하면
`dev` 전용 **Migrate Development Database**를 사용한다. Deploy Web은 DB 초기화를 하지 않는다.
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
3. Confirm the existing dev build/deployer OIDC roles and backend secrets are configured.
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
secret을 준비한다. `TF_TFVARS_DEV`의 project 문자열은 최대 한 번만 지정하며,
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

Offline controller checks require Node 20, Python 3 with PyYAML, Terraform 1.15.7 and cached providers:
오프라인 controller 검사는 Node 20·Python 3/PyYAML·Terraform 1.15.7·캐시된 provider가 필요하다.

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

Related ADRs / 관련 ADR: **ADR-002** (edge authentication/private HTTPS boundaries),
**ADR-005** (operator CI migration versus product AWS-resource mutation/autonomy), and
**ADR-016** (domain/certificate cutover). Manual CI writes the database schema using its
scoped credentials; it enables no product AWS-resource mutation/autonomy or DNS exception.
수동 CI는 제한된 자격증명으로 DB schema를 변경하며 제품의 AWS 리소스 변경·자율 실행이나
DNS 예외를 활성화하지 않는다.
