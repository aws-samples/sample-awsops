# Verified web release and rollback

This workflow verifies migrations, provenance and web rollout. Infrastructure, AgentCore, workers and broad readiness remain separate.

## Symptoms and candidate causes

| Symptom | Candidate cause |
| --- | --- |
| Migration capability is unavailable | The reviewed capability plan was not applied, or the selected stack differs |
| Current-source release stops before promotion | Migration failed, source moved, or required deployment reads are denied |
| Reused image is rejected | Producer/run/source differs, receipt expired, or build/publication did not succeed |
| Verification times out | ECS observations did not converge, the rollout failed, or task/image health differs |
| Login/DB smoke fails | Configured demo credentials, edge authentication or the application's DB connection failed |

## Verification commands

```bash
gh pr checks <PR_NUMBER> -R aws-samples/sample-awsops
gh run view <RUN_ID> -R aws-samples/sample-awsops --json status,conclusion,jobs
```

Inspect both `migrate-dev` and deploy step results. Migration failures use bounded categories; do not publish raw Terraform state,
credentials or response bodies.

## Action: current-source development releases

A dev push changing `web/**`, `CHANGELOG.md` or `terraform/foundation/migrations/**` builds ARM64, runs the matching private migration,
promotes the digest and verifies the exact deployment/image. Dev login/DB smoke is mandatory; `verify_database=false` cannot disable it.
Other paths require an explicit release dispatch.

First review/apply `ci_migrations_enabled=true`, set `CI_MIGRATIONS_ENABLED_DEV=true` and confirm non-null `migration_job`. The dev account,
roles and private network must work. Missing capability or failed migration blocks promotion; nothing enables the capability automatically.
Once enabled, authorized merges intentionally run dev DDL. These are operator deployments under ADR-005, not product autonomy or a freeze
exception.

Settings verified on 2026-09-14: `protect-main-dev` requires PRs and GitHub Actions `AI Code Review`/`Merge Verify` success on main/dev,
blocks force-push/deletion and has no bypass actors or required human approval count. The development environment allows dev and the three
preview branches without environment reviewers. Required checks and latest-HEAD review gate merge; the branch filter is not human approval.

```bash
# Build the dispatched dev source, migrate that source, deploy and verify:
gh workflow run deploy-web.yml -R aws-samples/sample-awsops --ref dev -f build=true

# Reuse a retained successful build of the current dev SHA; migrations still run:
gh workflow run deploy-web.yml -R aws-samples/sample-awsops --ref dev \
  -f image_build_run_id='<PRODUCER_RUN_ID>'
```

The migration result must match the source SHA/project. Standalone/AgentCore use stays dispatch-only; dev web pushes require both explicit
reusable opt-in and the exact samples/dev Deploy Web caller. Generic runtime builds cannot use that opt-in.

## Image producer evidence

Fresh builds use Buildx's digest. Reuse verifies repository/workflow/branch/source/ project, artifact digest, producing attempt/job ID,
successful build/publication steps and artifact creation interval. Names alone never authorize an image.

A successful attempt-1 build survives a deploy-only attempt-2 retry. Later failed builds are ineligible without invalidating earlier
success; the newest verified successful attempt wins. Receipts expire after 90 days. Missing, legacy, expired or unverifiable receipts
require a rebuild, another retained producer or reviewed operator recovery. There is no mutable-tag fallback. Public receipts contain no
account ID or deterministic fingerprint, credentials, role ARN or tfvars; caller/account binding is checked separately at runtime, alongside
authenticated source/project/image evidence.

## Explicit older-image rollback

Select an older ancestor and retained producer, then acknowledge compatibility with the applied schema. This neither proves compatibility
nor undoes DDL. Coordinate independent migration activity before acknowledging it.

```bash
gh workflow run deploy-web.yml -R aws-samples/sample-awsops --ref dev \
  -f image_sha='<OLDER_FULL_COMMIT_SHA>' \
  -f image_build_run_id='<PRODUCER_RUN_ID>' \
  -f rollback_schema_compatible=true
```

Rollback skips all migrations, so broken current migrations cannot block it. Producer/account/project proof, exact new deployment, healthy
digest and dev login/DB checks still apply; schema repair remains separate. Preflight requires identity/configuration, positive desired
count and actual read permissions, including a DescribeTasks probe for empty services. Prior health is advisory: failed services can
recover, while intentionally paused services are not reactivated.

## Production and previews

`main` pushes build only. For manual, environment-gated production rollout, use
the build/reuse/rollback examples above with `--ref main`.

The same rollback inputs select older production images. Main requires production roles/backend and rejects the declared dev account;
missing configuration cannot fall back to dev. Previews use dev-tier roles with separate stack secrets. Non-dev migrations remain
operator-managed; dev DB/demo credentials are not substituted.

## Verification, recovery and integration

New runs do not cancel in-flight rollouts. Superseded source checks fail, even if DDL already applied. Verification binds account/project,
deployment ID, revision, desired count, task/container health and digest. Wrong-image rollback or a moved `web-latest` fails. There is no
automatic rollback: post-pin failures can leave the tag/deployment changed; inspect it before a new explicit release/rollback request.

The separate runtime gate consumes the root/ARM64 digests after exact ECS verification. Job outputs `expected_image_digest` and
`expected_runtime_digest` require a successful deploy job. Within that job pass:

```yaml
EXPECTED_WEB_IMAGE_DIGEST: ${{ steps.pin.outputs.digest }}
EXPECTED_WEB_RUNTIME_DIGEST: ${{ steps.pin.outputs.runtime_digest }}
```

Fetch manifests by `imageDigest`; `PIN_SHA` is source metadata, never authority to re-resolve a mutable `web-<SHA>` tag. Replace/wrap the
authenticated smoke: its CLI consumes and removes the private credential file, so a later consumer cannot reuse it.

Targeted offline verification:

```bash
python3 -B -m pytest -q scripts/v2/test_ci_web_image.py scripts/v2/test_ci_web_deploy.py
node --test scripts/v2/ci/run-migration.test.mjs scripts/v2/ci/run-migration.workflow.test.mjs scripts/v2/ci/runtime-build.test.mjs scripts/v2/deployment-smoke.test.mjs
actionlint .github/workflows/deploy-web.yml .github/workflows/deploy-migrations.yml
```

Offline tests/lint do not prove live IAM/deployment. `.github/actionlint.yaml` declares the existing `sample-awsops` runner label.

## Related files and decisions

- `.github/workflows/deploy-web.yml` and `deploy-migrations.yml`: release ordering and guarded private execution.
- `scripts/v2/ci_web_image.py` and `ci_web_deploy.py`: producer evidence, IAM preflight and ECS verification.
- `scripts/v2/ci/run-migration.mjs`, `prepare-smoke-credentials.mjs` and `authenticated-smoke.mjs`: migration, private credentials and login/DB checks.
- `terraform/foundation/ci-migrations.tf`: default-off task and secret scopes.
- [Deployment setup](dev-repo-setup.md), [branch strategy](branch-strategy.md), and [SQL reader](agent-sql-reader.md): prerequisites and recovery.

ADR-001 governs immutable migrations; ADR-005 keeps product autonomy frozen while permitting these operator-authorized deployments.
