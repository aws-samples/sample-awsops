# Web image provenance helper contract

## Status and symptoms

Deploy Web uses `scripts/v2/ci_web_image.py` through `ci_web_deploy.py`. This document defines the helper contract; [web release](web-release.md) defines migration and exact ECS verification ordering. Repository wiring does not establish a successful live deployment.

| Failure | Required action |
| --- | --- |
| Missing producer receipt/steps | Select a build with the completed steps below; existing builds do not gain receipts retroactively |
| Expired, missing or unverifiable receipt | Rebuild current source through receipt-enabled wiring; do not use a mutable tag as fallback |
| Development account missing/mismatched | Supply the protected 12-digit repository secret, including for main's exclusion check |
| Migration receipt missing | Require successful private-migration SHA/project outputs from the dev web caller |
| Branch moved | Dispatch current HEAD and validate the chosen producer again |
| Schema acknowledgement missing | Do not promote an older image until compatibility is explicitly approved |

## Verification and prerequisites

Offline tests: `python3 -B -m pytest -q scripts/v2/test_ci_web_image.py`. They use no AWS/GitHub calls but require **jq** for the large-compare projection fixture. The CLI requires Python 3.12, AWS CLI and GitHub CLI; `gh --jq` filters responses locally before the Python output cap.

Supply `GH_TOKEN` with repository contents/actions read access. AWS credentials come from the reviewed branch role and existing OIDC setup; credentials are never written into receipts. Build/deploy identity checks do not provision IAM.

`AWS_ACCOUNT_ID_DEV` must be a valid 12-digit **repository secret available to every helper invocation, including main**. Non-main roles must match it; main must differ. Main still requires the production role and target-stack checks in its caller. Do not define this secret only in the development environment or replace it with an invalid production override.

## Required workflow wiring

Deploy Web uses job `Build & push (arm64)` and step `Build and push (arm64)`, followed by these required producer steps:

1. `Record the image producer`: invoke `python3 scripts/v2/ci_web_image.py receipt --output <private-directory>/web-build.json` in job ID `build`, using the actual Buildx `IMAGE_DIGEST`.
2. `Retain the build receipt for explicit reuse`: upload exactly `web-build.json` as artifact `web-build-<GITHUB_RUN_ID>-<GITHUB_RUN_ATTEMPT>`, with 90-day retention.

Those exact job/step names are part of `BUILD_JOB`/`BUILD_STEPS`; renaming them requires updating this contract and its tests. The receipt records the real build job ID and attempt. Reuse validates artifact SHA-256, one-file archive shape, repository/branch/source/project, actual producing attempt, successful build/publication steps and artifact creation during that job.

The readonly `image-proof` job validates the selected receipt and ECR content **before** migrations. Deploy passes that selection as `PREFLIGHT_DIGEST`; `ci_web_deploy.py` checks it before snapshot/read preflight and calls `promote(env, expected_digest=digest)`. Publication must retain that validated project/digest. Dev migrations require `CI_MIGRATIONS_ENABLED_DEV=true`, applied `ci_migrations_enabled=true`, and a non-null `migration_job` output as described in [CI setup](dev-repo-setup.md).

The reusable `deploy-migrations.yml` exposes `source_sha`/`project` only after its migration controller succeeds. Deploy consumes them as `MIGRATED_SHA`/`MIGRATED_PROJECT`. Copying requested values without successful execution is not a migration receipt.

## Promotion entrypoint

Use `python3 scripts/v2/ci_web_image.py promote` from the protected integration, or `promote(env, expected_digest=...)` from its reviewed controller. This entrypoint enforces:

`actual caller → validated context → current source/migration or rollback checks → producer digest → final source/migration recheck → digest-checked ECR publication`.

The repository is always derived as `<validated IMAGE_PROJECT>-web`; callers cannot pass a different repository to `promote`. `pin_image` is a low-level publishing primitive, **not** the supported CI integration API. Do not assemble a weaker guard chain around it.

| Input | Trusted source / meaning |
| --- | --- |
| `GITHUB_*` run/ref/repository/workflow identity | GitHub-provided context for this repository's Deploy Web push/dispatch |
| `CI_ROLE_ARN`, `IMAGE_PROJECT` | Protected branch role/configuration; caller must independently bind the target stack |
| `AWS_ACCOUNT_ID_DEV` | Protected 12-digit dev account; mandatory even on main |
| `FRESH_DIGEST`, `FRESH_PROJECT` | Outputs of this run's trusted build job, never free-form dispatch values |
| `IMAGE_BUILD_RUN_ID` | Explicit completed producer run for reuse; cannot be the current run |
| `PIN_SHA` | Full source SHA; defaults to the current GitHub SHA |
| `MIGRATED_SHA`, `MIGRATED_PROJECT` | Real successful private-migration outputs matching current dev source/project |
| `ROLLBACK_SCHEMA_COMPATIBLE=true` | Explicit acknowledgement for an older ancestor image |
| `PREFLIGHT_DIGEST` / `expected_digest` | If supplied, promotion must retain the digest already validated before migration |

Fresh builds can promote only their own current SHA/project. Reuse is dispatch-only. A successful attempt-1 build remains eligible after a deploy-only attempt-2 retry, but the operator selects that producer in a new dispatch; the same run cannot recover through its own receipt.

Older-image rollback requires an ancestor SHA, retained successful producer and schema acknowledgement, and rejects any `MIGRATED_*` values. It runs no migrations and does not undo schema changes. The helper performs only ECR publication; the controller verifies the exact ECS deployment/running digest, followed by mandatory dev login/DB checks.

The migration receipt check applies to current-source **dev** only. Main/preview migration procedures remain caller/operator responsibilities. Main's account exclusion is not a positive production-account binding; protected production role/account and project configuration remain independent prerequisites. Jobs that need receipt metadata require `actions: read`.

## Expiry and transition recovery

This helper cannot validate pre-receipt or expired-receipt images and supplies no Actions bypass. [Legacy image recovery](legacy-web-image-recovery.md) defines the separately approved private-host procedure with independent source/digest evidence and schema approval.

For receipt-enabled rollback or a failed deploy retry:

1. Select a completed Deploy Web producer run on the same branch/project and its full source SHA. Dispatch from the current branch HEAD in a **new** run; do not rerun the producer to make it consume its own receipt.
2. For current-source reuse, validate the retained receipt/digest before migrations, run the required dev migration phase, and pass its successful SHA/project outputs. For an older ancestor, omit both migration values and record explicit schema compatibility approval.
3. Run `promote` with the selected producer/SHA and preflight digest. If identity, branch HEAD, receipt, manifest or migration evidence fails, stop before ECS rollout and select/rebuild through the same reviewed path. A fresh build cannot be used as an older-source rollback.
4. After publication, use the controller's bounded ECS rollout and authenticated verification. If rollout or verification fails after the tag changed, stop further promotion; record the previous/candidate digests and observed ECS deployment. An ECR tag change is not a service rollback, and this helper performs no automatic recovery or schema reversal.

Reuse examines at most 100 artifacts and 20 matching receipts, with a 1 MiB provider/archive cap and 4 KiB receipt cap; expired or incomplete evidence fails closed. Each provider command has a 90-second timeout. The controller bounds snapshot/start polling to 120 seconds each and exact deployment verification to 600 seconds; per-call limits alone do not bound the whole release. The 90-day retention setting is not proof that a receipt is still available.

For new receipt-enabled releases, rebuild the current reviewed source or choose another retained successful producer. If neither is possible, stop this helper path. Any separate operator recovery requires independent trusted source/digest evidence, schema approval and scoped write authorization; do not fabricate a receipt, treat an image label as evidence, or silently downgrade to the legacy mutable-tag path.

## Related files and boundary

See `scripts/v2/ci_web_image.py`, `scripts/v2/test_ci_web_image.py`, `.github/workflows/deploy-web.yml`, and [CI setup](dev-repo-setup.md). This operator CI publication is not product remediation/autonomy and adds no ADR-005 exception or IAM grant.
