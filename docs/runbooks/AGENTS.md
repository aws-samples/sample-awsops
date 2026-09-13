<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: f42d7573b522 · generated-at: 2026-09-13 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are an external reviewer for this repo — project context below, distilled from CLAUDE.md. This file is shared verbatim by Kiro, Codex, and Agy (not a per-AI copy).

# Runbooks — Reviewer Context

Operational playbooks organized by scenario, each following symptoms → diagnosis → action. See
`docs/runbooks/CLAUDE.md`'s index for the current runbook list (several are marked **v1
(legacy)** — v2 has since replaced their procedure with a different mechanism; don't treat a
legacy runbook's steps as the current operational path).

## Deployment review checks
- `ci_migrations_enabled` / `CI_MIGRATIONS_ENABLED_DEV` is default-off. The manual
  `deploy-migrations.yml` + `run-migration.mjs` controller starts one verified private
  ARM64 task. Its IAM reads exact Aurora secrets; DB DDL uses those credentials.
  It enables no product AWS-resource mutation/autonomy (ADR-005).
- `dev-repo-setup.md` covers CI/OIDC, protected review recovery, ECR preflight and explicit
  same-branch/SHA dispatch plans. PR/push plans are advisory.
- `dev-domain-rollout.md` covers unpublished/same-domain dev stages only. Every domain-stage
  plan sets `domain_rollout=true` (dev/full only), pinned as default-false Terraform metadata
  `ci_domain_rollout`. Apply reads the saved marker, not current repo vars or an apply toggle.
  Scoped DNS permits only configured service A/ACM CNAME owners in the selected zone.
  Published old-domain retirement needs a separate expressly authorized plan under the old
  configuration; do not expand scope or accept unknown identities to make a rename pass.
- Dev repo name overrides feed console and plan through gitignored auto-tfvars; reject tracked
  copies before generation. Dev advisory preflight preserves ownership/publication from state
  without live ACM/SAN/trust validation. Its DNS allowance is reporting only, never apply
  authority. `CERTIFICATE_MODE_DEV` preserves ownership or selects managed issuance.
- Keep managed certificates as JSON null and preserve existing service aliases. External
  certificates must be operator-selected or already attached; never scan the account.
  Routine CI cannot externalize managed certificates or delete/replace owned validation CNAMEs,
  even with DNS permission. Ownership migration and record retirement need separate review.
- ALLDNS includes private Cloud Map, validation CNAMEs and registered ECS task changes:
  Steampipe tuning, hydrate-fallback remedies and rollback/disable can change private DNS.
  Ordinary full plans (`domain_rollout=false`) retain broad DNS behavior only with explicit
  permission. No private-DNS exception. Authorized cutovers set `allow_dns_changes=true` on
  both plan and apply; documentation is not authorization.
- Public summaries permit certificate suffixes, publication, change counts/addresses and
  active-rollout public zone name/ID/NS. Never expose full ARNs, account IDs or raw
  configuration/state/plan JSON. Deploy Web/manual smoke share the argv-safe Host/SNI/TLS
  CLI; health proves liveness only. Verify DB/auth separately before service A publication.
- From the repo root, `bash scripts/v2/terraform-test.sh` runs Terraform 1.15.7 in an isolated
  tracked-file copy with fresh `TF_DATA_DIR`, `init -backend=false` and mocked providers.
  Never initialize a real backend for tests. Dependencies: `scripts/v2/requirements-test.txt`;
  Node smoke tests are also required by the shared merge script.
  Root Python command: `python3 -m pytest -q scripts/v2/test_ci_*.py`.

## Conventions
- Filename: `kebab-case.md`, domain-then-topic order.
- Structure: symptoms → candidate causes → verification commands → action → related files/ADRs.
- Runbook *bodies* must be bilingual Korean/English (this index file itself is English-only,
  per the repo's CLAUDE.md-is-English-only rule).
- Commands should be copy-paste ready; cite the related ADR number(s) at the bottom.
- Do not let a runbook embed secrets, AWS account IDs, ARNs, or live domains.

## Known false-positives
- A runbook marked **v1 (legacy)** describing a procedure that no longer matches v2's
  architecture is intentional — it's kept for reference during the v1 decommission window
  (ADR-016), not stale content to delete outright.

## Authenticated development verification
- Dev-only `verify_database=true` prepares effective demo credentials privately before rollout,
  then verifies login and edge-authenticated `/api/db`; positive table count is not a ledger audit.
- Unwrapped Terraform and private 0600/0700 files are required. The CLI's HTTP scratch shares
  the prepared credential directory and always-cleanup; expose only phases/validated HTTP status,
  never Terraform diagnostics, bodies or cookies. Do not reset credentials to pass verification.
- Auth fixtures require curl/OpenSSL, PyYAML and Terraform 1.15.7; missing tools fail the runner.
