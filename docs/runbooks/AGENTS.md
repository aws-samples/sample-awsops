<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: d8f83197b530 · generated-at: 2026-08-26 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are an external reviewer for this repo — project context below, distilled from CLAUDE.md. This file is shared verbatim by Kiro, Codex, and Agy (not a per-AI copy).

# Runbooks — Reviewer Context

Operational playbooks organized by scenario, each following symptoms → diagnosis → action. See
`docs/runbooks/CLAUDE.md`'s index for the current runbook list (several are marked **v1
(legacy)** — v2 has since replaced their procedure with a different mechanism; don't treat a
legacy runbook's steps as the current operational path).

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
