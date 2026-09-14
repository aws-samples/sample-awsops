<a id="cioidc-bring-up-single-repo--cioidc-활성화-단일-리포"></a>

# CI/OIDC bring-up (single repo)

<!-- Legacy fragment anchors preserve incoming links; visible guidance is English. -->

<a id="related-files--관련-파일"></a>

## Related files

`.github/workflows/{deploy-web,terraform,deploy-agentcore,deploy-migrations}.yml`,
`docs/runbooks/branch-strategy.md`, `.github/workflows/pr-review.yml`,
`scripts/v2/ci_review_access.py`, `scripts/v2/ci_dns_policy.py`, `scripts/v2/ci_plan_context.py`,
`scripts/v2/ci_private_plan.py`, `scripts/v2/test_ci_private_plan.py`,
`scripts/v2/test_ci_private_plan_workflow.py`, `scripts/v2/ci_plan_inspect.py`, `scripts/v2/ci_readiness_plan_summary.py`,
`scripts/v2/test_ci_readiness_plan_summary.py`,
`scripts/v2/ci_failure_diagnostics.py`,
`scripts/v2/ci_db_diagnostics.py`, `scripts/v2/test_ci_db_diagnostics.py`,
`scripts/v2/ci_tf_assets.py`, `scripts/v2/ci/pg8000-requirements.txt`,
`scripts/v2/test_ci_tf_assets.py`, `docs/reference/06-workers.md`,
`scripts/v2/deploy.mjs`, `scripts/v2/deployment-smoke.mjs`,
`scripts/v2/prepare-smoke-credentials.mjs`, `scripts/v2/authenticated-smoke.mjs`,
`terraform/foundation/outputs.tf` (`demo_username`),
`scripts/v2/ci/run-migration.mjs`, `terraform/foundation/ci-migrations.tf`,
`terraform/foundation/controller-readiness.tf`, `terraform/foundation/tests/controller_readiness.tftest.hcl`,
`terraform/foundation/tests/dns_deferred.tftest.hcl`, `docs/reference/01-edge-network.md`,
`docs/reference/03-data-aurora.md`

> Historical note: this file previously described the two-repo split
> (`Atom-oh/sample-awsops-dev`). The project consolidated into the single public
> repo `aws-samples/sample-awsops` (all branches public by design — see
> branch-strategy.md); the private repo is retired/archived.

<a id="symptoms--증상"></a>

## Symptoms

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

<a id="cause--원인"></a>

## Cause

The five sections below cover runner/identity/configuration prerequisites, ECR access,
and deployment with DNS deferred. Missing issued certificates, a DNS-changing plan,
or a moved branch intentionally stop the deployment.

<a id="action--조치"></a>

## Action

<a id="1-runner--러너"></a>

### 1. Runner

The `sample-awsops` self-hosted runner is already registered to this repo (it has
been running the main-branch pipelines). Nothing to do unless runs queue forever.

<a id="2-ci-roles--github-oidc-trust-matrix--ci-역할신뢰-매트릭스"></a>

### 2. CI roles + GitHub OIDC trust matrix

All roles live in the samples deployment account and trust the GitHub OIDC
provider with a `sub` condition — never the repo-wide `:*` wildcard, which would
let ANY branch (including an experiment branch with an edited workflow) assume the
mutation roles. Role-to-sub matrix:

| Role | Used by | Trust `sub` | Permissions scope |
|---|---|---|---|
| `sample-awsops-ci-build` | main build (no environment) | StringEquals `repo:aws-samples/sample-awsops:ref:refs/heads/main` | prod ECR push |
| `sample-awsops-ci-deployer` | main roll / apply / private-plan publication / agentcore (jobs carry `environment: production`) | StringEquals `repo:aws-samples/sample-awsops:environment:production` | prod ECS/ECR-pin/apply + AgentCore control plane, including `GetGateway`; publication also requires scoped S3/KMS permissions below |
| `sample-awsops-dev-ci-build` | dev + user-branch builds (no environment) | StringLike, one entry per branch: `...:ref:refs/heads/dev`, `...:ref:refs/heads/atomoh`, `...:ref:refs/heads/ssminji`, `...:ref:refs/heads/whchoi` | dev + user stacks' ECR push |
| `sample-awsops-dev-ci-deployer` | dev + user-branch rolls/apply/private-plan publication, dev agentcore (jobs carry `environment: development`) | StringEquals `repo:aws-samples/sample-awsops:environment:development` | dev + user stacks' ECS/ECR-pin/apply + AgentCore control plane, including `GetGateway`; scoped S3/KMS publication permissions — **never production** |
| `sample-awsops-ci-terraform-plan` | plan (PR/push incl. user-branch own-stack plans, read-only) | StringLike: `...:pull_request` + refs `main`, `dev`, `atomoh`, `ssminji`, `whchoi` | ReadOnlyAccess |
| `sample-awsops-ci-review` | AI pr-review | StringEquals: verified subject prefix + environments `ci-review-auto` / `ci-review-recovery`, or legacy refs `main` / `dev`; no bare `pull_request` subject | Bedrock / Mantle policies — inspect actual permissions before approval |

CRITICAL sub rule: **a job that declares `environment:` presents the
`repo:<owner>/<repo>:environment:<name>` sub — NOT its branch ref.** Deployer
roles must therefore trust the environment sub (pinning them to a branch ref
makes every deploy fail AssumeRoleWithWebIdentity). Which branches can reach an
environment is enforced by the environment's own deployment branch policy
(`production` → main only; `development` → dev, atomoh, ssminji, whchoi).
Build and read-only plan jobs carry no environment and present branch-ref subs.
Manual plan dispatches also enter the branch environment for private publication:
the existing deployer role is restricted by an S3/KMS-only session policy.
Main publication waits for production approval, as does its separate apply dispatch. Fork PRs can
never mint tokens (GitHub withholds id-token from forks) and `terraform.yml`
skips non-same-repo PRs outright.

The former `sample-awsops-dev-ci-preview` role and `deploy-preview.yml` are
RETIRED — user branches are standing branches with continuous deploy, covered by
the dev-tier roles above.

<a id="review-ci-protection-and-recovery--리뷰-ci-보호복구"></a>

#### Review CI protection and recovery

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

Run the following recovery commands in order in the same shell so the private directory
and reviewed PR/SHA variables remain bound to that operation.

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

<a id="3-per-stack-terraform-secrets--스택별-tf-시크릿"></a>

### 3. Per-stack terraform secrets

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

Saved plans and rendered assets can contain credentials. Manual plans use the configured private, versioned SSE-KMS backend bucket under a separate `ci/tfplans/` prefix. The read-only plan job validates/HMAC-packs assets and stages an attempt-specific encrypted handoff for a protected publisher. The publisher uses the existing deployment role with an S3/KMS-only session, verifies/decrypts the handoff and stores pinned plan/assets plus a private manifest. It then replaces the GitHub handoff with a nonsecret reference. No new bucket, key or IAM allow is created by this flow. Automatic PR/push plans retain required asset validation but upload no saved-plan handoff.

`TF_PLAN_ENC_KEY` stays inside CI for the temporary handoff, asset HMAC and existing failure capsules. Operators inspect the S3 plan through IAM/KMS without that client key. Rotation still requires the matching key for historical signed bundles; never put it in argv or logs.

| Channel | Contents and conditions |
|---|---|
| `tfplan-<attempt>` | Initially an encrypted one-day handoff; successful publication overwrites it with only `reference.json` for five days. The reference has source/digest metadata, no bucket/account/ARN/version/private values. |
| Private S3 | Exact plan and HMAC-authenticated assets protected by SSE-KMS, pinned versions/checksums and a private manifest. Publication requires plan-prefix lifecycle. Seven-day current expiration is followed by seven-day noncurrent expiration; S3 deletion is asynchronous. Reference expiry does not delete objects or authorize stale apply. |
| `terraform-failure-<phase>-<attempt>` | One validated ciphertext file for an explicit failed/cancelled dispatch, five-day artifact retention. Local ciphertext is deleted only after confirmed upload success; failed/cancelled/skipped uploads retain it privately. |
| Job log and step summary | Fixed command/capture/retention classifications, subsequent upload/cleanup status and numeric Terraform success action counts; no raw command output or arbitrary `Error:` text. Advisory PR/push failures are classified but retain no raw log. |

This applies to main, dev and supported user branches. Use [private exact-plan inspection](#private-exact-plan-inspection) before approval and [encrypted failure recovery](#encrypted-failure-recovery) for a specific failed attempt. The inspector authenticates before rendering and never applies. Captured Terraform and pre-apply scope-check children do not receive GitHub command-file/token variables, encryption keys, `TF_LOG*` or `TF_CLI_ARGS*`; their AWS STS credentials, including `AWS_SESSION_TOKEN`, remain. Captured output and its sealing payload stay in memory and reach OpenSSL through stdin. The Linux child runs in a separate session: one interrupt requests graceful shutdown, a second kills its process group, and parent death kills the Terraform process. Storage/sealing/publication failures are distinct and do not replace the command exit or authorize a retry. A valid pointer identifies only the parent's owned ciphertext, never an arbitrary runner file. Abrupt runner termination can prevent retention or its final audit.

Then register the generated files (base64) as repo secrets:

| Stack | Secrets |
|---|---|
| all stacks (repo-wide) | `TF_PLAN_ENC_KEY` (saved-plan/failure-capsule encryption, private asset HMAC and a separate failure HMAC domain; rotation requires the matching key for old bundles) / `TF_VAR_DEMO_PASSWORD` (demo user) / role-ARN secrets `AWS_CI_BUILD_ROLE_ARN` · `AWS_CI_BUILD_DEV_ROLE_ARN` · `AWS_CI_DEPLOYER_ROLE_ARN` · `AWS_CI_DEPLOYER_DEV_ROLE_ARN` · `AWS_CI_TERRAFORM_PLAN_ROLE_ARN` · `AWS_CI_REVIEW_ROLE_ARN` (moved from repo variables — public-repo logs never mask variables) |
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

The manual development [deployment audit](deployment-audit.md)
(`audit-deployment.yml`) reuses the dev account/deployer/backend secrets with a
restrictive session policy. It reads status, schedule metrics and SQL-reader
metadata without provisioning resources or claiming complete collection.

<a id="development-variable-catalog--개발-변수-목록"></a>

#### Development variable catalog

Nonsecret dev repository variables are `DOMAIN_NAME_DEV` / `HOSTED_ZONE_NAME_DEV` (paired names),
`CERTIFICATE_MODE_DEV` (`preserve` by default), `CI_MIGRATIONS_ENABLED_DEV` (`false` by default),
and `CI_DB_DIAGNOSTICS_DEV` (`false`/unset by default; manual advisory read-only diagnostics only).
Runtime activation also uses default-off `CI_READONLY_RUNTIME_DEV` and verified
`STEAMPIPE_IMAGE_DIGEST_DEV` / `WORKER_IMAGE_DIGEST_DEV`. These select reviewed deployment
behavior; account identifiers and credentials stay in secrets. Full activation requires
real login/DB/host-registry preflight. Readiness is a separate capability controlled by
`CI_READINESS_ENABLED_DEV`: true/false explicitly overrides the dev Terraform value; empty/unset
preserves explicit tfvars and its default false. The runtime profile alone never enables it.
See [readiness capability](runtime-foundation.md#readiness-capability) for billed access and revocation.
`AWS_ACCOUNT_ID_DEV` is a required repository **secret** for both migration jobs, runtime image builds and dev AgentCore provisioning. No variable/default-account fallback exists. It must match the configured role accounts and actual STS
callers; this agreement is not proof of effective permissions or an independent classification of the account as development.

The distinct NAMES are the isolation: a dev/preview job can never fall back to the
production pair. From then on, terraform changes flow through `terraform.yml`.
Automatic PR/push plans are advisory. Apply requires a successful explicit `mode=plan`
dispatch at the same repository, branch and SHA, followed by `mode=apply` with its run ID
and privately obtained `reviewed_plan_sha256`. Both publication and apply enter the branch's
environment; main requires production approval for each dispatch. Publication assumes
the deployer role under its required S3/KMS-only session restriction. See §5
for DNS restrictions; the manual Terraform commands above alone do not enforce them.

<a id="dev-db-diagnostics"></a>

<a id="optional-database-diagnostics--선택적-db-진단"></a>

#### Optional database diagnostics

For a failed authenticated DB check, temporarily set `CI_DB_DIAGNOSTICS_DEV=true` and manually
dispatch the Terraform workflow (`workflow_dispatch`, `mode=plan`, branch `dev`).
Automatic PR/push plans never run this optional database-diagnostics collector; fixed Terraform command audits still run. The collector step and helper require the manual event,
the literal flag value `true`, and `--target dev`; the supported region is `ap-northeast-2`.
Comparing the persisted-state account with STS is a consistency check: it does not detect
a wrong stack in the same account or provide authorization. The helper uses
the existing read-only plan role and a fixed CLI operation allowlist, with no new IAM grants,
resource writes, database connection, or apply step. It runs **after encrypted plan upload**,
when the plaintext plan has been removed. This advisory DB step has
`continue-on-error` and an eight-minute timeout. The separate readiness-plan summary
runs before encryption with its own two-minute timeout and `continue-on-error`.
Neither reporting failure fails an otherwise valid
plan; the Terraform plan, DNS checks, artifact protection, CI and readiness gates remain required.
Enabling the flag and dispatching the plan publishes the safe JSON projection, including
configuration booleans, in the **public Actions job log and fenced step summary**.
Unset the variable or set it to `false` after diagnosis.
Interpreting the sample requires a known authenticated DB probe within its returned one-hour
window. Dispatch within one hour of that probe and check its timestamp against the returned
bounds; otherwise repeat the existing authorized probe before collecting a new sample.

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

| Timing allowlist | Fixed values |
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

Regex inspection is limited to the first 4,096 characters of each ping error/server-log line.
Shortening marks `logs.classification_truncated` or `server_logs.tail_truncated` and makes
that sample partial; counters describe only the inspected prefixes.

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

**Configured-instance metrics:** one read-only `GetMetricData` request selects the configured
`<project>-aurora-1` using `AWS/RDS` / `DBInstanceIdentifier`. The ten fixed IDs below share
60-second buckets over the hour ending at the last completed minute when diagnostics starts.
`window_start_ms` / `window_end_ms` expose that `[start,end)` range; the current incomplete
minute and later publications may be missing. The request permits at most 1,000 datapoints,
does not follow `NextToken`, and publishes at most 60 timestamp/value pairs per series.

| ID | AWS/RDS metric | Statistic |
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

IAM counters aggregate all IAM clients on the configured instance. Positive failure-category
points identify observed instance-level failures, but `probe_outcome=unknown` and
`no_error_inference=true` prohibit attributing them to one connection or treating missing/zero
data as healthy. CPU is percent, memory bytes and capacity ACUs. Configuration additionally
projects numeric `serverless_min_acu` / `serverless_max_acu`, or null when unavailable/invalid.
Pressure is a hypothesis to compare with the known probe window, not authority to change capacity,
timeouts or authentication. The existing readiness gates remain required.

Sources: [IAM-auth metrics](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/UsingWithRDS.IAMDBAuth.Troubleshooting.html),
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

<a id="4-ecr-permissions-for-the-pin-step--ci-deployer-ecr-권한"></a>

### 4. ECR permissions for the pin step

**AgentCore upgrade prerequisite:** the configured operator-owned CI deployer
must permit `bedrock-agentcore:GetGateway` on its managed gateway resources,
in addition to its existing AgentCore list/create/update/target/runtime permissions.
The provisioner reads the current role and authorizer/protocol before updating a
gateway. A read failure returned after SDK retry handling, including a throttle or
timeout, records `ERR` and makes the run exit nonzero: a matching listed description does not verify the role.
Known IDs and baseline teardown are retained. A confirmed description-only update
failure remains `WARN`. This is a deployer permission, not the web task role's
status-page permission.

Verify the grant in the IAM owner's configuration before dispatch. A role already
using `AdministratorAccess` already has the IAM allow; this is not a recommendation
to add AdministratorAccess for a read, nor evidence that another stack's role is
configured correctly. Least-privilege roles need the scoped read added by their
owner. The application workflow does not grant IAM. See the
[AgentCore reconciliation contract](../reference/05-agentcore.md#provisioner-reconciliation).

The deploy jobs re-point `:web-latest` at the approved `web-<sha>` before rolling,
so each deployer role needs `ecr:BatchGetImage` + `ecr:PutImage` scoped to its own
stack's web ECR repository (plus the auth-token action it already has).

Backend image builds require additional **repository scopes**, which the web grants above do not establish. Verify the configured roles before using the runtime build workflows:

| Configured role | Required backend repositories |
|---|---|
| Dev build role (`AWS_CI_BUILD_DEV_ROLE_ARN`) | `${project}-steampipe`, `${project}-worker` |
| Dev deployer role (`AWS_CI_DEPLOYER_DEV_ROLE_ARN`) | `${project}-agentcore` |

On those exact repository ARNs in the configured account/region, each role needs `ecr:BatchGetImage`, `ecr:BatchCheckLayerAvailability`, `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload` and `ecr:PutImage`. Retain `ecr:GetAuthorizationToken` on `Resource: "*"` with `aws:RequestedRegion` restricted to the deployment region; it cannot use repository ARNs. These
workflows do not change IAM; missing backend scopes require a separately reviewed policy change. The repository preflight tests effective access and fails on denial.

Web build checks repository availability **before** QEMU/Buildx and the image build using
`ecr:BatchCheckLayerAvailability`, already part of its scoped push permissions, with an
intentionally absent but valid layer digest. `LayerNotFound` is normal for this probe;
repository-not-found or access-denied stops the build. Review/apply an `ecr-bootstrap`
plan for a missing repository. Keep this check; any missing permission scope needs the reviewed role/repository change described above.

<a id="5-deploy-while-dns-changes-are-deferred--dns-변경-보류-상태의-배포"></a>

### 5. Deploy while DNS changes are deferred

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

```bash
gh workflow run terraform.yml -R aws-samples/sample-awsops --ref dev \
  -f mode=plan -f plan_scope=full \
  -f allow_dns_changes=false
```

In this no-DNS example, `publish_service_dns` is derived from state, not the dispatch input.
For a fresh stack, also supply the operator's `existing_cf_certificate_arn` and
`existing_alb_certificate_arn` inputs (or their reviewed stack tfvars); otherwise it stops.

Inspect the completed run, its resource changes and commit. Set `PLAN_RUN_ID` to
that successful run's numeric ID and `REVIEWED_PLAN_SHA256` from the private inspection receipt, then apply:

```bash
gh workflow run terraform.yml -R aws-samples/sample-awsops --ref dev \
  -f mode=apply -f plan_run_id="$PLAN_RUN_ID" -f allow_dns_changes=false \
  -f reviewed_plan_sha256="$REVIEWED_PLAN_SHA256"
```

Apply accepts only a successful explicit Terraform plan dispatch from the same
repository, stack branch and commit. It checks the live branch again and
rechecks DNS changes after restoring the privately reviewed plan. A moved branch requires a fresh
plan. `plan_scope=ecr-bootstrap`, with `domain_rollout=false`, is available for an initial plan limited to the
web ECR repository; the JSON gate also rejects unrelated mutations in that scope.
Dev `plan_scope=runtime-ecr-bootstrap` targets only three runtime repositories; it needs no
images yet. Repeat the same scope on apply. Private publication authenticates both encrypted
handoff files; apply downloads the pinned S3 plan/assets and verifies the reviewed hash plus
HMAC plan/SHA/scope binding. Old or missing bundles require a fresh reviewed plan; never
rebuild assets during apply.
It needs no certificates unless external ARNs are explicitly configured.
Apply a full reviewed plan before rolling the service.

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

```bash
# FUTURE domain rollout ONLY: separate DNS authorization required; unpublished/same-domain cases.
gh workflow run terraform.yml -R aws-samples/sample-awsops --ref dev \
  -f mode=plan -f plan_scope=full -f domain_rollout=true \
  -f publish_service_dns=true -f allow_dns_changes=true
# After private inspection, set PLAN_RUN_ID and REVIEWED_PLAN_SHA256 from its receipt.
gh workflow run terraform.yml -R aws-samples/sample-awsops --ref dev \
  -f mode=apply -f plan_scope=full -f plan_run_id="$PLAN_RUN_ID" -f allow_dns_changes=true \
  -f reviewed_plan_sha256="$REVIEWED_PLAN_SHA256"
```

External certificate owners must monitor expiry and renew/reimport ahead of time.
CI validates availability but does not manage an external certificate's lifecycle.
Do not remove existing validation CNAMEs or add new ones during DNS deferral.
The supported key set is RSA 2048/3072/4096 and ECDSA P-256/P-384; see
[AWS's certificate requirements](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cnames-and-https-requirements.html).

[Deploy Web's `deploy` / `Smoke test`](../../.github/workflows/deploy-web.yml) and manual
`make deploy` invoke the shared [deployment-smoke.mjs](../../scripts/v2/deployment-smoke.mjs) CLI,
which validates destinations and passes curl arguments without shell interpolation.
They connect to `cloudfront_domain` with curl
`--connect-to` while requesting `public_url`. This preserves the service Host,
SNI and certificate verification before service DNS is published. `/api/health`
checks process liveness; complete the required database migrations and verify
authenticated application routes separately.
For an authorized AgentCore deployment, [Deploy AgentCore](../../.github/workflows/deploy-agentcore.yml)
first runs the private reusable migration workflow on `dev`; other branches retain `make migrate`. Before dev dispatch, apply `ci_migrations_enabled=true` using `CI_MIGRATIONS_ENABLED_DEV=true` and confirm a non-null `migration_job` output. Optional `smoke=true` runs after provisioning. On dev it requires
the matching readiness producer, `runtime_deployment`, enabled inventory and producer-classified freshness. The applied `agentcore.deployment_readiness_enabled` output must be boolean true; the provisioner keeps the runtime probe disabled for missing/false values, ignoring
ambient overrides. Missing optional-readiness prerequisites fail dev smoke with a fixed code after provisioning. Other stacks retain advisory invocation behavior when readiness is unavailable; structured checks are
advisory there when available, while invocation transport failures still fail. Neither AgentCore smoke nor `/api/health` substitutes for a web-role permission, login/database or full collection/worker check.

The DNS/provenance scripts run from the deployment ref. They are safety checks for reviewed
code, not a security boundary against changes to that ref; normal review and environment
protections remain required.

#### AgentCore provisioner Python

In the deploy job (after the separate private migration job), Deploy AgentCore prepares a private Python 3.12 virtual environment before that job's AWS credential setup and agent image build. `requirements-provision.txt` pins the host SDK closure by version and hash. `setup-provision-python.py` derives control-plane operations from the provisioner's `ctrl` references and runtime operations from `smoke`, verifies model availability and exact SDK versions, and imports the provisioner through `--help` without AWS credentials. This checks local SDK compatibility, not live IAM, quotas, input-shape compatibility or runtime health.

The verified interpreter path is published only after success. Final cleanup uses the base interpreter; SDK-folder removal failures produce a fixed warning instead of changing the deployment result. The SDK folder contains packages, not deployment credentials. Container dependencies remain separate.

For a pin update, resolve the complete Python 3.12 wheel closure from PyPI, generate hashes from the downloaded wheels (`python -m pip hash <wheel>`), then run the actual setup/preflight and `python3 -m pytest scripts/v2/ci/test_setup_provision_python.py -q`. The existing merge-verification Python stage discovers that test file; it is not repeated by a Node wrapper. The runner needs setup-python access and PyPI egress.

<a id="runtime-images--런타임-이미지"></a>

#### Runtime images

The helper exports the built image to a private `docker image save` archive. It checks the exact tag, validates Linux/ARM64 in the real config, and hashes its bytes before binding the ECR manifest to that digest. This works when containerd omits BuildKit's config digest and exposes a manifest ID instead. `tar` reads only the bounded manifest/config entries through validated hash paths, without AWS credentials. Push remains `--platform linux/arm64` (Docker API 1.46+); the runner needs `tar`. The archive is removed with the private build scratch. Steampipe retains its engine/plugin and checksum-pinned standalone Python runtime.

After the reviewed Terraform ECR bootstrap, dispatch **Build Development Runtime Image** (`build-runtime-images.yml`) on `dev` with `component=steampipe` or `component=worker`. The repository must already exist: `steampipe_enabled`, `workers_enabled` and `agentcore_enabled` gate the respective `-steampipe`, `-worker` and `-agentcore`
repositories. The helper checks the independently configured secret account, configured CI role and actual STS identity before writes; it never creates repositories. It builds one Linux/ARM64 manifest, verifies the
uploaded configuration and manifest hashes, and returns the project and immutable digest. Record those verified digests for the full infrastructure plan; the build itself deploys no service. Repository preflight and
digest verification require `ecr:BatchGetImage` on the selected backend repository; see §4 for the complete role/repository scopes. An expected ImageNotFound for the commit tag is acceptable. Repository-not-found and access denial
fail. The helper neither calls DescribeRepositories nor provisions repositories or IAM.

Dev AgentCore follows the same account/digest checks using an `agent-<commit SHA>` tag. Before dispatch, set `CI_MIGRATIONS_ENABLED_DEV=true` and apply the reviewed full plan with `ci_migrations_enabled=true`; `migration_job` must be non-null in applied state. The default-off migration infrastructure
is mandatory for this dev workflow, even with `smoke=false`. A successful ECR-only bootstrap does not provision that infrastructure. After setup, the workflow obtains a fresh one-hour session for `--build-only`. It then refreshes the SAME
deployer role before `--provision-only`, passing only the verified project/digest outputs. Provision-only repeats identity checks, rereads the commit tag and verifies that its immutable digest still matches; it never rebuilds or
selects latest. The old combined dev CLI path is rejected; main/preview retain their existing CLI path. Docker credential scratch is private and cleaned. Leave optional AgentCore smoke off during first provisioning until
inventory has been collected and the applied readiness flag is enabled, then run the full application release verification. Never count successful provisioning alone as application readiness. Short CLI/Terraform
operations have a two-minute process limit; dev build, image push and provisioning have separate 35/10/45-minute limits. Aggregate deadlines also cap the build helper at 48 minutes and each agent CLI phase at 50 minutes,
including reads. Fresh-role verification is capped at two minutes and phase workflow steps at 52 minutes, within each fresh one-hour session. The dev job allows 120 minutes for setup plus both phases. Manual runtime
image builds obtain credentials only after QEMU/buildx setup and use a 50-minute build step. No custom credential process or role-session maximum change is introduced. Required IAM scopes must be provisioned before
dispatch; the workflow does not grant them. Public diagnostics retain fixed stages/codes, catalog keys and status counts, at most 240 resource events with an explicit dropped count. Child failure exit codes are
preserved; ARNs, credentials, endpoints and raw SDK errors are not relayed.

## Private exact-plan inspection

### Storage and role prerequisites

Use the configured backend bucket and its private `backend.hcl` for publication,
inspection and apply. The backend's `encrypt=true` alone does not establish the
bucket's default encryption or access controls. This transport requires versioning
Enabled, all four public-access blocks, BucketOwnerEnforced ownership and default
SSE-KMS in the same account/region. `terraform/bootstrap/main.tf` provisions the
versioning, public-access blocks and SSE-KMS settings for new state buckets;
inspect existing bucket ownership and writer compatibility before changing them.
The bucket policy must be nonpublic, or absent with the other controls intact.
Plan-prefix lifecycle is mandatory for the transport. The optional bootstrap
`private_plan_retention_enabled` flag defaults false to preserve existing ownership:
the owner must explicitly configure retention before publishing any plan.
The artifact key is resolved from the bucket default into an enabled same-account/region
symmetric key; the backend state-object key is independently configured and exactly bound
as metadata, not compared with that bucket-default key.
The GitHub handoff remains application-encrypted. S3 publication removes that envelope
and relies on SSE-KMS plus effective S3/KMS access policies. Authorized reads return
decrypted plan/assets without the CI key, so existing state-bucket administrators or
other principals with effective object-read and key-decrypt permissions may read them.
Review this population and restrict the plan prefix before rollout. Block Public Access
does not restrict authorized principals. This workflow checks storage prerequisites
but creates no bucket/key or IAM grant and does not apply bootstrap.

Run these metadata checks locally with the intended profile. Set `PLAN_BUCKET`,
`PLAN_OWNER` and `PLAN_REGION` from the private backend and verified deployment account:

```bash
set -euo pipefail
umask 077
SETUP_DIR=$(mktemp -d "$HOME/awsops-plan-storage.XXXXXX")
storage_args=(--profile samples --region "$PLAN_REGION" --bucket "$PLAN_BUCKET" --expected-bucket-owner "$PLAN_OWNER")
for operation in get-bucket-versioning get-public-access-block get-bucket-ownership-controls get-bucket-encryption get-bucket-lifecycle-configuration; do
  aws s3api "$operation" "${storage_args[@]}" > "$SETUP_DIR/$operation.json"
done
```

If a setting is missing or incompatible, prepare its correction through the bucket
owner's reviewed bootstrap configuration before publishing. For legacy state buckets,
BucketOwnerEnforced also requires compatible writers; do not silently change an
existing key/ACL contract merely to make the check pass.

The owner-run bootstrap can supply retention with `private_plan_retention_enabled=true`.
Use its existing private Terraform state and inspect a saved bootstrap plan before
applying the exact reviewed bytes. **S3 has one lifecycle configuration per bucket**:
if other rules already exist, merge them into the owning configuration before adopting
the resource. Do not initialize an empty bootstrap state for an existing bucket or
replace other rules with the sample's two plan rules. The deployment workflow neither
imports that ownership nor changes lifecycle on failure.

The required enabled rule uses exactly `ci/tfplans/`, expires current objects after
seven days and noncurrent versions after seven days, retains no minimum version count,
and aborts incomplete multipart uploads after one day. A separate plan-prefix rule
cleans expired delete markers. State keys and unrelated prefixes must remain outside
these rules. Verify the applied configuration again before dispatching the plan.
Missing, unreadable or incompatible lifecycle causes a fixed publication failure.

The named deployer-role secret must be configured for manual publication. An inline
session policy can only restrict existing permissions; it grants none. Existing base
roles and any KMS key policy must authorize these operations in the selected account:

| Actor | Required existing permission scope |
|---|---|
| Publisher | Bucket metadata reads below; `s3:PutObject` only under `ci/tfplans/`; KMS GenerateDataKey/Decrypt for the supported S3 encryption context, plus direct DescribeKey for key normalization. |
| Inspector / apply | Bucket metadata reads; `s3:GetObject` / `s3:GetObjectVersion` under that private prefix, direct KMS DescribeKey and KMS Decrypt. Existing apply/state permissions remain separate. |
| Purge operator | `s3:ListBucketVersions` for the repository/branch prefix and `s3:DeleteObjectVersion` for the reviewed expired attempt, excluding state keys. Publisher sessions cannot delete. |

Bucket reads are GetBucketLocation, GetBucketVersioning, GetEncryptionConfiguration,
GetBucketPublicAccessBlock, GetBucketOwnershipControls and GetBucketPolicyStatus.
They also include GetLifecycleConfiguration for the mandatory retention check.
Scope S3 encryption use by key, ViaService, CallerAccount and encryption context. Scope
direct DescribeKey separately: the generated session policy uses the selected
account/region's `key/*` ARN pattern, while existing identity/key policies determine
effective access. S3-only context conditions do not apply to a direct metadata lookup.
All dev-family CI branches require AWS_ACCOUNT_ID_DEV.
Update operator-managed policies if required; no policy widening occurs in this PR.
Missing backend/tfvars blobs retain the plan's soft skip. A configured plan with a
missing deployer role or insufficient storage permissions fails publication explicitly.
The helper's generated policy applies only to publication; the consumer must attach it
to the fresh session. Restore runs under the separately protected Apply role.

### Inspect and select exact bytes

These procedures support main, dev and the supported user branches without changing
which domain-rollout stages are authorized. Wait for the entire manual plan run,
including **Publish private plan**, to succeed. Its safe reference binds repository,
branch, full SHA, run/attempt, scope and private object hashes. A failed/skipped publisher,
missing/expired reference, changed bytes or moved branch never authorizes apply.
The encrypted handoff lasts one day. If a protected publication is delayed beyond that
window, or a publisher-only rerun has no handoff for its new attempt, dispatch a fresh
complete plan and inspect its new reference. Do not relax attempts, expiry or source checks.
Plan and Apply migrate together from `tfplan` to `tfplan-<attempt>`; historical runs
retain the old format and inspector. The reference overwrite uses the upload action's
same-run runtime token, so `GITHUB_TOKEN` remains `actions: read`, not `actions: write`.

Use a trusted checkout at the plan's full SHA with Terraform 1.15.7 provider schemas
already installed. Authenticate `gh` and the intended AWS profile. No client encryption
key is required for this S3 inspection:

```bash
python3 scripts/v2/ci_private_plan.py inspect \
  --repository aws-samples/sample-awsops --branch dev \
  --commit "$PLAN_SHA" --run-id "$PLAN_RUN_ID" --scope full --profile samples \
  --foundation /private/checkout/terraform/foundation \
  --backend /private/backend.hcl \
  --destination /private/review/new-plan-directory
```

The inspector validates the completed source run, publisher and exact attempt's reference
before fetching private S3 data. `--backend /private/backend.hcl` is required; the
public reference contains no storage identifier or digest of bucket/account/backend
values. The private manifest is checked against that backend and the actual caller.
This reads no Terraform state. No public or presigned access link is used.

The helper writes `plan.txt`, `plan.json` and `receipt.json` in a **new 0700 directory**, with
0600 files. Plan contents may include passwords or signing material: inspect them privately.
Rendering is bounded to 32 MiB per file and receives no deployment credentials, backend
initialization or Terraform debug/argument overrides. Inspection downloads only the plan;
asset HMAC verification remains mandatory inside publication and apply. The helper never
refreshes, re-plans, approves or applies, and rejects execution inside GitHub Actions.

After reviewing the complete plan, take `plan_sha256` from its private receipt and pass it
as `REVIEWED_PLAN_SHA256`. The public reference contains no plan hash. This is explicit
byte selection, not proof that a human read the plan; review is still an operator duty.
The apply input is required even when all summary checks passed:

```bash
REVIEWED_PLAN_SHA256=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["plan_sha256"])' /private/review/new-plan-directory/receipt.json)
gh workflow run terraform.yml -R aws-samples/sample-awsops --ref dev \
  -f mode=apply -f plan_scope=full -f plan_run_id="$PLAN_RUN_ID" \
  -f reviewed_plan_sha256="$REVIEWED_PLAN_SHA256"
```

Repeat the plan's DNS permission/scope when applicable; the command above grants neither
new DNS changes nor a different plan. Apply authenticates the reference, pinned versions,
reviewed hash and existing HMAC/plan/asset binding before the original host, DNS/runtime and
branch checks and `terraform apply -input=false tfplan`. It never re-plans. A newer attempt
or changed plan requires a fresh private inspection. Reference lifetime is five days.
In a versioned bucket, current expiration creates a delete marker; the seven-day
noncurrent clock starts then. Version deletion can therefore become eligible around
fourteen days after publication, plus asynchronous deletion delay. Reference expiry
does not prove deletion. The optional purge procedure below can remove reviewed expired
attempts sooner and investigate lifecycle cleanup failures.

Wrong context, unsafe paths, missing schemas, oversized/tampered data or failed cleanup
produce fixed errors without printing private contents. Only owned scratch is cleaned;
runner/process loss can prevent finalizers. No public summary is full-plan approval.

| Diagnostic | Operator check |
|---|---|
| `bucket_ownership_missing` | Confirm explicit BucketOwnerEnforced ownership controls with the bucket owner; this workflow does not configure them. |
| `bucket_public_access_block_missing` | Confirm the bucket's four public-access blocks; missing settings cannot establish private storage. |
| `s3_access_denied` | Check the selected profile/session, expected bucket owner and scoped S3/KMS permissions privately. No missing-object or empty-state inference is valid. |
| `bucket_not_private` / `bucket_not_versioned` | Establish the four public-access blocks and Enabled versioning through the reviewed bucket configuration. |
| `bucket_ownership_invalid` | Confirm BucketOwnerEnforced ownership; other ownership modes are not supported by this transport. |
| `bucket_not_sse_kms` / `bucket_encryption_missing` / `bucket_encryption_invalid` | Confirm one supported default SSE-KMS rule; backend `encrypt=true` is not evidence of that setting. |
| `backend_key_mismatch` / `bucket_key_invalid` / `bucket_key_unusable` | Check identifier format and the resolved artifact key's account, region, Enabled state and symmetric ENCRYPT_DECRYPT use. Backend state-key metadata is independent. |
| `kms_access_denied` / `kms_key_missing` | Verify direct DescribeKey authorization and the configured key/alias; no key material is requested. |
| Lifecycle validation failure | Inspect GetLifecycleConfiguration privately; establish the required plan-only current/noncurrent/MPU rule through the owning bootstrap. Do not bypass the check or broaden expiry to state. |
| `object_already_exists` / `object_upload_retry_exhausted` | Conditional PUT recovery requires a pinned GET proving exact bytes, hash, length and key; at most three identical PUTs are attempted. Wrong objects are never overwritten. |

These codes come only from the matching AWS S3 operation's exception envelope.
Other command failures remain generic; provider text is not published. Apply finalizers
remove only `.private-plan-<current-run>-<current-attempt>-*` under its Terraform directory.

### Purge expired plan versions

The workflow requires the owner-installed lifecycle but cannot prove deletion completed.
Monitor it and investigate retained expired versions, including failed-publication orphans.
For early cleanup, the deployment owner may purge a reviewed attempt after seven days.
The five-day GitHub reference is an apply limit, not storage expiry. Use the operator
profile; publisher sessions deliberately cannot delete objects or configure lifecycle.

Set `PLAN_BUCKET`, `PLAN_OWNER` and `PLAN_REGION` from the privately reviewed backend/account.
Discover candidates locally, including failed-publication orphans and noncurrent-only
objects. This metadata listing does not delete anything or authorize a purge. An incomplete
listing must be paged privately or narrowed to a branch; never treat it as complete:

```bash
set -euo pipefail
umask 077
DISCOVERY_DIR=$(mktemp -d "$HOME/awsops-plan-discovery.XXXXXX")
aws s3api list-object-versions --profile samples --region "$PLAN_REGION" \
  --bucket "$PLAN_BUCKET" --expected-bucket-owner "$PLAN_OWNER" \
  --prefix ci/tfplans/aws-samples/sample-awsops/ --max-items 1000 > "$DISCOVERY_DIR/versions.json"
python3 - "$DISCOVERY_DIR/versions.json" > "$DISCOVERY_DIR/candidate-prefixes.txt" <<'PY'
import json, re, sys
data = json.load(open(sys.argv[1]))
if data.get("NextToken") or data.get("IsTruncated"):
    raise SystemExit("Incomplete discovery; narrow or finish paging privately")
prefixes = set()
for row in data.get("Versions", []) + data.get("DeleteMarkers", []):
    match = re.fullmatch(r"(ci/tfplans/aws-samples/sample-awsops/(?:main|dev|atomoh|ssminji|whchoi)/[0-9a-f]{40}/[1-9][0-9]*/[1-9][0-9]*/).+", row["Key"])
    if match:
        prefixes.add(match[1])
print("\n".join(sorted(prefixes)))
PY
```

Set `PLAN_PREFIX` to one expired attempt's exact
`ci/tfplans/aws-samples/sample-awsops/<branch>/<commit>/<run>/<attempt>/` prefix.
The following preparation rejects broader prefixes, truncated listings, unexpected names,
unversioned entries and any version less than seven days old:

<!-- Executable purge example: test_ci_private_plan_workflow.py exercises normal and optimized Python. -->
```bash
set -euo pipefail
umask 077
PURGE_DIR=$(mktemp -d "$HOME/awsops-plan-purge.XXXXXX")
aws s3api list-object-versions --profile samples --region "$PLAN_REGION" \
  --bucket "$PLAN_BUCKET" --expected-bucket-owner "$PLAN_OWNER" \
  --prefix "$PLAN_PREFIX" --max-items 1000 > "$PURGE_DIR/versions.json"
python3 - "$PLAN_PREFIX" "$PURGE_DIR" <<'PY'
import datetime as dt, json, pathlib, re, sys
def require(condition):
    if not condition:
        raise SystemExit("Unsafe or incomplete purge selection")
prefix, root = sys.argv[1], pathlib.Path(sys.argv[2])
require(re.fullmatch(r"ci/tfplans/aws-samples/sample-awsops/(main|dev|atomoh|ssminji|whchoi)/[0-9a-f]{40}/[1-9][0-9]*/[1-9][0-9]*/", prefix))
data = json.loads((root / "versions.json").read_text())
require(not data.get("NextToken") and not data.get("IsTruncated"))
rows = data.get("Versions", []) + data.get("DeleteMarkers", [])
require(0 < len(rows) <= 1000)
cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=7)
objects = []
for row in rows:
    require(re.fullmatch(re.escape(prefix) + r"(plan-[0-9a-f]{64}\.bin|assets-[0-9a-f]{64}\.tar\.gz|manifest-[0-9a-f]{64}\.json)", row["Key"]))
    require(isinstance(row.get("VersionId"), str) and row["VersionId"] not in ("", "null"))
    require(dt.datetime.fromisoformat(row["LastModified"].replace("Z", "+00:00")) < cutoff)
    objects.append({"Key": row["Key"], "VersionId": row["VersionId"]})
(root / "delete.json").write_text(json.dumps({"Objects": objects, "Quiet": True}))
print("Expired versions prepared:", len(objects))
PY
```

Review the private candidate file against that expired attempt, then delete its versions:

```bash
aws s3api delete-objects --profile samples --region "$PLAN_REGION" \
  --bucket "$PLAN_BUCKET" --expected-bucket-owner "$PLAN_OWNER" \
  --delete "file://$PURGE_DIR/delete.json" > "$PURGE_DIR/delete-result.json"
python3 - "$PURGE_DIR/delete-result.json" <<'PY'
import json, sys
if json.load(open(sys.argv[1])).get("Errors"):
    raise SystemExit("Version purge incomplete")
PY
```

Separately list the same prefix again and confirm no versions or delete markers remain;
do not rerun purge preparation to validate an empty listing. Only preparation refuses an
empty deletion request. Finish this verification before
removing the owned local directory. Retain failed cleanup evidence privately and resolve
it; do not claim expiry from reference deletion or use a bucket-wide recursive delete.
No state key is covered by this prefix.

### Legacy encrypted-artifact inspection

`ci_plan_inspect.py` remains available only for historical runs that published the old
`tfplan` encrypted artifact. It requires that source checkout and matching client key,
authenticates the run plus HMAC-bound plan/assets before protected rendering, and retains
its existing 32 MiB and path/cleanup guards. The current S3 apply path does not fall back
to legacy artifacts. This historical helper never makes an old plan apply-eligible:

```bash
python3 scripts/v2/ci_plan_inspect.py \
  --repository aws-samples/sample-awsops --branch dev \
  --commit "$PLAN_SHA" --run-id "$PLAN_RUN_ID" --scope full \
  --foundation /private/checkout/terraform/foundation \
  --backend /private/backend.hcl \
  --destination /private/review/new-legacy-plan-directory
```

## Encrypted failure recovery

The wrapper drains Terraform plan/apply output into bounded memory while the command runs. It retains the last 1 MiB, including terminal errors, and counts all observed output bytes. After Terraform exits, the diagnostic payload goes directly to OpenSSL stdin; only ciphertext is written to the owned 0700 directory, with mode 0600. No plaintext log or staging capsule is written during capture or sealing. Handled capture or storage failures do not SIGKILL Terraform or replace its observed exit status.

Every captured command reports fixed JSON audit fields to the job log and step summary. Successful standard Terraform summaries supply numeric add/change/destroy counts; absent or unreadable summaries remain unavailable, not zero. Failure classifications are bounded hints such as state-lock, access-denied, authentication, provider-install, invalid-plan, configuration, interrupted or generic command failure. Arbitrary `Error:` lines and resource/output values are never echoed. A failed launch is distinct from Terraform itself exiting 127.

The capture parent removes GitHub command-file paths, action/token variables, encryption keys, `TF_LOG*` and `TF_CLI_ARGS*` from the Terraform child environment. AWS temporary credentials, including `AWS_SESSION_TOKEN`, remain available. The pre-apply show/policy subprocesses receive the same isolation in a subshell. On Linux CI runners, each captured Terraform child runs in a separate session. The first SIGINT or SIGTERM requests graceful shutdown once; a second interrupt kills its process group. The exec launcher arms Linux parent-death SIGKILL before Terraform starts, so killing the capture parent cannot leave the Terraform process running. A launch-status pipe closes on exec and keeps launcher errors distinct from Terraform exit codes. A handled interrupt remains classified as interrupted even when Terraform returns 1. Original argv, branch/provenance/asset/DNS/runtime checks and exact saved-plan apply remain unchanged; this does not sandbox hostile processes sharing the same OS user.

Raw retention is only for explicit dispatch failures. `policy_not_retained`, `key_missing`, `context_invalid`, `storage_failed`, `seal_failed` and `publication_failed` are distinct from `sealed`. Capture and cleanup status are reported separately. A partially applied command with unavailable diagnostics still requires private state reconciliation; no automatic retry or success inference is made.

Failure capsules use schema 2 with the existing CBC/PBKDF2 cipher and key and a separate diagnostic HMAC domain. The signed manifest binds source/run/attempt/phase, observed exit/launch status, timestamp, total and retained bytes, capture/truncation status and content hash. This newly introduced diagnostic format is not an apply artifact or a migration from a published earlier capsule format. Never relabel metadata or skip authentication to force recovery. Saved-plan artifact compatibility is unchanged.

Only the parent's validated single ciphertext file can be published. Ownership, private modes, regular-file/link checks, a literal non-glob path and the recorded ciphertext hash are checked before the output pointer is written. The generated directory is non-hidden; the upload explicitly permits hidden ancestors for this one file, not a directory or wildcard. Artifacts are named `terraform-failure-plan-<attempt>` or `terraform-failure-apply-<attempt>` and retained for five days, so later attempts do not collide with earlier ones.

Uploads require the real workflow dispatch event plus failure or cancellation and a validated nonempty pointer. The capture audit reports `pending_upload` after sealing. The always-run cleanup step reads the identified upload step's outcome and deletes only the owned ciphertext after literal `success`. Failed, cancelled, skipped or unknown uploads retain the file and report `retained_unpublished`; the final audit records the upload status plus `complete`, `failed` or `not_available` when applicable. If pointer publication fails, the sealed file also remains for private owner recovery; a missing pointer does not prove no ciphertext exists.

Cancellation does not roll back AWS operations already accepted by services. After an interrupted or forced termination, inspect the actual resources, state and lock owner before retrying or considering a manual unlock; never infer that cancellation made the infrastructure unchanged.

Cancellation recovery is best effort: SIGKILL, host loss or an exhausted runner timeout may prevent capture/upload/audit entirely. Unpublished ciphertext remains in its owned `RUNNER_TEMP/tf-diagnostics-<run>-<attempt>-<phase>-*` directory. There is no broad runner-temp sweep. Do not publish an arbitrary replacement file or delete another run's directory.

On a trusted private operator machine, authenticate `gh` normally and provide the corresponding `TF_PLAN_ENC_KEY` using the approved private mechanism. Select the original failed SHA, attempt and phase. The helper verifies that exact authenticated attempt even after a later rerun. A new destination is required. The `GITHUB_ACTIONS` refusal is an accident guard, not an authorization boundary; do not recover raw logs in shared CI.

```bash
gh run download "$FAILED_RUN_ID" --repo aws-samples/sample-awsops \
  --name "terraform-failure-plan-$FAILED_ATTEMPT" --dir /private/download
python3 scripts/v2/ci_failure_diagnostics.py recover \
  --repository aws-samples/sample-awsops --branch dev \
  --commit "$FAILED_SHA" --run-id "$FAILED_RUN_ID" --attempt "$FAILED_ATTEMPT" \
  --phase plan --file /private/download/diagnostics.enc \
  --destination /private/review/new-failure-directory
```

Recovery authenticates the failed dispatch, attempt, HMAC, context and content before writing 0600 `diagnostics.log` and `metadata.json` inside a new 0700 directory. Timeouts and verification errors expose fixed categories only. It does not deploy or approve anything. Key rotation requires the corresponding old key for old ciphertext; file modes and handled cleanup are not guarantees against hostile shared-UID processes or abrupt host loss. Inspect owned residue privately.

Initialization and earlier policy failures are outside command-tail capture. Existing policy diagnostics remain, and advisory PR/push command failures still receive fixed classifications without raw retention. The saved-plan inspector keeps its strict 32 MiB render bound and fail-closed verification.

<a id="private-development-database-migration--비공개-개발-db-마이그레이션"></a>

## Private development database migration

**Symptom:** a newly provisioned private Aurora has no application tables, or the
external Actions runner cannot connect to its private endpoint. Deploy Web does not initialize
the database. Use **Migrate Development Database** (`deploy-migrations.yml`), a manual-only
workflow restricted to this samples repository's `dev` branch, also reusable by a manual dev AgentCore dispatch. It builds an ARM64 image and
runs one Fargate task in the existing private subnets with the existing service security group.

**Preparation:**

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
   build/deployer OIDC roles and backend secrets. The account secret is mandatory for both build and migrate jobs, including reusable AgentCore invocation.
   `TF_TFVARS_DEV` accepts at most one literal, single-line `project = "…"` assignment.
   If absent (including `make configure` output), the foundation default `awsops-v2` is used;
   the applied migration output must still match that project/account/region.
   This workflow accepts the existing `ap-northeast-2` deployment region only, without
   cross-stack fallback. The SQL reader sync is enabled only when AgentCore is enabled.
4. Dispatch **Migrate Development Database** from the current `dev` HEAD. It accepts no
   image, role, task, template or repository override. If the branch moves before launch,
   dispatch again from the new reviewed HEAD.

For a controller reviewing a local Terraform plan, the equivalent opt-in is:

```bash
TF_VAR_ci_migrations_enabled=true terraform -chdir=terraform/foundation plan -out=tfplan
```

The `TF_VAR_` local form follows normal Terraform variable precedence; remove conflicting
local tfvars entries or pass `-var=ci_migrations_enabled=true` explicitly. The new migration
workflow itself only initializes the dev backend and reads `migration_job`; it never plans
or applies infrastructure. The gated resources are one task role/policy, one log group, and
one task-definition template. `migration_job` is absent/null while disabled.

The migration workflow uses the existing `AWS_CI_BUILD_DEV_ROLE_ARN` and
`AWS_CI_DEPLOYER_DEV_ROLE_ARN` secrets, plus required account secret `AWS_ACCOUNT_ID_DEV`. Role names in the setup matrix are conventions;
operators do not need to rename an existing role. Valid IAM paths and surrounding input
whitespace are supported. Both selected roles must belong to that configured account. The workflow
checks the actual build STS identity before ECR access, and the controller checks the exact
configured deploy role identity before ECR/ECS access and cleanup. Account/region/backend,
private-network, task-family, digest and current-commit checks still apply. There is no
production-secret fallback, new role input or IAM permission change.

**Privilege review:** CI roles are existing, separately managed prerequisites;
this feature does not broaden them automatically. Verify the following grants before execution.
An access denial is a failed run, never permission to substitute a more privileged role.

| Principal | Required scope |
|---|---|
| Dev build role | Push only to the selected project's existing private `-web` ECR repository; retain the existing ECR login permission. Only `migration-<full commit SHA>` is written. |
| Dev deployer role | Read the dev state backend and selected ECR image; register/describe the project's `-migration` family; run only that family on the project's cluster. Where an ECS API requires wildcard resource access, constrain the requested region and use supported action-specific conditions. |
| Dev deployer `iam:PassRole` | Exactly the project's `-task-execution` and `-migration-task` roles, with `iam:PassedToService = ecs-tasks.amazonaws.com`; no arbitrary role pass. |
| Dev deployer cleanup | `ecs:DescribeTasks` / `ecs:StopTask` limited to the project's task ARN prefix and cluster; `ecs:ListTasks` constrained to that cluster. The controller additionally checks run identity, exact registered revision and task ARN before stopping. |
| Optional failure-log reader | `logs:GetLogEvents` only for `/ecs/<project>-migration`, stream prefix `migration/migration/`. No log-wide search is needed. |
| Migration task role | `secretsmanager:GetSecretValue` for this Aurora master secret, plus the project's SQL reader secret only when AgentCore is enabled. Aurora CMK `kms:Decrypt` requires Secrets Manager and the master secret's encryption context. No AWS-side mutation permissions (ECS/ECR/IAM/DNS/secret writes); schema DDL uses the database credentials. |
| Existing execution role | Existing private ECR pull and CloudWatch log delivery. Database credentials are fetched by the task role at runtime, never through ECS environment/secrets injection. |

Database passwords remain in container memory, never in public logs or environment variables.

**Verification and recovery:** the controller refuses the `migration-unbuilt`
template image and clones only approved fields using this run's immutable build digest.
Only project and digest cross the build-job boundary; a masked registry/account value is
not a job output. The controller verifies the digest in the expected ECR repository,
checks current `dev` SHA immediately before `RunTask`, and requires task **STOPPED**,
the same running-image digest, and the migration container's **numeric `exitCode: 0`**.
Missing/string/null exit codes cannot pass.

Migration logs retain 14 days; disabling the flag destroys the log group and its retained history.
After changing AgentCore/reader settings, review and apply the migration template before dispatch.

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

After a successful migration, deploy the reviewed web image and verify authenticated database access before publishing service DNS.

Offline controller checks require Node 20, Python 3 with PyYAML and boto3/botocore, Terraform 1.15.7 and cached providers (`pip install -r agent/requirements.txt` supplies the SDK):

```bash
node --test scripts/v2/ci/run-migration*.test.mjs
```

Merge Verify also runs the required runtime tests and disposable PostgreSQL integration suite.
The manual controller adds no product autonomy or DNS exception.

<a id="verification--확인"></a>

## Verification

For a provisioned dev stack, the web workflow should build, pin, roll and pass the
Host/SNI-preserving smoke through `cloudfront_domain`, even before `public_url` resolves.
For production, dispatch Deploy Web from the reviewed main commit through the normal
environment approval. Health is process liveness, not proof that migrations/authenticated
routes work. Inspect certificate preflight and plan-gate output; a DNS refusal or moved
branch requires investigation and a fresh plan, never bypassing checks.

<a id="runtime-probe-capability--런타임-검증-기능"></a>

### Runtime probe capability

For verify, apply `agentcore_enabled=true` and `ci_readiness_enabled=true`, then provision AgentCore.
Only applied output sets `DEPLOYMENT_READINESS_ENABLED`; false/missing yields `runtime_disabled`, ignoring shell overrides.
Also enable `steampipe_enabled=true`, `workers_enabled=true` and dispatch, and deploy inventory/ARM64
worker images as described in [worker deployment](../reference/06-workers.md).

Runtime requests the exact CloudFront ID and an identity-only row; deploy Lambda and gateway schema first.
The web API scan remains capped at 500 rows. Failures distinguish `known_resource_unverified`,
`collection_partial`, `collection_failed`, `collection_missing` after waiting, and `inventory_incomplete`.
The optional-mode paragraph below also defines `collection_stale`, `release_timeout` and
`runtime_inventory_contention`.
Degraded inventory never passes release readiness. A missing match is not proof that the resource is absent in AWS.

`SMOKE_RUNTIME_CONFIG_FILE` is an absolute 0600 JSON file beside credentials in the same 0700 directory;
Normal finalizers cover both; process or runner loss can prevent cleanup. The 16 KiB cap,
30-minute verify window and unique type list including cloudfront are required.
The release controller must supply actual deployment/dispatch evidence; current Deploy Web remains DB-only.

`schemaVersion: 1`, `mode: "prepare"` and `expectedAccountId` check login/DB and the enabled host.
Optional `hostOnly: true` also rejects enabled members. Verify adds `expectedCloudfrontId`,
caller-supplied `expectedQueuedTypes` and the pre-dispatch `collectionStartedAt`, from applied
deployment and owned Lambda evidence. It requires fresh complete collection, web SSM/runtime calls
and succeeded Lambda/Fargate jobs. Missing/partial/stale is never healthy zero; deploy the updated
inventory-reader Lambda so legacy NULL attribute coverage is disclosed as incomplete.

Verify also accepts `inventoryPolicy: "full"` and `collectionMode: "release"`; prepare rejects
both. Only those values are supported. The policy adds structured quality/gaps for
programmatic callers; the CLI retains fixed diagnostics. Missing policy still enforces
complete evidence for every supplied type. The caller must obtain the intended type set.
Release mode allows 20 minutes of collection polling rather than 10; a retry shares the
original window. All runtime entry points expire 30 minutes after the verification marker
(or 30 minutes from prepare entry); earlier caller deadlines are honored. This includes
login/DB, HTTP, cooldowns and worker proof, and no later deadline can extend it.
The collection window is a cap: late completion may leave too little time for the
remaining proof. Before billed readiness, require its full 80-second allowance plus
370 seconds per worker (enqueue, polling and last status request); recheck before each
worker enqueue. HTTP requests need their full timeout remaining. Insufficient initial
proof time fails as `release_timeout` before spending.

Full-policy stale coverage can fail as `collection_stale`; the overall limit reports
`release_timeout`. A validated CloudFront running-sweep collision permits one 65-second
cooldown and strict collection recheck before another AgentCore probe. A second confirmed
collision, too little shared collection time, or insufficient overall time for cooldown,
a collection read, the next probe and both workers, is
`runtime_inventory_contention`; a continuous initial wait is `collection_timeout`.
Start verification promptly: an older valid marker leaves less than the advertised poll window.
Other failures do not retry. See [probe contracts](runtime-foundation.md#reusable-runtime-probe-contract).

`POST /api/deployment/readiness` requires an administrator or `deployment-verifiers` membership.
`controller-readiness.tf` creates that application group only when readiness and AgentCore are enabled.
Membership is added only for the Terraform-managed demo when `create_demo_user=true`; no existing
unmanaged identity is enrolled, and no admin membership or IAM role is granted. Public CI rejects
readiness outside dev. Use the separate CI_READINESS_ENABLED_DEV decision or explicit operator
Terraform configuration; the runtime profile is not authorization for this billed capability.
Use a fresh login after membership changes; one in-flight call and a 60-second process cooldown apply.

If the group or managed-demo membership already exists, adopt it through a reviewed import before
apply rather than deleting/recreating it: group ID `<pool-id>/deployment-verifiers`, membership ID
`<pool-id>,deployment-verifiers,<managed-username>`. Inspect unexpected roles/memberships first.
Disabling readiness or AgentCore removes the managed group/membership on a subsequent reviewed apply;
it does not reset passwords or delete the demo user. Existing ID tokens keep their group claims
until expiry (up to the configured 12 hours) unless session revocation rejects them. Runtime
disablement independently blocks the probe; membership removal alone is not immediate token
revocation. See [revocation details](runtime-foundation.md#readiness-capability).

<a id="authenticated-database-verification--인증된-db-검증"></a>

### Authenticated database verification

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
response scratch files inside that same directory. Workflow cleanup can recover a killed CLI
while its runner remains available; runner loss can prevent both workflow and local cleanup.
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

Troubleshoot by phase and safe status: login 401 points to the configured credential; 403 to
Cognito user/challenge state; 502 to its upstream connection. Database 503 points to missing
service configuration; 500 to database credentials, IAM or connectivity. A transport/TLS failure
may have no HTTP response. Inspect private application logs; never print response bodies or
reset a password to make a check pass. Opt-in preparation performs its own bounded private
Terraform init (10 minutes) before output/console (2 minutes each); it must finish before
image pinning or rollout.

Offline checks for this path (Node 20, curl, OpenSSL, Python 3 with PyYAML, and Terraform 1.15.7):

```bash
node --test scripts/v2/deployment-smoke.test.mjs
```

The deployment smoke suite evaluates a small offline Terraform variable fixture;
its backend/state and HTTP boundaries are substituted, with no AWS/provider calls.

<a id="offline-deployment-checks--오프라인-배포-검사"></a>

### Offline deployment checks

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

<a id="saved-plan-asset-utility--저장-계획-asset-도구"></a>

### Saved-plan asset utility

**Symptom:** a saved plan references Lambda ZIPs missing from the apply runner.
Plan-time archive-file outputs may not be recreated under a saved-plan apply. Inspect preparation and transport instead of expecting an apply-time rebuild.

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
Cognito signing keys and must never be uploaded as plaintext to GitHub. Pack validation
runs for all plans. Manual plans encrypt a one-day handoff; the protected publisher
decrypts and verifies HMAC before uploading to private SSE-KMS S3. Apply downloads pinned
private versions and re-verifies HMAC through `ci_private_plan.py restore`, without
decrypting a public artifact. Normal finalizers clean owned plaintext scratch; process
or runner loss can prevent cleanup. Terraform layer provisioners use the locked installer.

From the repository root, test with `python3 -m pytest scripts/v2/test_ci_tf_assets.py -q`.
The Terraform workflow supplies the secret without CLI arguments. Run from the foundation root,
with a reviewed plan/source SHA and trusted flags; pack happens after Terraform creates ZIPs:

```bash
cd terraform/foundation
# Trusted configuration, before plan:
printf '%s' '{"steampipe_enabled":true,"workers_enabled":true}' | python3 ../../scripts/v2/ci_tf_assets.py prepare --scope full
# After a reviewed tfplan exists; GITHUB_SHA and TF_PLAN_ENC_KEY must already be set:
python3 ../../scripts/v2/ci_tf_assets.py pack --scope full
# Local utility only: after obtaining the matching plan/archive and CI key privately.
# CI apply uses ci_private_plan.py restore to authenticate S3 source, versions and HMAC:
python3 ../../scripts/v2/ci_tf_assets.py restore --scope full
python3 ../../scripts/v2/ci_tf_assets.py check-layer --layer inv_layer # only if inventory is enabled
python3 ../../scripts/v2/ci_tf_assets.py check-layer --layer pg8000_layer # only if workers are enabled
# Controller only, after the existing identity/review/DNS gates approve this saved plan:
CI_ASSETS_READY=true terraform apply -input=false tfplan
# Workflow finalizers remove owned plaintext while the runner remains available; abrupt loss can prevent cleanup.
```

Missing/mismatched authentication, plan or content requires a fresh reviewed plan/bundle,
not rebuilding under an old approval. See `scripts/v2/ci_tf_assets.py`,
`scripts/v2/ci/pg8000-requirements.txt` and `scripts/v2/test_ci_tf_assets.py`.
Current CI verifies with its configured key. Historical offline recovery of an older bundle
requires its matching prior key; rotation does not erase previously published ciphertext.
Dependency updates must change the lock,
its verified wheel hashes and the four shared-layer pins in
`scripts/v2/{workers,steampipe,incident,remediation}/requirements.txt`; the validator checks all five.
The separate `scripts/v2/steampipe/Dockerfile` image pin/installer is outside the Lambda lock.
See [worker build inputs](../reference/06-workers.md).
Check `LAYER_IMPORTS` when updating wheels. A killed restore may retain a private previous-build
directory; retrying a verified restore is safe. Its integrating job owns later cleanup, after
the retained copy is no longer needed. Never blindly delete another job's staging directory.

Related ADRs: **ADR-002** (edge authentication/private HTTPS boundaries),
**ADR-005** (operator CI migration versus product AWS-resource mutation/autonomy), and
**ADR-016** (domain/certificate cutover). Manual CI writes the database schema using its
scoped credentials; it enables no product AWS-resource mutation/autonomy or DNS exception.
The separately opted-in manual diagnostics step is read-only under ADR-005: no database
connection, AWS-resource mutation, autonomous remediation, or relaxation of readiness gates.
