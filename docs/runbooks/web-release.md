# Verified web release and rollback

Use this procedure when a web release needs migration, image provenance or
rollout verification. Terraform/tool/AgentCore/worker deployment and broad runtime
or collection readiness remain separate procedures; this workflow changes no IaC.

## Symptoms and candidate causes

| Symptom | Candidate cause |
| --- | --- |
| Migration capability is unavailable | The reviewed capability plan was not applied, or the selected stack differs |
| Current-source release stops before promotion | Migration failed, source moved, or required deployment reads are denied |
| Reused image is rejected | Producer/run/source differs, receipt expired, or build/publication did not succeed |
| Verification times out | ECS observations did not converge, the rollout failed, or task/image health differs |
| Login/DB smoke fails | Configured demo credentials, edge authentication or the application's DB connection failed |

## Verification commands

From the repository root:

```bash
gh pr checks <PR_NUMBER> -R aws-samples/sample-awsops
gh run view <RUN_ID> -R aws-samples/sample-awsops --json status,conclusion,jobs
```

The called `migrate-dev` jobs contain the bounded migration failure categories;
inspect their step results as well as the deploy job. Do not publish raw
Terraform state, credentials or response bodies to diagnose a failure.

## Action: current-source development releases

A matching `dev` push builds ARM64, completes the reusable private migration,
then promotes the verified digest and checks the exact ECS deployment and running
image. Every dev release also performs the existing private login/DB smoke.
`verify_database=false` does not turn that verification off.

Before enabling this path, review/apply `ci_migrations_enabled=true` with
`CI_MIGRATIONS_ENABLED_DEV=true` and confirm the non-null `migration_job` output.
The configured dev account, build/deployer roles and private migration network
must already work. A missing output or failed migration blocks promotion with
an explicit capability/migration failure; no gate is automatically enabled.
This deliberately runs required DDL unattended after an authorized dev push
once the operator has applied the capability. It is operator deployment
automation under ADR-005, not product/agent autonomy or a new AWS-mutation exception.

The repository settings verified on 2026-09-14 use the active `protect-main-dev`
ruleset: PRs are required for main/dev, bypass actors are absent, and force pushes
and branch deletion are blocked. The ruleset has no required approving-review
count or required-status-check rule. The `development` environment allows dev
and the three documented preview branches, with no environment reviewer gate.
Thus a merge intentionally starts dev DDL without another manual approval.
The maintained PR procedure still requires latest-HEAD AI review and successful
CI before merge; do not mistake the environment branch filter for a human approval.

```bash
# Build the dispatched dev source, migrate that source, deploy and verify:
gh workflow run deploy-web.yml -R aws-samples/sample-awsops --ref dev -f build=true

# Reuse a retained successful build of the current dev SHA; migrations still run:
gh workflow run deploy-web.yml -R aws-samples/sample-awsops --ref dev \
  -f image_build_run_id='<PRODUCER_RUN_ID>'
```

The migration result must name this source SHA and project. Standalone migrations
and AgentCore reuse remain dispatch-only. The additional push path requires both
the explicit reusable-workflow opt-in and the exact samples/dev Deploy Web caller.
Generic runtime-image build commands do not accept that opt-in.

## Image producer evidence

Fresh builds use the digest returned by Buildx. Reuse requires a receipt from
this repository, workflow, branch and source, with the same project and account
binding. The receipt records its producing attempt and numeric build-job ID.
GitHub artifact digest, workflow metadata, actual producing attempt, successful
build/publication steps and creation interval are verified; an artifact name
alone never authorizes an image.

An attempt-1 build receipt remains valid when a deploy-only retry advances the
run to attempt 2. The producer's build job must have succeeded; a subsequent
deployment failure is not evidence that the image build failed. A later,
authenticated failed build is ineligible and does not invalidate an earlier
successful receipt; selection uses the newest verified successful build attempt.
Receipts are
retained for 90 days. Expired, missing, legacy or unverifiable receipts fail closed:
rebuild the current source, choose another retained producer, or use a separately
reviewed operator recovery procedure. There is no mutable-tag-only fallback.
Public receipts contain no account identifier or deterministic account fingerprint,
credentials, role ARN or tfvars. The configured account and actual assumed role
are verified at runtime; repository, workflow, branch, source, project and image
content remain bound to the authenticated producer.

## Explicit older-image rollback

Rollback is a separate behavior. Select an older ancestor source and its retained
producer, and explicitly acknowledge compatibility with the currently applied
schema. This does **not** prove compatibility automatically or revert database
changes. Coordinate independent migration activity before acknowledging it.

```bash
gh workflow run deploy-web.yml -R aws-samples/sample-awsops --ref dev \
  -f image_sha='<OLDER_FULL_COMMIT_SHA>' \
  -f image_build_run_id='<PRODUCER_RUN_ID>' \
  -f rollback_schema_compatible=true
```

This skips the migration workflow entirely: neither the current source's DDL nor
an old migration runner executes. It still requires producer/account/project
proof, the exact new ECS deployment, healthy running digest, and dev login/DB
verification. Thus a broken current migration does not prevent an explicitly
acknowledged image rollback. Schema repair is a separate reviewed operation.

## Production and previews

`main` pushes build only. Production rollout remains manual and environment-gated:

```bash
gh workflow run deploy-web.yml -R aws-samples/sample-awsops --ref main -f build=true
# Or reuse a retained producer of the currently dispatched main SHA:
gh workflow run deploy-web.yml -R aws-samples/sample-awsops --ref main \
  -f image_build_run_id='<PRODUCER_RUN_ID>'
```

The same explicit source/producer/compatibility inputs select older production
images. Main always selects its production roles/backend; missing configuration
fails instead of falling back to dev. Preview branches keep their documented
dev-tier roles and separate stack secrets. Non-dev database migrations remain
operator-managed; this workflow never substitutes the dev database or demo
credentials for another stack.

## Verification, recovery and integration

In-flight rollouts are not cancelled by newer runs. Before promotion, the
dispatched branch must still match the source SHA. State metadata must agree with
the configured branch account/project. Verification binds the new deployment ID,
task revision, desired count, healthy task/container state and actual image digest.
A stable rollback to another image or a changed `web-latest` pointer is a failure.
There is no automatic rollback. A failure after pinning may leave the selected tag
or deployment changed; inspect it and use a new explicit release/rollback request.

For the separately owned runtime gate, `steps.pin.outputs.digest` is the trusted
root image digest; `steps.pin.outputs.runtime_digest` is its ARM64 manifest digest.
The deploy job exposes `expected_image_digest` and `expected_runtime_digest`.
Consumers of job outputs must require that deployment job to succeed. Within
the deployment job, run the verifier after exact ECS/image verification and
pass the values explicitly:

```yaml
EXPECTED_WEB_IMAGE_DIGEST: ${{ steps.pin.outputs.digest }}
EXPECTED_WEB_RUNTIME_DIGEST: ${{ steps.pin.outputs.runtime_digest }}
```

The runtime verifier must accept these digest inputs, fetch any needed manifest
by `imageDigest`, and compare running images to these values. `PIN_SHA` remains
source metadata; it must not become a fresh lookup of mutable `web-<SHA>` authority.
The runtime integration should replace/wrap the authenticated smoke at that
verification point: its current CLI consumes and removes the private credential
file. Do not append another consumer that assumes the same file still exists.

Targeted offline verification:

```bash
python3 -B -m pytest -q scripts/v2/test_ci_web_image.py scripts/v2/test_ci_web_deploy.py
node --test scripts/v2/ci/run-migration.test.mjs scripts/v2/ci/run-migration.workflow.test.mjs scripts/v2/ci/runtime-build.test.mjs scripts/v2/deployment-smoke.test.mjs
actionlint .github/workflows/deploy-web.yml .github/workflows/deploy-migrations.yml
```

These tests and workflow lint do not establish live deployment or effective IAM.
`.github/actionlint.yaml` declares the existing `sample-awsops` runner label.

## Related files and decisions

- `.github/workflows/deploy-web.yml` and `deploy-migrations.yml`: release ordering and guarded private execution.
- `scripts/v2/ci_web_image.py` and `ci_web_deploy.py`: producer evidence, IAM preflight and ECS verification.
- `scripts/v2/ci/run-migration.mjs`, `prepare-smoke-credentials.mjs` and `authenticated-smoke.mjs`: migration, private credentials and login/DB checks.
- `terraform/foundation/ci-migrations.tf`: default-off task and secret scopes.
- [Deployment setup](dev-repo-setup.md), [branch strategy](branch-strategy.md), and [SQL reader](agent-sql-reader.md): prerequisites and recovery.

ADR-001 governs immutable database migrations; ADR-005 keeps product remediation
and autonomy frozen while allowing these operator-authorized deployment steps.
