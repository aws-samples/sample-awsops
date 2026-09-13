<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: a7585dcee471 · generated-at: 2026-09-13 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are an external reviewer for this repo — project context below, distilled from CLAUDE.md. This file is shared verbatim by Kiro, Codex, and Agy (not a per-AI copy).

# Scripts — Reviewer Context

Deployment/ops scripts live under `v2/`; PR review automation lives under `pr-review/`.
Run from the repo root. Node dependencies are in `scripts/v2/package.json`, not the root.

## Diagnostic and deployment boundaries

- `v2/ci_db_diagnostics.py` is default-off advisory dev-plan diagnostics, enabled only by
  `CI_DB_DIAGNOSTICS_DEV=true`. Require `--target dev`, verify the state account, use the
  existing read-only role and exact CLI verb allowlist; no new grants, AWS writes or DB connection.
- Preserve independent web-log/configuration/server-tail results and unavailable/partial flags.
  Web logs select `db_ping_failed` OR `db_connection_failed` using JSON `evt`; fixed one-hour
  bounds, oldest-first, at most 3 × 100 events, actual `--next-token`/`--limit` pagination.
  Only fixed phase/milestone keys and finite 0–3,600,000 ms durations may be emitted;
  milestones cannot exceed elapsed. Latest timing is only the latest valid returned sample.
- RDS server logs use the configured first Aurora instance, at most three listing pages and
  the latest observed PostgreSQL file. Download newest 500 lines without Marker (1 MiB cap).
  Count only web-role lines; never publish filenames/raw lines. HBA is distinct from TLS.
- Metadata describes the service target definition, not every running revision. Credential
  environment/secrets names and environment-file presence are declarations only. SG and
  inline connect-Allow matches do not prove effective access under SCPs/permission boundaries.
- Emit fixed projections only; withhold raw logs, credentials, ARNs and Terraform/AWS errors.
  Only the optional diagnostics step tolerates failure, with an eight-minute limit.
  DNS/CI/readiness gates stay required. No result waives authenticated login/DB verification.
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
```

The CI fixtures use mocked AWS responses or local Terraform backends, not live AWS. Terraform
checks use 1.15.7 with isolated data and mocked providers; dependencies are declared in
`v2/requirements-test.txt`. Do not initialize a real backend for tests.
