<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: a28f836feb34 · generated-at: 2026-09-13 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are an external reviewer for this repo — project context below, distilled from CLAUDE.md. This file is shared verbatim by Kiro, Codex, and Agy (not a per-AI copy).

# Scripts — Reviewer Context

Deployment/ops scripts live under `v2/`; PR review automation lives under `pr-review/`.
Run from the repo root. Node dependencies are in `scripts/v2/package.json`, not the root.

## Diagnostic and deployment boundaries
- `v2/ci_runtime_policy.py` checks the configured CI role and STS account for dev activation,
  pins inventory/worker image digests and confines explicit runtime rollout DNS to owned
  private Cloud Map/ECS changes. Public DNS/certificates stay blocked; the runtime ECR
  bootstrap permits only three runtime repositories. Default-off flags and policy checks
  do not prove effective runtime access or collection.
- `v2/ci_tf_assets.py` prepares hash-locked pg8000 layers and carries generated Lambda assets
  with the encrypted saved plan. Restore checks plan hash, commit, scope, paths, types, modes
  and content hashes; missing or mismatched assets fail. The dependency closure is
  `v2/ci/pg8000-requirements.txt`.

- `v2/ci_db_diagnostics.py` is default-off manual dev-plan diagnostics. Both workflow and helper
  require `workflow_dispatch`, literal `CI_DB_DIAGNOSTICS_DEV=true`, and `--target dev`;
  region is fixed to `ap-northeast-2`. Invalid invocation context causes no AWS calls.
  State-account/STS consistency does not authorize access or detect the wrong same-account stack.
  Use existing read-only grants and a fixed CLI verb allowlist; no new grants/writes/DB connection.
- Run only after encrypted plan upload. Opt-in publishes fenced safe JSON, including posture
  booleans, to the public Actions log and step summary. Only this optional step tolerates
  failure (eight-minute limit); DNS/CI/readiness gates remain required.
- Retain all four sections independently: `logs`, `configuration`, `server_logs`, `rds_metrics`. Capped/failed reads with
  retained evidence are partial; distinguish unavailable source reads from unknown derived
  fields. Early context/input/identity failure returns only `{"status":"unavailable"}`.

- `no_matching_events` labels empty accepted samples; `no_error_inference=true` prohibits
  no-error/healthy conclusions from zero counts in every status. A known authenticated DB
  probe must fall within the returned one-hour window before interpreting the sample.
  Successful task-definition reads remain source-available for missing/malformed web containers;
  use `web_container_found` and derived-unknown flags. Discarded milestones and regex inputs
  shortened to 4,096 characters make samples partial; read-only violations are not swallowed.
- Web logs use JSON `evt` OR for ping errors and connection-stage observations: fixed one-hour
  bounds, oldest-first, at most 3 × 100 with `--next-token`/`--limit`. Only fixed phases/milestones
  and finite 0–3,600,000 ms durations are emitted; milestones cannot exceed elapsed. Latest
  timing describes the returned sample. Count invalid timings/discarded milestones explicitly.
- RDS reads at most two latest observed PostgreSQL files from at most three listing pages.
  Each download is newest 500 lines without Marker (1 MiB cap per file). FATAL/ERROR/PANIC
  web-role lines count as errors. `benign_role_mentions` counts exactly non-error-severity
  lines mentioning `awsops_web`; lines for other database roles are ignored. Never print
  filenames/raw lines. Failed downloads retain listing metadata as partial.
- Pool-acquire timeouts, unexpected connection loss, HBA rejection, TLS errors and PostgreSQL
  client/slot limits have distinct fixed categories. Metadata describes the service target
  definition, not running revisions; credential declarations do not prove runtime values.
  Exact inline-Allow/SG comparisons do not prove effective access or connectivity. Never
  waive authenticated DB/login readiness or expose Terraform/AWS error details.

- `rds_metrics` adds one bounded CloudWatch get-metric-data request for the configured first
  instance: seven IAM-auth Sum series, CPU Average, free-memory Minimum and capacity Average.
  Preserve fixed IDs, status/missing/invalid flags and at most 60 minute points per series;
  never publish remote labels/messages/tokens. Configured min/max ACUs are numeric or null.
  Clean Complete+empty is an available read with missing=true; Forbidden/InternalError is
  unavailable and PartialData or malformed/degraded reads are partial. `read_ok` describes
  the response envelope only. Instance metrics cannot attribute a probe outcome or authorize tuning.
  Prefix/message filters reject bare and mid-line tokens, but full-prefix SQL continuations
  and RAISE LOG can forge lifecycle text. Keep lifecycle_source_integrity=unverified_text,
  lifecycle_injection_possible=true and unknown probe outcome. Auth-success messages need
  log_connections (PostgreSQL default off, not enabled here); the uninspected setting stays null.
- `ci_plan_context.py` accepts only successful explicit same-repo/branch/SHA plan dispatches.
  PR/push plans are advisory. `ci_dns_policy.py` preserves managed certificate ownership and
  service aliases; blocks all public/private DNS mutations unless authorized, including Cloud
  Map and validation records. Routine CI cannot retire owned validation records.
- `ci_dev_domain.py` writes gitignored overrides for console/plan; reject tracked copies.
  Domain rollout is saved-plan metadata, not apply-time authority. No account-wide cert scan.
- Smoke scripts keep credentials/HTTP scratch in private 0700/0600 files with cleanup; publish
  only fixed phases and validated HTTP status. Never reset credentials to pass verification.
- Migration credentials stay in memory; verify RDS TLS and immutable baseline/ULID checksums.
  ULIDs have 26 Crockford-base32 characters (no I/L/O/U). One-shot initialization is atomic;
  elevated/missing reader roles and connection/cleanup errors block migration/deployment.
  Worker/migration images are ARM64, nonroot where applicable, and use CMD rather than ENTRYPOINT.
- PR panel/chair Claude calls require `--strict-mcp-config`; allowed-tools is not a substitute.

## Local verification

```bash
python3 -m pytest -q scripts/v2/test_ci_db_diagnostics.py
python3 -m pytest -q scripts/v2/test_ci_*.py
npm ci --prefix web
npm ci --prefix scripts/v2 --ignore-scripts --no-audit --no-fund
node --test scripts/v2/ci/*.test.mjs
node --test scripts/v2/ci/migration.itest.mjs scripts/v2/ci/web-db-connection.itest.mjs
```

Both PostgreSQL suites are required and fail rather than skip when prerequisites are missing.
They require bare `docker` on PATH, a reachable daemon, OpenSSL and `postgres:17`, without an
automatic `sudo`/`DOCKER` override. The web connection suite uses the locked web driver and
TypeScript, covering phase/timing logs, asynchronous passwords and original error propagation.

The CI fixtures use mocked AWS responses or local Terraform backends, not live AWS. Terraform
checks use 1.15.7 with isolated data and mocked providers; dependencies are declared in
`v2/requirements-test.txt`. Do not initialize a real backend for tests.
