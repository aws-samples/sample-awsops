# Verified web release and rollback

Use this procedure when a web release needs migration, image provenance or
rollout verification. Terraform/tool/AgentCore/worker deployment and broad runtime
or collection readiness remain separate procedures; this workflow changes no IaC.

## Current-source development releases

A matching `dev` push builds ARM64, completes the reusable private migration,
then promotes the verified digest and checks the exact ECS deployment and running
image. Every dev release also performs the existing private login/DB smoke.
`verify_database=false` does not turn that verification off.

Before enabling this path, review/apply `ci_migrations_enabled=true` with
`CI_MIGRATIONS_ENABLED_DEV=true` and confirm the non-null `migration_job` output.
The configured dev account, build/deployer roles and private migration network
must already work. A missing output or failed migration blocks promotion with
an explicit capability/migration failure; no gate is automatically enabled.
Protect dev push/merge access and the development environment for this
operator-authorized automation.

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
Receipts contain a digest of the account identifier rather than the raw configured
account, and contain no credentials, role ARN or tfvars.

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
```

These tests and workflow lint do not establish live deployment or effective IAM.
