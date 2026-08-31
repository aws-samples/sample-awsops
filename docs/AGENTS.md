<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: 19f7e3db1edd · generated-at: 2026-08-26 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are an external reviewer for this repo — project context below, distilled from CLAUDE.md. This file is shared verbatim by Kiro, Codex, and Agy (not a per-AI copy).

# Documentation — Reviewer Context

Project docs organized by purpose; each subdirectory has its own `CLAUDE.md`.
`decisions/BASELINE.md` is the decision single source of truth (+ consolidated ADRs 001–020).
`reference/` is current v2 design, one file per component. `plans/`, `superpowers/plans|specs`,
and `history/` mix current, frozen, and superseded material — never treat them as live guidance
on their own; anything about mutation/autonomy is settled by ADR-005 FROZEN regardless of what
an old plan says.

## Conventions
- New documents are bilingual Korean/English, with one exception: **all `CLAUDE.md`-type files
  are English-only regardless of directory** (they're context files Claude Code auto-loads —
  the goal is context-size savings). "Stays bilingual" is about a directory's body content,
  never its `CLAUDE.md`.
- ADR bodies and the `BASELINE.md` register live in the private upstream repository, not in
  this public tree — cite ADR numbers for traceability only.

## Review checklist
1. A CLAUDE.md-type file added in Korean (or bilingual) anywhere in the repo is a convention
   violation — flag it.

## Additional rule
- Docs tree only — no application logic. Watch for secrets/credentials in committed docs
  (account IDs, ARNs, live domains, tokens) and reject them.
