# High-risk ADR reversal — co-agent consensus + decision (2026-06-11)

> Panel: kiro · codex · gemini (model-diverse, 3/3 quorum) · Claude chair. Owner-initiated
> re-review ("리스크가 큰 ADR을 다시 확인하여 결정을 번복하자"). All subjects were built but shipped
> **flag-OFF** ($0/dark), so reversal = decision-level + freeze (keep the harmless dark code).

## Context that drove the call
AWSops v2 is an **AWS-only, small-team operations DASHBOARD** (real-time inventory/cost/AI-diagnosis),
already useful **read-only**. The high-risk tier (mutation, autonomy, external endpoints) was just
built behind disabled flags. The question: should AWSops pursue these *directions* at all?

## Verdicts (raw agreement)
| ADR | codex | gemini | kiro | Consensus |
|---|---|---|---|---|
| 029 + 036 — mutating/remediation substrate | REVERSE | REVERSE | REVERSE | **REVERSE (3/3)** |
| 031 Phase 3 — BYO-MCP (external tool servers) | REVERSE | REVERSE | REVERSE | **REVERSE (3/3)** |
| 031 Phase 4 — mutating tools via 029 | REVERSE | REVERSE | REVERSE | **REVERSE (3/3)** |
| 032 — autonomous incident lifecycle | DOWNGRADE | DOWNGRADE | REVERSE | **DOWNGRADE** (keep read-only investigation/Triage/RCA; drop autonomous mitigation/action) |
| 035 — K8sGPT in-cluster diagnosis | DOWNGRADE | KEEP | DOWNGRADE | **DOWNGRADE** (keep read-only Result-CRD integration; drop the H3a → 032/034/029 wiring) |
| 034 — RCA write-back (OpsCenter) | KEEP | KEEP | KEEP | **KEEP (3/3)** |

## Decisive rationale (unanimous theme)
AWSops' core value = **read-only ops dashboard + AI-assisted diagnosis**. Mutation / autonomy /
external-endpoint directions are **scope-creep a small team cannot safely maintain**, duplicate what
operators already run (SSM, Change Manager, IaC, console/CLI), and carry a permanent security/
maintenance surface (IAM blast radius, approval/rollback correctness, egress/SSRF/credential custody,
Sandbox-schema coupling). **Analysis stays in AWSops; action stays with humans / existing tooling.**

Dissent resolved by the chair: 032 — 2× DOWNGRADE vs 1× REVERSE → DOWNGRADE (its mitigation path
depended on 029/036, which is reversed, so the action path is moot; the read-only investigation/RCA
value is retained). 035 — keep the GET-only Result-CRD integration (all three agree it's low-risk);
abandon only the H3a autonomy/remediation wiring.

## Decision (owner-confirmed 2026-06-11) — status reversal + freeze
- **REVERSE:** ADR-029, ADR-036, ADR-031 Phase 3, ADR-031 Phase 4. Status → Reversed; flags stay
  `false` permanently with a **do-not-enable** marker. The flag-OFF substrate code is harmless ($0/
  dark) and is **frozen, not deleted** (cheap to revisit; deleting applied migrations is destructive).
- **DOWNGRADE:** ADR-032 (autonomous mitigation/action path abandoned; read-only Triage/investigation/
  RCA retained, recommendation-only, NO routing to the reversed 029/036). ADR-035 (read-only K8sGPT
  Result integration retained; H3a → 032/034/029 wiring abandoned).
- **KEEP:** ADR-034 (observability-write; low blast radius).

## What changes vs not
- **Changes:** ADR statuses + a "Decision Reversal" section per affected ADR; flag descriptions get a
  do-not-enable marker; the ADR index reflects the reversal. The read-only product is unaffected.
- **Does NOT change:** the LIVE read-only dashboard, ADR-031 Phase 1/2 (custom-agent catalog + per-
  account scoping — live), ADR-034, ADR-035's read-only path, all inventory/cost/chat/EKS-read.
- **Frozen dark code remains** (remediation/incident/writeback/k8sgpt substrates, flag-OFF). A future
  owner can delete it as cleanup or revisit a reversal; nothing runs while the flags are false.

## Addendum (2026-06-14 → 2026-06-16) — external-endpoint clause subsequently narrowed

This 2026-06-11 reversal named three high-risk directions — **mutation, autonomy, and external
endpoints** ("egress/SSRF/credential custody"). The **external-endpoint** clause was later
**narrowed (not erased)**:

- **ADR-040 (2026-06-14)** re-ran a multi-AI panel for a *narrow* slice — governed external
  knowledge/comms **DATA writes** (Slack/Notion/Jira/ServiceNow records, non-AWS-resource only).
  Verdict: 3 conditional un-freeze / **1 strong dissent (kept-frozen)** / 1 no-verdict. The dissent's
  data-exfiltration objection was **converted into hard conditions** (DLP/redaction + destination
  allowlist, non-AWS-only, flag-OFF, deferred impl), not dismissed. This slice has panel quorum.
- **ADR-041 (2026-06-14, owner-solo)** re-scoped the *principle*: "read-only" binds **AWS-resource
  mutation + autonomy**, not external DATA integration. A 2026-06-16 multi-AI panel reviewed that
  re-scope and returned **PARTIAL** — the outcome is legitimate (ADR-040 has quorum) but ADR-041's
  "this was always the intent" framing contradicts this record's text, so it is corrected to an
  **owner-override** (see ADR-041 governance addendum).

**Net invariant (unchanged):** **AWS-resource mutation + autonomy stay permanently reversed** (ADR-029/
036, ADR-031 P4 AWS-mutating tools, ADR-032 autonomous mitigation). Only the *external-DATA-integration*
reading of the external-endpoint clause was narrowed, under the controls above.

## Governance rule (adopted 2026-06-16)

When a multi-AI consensus **names a feature/direction by name as scope-creep**, any later
re-introduction — even under a narrowed scope — requires **either** (a) a fresh multi-AI panel on
the narrowed slice (as ADR-040 did), **or** (b) an explicit, dated **owner-override log entry** with
rationale (as ADR-041 now records). A re-scope must **not** be framed as a mere "clarification of
original intent" when it contradicts the documented rationale of the prior consensus. The
"multi-AI review not required" shortcut does **not** apply to such keystone re-interpretations.
