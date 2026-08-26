# External knowledge/comms WRITE — scoped un-freeze co-agent decision (2026-06-14)

> Panel: kiro (opus-4.8 · kimi-k2.5 · glm-5) · codex · gemini · Claude chair. Owner-initiated
> ("후자[write] 본격 검토"). A **reversal-of-reversal** review of the 2026-06-11 high-risk reversal,
> scoped to ONE narrow slice: governed EXTERNAL KNOWLEDGE/COMMS writes (Slack/Notion/Confluence/Jira/
> ServiceNow records+messages) via ADR-039 `READ_WRITE`, AWS-resource mutation + autonomy staying reversed.

## Question
Un-freeze ONLY external knowledge/comms writes under the full ADR-039 §7 mutating-gate controls
(non-AWS-resource), or keep frozen? Options: (1) keep frozen, (2) un-freeze narrow, (3) un-freeze full,
(4) draft-only/no-live-write.

## Verdicts (raw)
| Panelist | Verdict | Core reasoning |
|---|---|---|
| **codex** | **2 (un-freeze narrow)** | Different risk class (annotative, reversible, ADR-034 precedent); must be a scoped exception, not a 029/036/031-P4 re-entry. Conditions: no AWS-resource writes, no BYO-MCP/arbitrary HTTP, enabled=false default, kill-switch, dry-run, idempotency, audit, scoped Secrets, SSRF, **content redaction**, 4-eyes. |
| **gemini** | **2 (un-freeze narrow)** | External comms ≈ "observability-writes" (ADR-034-aligned); keeps "analysis in AWSops, action with humans" as record-keeping/notification, not infra-changing. Reuse §7 controls; AWS-resource mutation stays frozen. |
| **kiro-glm** | **2 (un-freeze narrow)** | Concur; + flags that even egress-READ (inc2) opens egress surface → give READ its own ADR/Phase, don't bundle with write-back. |
| **kiro-opus** | **1 (KEEP FROZEN)** — strong dissent | Write routes through frozen 029/036 → un-freeze = revive the frozen substrate or a 2nd one (rejected scope-creep). **ADR-034 not a clean precedent** (internal OpsCenter, no 3rd-party egress/credential). Agent-driven SaaS write = **data-exfiltration channel** (prompt-injected agent posts inventory/topology/secrets externally) = different risk class, **worse on the axis that matters**. "Tell humans" already served by one-way ADR-012 Slack → low marginal value vs permanent surface. |
| kiro-kimi | (no parseable verdict) | not counted |

**READ-side (inc2 already-live egress-READ):** codex/gemini/opus = OK as-is (ADR-011 observability, not reversed BYO-MCP; reversal-compatible); opus notes residual DNS-rebinding TOCTOU → P3 backlog; glm = give it its own ADR (egress surface).

## Chair synthesis (verify-don't-vote-count)
Surface tally 3:1 for Option 2 — but a 3-day-old **unanimous owner-confirmed reversal** should not fall to a simple majority, and **all three Option-2 votes are conditional** (heavy guardrails; codex explicitly requires content-redaction). The dissent's **exfiltration** objection was **not rebutted** by the Option-2 camp, and the ADR-034 precedent is genuinely weaker than claimed (internal-only). Therefore: a "quiet un-freeze" does **not** clear the bar — but the qualified majority + the principled non-AWS-resource distinction justify pursuing it **only via a new dedicated ADR that bakes in the dissent's concerns as hard conditions** (esp. exfiltration DLP/redaction + destination allowlist; non-AWS-resource only; decoupled narrow substrate; flag-OFF; Option-4 draft-only fallback).

## Decision (owner-confirmed 2026-06-14)
**Option 2 via a new dedicated ADR → ADR-040.** Pursue (conditional), implementation deferred + flag-OFF.
The dissent's exfiltration + marginal-value points are converted into ADR-040's hard conditions 2 & 6 and
the Option-4 fallback. AWS-resource mutation + autonomy stay permanently reversed (2026-06-11 intact).
inc2 egress-READ confirmed OK as-is (ADR-011); a READ-axis ADR clarification is a low-priority follow-up.
