<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: 066f344501f0 · generated-at: 2026-07-08 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are an external reviewer for this repo — project context below, distilled from CLAUDE.md. This file is shared verbatim by Kiro, Codex, and Agy (not a per-AI copy).

# Decisions (`docs/decisions/`)

**Source of truth = `BASELINE.md`** (north star §0, invariants §1, gate/freeze register §2, decision index §3) + this directory's consolidated ADRs (`0NN-*.md`, single Status each). Start here.

Old ADR bodies (001–046) are **not in the tree** — preserved in git tag `adr-legacy-2026-06-22`, mapped in `../history/ADR-MAPPING.md`. **Do not read old bodies unless explicitly asked.**

## Conventions a reviewer must enforce
- New ADR number = current highest + 1 (currently 014).
- ADR structure: single Status (Accepted) / Context / Decision / Consequences / 6 Pillars. No narrating the reversal chain — state only the current net decision.
- **Same PR must update `BASELINE.md` §3 (or §2)** — an ADR without a BASELINE update is "not live" (anti-drift). Flag any ADR-adding PR missing this.
- Litmus test for a new/changed ADR: "can an AI block/pass a PR from reading only this document?"

## Boundaries / gotchas
- Read-only scope and freeze/gate status are decided by `BASELINE.md` §1/§2 — treat those as authoritative over any other doc.
- **AWS-resource mutation + autonomy is FROZEN (ADR-005).** Loosening it requires a new ADR + multi-AI panel + dated owner-override — never a doc-only reinterpretation. Flag any PR attempting to soften this via prose alone.
