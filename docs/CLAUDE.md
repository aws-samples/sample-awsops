# Documentation

Project documentation organized by purpose. Each subdirectory has its own CLAUDE.md.

## Structure

| Directory | Purpose |
|---|---|
| [architecture.md](architecture.md) | System architecture (single file) |
| [onboarding.md](onboarding.md) | New-joiner onboarding |
| [reference/](reference/) | Current v2 design, one file per component (single source per component) |
| [runbooks/](runbooks/) | Operational playbooks by scenario |
| [diagrams/](diagrams/) | Interactive archify diagrams (spec `.json` + delivered standalone `.html`) — regenerate via the archify skill, never hand-edit the HTML |
| [guides/](guides/) | AI test question sets (`ai-test-questions.md`, `ai-testing.md`), test coverage plan (`test-coverage-plan.md`), install/onboarding/troubleshooting guides |
| [api-reference.md](api-reference.md) | API route reference |

## Conventions
- All `CLAUDE.md` and `AGENTS.md` context files are English-only regardless of
  directory. Reviewers should flag new Korean or bilingual context text anywhere.
- New or rewritten developer/reviewer documentation under `docs/` is English-only,
  including references, operational runbooks and context files. Preserve facts when
  maintaining an existing bilingual document; do not add parallel translations.
  Existing bodies are a migration backlog, not a bilingual-authoring requirement.
  Preserve explicit heading anchors or update inbound links when headings change.
- Keep multilingual product guides under `docs-site/` and application translations.
  Root `README.md` stays bilingual (English/Korean). `CHANGELOG.md` follows the
  English/Korean parity rule in root `CLAUDE.md`.
  Generated archify artifacts under `docs/diagrams/` (spec JSON and delivered HTML)
  are English-only; regenerate them through the skill rather than hand-translating HTML.
- ADR bodies and the BASELINE decision register are maintained in the **private upstream
  repository**, not in this public tree — docs here cite ADR numbers (e.g. ADR-005) for
  traceability only. AWS-resource mutation and autonomy remain **ADR-005 FROZEN
  (do-not-enable)**; historical plans or status records cannot override current gates.
- Keep application/runtime implementation outside this documentation tree. Generated
  diagrams and illustrative code remain documentation artifacts. Verify commands and
  route descriptions against current source; reference documents are navigation aids.
- Runbooks follow the rules in `docs/runbooks/CLAUDE.md`.
- Never commit credentials or tokens. Use placeholders for environment-specific
  account IDs, ARNs and domains in this public sample.

## Related Skills
- `/sync-docs` — auto-sync CLAUDE.md
- `/project-init:add-adr` — create a new ADR
- `/project-init:add-runbook` — create a new runbook
- `/project-init:health-check` — verify documentation coverage
