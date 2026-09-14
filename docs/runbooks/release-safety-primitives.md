# Release safety primitives

## Symptoms and current integration

Use this guide for a failed migration lock, SQL rejected on an automatic release,
or an ECS release whose read calls are throttled or whose deployment rolls back.
The web controller and read transport are preparatory utilities: no workflow in
this change invokes them. The existing migration runner gains immediate lock
contention reporting and an opt-in SQL policy; automatic caller wiring is separate.

## Candidate causes

- Another migration owns the shared PostgreSQL advisory lock.
- A pending file contains SQL outside the conservative additive subset.
- A read-only AWS request encounters throttling or a temporary transport failure.
- ECS reports a failed deployment or a different replacement deployment.
- Caller identity, permissions, task configuration or image evidence differs.

## Verification

Run from the repository root:

```bash
python3 -m pytest -q scripts/v2/test_ci_web_read.py scripts/v2/test_ci_web_deploy.py
node --test scripts/v2/ci/automatic-migration-policy.test.mjs scripts/v2/ci/migration-runtime.test.mjs
node --test scripts/v2/ci/migration.itest.mjs
```

Python uses the documented Linux runner with AWS CLI, gh, curl and jq.
Node dependencies come from `scripts/v2/package-lock.json`; the PostgreSQL
integration suite additionally requires a reachable Docker daemon. These tests
do not prove deployed IAM or service readiness.

## Automatic migration policy

`AUTOMATIC_MIGRATION=1` checks **every ledger-derived pending migration** while
holding the advisory lock, after checksum validation and before pending SQL,
ledger upgrades or reader password synchronization. Applied migration contents
and immutable `-- since:` headers are never rewritten.

The supported subset includes simple new tables, non-unique btree indexes and
nullable columns with supported built-in types and constant defaults. Destructive
or restrictive alterations, procedural/dynamic SQL, dollar-quoted bodies and
unrecognized syntax require a reviewed standalone migration. This is a conservative
syntax admission rule, not proof that arbitrary SQL is backward-compatible or
cheap. Review remains mandatory. The existing frozen-baseline initializer still
checks that the database is empty; setting its flag on an existing database does
not bypass pending-file checks.

The caller must set this flag from its verified automatic web context, never a
dispatch input or a caller-supplied SQL annotation. Standalone manual migration
leaves it unset and is the explicit override for approved contract cutovers.
Keep web releases disabled and queues drained during those cutovers; keep required
AI/CI checks enabled. Re-enable only after compatible consumers are verified.

The deployment owner's standing instructions dated 2026-09-14 authorize this
work's reviewed commits, merges and deployments. The implementation confines
unattended development SQL to this checked subset; it adds no product autonomy,
AWS-resource remediation flag or exception to ADR-005.

`pg_try_advisory_lock(4729411)` fails immediately when another runner holds the
lock. No pending SQL or reader synchronization starts in that case. Acquired
locks remain held through reader synchronization. Wait for the other release
and start a new verified run; never remove the lock or repeat a mutation blindly.
SQLSTATE `55P03` reports a database lock conflict, while `57014` reports query
cancellation/timeout; neither alone proves another migration owns the advisory lock.

## AWS read and deployment contract

`ci_web_read.read_request(service, operation, options)` accepts only its explicit
read-operation allowlist. `read_window(deadline, now=...)` supplies one shared
remaining budget to nested calls; outside a window a call is capped at 30 seconds.
Each call makes one attempt and cannot mutate AWS resources. Only recognized
throttling, service-unavailable and transport-timeout errors raise
`TransientReadError`; identity, permission, malformed responses and unknown errors
are fatal. Diagnostics contain fixed labels, not provider data or credentials.

The controller's `wait_for` retries only transient reads and not-yet-converged
observations inside that budget. Writes remain single-attempt. An explicit failed
deployment or a new replacement PRIMARY fails immediately. The known pre-update
PRIMARY may be stale for at most 15 seconds; a persistent old projection then
fails with a replacement/rollback diagnosis. Callers pass the recorded
`old_deployment_id` with the other verification fields to enable that narrow grace.
Task digests, health and the final promoted-tag read share the verification window.

The controller still requires owned ARM64 `web-latest` task configuration, real
source/image/migration proof before promotion, and exact healthy deployment
evidence afterward. It performs no automatic rollback. Retain verified
source/digest records and inspect any post-publication failure before another run.

## Related files

See `scripts/v2/automatic-migration-policy.mjs`, `migrate.mjs`,
`migration-errors.mjs`, `ci_web_read.py`, `ci_web_deploy.py`,
[web provenance](web-image-provenance.md), and [migration setup](dev-repo-setup.md).
ADR-001 preserves migration history; ADR-005 separates operator deployment from
frozen application autonomy; ADR-021 governs consumer/schema compatibility.
