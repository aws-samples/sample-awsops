<!-- generated-by: co-agent · source: CLAUDE.md · claude-md-sha: 50685120b3d4 · generated-at: 2026-09-14 · DO NOT EDIT — edit CLAUDE.md then run /co-agent sync-context -->

> You are an external reviewer for this repo — project context below, distilled from CLAUDE.md. This file is shared verbatim by the external review panel (not a per-AI copy).

# Documentation review

Use the current component references and scoped runbooks. Historical plans and
status records do not establish current deployment, approval or feature enablement.
ADR bodies and the BASELINE register live in the private upstream repository, not
this public tree. Cite ADR numbers for traceability; do not require local copies.
AWS-resource mutation and autonomy remain **ADR-005 FROZEN (do-not-enable)**.
Historical plans or status records cannot override current gates.

New or rewritten developer/reviewer documents under `docs/`, including operational
runbooks and context files, are English-only. Preserve facts while maintaining old
bilingual bodies; do not require parallel translations. Preserve explicit heading
anchors or update inbound links when headings change. Multilingual product guides
under `docs-site/` and application translations remain.

Generated archify spec/HTML artifacts are English-only. Regenerate delivered HTML
from its source using the skill instead of hand-translating it. Follow the scoped
runbook conventions for operational procedures. Verify commands and route descriptions
against source; reference documents aid navigation, not hand-maintained count authority.
Keep application/runtime implementation outside this documentation tree.

Never commit credentials or tokens. Use placeholders for environment-specific
account IDs, ARNs and domains throughout this public documentation tree. Distinguish source-supported
capability from actual execution evidence, and check commands and links against
this public checkout.
