# Release safety primitives

## Symptoms and current integration

Use this guide for a failed migration lock, SQL rejected on an automatic release, or an ECS release whose read calls are throttled or whose deployment rolls back. Deploy Web uses the controller/read transport and forces the automatic SQL policy for every web-driven migration. Standalone operator migrations retain their explicit manual mode. The runner reports lock contention immediately.

## Candidate causes

- Another migration owns the shared PostgreSQL advisory lock.
- A pending file contains SQL outside the conservative additive subset.
- A read-only AWS request encounters throttling or a temporary transport failure.
- ECS reports a failed deployment or a different replacement deployment.
- Caller identity, permissions, task configuration or image evidence differs.

## Verification

Run from the repository root:

```bash
npm ci --prefix scripts/v2 --ignore-scripts --no-audit --no-fund
python3 -m pytest -q scripts/v2/test_ci_web_read.py scripts/v2/test_ci_web_deploy.py
node --test scripts/v2/ci/automatic-migration-policy.test.mjs scripts/v2/ci/migration-runtime.test.mjs
node --test scripts/v2/ci/migration.itest.mjs
```

The two Python suites need Python 3.12 on Linux with `/proc`, POSIX process groups and `os.geteuid`; they simulate provider boundaries and do not invoke AWS CLI, gh, curl or jq. Running the controller itself still needs the provider tools documented by the web provenance contract. Node dependencies come from `scripts/v2/package-lock.json`; the PostgreSQL integration suite additionally requires bare Docker on PATH, a reachable daemon and OpenSSL. These tests do not prove deployed IAM or service readiness.

## Actions

### Automatic migration policy

`AUTOMATIC_MIGRATION=1` checks **every ledger-derived pending migration** while holding the advisory lock, after checksum validation and before pending SQL, ledger upgrades or reader password synchronization. Applied migration contents and immutable `-- since:` headers are never rewritten.

The automatic subset permits only transactional files containing simple new tables and ordinary non-unique btree indexes. Non-transactional files, `CONCURRENTLY`, all column alterations, procedural/dynamic SQL, dollar-quoted bodies and unknown syntax require a reviewed standalone migration. Column changes and their paired `sql_reader` view refresh must be reviewed/applied together; do not split a file to omit the view update. Rejecting all automatic column alterations avoids silently leaving fixed-column reader views stale. Failed concurrent indexes and partial non-transactional files require inspection/repair, never an `IF NOT EXISTS` retry that could ledger an invalid index. This is a conservative syntax admission rule, not proof that arbitrary SQL is backward-compatible or cheap. Review remains mandatory. The existing frozen-baseline initializer still checks that the database is empty; setting its flag on an existing database does not bypass pending-file checks.

The caller must set this flag from its verified automatic web context, never a dispatch input or a caller-supplied SQL annotation. Standalone manual migration leaves it unset and is the explicit override for approved contract cutovers. Keep web releases disabled and queues drained during those cutovers; keep required AI/CI checks enabled. Re-enable only after compatible consumers are verified.

This implementation adds no product autonomy, AWS-resource remediation flag or exception to ADR-005. Automatic caller activation remains a separately reviewed operator deployment change. `DRY_RUN=1` combined with automatic mode still validates the subset and rejects unsupported SQL rather than previewing rejected statements.

`pg_try_advisory_lock(4729411)` fails immediately when another runner holds the lock. No pending SQL or reader synchronization starts in that case. Acquired locks remain held through reader synchronization. Wait for the other release and start a new verified run; never remove the lock or repeat a mutation blindly. SQLSTATE `55P03` reports a database lock conflict, while `57014` reports query cancellation/timeout; neither alone proves another migration owns the advisory lock.

### AWS read and deployment contract

`ci_web_read.read_request(service, operation, options)` accepts only its explicit read-operation allowlist. `read_window(deadline, now=...)` supplies one shared remaining budget to nested calls; outside a window a call is capped at 30 seconds. Each call makes one attempt and cannot mutate AWS resources. Only recognized throttling, service-unavailable and transport-timeout errors raise `TransientReadError`; identity, permission, malformed responses and unknown errors are fatal. Diagnostics contain fixed labels, not provider data or credentials.

The controller's `wait_for` retries only transient reads and not-yet-converged observations inside that budget. Writes remain single-attempt. An explicit failed deployment or a new replacement PRIMARY fails immediately. The known pre-update PRIMARY may be stale for at most 15 seconds during receipt verification; a persistent old projection then fails with a replacement/rollback diagnosis. Callers pass the recorded `old_deployment_id` with the other verification fields to enable that narrow grace. Task digests, health and the final promoted-tag read share the verification window.

The controller still requires owned ARM64 `web-latest` task configuration, real source/image/migration proof before promotion, and exact healthy deployment evidence afterward. It performs no automatic rollback. Retain verified source/digest records and inspect any post-publication failure before another run.

### Caller inputs and permissions

The controller modes are `preflight-image`, `deploy` and `verify`. Use the verified caller/workflow/project/source and producer inputs from the web provenance contract. The caller independently supplies Terraform-derived `ECR_URI`, `ECS_CLUSTER` and `ECS_SERVICE`. Verification consumes `WEB_DIGEST`, `WEB_RUNTIME_DIGEST`, `WEB_DEPLOYMENT_ID`, `WEB_TASK_REVISION`, `WEB_DESIRED_COUNT` and optional `WEB_OLD_DEPLOYMENT_ID` only from the successful deployment step's outputs, never dispatch inputs.

The role needs ECR image/config reads and publication on the selected repository; ECS DescribeServices/UpdateService on its web service; ListTasks restricted by cluster; DescribeTasks on that cluster's task ARN prefix (including the synthetic permission probe); and region-scoped DescribeTaskDefinition. IAM UpdateService covers more than forced redeployment: code constrains the requested fields, and the underlying role's residual authority must be reviewed separately. No grants are installed here. For lock investigation, use the read-only `pg_locks`/`pg_stat_activity` procedure in [SQL-reader diagnostics](agent-sql-reader.md); never terminate sessions automatically.

## Related files

See `scripts/v2/automatic-migration-policy.mjs`, `migrate.mjs`, `migration-errors.mjs`, `ci_web_read.py`, `ci_web_deploy.py`, [web provenance](web-image-provenance.md), and [migration setup](dev-repo-setup.md). ADR-001 preserves migration history; ADR-005 separates operator deployment from frozen application autonomy. Schema/reader compatibility is governed by the migration and SQL-reader contracts linked above.
