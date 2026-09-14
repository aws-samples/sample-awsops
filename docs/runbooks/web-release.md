# Verified web release and rollback

This workflow verifies migrations, provenance and web rollout. Infrastructure, AgentCore, workers and broad readiness remain separate.

## Symptoms and candidate causes

| Symptom | Candidate cause |
| --- | --- |
| Migration capability unavailable | Capability plan not applied, or wrong stack selected |
| Current release stops before promotion | Migration failed, source moved, or required reads denied |
| Reused image rejected | Wrong producer/source, expired receipt, or unsuccessful build/publication |
| Verification timeout | ECS did not converge, deployment failed, or image/health differs |
| Login/DB failure | Demo credentials, edge authentication or application DB connection failed |

## Verification commands

Use `gh pr checks <PR_NUMBER> -R aws-samples/sample-awsops` and `gh run view <RUN_ID> -R aws-samples/sample-awsops --json status,conclusion,jobs`. Inspect both `migrate-dev` and deploy step results. Migration failures have bounded categories; never publish raw state, credentials or response bodies.

## Action: current-source development releases

Dev pushes changing `web/**`, `CHANGELOG.md` or `terraform/foundation/migrations/**` build ARM64, run the matching private migration, promote its verified image and check the exact deployment. Login/DB smoke is mandatory; `verify_database=false` cannot disable it. Other paths require explicit dispatch.

First review/apply `ci_migrations_enabled=true`, set `CI_MIGRATIONS_ENABLED_DEV=true` and confirm non-null `migration_job`. Account, roles and private network must work. Missing capability or failed migration blocks promotion; this workflow does not provision them. Enabled dev merges intentionally run DDL as operator deployments under ADR-005, not product autonomy or a freeze exception.

Settings verified on 2026-09-14: `protect-main-dev` requires PRs and GitHub Actions `AI Code Review`/`Merge Verify` success on main/dev, blocks force-push/deletion and has no bypass actors or required human approval count. Development allows dev and the three preview branches without environment reviewers. Required checks and latest-HEAD review gate merge; a branch filter is not human approval.

```bash
gh workflow run deploy-web.yml -R aws-samples/sample-awsops --ref dev -f build=true
gh workflow run deploy-web.yml -R aws-samples/sample-awsops --ref dev \
  -f image_build_run_id='<PRODUCER_RUN_ID>'
```

The migration receipt must match source SHA/project. Standalone/AgentCore migration use stays dispatch-only. Dev web pushes require explicit reusable opt-in plus the exact samples/dev Deploy Web caller; generic runtime builds cannot use that opt-in.

Fresh images use Buildx's digest. Reuse verifies repository, workflow, branch, source, project, artifact digest, producing attempt/job ID, successful build/publication steps and creation interval. Names alone never authorize an image. A successful attempt-1 build survives deploy-only attempt-2 retries; a later failed build does not invalidate earlier success. The newest verified successful attempt wins.

Receipts expire after 90 days. Missing, legacy, expired or unverifiable receipts require a rebuild, another retained producer or reviewed operator recovery; there is no mutable-tag fallback. Public receipts contain no account ID/fingerprint, credentials, role ARN or tfvars. Caller/account checks happen separately at runtime alongside authenticated source/project/image evidence.

## Explicit older-image rollback

Select an older ancestor and retained producer, then acknowledge compatibility with the applied schema. This neither proves compatibility nor undoes DDL. Coordinate independent migration activity first.

```bash
gh workflow run deploy-web.yml -R aws-samples/sample-awsops --ref dev \
  -f image_sha='<OLDER_FULL_COMMIT_SHA>' \
  -f image_build_run_id='<PRODUCER_RUN_ID>' \
  -f rollback_schema_compatible=true
```

Rollback skips all migrations, so broken current migrations cannot block it. Producer/account/project proof, exact new deployment, healthy digest and dev login/DB checks still apply; schema repair stays separate. Preflight requires identity/configuration, positive desired count and actual read permissions, including DescribeTasks for empty services. Prior health is advisory: failed services can recover; intentionally paused services are not reactivated.

Main pushes build only. For manual, environment-gated production rollout, use the examples with `--ref main`. Main requires production roles/backend and rejects the declared dev account; missing configuration never falls back to dev. Previews use dev-tier roles with separate stack secrets. Non-dev migrations remain operator-managed; dev DB/demo credentials are not substituted.

## Verification, recovery and runtime integration

New runs do not cancel in-flight rollouts. Superseded source checks fail even if DDL already applied. Verification binds account/project, deployment ID, revision, desired count, task/container health and digest. Wrong-image rollback or moved `web-latest` fails. The mutable-tag circuit breaker cannot recover a bad image; post-pin failures may leave state changed. Inspect it before an explicit release/rollback request.

The separate runtime gate consumes root/ARM64 digests after exact ECS verification. Job outputs `expected_image_digest` and `expected_runtime_digest` require a successful deploy job. Within that job pass:

```yaml
EXPECTED_WEB_IMAGE_DIGEST: ${{ steps.pin.outputs.digest }}
EXPECTED_WEB_RUNTIME_DIGEST: ${{ steps.pin.outputs.runtime_digest }}
```

Fetch manifests by `imageDigest`; `PIN_SHA` is source metadata, never authority to re-resolve `web-<SHA>`. Replace/wrap authenticated smoke: its CLI consumes and removes the private credential file, so later consumers cannot reuse it.

## Related files, validation and decisions

- `.github/workflows/deploy-web.yml`, `deploy-migrations.yml`: release order and guarded private execution.
- `scripts/v2/ci_web_image.py`, `ci_web_deploy.py`: provenance, permission preflight and ECS checks.
- `scripts/v2/ci/run-migration.mjs`, `prepare-smoke-credentials.mjs`, `authenticated-smoke.mjs`: migrations, credentials and login/DB checks.
- `terraform/foundation/ci-migrations.tf`: default-off task/secret scopes.
- [Deployment setup](dev-repo-setup.md), [branch strategy](branch-strategy.md), [SQL reader](agent-sql-reader.md): prerequisites and recovery.

Offline checks: `python3 -B -m pytest -q scripts/v2/test_ci_web_image.py scripts/v2/test_ci_web_deploy.py`, `node --test scripts/v2/ci/*.test.mjs scripts/v2/deployment-smoke.test.mjs`, and `actionlint .github/workflows/deploy-web.yml .github/workflows/deploy-migrations.yml`. `.github/actionlint.yaml` declares the existing `sample-awsops` runner label. Offline checks do not prove live IAM/deployment.

ADR-001 governs immutable migrations; ADR-005 keeps product autonomy frozen while permitting these operator-authorized deployments.
