# Design: v2 Design-Document Consolidation (component-oriented reference)

- **Date**: 2026-06-03
- **Status**: Approved (brainstormed via co-agent/superpowers flow)
- **Branch**: `feat/v2-architecture-design`
- **Scope**: v2 design documents only (specs + plans). ADRs and v1 design docs are out of scope.

## Problem

The v2 design knowledge is spread across 11 dated, phase-oriented documents under `docs/superpowers/`:

- **specs (3 v2)**: `2026-05-30-awsops-v2-architecture-design.md` (master, 23 KB), `2026-05-31-custom-agents-skills-design.md` (ADR-031), `2026-06-02-awsops-v2-p2-async-worker-backbone-design.md`
- **plans (8 v2)**: P1a–P1f phase plans (6) + `2026-05-31-adr-031-phase1.md` (53 KB) + `2026-06-02-awsops-v2-p2-async-worker-backbone.md` (57 KB)

To implement or modify any single v2 **component**, one must reassemble the master spec + the relevant phase plan(s) + the governing ADR(s). The phase plans are largely **execution history** (P1a–P2 are all DONE) organized by date/phase, not by component. There is **no consolidated, current, component-oriented design view**. This scatter is the core reason implementation is hard.

The ADRs themselves are immutable decision records and are **not** the problem — they were cleaned up separately (2026-06-03 correction notes). This work organizes only the *design documents derived from those decisions*.

## Goals

1. One current design view **per component** — "one component = one file."
2. Preserve all execution history (archive, not delete).
3. Keep ADRs as the immutable source of decisions; reference docs cite them.
4. Reference docs are living (no date prefix) and scale to P3/P4 by adding sections/files.

## Non-goals (YAGNI)

- Merging / renumbering ADRs.
- Touching v1 design docs (`container-cost`, `ai-routing-improvement`).
- Any code change.
- Authoring new P3/P4 designs (reference docs get a "🔜 backlog" placeholder section only).

## Target structure

```
docs/superpowers/
  reference/                      # NEW — current v2 design (living, no date prefix)
    README.md                     # overview + request flow + component→ADR/file map + phase status
    01-edge-network.md
    02-auth.md
    03-data-aurora.md
    04-web-bff.md
    05-agentcore.md
    06-workers.md
    07-eks.md
  archive/                        # NEW — execution history (preserved, superseded by reference/)
    README.md                     # "superseded by reference/" note + original→reference map
    <v2 specs ×3 + v2 plans ×8 moved here, filenames unchanged>
  specs/  plans/                  # v1 docs only remain (container-cost, ai-routing)
```

## Per-reference-doc template (fixed 7 sections)

Each `reference/NN-*.md` uses the same skeleton so any component reads the same way:

1. **Purpose** — 1–2 lines: what this component is.
2. **Current design** — the as-built architecture (synthesized from the source plan/spec, reflecting the live state).
3. **Decisions** — links to the governing ADR(s) with a one-line "what it decided."
4. **Key files** — `terraform/foundation/*.tf`, `scripts/v2/*`, `web/*` paths.
5. **Status** — phase + state (e.g., "P1a ✅ GREEN").
6. **Learnings & gotchas** — the reuse-critical traps (edge TLS 504, SG description immutable, HOSTNAME=0.0.0.0, Fargate CMD-not-ENTRYPOINT, Aurora major-upgrade, AgentCore eventual-consistency, SSM reserved prefix, ESM drain latency, etc.).
7. **Source** — the archived spec/plan(s) this consolidates + relevant `docs/reviews/*` links.

Bilingual (Korean + English) to match repo convention, kept concise.

## Source → reference mapping

| reference | absorbs |
|---|---|
| `README.md` | spec `2026-05-30-awsops-v2-architecture-design` (master overview, request flow, cross-cutting) |
| `01-edge-network.md` | plan P1a (foundation + CloudFront VPC Origin → internal ALB → Fargate) |
| `02-auth.md` | plan P1b (Cognito + Lambda@Edge) + P1d auth hardening (RS256 JWKS + PKCE) |
| `03-data-aurora.md` | plan P1c (Aurora Serverless v2 + 7-table schema) + PG 15→17.9 upgrade learning |
| `04-web-bff.md` | plan P1d (Next.js thin-BFF + dual-tier ECR + `make deploy`) + HOSTNAME/healthcheck learning |
| `05-agentcore.md` | plan P1f (provisioner) + spec `custom-agents-skills-design` + plan `adr-031-phase1` |
| `06-workers.md` | spec P2 + plan P2 (SQS+SFN+Lambda/Fargate `worker_jobs`) |
| `07-eks.md` | plan P1e (Access Entry + AmazonEKSViewPolicy onboarding) |

`docs/reviews/v2-p1d-*` and `v2-p1f-*` are linked from the Source section of the matching component doc (not moved).

## README index content

- One-paragraph v2 overview.
- **Request flow** (mermaid or text): CloudFront → VPC Origin (https-only:443) → internal ALB (HTTPS:443) → Fargate web:3000 → { Aurora (node-pg) | SQS → async workers | AgentCore (SSM-configured) }.
- **Component table**: component → reference file → governing ADR(s) → key files → status.
- **Phase status**: P1a–P1f ✅, P2 ✅ (W9 GREEN), P3 🔜, P4 🔜.
- Pointer to `archive/` for execution history.

## Archive strategy

- Create `docs/superpowers/archive/`.
- After extracting content into `reference/`, **move** (git mv) the 3 v2 specs + 8 v2 plans into `archive/` (filenames unchanged — history preserved and git-traceable).
- `archive/README.md`: states these are historical execution artifacts superseded by `reference/`, with an original-file → reference-doc map.
- v1 docs (`2026-03-16-container-cost-*`, `2026-03-09-ai-routing-*`) stay in `specs/`/`plans/` untouched.

## Cross-doc sync

- `reference/` is the single current source of v2 design; ADRs remain the immutable decision source (cited, never duplicated as authority).
- Add a pointer to `docs/superpowers/reference/` from `docs/CLAUDE.md` (docs index).
- No claude-md-sha impact (root `CLAUDE.md` unchanged), so AGENTS.md/GEMINI.md need no resync.

## Risks / mitigations

- **Content loss during synthesis** → archive originals (never delete); reference docs cite Source so the full detail is one click away.
- **Reference docs drifting stale** → they're component-scoped and small (easy to keep current); ADRs stay authoritative for decisions, so reference only restates current design, not rationale.
- **Concurrent-session branch switches** (repo hazard) → commit in small units; this is docs-only so no infra risk.

## Acceptance

- 7 `reference/NN-*.md` + `reference/README.md` exist, each following the 7-section template, covering P1a–P2 accurately against the live state.
- All 11 v2 specs/plans (3 specs + 8 plans) moved to `archive/` with an `archive/README.md` map; v1 docs untouched.
- `docs/CLAUDE.md` points to `reference/`.
- A reader can implement/modify any v2 component from its single reference doc (with ADR + archived-source links for depth).
