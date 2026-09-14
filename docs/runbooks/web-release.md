# Verified web release and rollback

Dev Deploy Web verifies image provenance, private migrations and exact ECS rollout, then mandatory full runtime readiness including login/DB, inventory, AgentCore/model access and both worker types. Runtime infrastructure and images must already be deployed.

## Symptoms and candidate causes

| Symptom | Candidate cause |
| --- | --- |
| Migration capability unavailable | Capability plan not applied, or wrong stack selected |
| `manual database bootstrap required` | Automatic web migration stops before baseline initialization; complete standalone bootstrap and reader sync first |
| Automatic SQL policy rejects a pending file | The full pending set includes unsupported SQL; complete reviewed standalone migration, then dispatch a fresh web release |
| Current release stops before promotion | Migration failed, source moved, or required reads denied |
| Reused image rejected | Wrong producer/source, expired receipt, or unsuccessful build/publication |
| Verification timeout | ECS did not converge, deployment failed, or image/health differs |
| Login/DB or runtime failure | Credentials, applied runtime prerequisites, collection freshness/quality, AgentCore/model access or owned worker proof failed |

**Verification commands:** Use `gh pr checks <PR_NUMBER> -R aws-samples/sample-awsops` and `gh run view <RUN_ID> -R aws-samples/sample-awsops --json status,conclusion,jobs`. Inspect both `migrate-dev` and deploy step results. Migration failures have bounded categories; never publish raw state, credentials or response bodies.

## Action: current-source development releases

Dev pushes changing `web/**`, `CHANGELOG.md` or `terraform/foundation/migrations/**` build ARM64, validate the selected receipt/ECR digest in a readonly prerequisite job, run matching private migrations on an initialized database only if the entire pending set passes automatic SQL admission, then promote and verify that same digest. Invalid reuse stops before DDL. Exact ECS/image verification precedes the mandatory full runtime gate, including login/DB; `verify_database=false` cannot disable it. Changes outside these file paths require explicit dispatch. Supported preview branches also deploy automatically for their configured push paths; main pushes build only. Migration receipts must match SHA/project. Standalone/AgentCore calls stay dispatch-only; dev web pushes require explicit reusable opt-in and the exact Deploy Web caller.

Preview migration-only pushes also build and roll the web service; their DDL and authenticated verification remain operator-managed. Automatic admission never changes `sql_reader` views, including views exposing new tables: review and apply those view changes through the standalone migration procedure.

First review/apply `ci_migrations_enabled=true`, set `CI_MIGRATIONS_ENABLED_DEV=true` and confirm non-null `migration_job`. Also complete [runtime/readiness adoption](runtime-foundation.md#required-development-release-check--개발-배포-필수-검증), including inventory/worker images, enabled dispatch and AgentCore provisioning. Missing capability or failed migration blocks promotion; disabled runtime prerequisites fail closed, and this workflow does not provision them. Enabled dev merges intentionally run DDL as operator deployments under ADR-005, not product autonomy or a freeze exception. Settings verified on 2026-09-14: `protect-main-dev` requires PRs and GitHub Actions `AI Code Review`/`Merge Verify` success on main/dev, blocks force-push/deletion and has no bypass actors or required human approval count. Development allows dev and the three preview branches without environment reviewers. Required checks and latest-HEAD review gate merge; a branch filter is not human approval.

**Database prerequisite:** a missing `public.schema_migrations` ledger fails under the advisory lock before any frozen-baseline initialization, even when the private task template retains `INITIALIZE_EMPTY_DB=1`. The runner error starts `Automatic migration requires manual bootstrap;`; CI reports `manual database bootstrap required`. Bootstrap a new empty database with the standalone workflow below (or `INITIALIZE_EMPTY_DB=1 make migrate` on an approved private host), completing the historical corpus and reader sync first. An occupied database without a ledger is refused. Initialized databases still check all pending files, including older gaps: `DEFAULT now()`/`gen_random_uuid()`, `ALTER`, `GRANT`, views and other unsupported syntax deliberately require reviewed standalone migration. No historical SQL exemption, annotation or flag bypass is available.

For bootstrap or unsupported pending SQL, dispatch the reviewed current dev source:

```bash
gh workflow run deploy-migrations.yml -R aws-samples/sample-awsops --ref dev
gh run list -R aws-samples/sample-awsops --workflow deploy-migrations.yml --branch dev --event workflow_dispatch
```

Select that dispatch's run ID and confirm its `headSha` is the intended commit:

```bash
MIGRATION_RUN_ID='<RUN_ID>'
gh run watch "$MIGRATION_RUN_ID" -R aws-samples/sample-awsops --exit-status
gh run view "$MIGRATION_RUN_ID" -R aws-samples/sample-awsops --json status,conclusion,headSha,jobs
```

Require **SUCCESS** (`status=completed`, `conclusion=success`), migration-container exit `0` and completed reader synchronization. Then start a fresh `build=true` web dispatch below; do not rerun an obsolete failed web run. If dev moves, reassess the new pending set. With an initialized ledger and no unsupported pending SQL, release directly. Contract cutovers also require the coordination procedure below.

```bash
gh workflow run deploy-web.yml -R aws-samples/sample-awsops --ref dev -f build=true
gh workflow run deploy-web.yml -R aws-samples/sample-awsops --ref dev -f image_build_run_id='<PRODUCER_RUN_ID>'
```

Fresh images use Buildx's digest. Reuse verifies repository, workflow, branch, source, project, artifact digest, producing attempt/job ID, successful build/publication steps and creation interval. Names alone never authorize an image. A successful attempt-1 build survives deploy-only attempt-2 retries; a later failed build does not invalidate earlier success. The newest verified successful attempt wins. Receipts expire after 90 days. Missing, legacy, expired or unverifiable receipts require a rebuild, another retained producer or reviewed operator recovery; there is no mutable-tag fallback. Public receipts contain no account ID/fingerprint, credentials, role ARN or tfvars. Caller/account checks happen separately at runtime alongside authenticated source/project/image evidence.

After image proof, migrations and service/read preflight, the controller calls `ci_web_image.promote(env, expected_digest=digest)` with the validated `IMAGE_PROJECT`. This repeats the caller/provenance/source guards and rejects a changed selection before publication. The source check immediately before ECS rollout and exact deployment/digest verification remain required. See the [helper contract](web-image-provenance.md).

## Explicit older-image rollback

Select an older ancestor and retained producer, then acknowledge compatibility with the applied schema. This neither proves compatibility nor undoes DDL. Coordinate independent migration activity first.

For pre-receipt or expired-receipt images, use [legacy operator recovery](legacy-web-image-recovery.md) with trusted source/digest evidence and explicit schema/write approval. Do not fabricate a receipt or use a mutable tag as provenance.

```bash
gh workflow run deploy-web.yml -R aws-samples/sample-awsops --ref dev -f image_sha='<OLDER_FULL_COMMIT_SHA>' -f image_build_run_id='<PRODUCER_RUN_ID>' -f rollback_schema_compatible=true
```

Rollback skips all migrations, so broken current migrations cannot block it. Producer/account/project proof, exact new deployment, healthy digest and full dev runtime checks including login/DB still apply; schema repair stays separate. Preflight requires identity/configuration, positive desired count and actual read permissions, including DescribeTasks for empty services. Prior health is advisory: failed services can recover; intentionally paused services are not reactivated. Main pushes build only. For manual, environment-gated production rollout, use the examples with `--ref main`. Main requires production roles/backend and rejects the declared dev account; missing configuration never falls back to dev. Previews use dev-tier roles with separate stack secrets. Non-dev migrations remain operator-managed; dev DB/demo credentials are not substituted.

## Verification, recovery and runtime integration

Automatic web callers force `AUTOMATIC_MIGRATION=1`: a missing ledger stops before initialization; on initialized databases the private runner checks every ledger-derived pending file against a conservative additive SQL subset before pending DDL, ledger upgrades or reader synchronization. Unsupported syntax requires the reviewed standalone migration procedure; annotations and dispatch inputs cannot bypass the automatic check. See [release safety primitives](release-safety-primitives.md). Automatic DDL is **expand-only**: every migration must remain compatible with all deployed web, collector, AgentCore/SQL-reader and worker consumers. The mandatory runtime gate proves the defined collection, AgentCore/model and Lambda/Fargate checks, not compatibility of every consumer with contract DDL. Column/view removal, restrictive CHECK/NOT NULL changes and other contract operations require a separately approved manual cutover after compatible consumers are deployed and verified.

For a contract cutover, freeze dev merges and other release/migration dispatches. Disable only Deploy Web with `gh workflow disable deploy-web.yml --repo aws-samples/sample-awsops` and confirm `disabled_manually` using `gh api repos/aws-samples/sample-awsops/actions/workflows/deploy-web.yml --jq .state`. Disabling prevents new runs but does not cancel existing ones: drain and verify that no web or migration runs remain active or queued before merging the reviewed contract change. Keep required AI/CI checks enabled. `CI_MIGRATIONS_ENABLED_DEV` controls planning, not execution of an already-applied `migration_job`; retain the applied capability for the approved manual cutover. With Deploy Web still disabled, explicitly dispatch `deploy-migrations.yml` on dev and verify every affected consumer. Then enable Deploy Web with `gh workflow enable deploy-web.yml --repo aws-samples/sample-awsops`, dispatch and verify the normal current-source web release, and only then lift the freeze. Do not merge contract DDL while automatic web execution is enabled or disable required checks as a migration bypass.

Web-driven migrations and operator/AgentCore migrations use separate concurrency groups, so automatic web traffic cannot evict a pending operator run. PostgreSQL's shared advisory lock admits only one runner and remains held through reader synchronization. A competing runner fails immediately with an actionable concurrent-migration message; retry only after the other release finishes. This lock does not span subsequent AgentCore provisioning, so release/schema compatibility and the maintenance freeze remain required.

New runs do not cancel in-flight rollouts. Superseded source checks fail even if DDL already applied. Verification binds account/project, deployment ID, revision, desired count, task/container health and digest. Wrong-image rollback or moved `web-latest` fails. The controller does not initiate rollback or count an ECS rollback as release success. Post-pin failures may leave state changed; inspect it before an explicit release/rollback request.

Every dev push/dispatch privately captures Terraform `runtime_deployment`, prepares credentials and uses a nonempty restricted workload session. After exact ECS/image verification, `runtime-release.mjs` collect mode consumes the verified root digest and resolves its ARM64 manifest by digest. The wired input is:

```yaml
EXPECTED_WEB_DIGEST: ${{ steps.pin.outputs.digest }}
```

Fetch manifests by `imageDigest`; `PIN_SHA` is source metadata, never authority to re-resolve `web-<SHA>`. The full gate includes login/DB, every catalog type's clean post-marker success with known counts/zero unknown attributes, a fresh known CloudFront record, nonce-bound SSM/AgentCore/model proof and both owned worker completions. Its authenticated helper consumes the private credential file; do not run standalone authenticated smoke first. Manual `collect-runtime.yml` supports existing-web prepare or full collect verification; prepare never substitutes for the release gate. See [runtime proof and budgets](runtime-foundation.md) and [restricted sessions](runtime-verifier-sessions.md).

## Related files, validation and decisions

- `.github/workflows/deploy-web.yml`, `deploy-migrations.yml`: release order and guarded private execution. `scripts/v2/ci_web_image.py`, `ci_web_deploy.py`: provenance, permission preflight and ECS checks.
- `scripts/v2/ci/run-migration.mjs`, `prepare-smoke-credentials.mjs`, `ci/runtime-release.mjs`: migrations, private credentials and full runtime verification; `.github/workflows/collect-runtime.yml` provides manual preparation/collection. `terraform/foundation/ci-migrations.tf`: default-off task/secret scopes.
- [Deployment setup](dev-repo-setup.md), [branch strategy](branch-strategy.md), [SQL reader](agent-sql-reader.md): prerequisites and recovery.

Mandatory CI checks include `python3 -B -m pytest -q scripts/v2/test_ci_web_image.py scripts/v2/test_ci_web_read.py scripts/v2/test_ci_web_deploy.py scripts/v2/test_ci_web_workflow.py` and `node --test scripts/v2/ci/*.test.mjs scripts/v2/deployment-smoke.test.mjs`; the workflow suite needs PyYAML and Bash. Optional local lint requires separately installed `actionlint` on PATH: `actionlint .github/workflows/deploy-web.yml .github/workflows/deploy-migrations.yml`. CI does not install/run actionlint; `.github/actionlint.yaml` declares the existing `sample-awsops` runner label. Offline checks do not prove live IAM/deployment.

ADR-001 governs immutable migrations; ADR-005 keeps product autonomy frozen while permitting these operator-authorized deployments.
