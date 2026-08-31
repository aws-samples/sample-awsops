# Documentation

Project documentation organized by purpose. Each subdirectory has its own CLAUDE.md.

## Structure

| Directory | Purpose |
|---|---|
| [architecture.md](architecture.md) | System architecture (single file) |
| [onboarding.md](onboarding.md) | New-joiner onboarding |
| [decisions/](decisions/) | **Decision single source of truth = `BASELINE.md`** + consolidated ADRs 001–020 + `ADR-MAPPING.md` (old ADR 001–046 bodies are at git tag `adr-legacy-2026-06-22`) |
| [reference/](reference/) | Current v2 design, one file per component (single source per component) |
| [runbooks/](runbooks/) | Operational playbooks by scenario |
| [reviews/](reviews/) | Code review / cross-review results |
| [plans/](plans/) | Old planning docs (legacy) — current plans live under `superpowers/plans/` |
| [superpowers/specs/](superpowers/specs/) | Design specs (brainstorming output) |
| [superpowers/plans/](superpowers/plans/) | Implementation plans (writing-plans output) — **a mix of current and frozen/superseded**; frozen-era plans (029–036 remediation, etc.) are not live (ADR-005 FROZEN); current truth is `decisions/BASELINE.md` |
| [history/](history/) | Old history — `archive/` (execution history), etc. Not current truth |
| [guides/](guides/) | AI test question sets (`ai-test-questions.md`, `ai-testing.md`), test coverage plan (`test-coverage-plan.md`), install/onboarding/troubleshooting guides |
| [api-reference.md](api-reference.md) | Full API route index (root `CLAUDE.md` calls this the 94-route index) |

## Conventions
- All new documents are **bilingual Korean/English** — exception: **all `CLAUDE.md`-type
  files, regardless of directory, are English-only** (root `CLAUDE.md`, `AGENTS.md`,
  `web/**/CLAUDE.md`, `agent/CLAUDE.md`, `terraform/CLAUDE.md`, `docs/runbooks/CLAUDE.md`,
  `docs/CLAUDE.md` itself, etc. — these are context files Claude Code auto-loads, so the goal
  is context-size savings). "Stays bilingual" applies to a directory's **body content**, not
  its `CLAUDE.md` — `docs/runbooks/*.md` (the runbook bodies, excluding `CLAUDE.md`) and other
  user-/operator-facing documents keep the bilingual rule.
- ADR bodies and the BASELINE decision register are maintained in the **private upstream
  repository**, not in this public tree — docs here cite ADR numbers (e.g. ADR-005) for
  traceability only; anything about mutation/autonomy is settled by ADR-005 FROZEN.
- Runbooks follow the rules in `docs/runbooks/CLAUDE.md`.
- Watch for secrets/credentials in committed docs (account IDs, ARNs, live domains, tokens) and
  reject them.

## Related Skills
- `/sync-docs` — auto-sync CLAUDE.md
- `/project-init:add-adr` — create a new ADR
- `/project-init:add-runbook` — create a new runbook
- `/project-init:health-check` — verify documentation coverage
