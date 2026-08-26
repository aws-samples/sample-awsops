# Design — v1-parity restoration: Diagnosis WADD quality · scheduling · RDS metrics · Prometheus NL→query

> Branch `feat/v2-parity` (worktree, base = `origin/feat/v2-architecture-design` @ b81062e).
> Trigger: owner report — "v2 looks under-built vs v1: RDS has no CloudWatch metrics, AI-diag looks
> hardcoded, Explorer (Prometheus) NL→query doesn't work like v1." Investigation reframed all three.

## 0. Investigation verdicts (ground truth, origin latest)

| Claim | Verdict | Reality |
|---|---|---|
| RDS no CloudWatch metrics | **TRUE (gap)** | `/api/inventory/[type]/metrics` short-circuits to `[]` for non-EC2. RDS metrics explicitly deferred ("F5"). v1 rendered an 8-metric per-instance table. |
| AI-diag hardcoded | **FALSE → reframed** | Genuinely dynamic (live collectors + per-section Bedrock). NOT hardcoded. But output is **far thinner than v1's Well-Architected Deep Dive (WADD)**: ① collectors fed only `count(*) by type` (being fixed by a concurrent branch), ② section prompts are 1–2 sentences vs v1's 15-section expert-persona prompts with pricing benchmarks + scoring + prescribed tables, ③ no 6-pillar health score / savings rollup / roadmap, ④ **no scheduling** (v1 had `report-scheduler.ts`). |
| Prometheus NL→query broken | **TRUE (gap), reframed** | Refactored on origin to route through `invokeAgent(gateway:'monitoring')`. Slow (full AgentCore agent for a one-shot translate) + wrong (PromQL-naive prompt + empty/unwarmed schema → hallucination). |

## 1. Deconfliction (CRITICAL — concurrent sessions active)

Local `feat/v2-architecture-design` was 82 commits behind origin. Concurrent work in flight:

- **`fix/v2-diagnosis-data`** (own spec+plan+P2 gate): fixes the diagnosis **DATA** layer — `collect_cw_metrics`
  resource_type bug + `collect_inventory` now returns bounded per-resource detail (region+`data`, secret-filtered)
  instead of counts. **Explicitly OUT OF SCOPE there: "LLM prompt rewrites; section/tier changes; web; terraform."**
- The datasource NL→query path was refactored by a merged PR (#63) — `web/lib/datasource-querygen.ts` deleted,
  generation moved onto the monitoring agent.

**Therefore this effort owns the COMPLEMENTARY, non-overlapping slices:**
- **WS-A** = the diagnosis **prompt/quality** layer (NOT the collectors — those are the concurrent branch's).
- **WS-B** = scheduling (table exists, unwired).
- **WS-C** = RDS metrics (open).
- **WS-D** = a **minimal, safe** Prometheus prompt fix only; the agent-routing latency revert is FLAGGED for the
  owner of #63, not done unilaterally.

**Do NOT touch:** `scripts/v2/workers/diagnosis/sources.py` / `test_sources.py` (concurrent A-data). Anything in the
ADR-frozen mutating/autonomous substrate (029/031-P4/036). The #63 agent-routing decision (no unilateral revert).

## 2. Constraints / invariants (all WS)

- **Read-only.** No AWS-resource mutation, no autonomy (ADR-041 re-scope still bars infra/SSM/autonomous). All
  diagnosis output is advisory ("권고만, 자동변경 금지") — already enforced by `_SYSTEM` in `report.py`.
- **Thin-BFF.** Heavy/long work is enqueued to the worker tier, never run inline. RDS metrics (WS-C) is a fast
  read-only CloudWatch `GetMetricData` — allowed inline (EC2 already does it). Scheduling dispatch (WS-B) runs on
  the worker/EventBridge tier.
- **Flag-gated infra.** New terraform (WS-B EventBridge+Lambda) defaults OFF → `plan` = no-op, $0. Shared-infra
  `apply` is controller-run (no agent `-auto-approve`).
- **arm64** for any new Lambda/worker image. **PII/secret redaction** before any LLM call stays intact.
- **Multi-account:** WS-C metrics fetch uses the existing `assumedClient(accountId,…)`/`currentAccountId()` path.
- **TDD + per-task commits.** Every touched file passes scope-guard. Tests green before the multi-model gate.

## 3. WS-A — Diagnosis WADD prompt/quality restoration

**Goal:** bring per-run output to v1 Well-Architected Deep Dive depth, grounded ONLY in v2's available collected
data (the concurrent branch now feeds real resource detail). No new collectors, no new IAM.

**Files:** `scripts/v2/workers/diagnosis/sections.py` (catalog/prompts — free), `scripts/v2/workers/diagnosis/report.py`
(synthesis assembly — shared with concurrent branch's coverage-note edit; keep my change additive + localized to
`build_markdown`/a new helper to minimize merge conflict), plus their tests.

**Changes:**
1. **Rewrite section prompts to WADD depth** (port v1 `src/lib/report-prompts.ts` structure, adapt to v2 data):
   each section gets an expert persona, prescribed markdown tables, **severity (Critical/Warning/Info)**,
   **priority (P1/P2/P3)**, **effort (Low/Med/High)**, AS-IS→TO-BE framing, and **AWS pricing benchmarks**
   (Graviton −20%, gp3 −20% vs gp2, RDS Multi-AZ doubles cost, NAT $0.045/hr, S3 storage-class tiers, etc.).
   Each prompt MUST instruct: base only on provided data; state "데이터 불가" where v2 lacks the signal (v2 has
   inventory detail + CW EC2 CPU + cost-by-service + X-Ray + posture + CloudTrail — NOT v1's full Steampipe
   granularity, so prompts ask for what the data supports and degrade honestly).
2. **6-pillar Infrastructure Health Score (0–100)** in the executive summary: the prompt instructs the model to
   compute a weighted score across the 6 WA pillars with v1's weighting (Ops 15 / Security 20 / Reliability 20 /
   Performance 15 / Cost 20 / Sustainability 10) and an interpretation band. (LLM-computed with explicit rubric,
   matching v1 — read-only, evidence-based.)
3. **Recommendations & Roadmap synthesis**: enhance the `recommendations` section — Quick Wins (this week) /
   Short-term (1–3mo) / Medium-term (3–6mo) tables, a priority matrix (impact×effort), and an estimated-savings
   rollup ($/mo, $/yr) where cost data supports it.
4. **Pillar coverage**: ensure the section catalog spans all 6 WA pillars (the current 8/15 sections roughly cover
   security/network/compute/db/cost — add/relabel so Operational-Excellence (observability) and Sustainability
   (legacy-generation) are explicit). Keep tier structure (light/mid = base, deep = +deep-only). No tier-count
   change that fights the concurrent branch's `total = len(catalog)+1` UI contract — keep the +1 invariant.
5. `report.py`: only additive markdown assembly (e.g., the health score already lives inside the exec-summary
   section body, so report.py may need **no** change; if a structural tweak helps, keep it to `build_markdown`).

**Tests (deterministic — LLM output quality is validated by the gate + a live smoke, not unit tests):**
- `test_sections.py`-style assertions (NEW file `test_sections_wadd.py` to avoid the concurrent `test_sources.py`):
  every section has non-empty persona+table cues; the catalog covers all 6 pillars (a pillar→section map);
  the exec-summary prompt contains the health-score rubric tokens; recommendations prompt contains the
  Quick/Short/Medium roadmap tokens. Prompts stay Korean-first.
- `report.py` tests: `build_markdown` still assembles TOC+sections; the +1 INTENDED_VS_ACTUAL invariant holds.

## 4. WS-B — Scheduled auto-diagnosis (wire the existing `report_schedules` table)

**Goal:** v1 `report-scheduler.ts` parity — periodic auto-diagnosis (weekly/biweekly/monthly, KST). The table
`report_schedules` (user_sub, schedule_type, enabled, next_run_at, …) already exists in v2 schema; it is unwired.

**Mechanism (thin-BFF + worker backbone, NOT in-process timers):**
1. **BFF route** `web/app/api/diagnosis/schedule/route.ts` (GET/PUT, authed): read/upsert the caller's schedule
   row (singleton per user_sub+schedule_type; enabled, tier, model). Compute `next_run_at` server-side (KST).
2. **Dispatcher** (worker tier): a small Lambda (or extend the existing `reaper`) on an **EventBridge rule
   (hourly)** that `SELECT … FROM report_schedules WHERE enabled AND next_run_at <= now()`, enqueues a
   `diagnosis`/`report` worker job per due row (reusing `enqueueJob`/`worker_jobs`), then advances `next_run_at`.
   Idempotent (advance-then-enqueue or a run-lock to avoid double-fire).
3. **UI**: a schedule panel on the diagnosis page (frequency select + enable toggle + next-run display).
4. **Terraform** `workers.tf`: EventBridge rule + dispatcher Lambda, **gated** (`diagnosis_schedule_enabled`,
   default false → plan no-op). IAM scoped to read `report_schedules` + enqueue. apply is controller-run.

**Tests:** route test (GET/PUT, auth, next_run computation); dispatcher handler test (fake conn: due rows enqueue
+ advance, not-due skip, idempotent); `terraform validate`/`plan` shows no-op when the flag is off.

## 5. WS-C — RDS CloudWatch metrics (v1 parity)

**Goal:** restore v1's per-instance RDS metrics (the EC2-only short-circuit blocks all non-EC2 types).

**Files:** `web/lib/metrics.ts`, `web/app/api/inventory/[type]/metrics/route.ts`, the inventory detail panel
component (locate during impl), tests.

**Changes:**
1. `web/lib/metrics.ts`: add `rdsMetrics(instanceIds, accountId)` → `@aws-sdk/client-cloudwatch` `GetMetricData`,
   namespace `AWS/RDS`, dim `DBInstanceIdentifier`, 8 metrics (CPUUtilization, FreeableMemory, DatabaseConnections,
   ReadIOPS, WriteIOPS, FreeStorageSpace, NetworkReceive/TransmitThroughput), ~3h window avg. Mirror `ec2AvgCpu`'s
   `assumedClient` multi-account path. Read-only, no persist.
2. `metrics/route.ts`: add an `rds` branch → KPI cards (avg CPU %, connections, free storage GB) like EC2.
3. **Detail panel**: render a per-instance metrics table/cards (8 metrics) when a resource_type=`rds` row is opened
   (resource_id = DBInstanceIdentifier). Live-fetch on open; degrade gracefully if CloudWatch denies.

**Tests:** `metrics.ts` unit (mock CW `GetMetricData` → parsed by_instance/avg); route test (rds branch returns
cards; non-rds/ec2 unchanged).

## 6. WS-D — Prometheus NL→query (minimal safe fix; latency flagged)

**Goal:** stop "엉뚱한 쿼리." Do NOT revert #63's agent routing unilaterally (contested/recently-merged).

**Files:** `web/app/api/datasources/generate/route.ts` (+ its test).

**Changes (safe, prompt-only):**
1. **Language-aware prompt**: replace the generic `queryOnlyPrompt(lang)` with per-language guidance — PromQL
   (rate()/sum by()/histogram_quantile, instant-vs-range, `[5m]` windows, metric names from schema), LogQL
   (stream selector `{label="x"}` + `|~` filters + `count_over_time`), TraceQL, and the existing read-only SQL rule
   for clickhouse. 2–3 canonical examples per language. This directly fixes "wrong/nonsensical" output.
2. **Schema-empty guard**: when no cached schema is found, the prompt must instruct the model that NO real metric
   names are available → ask the user to refresh schema rather than invent names (reduces hallucination).

**FLAGGED (NOT in this pipeline — needs #63 owner):** the dominant latency is routing a one-shot translate through
the full monitoring AgentCore agent. The fast fix is a direct lightweight Bedrock `Converse` (Haiku) for generation,
bypassing the agent — but that reverts #63. Recorded as a follow-up decision, not implemented here.

**Tests:** route test asserting the system prompt for prometheus contains PromQL guidance tokens and for loki
contains LogQL tokens; the read-only SQL rule still present for clickhouse; existing 401/400/413/502 behavior intact.

## 7. Sequencing & integration

1. WS-C (smallest, isolated, web-only) → 2. WS-D (small, web-only) → 3. WS-A (prompts; coordinate report.py with
the concurrent branch) → 4. WS-B (infra-heavy, flag-gated). Each WS = its own TDD task block + per-task commit +
multi-model gate on the diff. Final P4 gate on the cumulative diff. Merge to `feat/v2-architecture-design` with
`--no-ff` after a `merge-tree` dry-run (the established concurrent-session pattern); WS-B terraform `apply` +
`make deploy`/`make workers` are controller-run post-merge. WS-D's prompt fix and WS-A ship via `make deploy` /
`make workers` respectively.

## 8. Out of scope / non-goals
- Diagnosis collectors (`sources.py`) — concurrent branch owns them.
- Reverting #63's agent routing for NL→query (flagged only).
- Any AWS-resource mutation, autonomous remediation, or enabling ADR-frozen substrate.
- New observability connector kinds (Jaeger/Dynatrace/Datadog) — separate datasource-parity effort.
- AWS-resource SQL "explorer" console — v1 never exposed one; not requested.
