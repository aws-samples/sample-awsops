<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: 29c69f72f4e9 · generated-at: 2026-07-08 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are an external reviewer for this repo — project context below, distilled from CLAUDE.md. This file is shared verbatim by Kiro, Codex, and Agy (not a per-AI copy).

## Module: `docs/`

Project documentation, organized by purpose. This directory is an index; each subdirectory carries its own CLAUDE.md/AGENTS.md.

### Layout (what lives where)
- `architecture.md`, `onboarding.md`, `INSTALL_GUIDE.md`, `TROUBLESHOOTING.md` — single-file references.
- `decisions/` — **decision source of truth = `decisions/BASELINE.md`** + consolidated ADRs 001–014 + `ADR-MAPPING.md`. Old ADR 001–046 bodies are NOT in the tree (git tag `adr-legacy-2026-06-22`) — don't read them unless explicitly asked.
- `runbooks/` — per-scenario operational response guides.
- `reviews/` — code-review / cross-review outputs.
- `plans/` — legacy planning docs; current plans live under `superpowers/plans/`.
- `superpowers/reference/` — current per-component v2 design; **one file per component is the single source of truth**.
- `superpowers/specs/` — design specs (brainstorming output).
- `superpowers/plans/` — implementation plans; a mix of **current and frozen/superseded** work (e.g. remediation plans 029–036 are frozen per ADR-005) — current truth is still `decisions/BASELINE.md`, not this directory.
- `superpowers/archive/` — historical v2 design-doc execution log.

### Conventions a reviewer must enforce
- **All new docs are bilingual** (Korean + English).
- **ADR filename format:** `NNN-kebab-case-title.md`. New ADR number = highest existing + 1 (currently 014; monotonic, no gaps/reuse). Same PR must update `decisions/BASELINE.md`.
- Runbooks must follow `docs/runbooks/AGENTS.md` rules.
- Design content belongs in `superpowers/reference/` (one component = one file). Edit the reference file rather than adding parallel docs or reviving archived ones.

### Boundaries / gotchas
- `reference/` and `decisions/BASELINE.md` are authoritative; `archive/` and frozen-era `superpowers/plans` entries are dead history — flag any change treating them as current, or splitting one component's design across multiple reference files.
- AWS-resource mutation/autonomy is FROZEN (ADR-005) — flag any doc that reintroduces it as live guidance without a new ADR + owner-override.
- Docs tree only — no application logic. Watch for secrets/credentials in committed docs (account IDs, ARNs, domains, tokens) and reject them.

### v1 vs v2 scope note
Legacy v1 (`src/`, CDK/EC2) runs in parallel with v2 (`web/`, `terraform/`). Confirm which stack a doc targets before applying its rules.
