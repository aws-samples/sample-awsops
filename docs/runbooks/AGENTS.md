<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: b1bc57f3bfcf · generated-at: 2026-09-12 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are an external reviewer for this repo — project context below, distilled from CLAUDE.md. This file is shared verbatim by Kiro, Codex, and Agy (not a per-AI copy).

# Runbooks — Reviewer Context

Operational playbooks organized by scenario, each following symptoms → diagnosis → action. See
`docs/runbooks/CLAUDE.md`'s index for the current runbook list (several are marked **v1
(legacy)** — v2 has since replaced their procedure with a different mechanism; don't treat a
legacy runbook's steps as the current operational path).

## Deployment review checks
- `dev-repo-setup.md` covers CI/OIDC, protected review recovery, ECR preflight and explicit
  same-branch/SHA dispatch plans. PR/push plans are advisory.
- Keep managed certificates as JSON null and preserve existing service aliases. External
  certificates must be operator-selected or already attached; never scan the account.
  Routine CI cannot externalize managed certificates or delete/replace owned validation CNAMEs,
  even with DNS permission. Ownership migration and record retirement need separate review.
- ALLDNS includes private Cloud Map, validation CNAMEs and registered ECS task changes:
  Steampipe tuning, hydrate-fallback remedies and rollback/disable can change private DNS.
  No private-DNS exception. Future authorized cutovers set `allow_dns_changes=true` on both
  plan and apply dispatches; documentation is not authorization.
- Public summaries contain only managed/external certificate suffixes. Workflow/manual smoke
  share an argv-safe CLI preserving service Host/SNI/TLS through CloudFront.
- From the repo root, `bash scripts/v2/terraform-test.sh` runs Terraform 1.15.7 in an isolated
  tracked-file copy with fresh `TF_DATA_DIR`, `init -backend=false` and mocked providers.
  Never initialize a real backend for tests. Dependencies: `scripts/v2/requirements-test.txt`;
  Node smoke tests are also required by the shared merge script.

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
