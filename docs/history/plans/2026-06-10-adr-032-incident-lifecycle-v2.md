# ADR-032 Incident Lifecycle (v2, flag-gated) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. This is the **v2-native** plan — it targets `terraform/foundation/` + `scripts/v2/` + `web/` + Aurora, NOT v1 `src/`/`data/*.json`. The v1 logic (`src/lib/alert-correlation.ts`, `alert-diagnosis.ts`, `alert-knowledge.ts`, `src/app/api/alert-webhook/route.ts`) is the **carried-forward reference** — PORT/ADAPT the logic into new v2 `web/` files, do **NOT** modify v1 `src/`. **Build the FULL Phase-1+2+3 substrate but ship it OFF behind `incident_lifecycle_enabled` (default false) ⇒ `terraform plan` = No changes for gated infra, $0, ZERO autonomous triggers fire. The Aurora `incident_lifecycle` data tables are always-present and harmless (idempotent migration v5, no autonomous behavior). Nothing autonomous runs until an operator flips the flag.**

**Goal:** Build the ADR-032 event-triggered autonomous incident lifecycle (Trigger → Triage → Investigation → Root-Cause & Mitigation-Plan → Prevention skeleton) **as a gated control-plane**, mirroring exactly how `workers_enabled`/`remediation_enabled` gate `workers.tf`/`remediation.tf` (`local.X = var.X ? 1 : 0`, every gated resource `count = local.X`). The lifecycle is a **persisted state machine** (Aurora domain state) that **rides the P2 backbone** (SQS + dispatcher + Step Functions + reaper) for orchestration/checkpointing/watchdog — it does **not** build a second orchestration spine (ADR-032 Addendum #3). All binding failure semantics (dedup races, per-stage checkpoint + watchdog, at-least-once + idempotency keys, Fargate-replacement resume) are implemented **from Phase 1**. Mitigation produces a plan that routes through the just-built `/api/actions` Action-Catalog front door (ADR-029/036) — the Lead agent **NEVER** executes mutations directly (Addendum #2/#5).

**Architecture (v2):** This **extends P2 + ADR-029/036 + ADR-031, gated by `incident_lifecycle_enabled`, $0/no-autonomy when off.** Layers:
- **Domain state (always-present, migration v5):** `incidents`, `incident_stages`, `incident_findings`, `incident_links`, `prevention_recommendations` Aurora tables. These are *domain state, not a second orchestration spine* (Addendum #3). The existing `alert_diagnosis` table (incident_id UNIQUE, severity, source, services[], resources[], fingerprint, payload JSONB) is **retained and extended** — `incidents` references it via `correlation_key`/`fingerprint` and persists the staged lifecycle on top. All tables empty + inert when the flag is off.
- **Orchestration (gated, reuses P2):** triggers enqueue `worker_jobs` rows of `type='incident_stage'` through the SAME P2 SQS queue + dispatcher; a **gated SIBLING `awsops-v2-incident` Step Functions** machine runs the per-stage progression with a Map over Sub-agents (Phase 2), `.waitForTaskToken` is NOT needed (agent calls are synchronous Lambda Tasks); the **P2 reaper is extended** to reconcile stalled incident stages (the watchdog). A gated EventBridge schedule drives the watchdog timeout sweep. `incident_lifecycle_enabled=false` ⇒ all gated infra `count=0` ⇒ `plan` = No changes ⇒ $0.
- **Agents (consume ADR-031, call ADR-029/036):** the Lead agent and Sub-agents execute as P2 Lambda Tasks that call `web/lib/agentcore.ts` `invokeAgent({gateway, messages, sessionId, systemPromptOverride?})` — actually a thin Python port (`scripts/v2/incident/agent_bridge.py`) calling AgentCore directly, since the SFN tasks are Lambdas. Sub-agent rosters resolve via the ADR-031 catalog (`agents`/`skills` tables read by the resolver). Mitigation builds an Action-Catalog plan and POSTs it through `/api/actions` (recommendation-only; remediation stays off) — never a direct mutation.
- **Ingress (env-gated web route):** `web/app/api/incidents/webhook` (HMAC per ADR-022) + `web/app/api/incidents` manual entry; both degrade-safe / return 503 when `INCIDENT_LIFECYCLE_ENABLED !== 'true'`.

**Tech Stack:** Terraform (`terraform/foundation/`, partial S3 backend, provider `~>6.0`, every gated resource `count = local.il`); Aurora PostgreSQL 17.9 via node-pg (`web/lib/db.ts` `getPool()`) on the web side and pg8000 (`scripts/v2/workers/db.py`) on the executor side; Python 3.12 arm64 Lambda (reuse the pg8000 layer + the worker_lambda VPC role pattern); Step Functions Standard ASL; AgentCore via `@aws-sdk/client-bedrock-agentcore` (web) / boto3 (python); Next.js 14 App Router (TS, `web/`, root path — no basePath, fetch `/api/*`); vitest for web, `ast.parse` + unit tests for Python. Admin gate reuses `web/lib/admin.ts` `isAdmin` + `web/lib/auth.ts` `verifyUser`.

**Key contracts (do not break):**
- **P2 single front-door + ledger (ADR-036 rule 1, ADR-032 Addendum #3):** the incident lifecycle ENQUEUES into the EXISTING P2 ledger/queue. `web/app/api/jobs/route.ts`-style insert: a `worker_jobs` row (`status='queued'`, `idempotency_key` ON CONFLICT) + `SendMessage` to `JOBS_QUEUE_URL`. The webhook/manual route does this for the *initial* stage; the incident SM advances subsequent stages by enqueuing more `incident_stage` jobs (or by direct stage Tasks within the SM — see Task 7). It does NOT create a parallel queue.
- **Dispatcher idempotency (reuse, extend):** `scripts/v2/workers/dispatcher.py` starts ONE SFN execution per message, `name == job_id`, `ExecutionAlreadyExists` = success. It currently routes `type=='action'` → remediation SM and `handlers.is_allowed(type_)` → workers SM. The incident path adds `type=='incident_stage'` → the **incident** SM (env `INCIDENT_STATE_MACHINE_ARN`, empty when the flag is off ⇒ incident jobs are DROPPED, never looped). `noop`/`noop-heavy`/`action` behavior is UNCHANGED.
- **`worker_jobs` lifecycle (reuse, terminal-immutable):** `db.py` `claim_running` (queued|running → running), `finish_job` (→ succeeded|failed|canceled), `get_job`, `set_manual_intervention`. The incident SM uses `worker_jobs` ONLY for orchestration accounting (one job per stage execution); the **authoritative lifecycle state lives in `incidents`/`incident_stages`** (the domain tables). Do NOT add incident-specific columns to `worker_jobs` — the link is `incidents.id`/`incident_stages` carrying the `job_id`.
- **SFN `$.runtime` Choice (reuse the workers idiom):** `scripts/v2/incident/incident.asl.json` is a SEPARATE ASL with its own state graph; on any Catch it reuses the EXISTING `status_updater` Lambda (`scripts/v2/workers/status_updater.py`) for the `worker_jobs` terminal-failed write (SFN cannot write VPC Aurora), and an incident-specific `incident_stage_failed` Lambda for the DOMAIN `incident_stages.status='failed'` + `incidents.status` write.
- **Workers gating idiom (mirror exactly):** `terraform/foundation/workers.tf` `local.we = var.workers_enabled ? 1 : 0`; `remediation.tf` `local.re = var.remediation_enabled ? 1 : 0`; every gated resource `count = local.X`; outputs `one(aws_*.x[*].attr)`; web env via `merge(base, var.X ? {..} : {})` so `false` ⇒ byte-identical. The new `incidents.tf` uses `local.il = var.incident_lifecycle_enabled ? 1 : 0` identically. **`incident_lifecycle_enabled=true` REQUIRES `workers_enabled=true`** (it reuses the SQS queue, dispatcher, status_updater, reaper, pg8000 layer, service SG — all `workers_enabled`-gated).
- **Action-Catalog front door (ADR-029/036, reuse — Addendum #2/#5):** Mitigation NEVER mutates. The mitigation-plan builder produces catalog-shaped action references and posts to `web/app/api/actions/route.ts` `POST` (create-plan, admin-gated, dry-run only). `web/app/api/actions/[id]/route.ts` `POST {op:'execute'}` already enforces flag + kill-switch + 4-eyes + not-expired; the Lead agent calls NONE of this — it only emits the recommended catalog action names + inputs into `prevention_recommendations`/the RCA payload. Execution is a separate, human-initiated `/api/actions` flow.
- **Resolver (ADR-031, reuse):** `web/lib/agent-resolver.ts` `resolveAgent(routeKey, candidates)` / `pickCustomAgent(prompt, candidates)`; `web/lib/catalog-source.ts` `getEnabledCustomAgents()`. The Lead agent resolves which Sub-agents (gateways/skills) apply per incident through these. `SAFEGUARD_LINE` (the non-overridable read-only safety boundary) MUST be prepended to any agent prompt built from attacker-controlled alert text (Addendum #6).
- **AgentCore invoke (reuse):** web side `web/lib/agentcore.ts` `invokeAgent({gateway, messages, sessionId, systemPromptOverride?, agentName?, skillHashes?})`; python side mirror in `scripts/v2/incident/agent_bridge.py` using `boto3` `bedrock-agentcore` `invoke_agent_runtime` reading the runtime ARN from SSM `/ops/awsops-v2/agentcore/runtime_arn` (the SSM source-of-truth rule).
- **Schema file shape:** `terraform/foundation/data/schema.sql` is one idempotent file: a `BEGIN;…COMMIT;` block (v1) then post-COMMIT `CREATE TABLE IF NOT EXISTS` blocks each ending `INSERT INTO schema_migrations VALUES (N,…) ON CONFLICT DO NOTHING`. Current head = **v4**. Migration **v5** is a new post-COMMIT idempotent block following the v4 style.
- **Container/SSM rules:** all images arm64; ops params under `/ops/${var.project}/…` (leading `aws…` rejected); ECS secrets need execution-role; Fargate worker CMD not ENTRYPOINT (the incident lifecycle uses only Lambda Tasks in Phase 1–3 — no new Fargate path).

---

## How schema.sql is applied in v2 (discovered)

Aurora has **no migration Lambda** in v2. `terraform/foundation/data/schema.sql` is applied by **`psql` from an in-VPC deploy host** (the controller's box inside `mgmt-vpc`). The file is idempotent (`CREATE TABLE IF NOT EXISTS` throughout) and tracked by `schema_migrations`. So "apply migration v5" = the controller runs `psql` against the cluster endpoint with the RDS-managed master secret. Migration v5 is harmless when `incident_lifecycle_enabled=false` (it only creates empty tables + a registry of stage-timeout defaults — no infra, no execution, no autonomous behavior).

Exact apply command (controller, final task):
```bash
PGPASSWORD="$(aws secretsmanager get-secret-value \
  --secret-id "$(terraform -chdir=terraform/foundation output -raw aurora_secret_arn)" \
  --query SecretString --output text | python3 -c 'import sys,json;print(json.load(sys.stdin)["password"])')" \
psql -v ON_ERROR_STOP=1 \
  "host=$(terraform -chdir=terraform/foundation output -raw aurora_endpoint) port=5432 dbname=awsops user=awsops_admin sslmode=require" \
  -f terraform/foundation/data/schema.sql
# verify: SELECT version FROM schema_migrations;  -> includes 5
```

---

## Decision: reuse the P2 queue/dispatcher/reaper/status_updater + a SIBLING incident SFN

**Decision: REUSE the P2 SQS queue, dispatcher, `status_updater`, reaper, pg8000 layer, and service SG. ADD only ONE new orchestration resource — a gated SIBLING `awsops-v2-incident` Step Functions machine — plus a gated EventBridge schedule for the watchdog timeout sweep, the incident-stage Lambdas, and the incident IAM. Mirrors how `remediation.tf` added exactly one sibling SM and otherwise rode P2.**

Why reuse P2's queue/dispatcher/reaper (Addendum #3 is binding — *"execution bound to the P2 backbone; `incident_lifecycle` tables are domain state, not a second orchestration spine; the watchdog/checkpointing rely on P2/Step Functions"*):
- **One queue, one dispatcher, one kill-switch.** The SQS ESM kill-switch already pauses ALL async work; adding a parallel incident queue would create a second, un-governed spine — exactly what Addendum #3 forbids. The dispatcher gains one `type` branch (`incident_stage` → incident SM), identical to how it gained `action` → remediation SM.
- **Watchdog = the existing reaper, extended.** The P2 reaper already runs every 5 min reconciling stale `worker_jobs`. The incident watchdog (per-stage timeout → terminal `stalled`) is the SAME pattern over `incident_stages` — extend `reaper.py` (or add a gated `incident_watchdog.py` Lambda on its own gated 1-min EventBridge rule for tighter stage timeouts; chosen: a **separate gated watchdog Lambda** so its cadence/role stay independent of the GREEN P2 reaper and so it is trivially $0 when off). Justification for a separate watchdog Lambda rather than folding into the reaper: the reaper is `workers_enabled`-gated and GREEN; adding incident-table queries to it would couple the GREEN P2 path to incident tables that may not exist on a workers-only deploy. A `local.il`-gated `incident_watchdog` is provably $0-when-off and independently monitored.

Why a SIBLING incident SM (not extend the workers SM):
1. **$0-when-off is structurally clean** — a separate `local.il`-gated `aws_sfn_state_machine.incident` (count=0 when off) makes No-changes-when-off trivially provable, and never touches the GREEN workers SM definition/tests.
2. **Different IAM surface** — the incident SM role needs `lambda:InvokeFunction` on the triage/lead/sub/finalize Lambdas + `states` logging; it does NOT need `ecs:RunTask`. Keeping it separate bounds blast radius.
3. **Different state graph** — Triage → (New|Linked|Skipped) Choice → Investigation (Phase 2: a Map state over the resolved Sub-agent roster, `MaxConcurrency` = the fan-out cap) → RootCause+MitigationPlan → Prevention(skeleton) → Done; with per-stage checkpoint Tasks and a Catch → `incident_stage_failed`. Independent of the workers/remediation graphs.

What is **reused** (no duplication): the SQS queue + DLQ + ESM kill-switch, the dispatcher (one new branch), `status_updater` (worker_jobs terminal-failed), the reaper (untouched — incident watchdog is its own gated Lambda), the pg8000 layer, `aws_security_group.service`, the `worker_lambda` VPC role pattern (the incident Lambdas get their OWN least-privilege role per Addendum #5), and the `worker_jobs` ledger for orchestration accounting. The incident SM + watchdog + stage Lambdas + IAM are the only new resources, all `local.il`-gated.

---

## File map

**Create (Terraform):**
- `terraform/foundation/incidents.tf` — ALL `incident_lifecycle_enabled`-gated infra: the sibling incident Step Functions SM (`incident.asl.json`), the incident-stage Lambdas (`triage`, `lead`, `subagent`, `rootcause`, `mitigation_plan`, `prevention`, `incident_stage_failed` — packaged from `scripts/v2/incident/` + shared `scripts/v2/workers/db.py`), the gated `incident_watchdog` Lambda + its EventBridge rate(1 minute) rule + permission, the incident SM IAM role (least-privilege: invoke the incident Lambdas + SfnLogging only), the incident-Lambda least-privilege role (Aurora secret + KMS + AgentCore invoke + SSM read of runtime ARN + the storm-cap SSM params), the configurable-window SSM params (`/ops/${project}/incident/correlation-window-minutes`, `/ops/${project}/incident/stage-timeout-seconds`, `/ops/${project}/incident/max-concurrent-investigations`, `/ops/${project}/incident/subagent-fanout-max`, `/ops/${project}/incident/min-severity`, all `ignore_changes=[value]`), CloudWatch log groups. Outputs `one(…)`-wrapped (`incident_state_machine_arn`).

**Create (Python — `scripts/v2/incident/`):**
- `correlation.py` — the Triage correlation engine PORTED from `src/lib/alert-correlation.ts` (time/service/resource/namespace rules), ADAPTED to a stateless, Aurora-backed look-back query (no in-memory `activeIncidents` Map — the active set is `SELECT … FROM incidents WHERE status IN ('triaged','investigating') AND last_event_at > now() - :window`). Returns `New|Linked|Skipped` + the matched `incident_id`. Window from SSM (configurable, Addendum #4), NOT hardcoded.
- `triage.py` — Lambda: dedup-race-safe `New` creation via the unique `correlation_key` + `INSERT … ON CONFLICT` (Addendum binding (a)); on conflict → resolve to `Linked` (append to `incident_links`); severity gate (Addendum #7); structured-input isolation of the attacker-controlled payload (Addendum #6) before any agent text is built; checkpoints `incident_stages`.
- `lead.py` — Lambda: the Lead/Incident-Commander. Resolves the Sub-agent roster via the ADR-031 catalog (read `agents`/`skills`), builds compacted-context, but **never calls a mutating tool** (Addendum #5). Phase 1 = single-pass investigation inline; Phase 2 = emit the resolved roster + fan-out plan for the SM Map state.
- `subagent.py` — Lambda: one Sub-agent invocation (logs/metrics/code-change/deploy-history), bound to one gateway via `agent_bridge.invoke`, returns compressed findings → `incident_findings`. Idempotent on `(incident_id, stage_idempotency_key)`.
- `rootcause.py` — Lambda: synthesize findings → RCA. PORT the analysis prompt + ROOT_CAUSE/CATEGORY/CONFIDENCE extraction from `src/lib/alert-diagnosis.ts` (`buildAnalysisPrompt`/`extractField`). Persist RCA in `incidents.rca` (Addendum #2: 034 owns write-back later — leave a clean seam, persist locally now).
- `mitigation_plan.py` — Lambda: build a recommendation-only mitigation plan that references `action_catalog` rows by name (NEVER executes). Writes the plan into `incidents.mitigation_plan` and emits the catalog action names; the actual `/api/actions` create-plan is a separate human flow.
- `prevention.py` — Phase-4 SKELETON Lambda (gated, trivial): write a single `prevention_recommendations` row summarizing observability/test gaps from the RCA. No feedback automation.
- `incident_stage_failed.py` — Lambda the SM Catch calls: set `incident_stages.status='failed'` + roll `incidents.status` (terminal-immutable), distinct from the P2 `status_updater` (which owns `worker_jobs`).
- `incident_watchdog.py` — Lambda (EventBridge rate(1 min)): any `incident_stages` row past its `stage-timeout-seconds` with no `last_checkpoint_at` advance → terminal `stalled` + notify marker (Addendum binding (b)). Never reaps a terminal incident.
- `agent_bridge.py` — boto3 `bedrock-agentcore` `invoke_agent_runtime` wrapper (runtime ARN from SSM), mirrors `web/lib/agentcore.ts`. Prepends the SAFEGUARD_LINE to any prompt built from alert text.
- `lifecycle.py` — shared: stage-idempotency-key helpers, checkpoint writer (`UPDATE incident_stages SET last_checkpoint_at=now()`), the storm-cap reader (max-concurrent / fan-out from SSM), severity ranking.
- `requirements.txt` — `pg8000==1.31.2`, `boto3>=1.34` (matches workers/remediation).
- `incident.asl.json` — the sibling SM ASL (Triage Choice → Investigation → RootCause → MitigationPlan → Prevention → Done; Phase-2 Map over Sub-agents with `MaxConcurrency` from input; Catch → `incident_stage_failed`).
- Tests: `scripts/v2/incident/test_incident.py` (ast.parse compile + unit tests for: dedup ON CONFLICT race, correlation rules, severity gate, fan-out cap, injection isolation, checkpoint advance, watchdog stalled transition, mitigation-plan-is-recommendation-only).

**Create (web):**
- `web/lib/incident.ts` — Aurora data layer (node-pg): `triageAndCreateOrLink(event)` (the dedup-race `INSERT … ON CONFLICT` in TS for the synchronous webhook path), `listIncidents()`, `getIncident(id)` (with stages/findings/rca/mitigation), `recordStageCheckpoint(...)`, `enqueueInitialStage(...)` (worker_jobs + SQS), config readers from SSM. Gated on `process.env.AURORA_ENDPOINT` + `process.env.INCIDENT_LIFECYCLE_ENABLED`.
- `web/lib/incident-normalize.ts` — alert normalizers PORTED from `src/lib/alert-types.ts` (CloudWatch SNS / Alertmanager / Grafana / Generic) + `detectAlertSource`, ADAPTED to v2 (no app-config; pure). The Addendum #6 structured-input isolation lives here (`isolatePayload(raw)` → a typed, length-bounded, no-instruction view).
- `web/app/api/incidents/webhook/route.ts` — `POST` HMAC ingress (PORT `verifySignature` + rate-limit + SNS subscription-confirm from `src/app/api/alert-webhook/route.ts`); returns 503 when the flag is off; on accept → `triageAndCreateOrLink` + `enqueueInitialStage`. **No autonomous behavior when the flag is off — it does not even accept.**
- `web/app/api/incidents/route.ts` — `GET` list (admin-gated) + `POST` manual trigger (admin-gated; free-text → synthetic event → same triage path; 503 when flag off).
- `web/app/api/incidents/[id]/route.ts` — `GET` incident detail (admin-gated reads): stages timeline, findings, RCA, mitigation plan (the recommended `/api/actions` names, NOT executed).
- Tests: `web/lib/incident.test.ts`, `web/lib/incident-normalize.test.ts`, `web/app/api/incidents/webhook/route.test.ts`, `web/app/api/incidents/route.test.ts`, `web/app/api/incidents/[id]/route.test.ts`.

**Modify:**
- `terraform/foundation/variables.tf` — add `variable "incident_lifecycle_enabled" { default = false }`.
- `terraform/foundation/data/schema.sql` — append migration v5 block (5 tables + the stage-timeout defaults registry; all empty/inert) + `schema_migrations` v5.
- `terraform/foundation/workload.tf` — add `INCIDENT_LIFECYCLE_ENABLED`, the incident SSM param names, and the HMAC-secret SSM ref to the web container env via `merge(..., var.incident_lifecycle_enabled ? {..} : {})` (byte-identical when off); add a `local.il`-gated web-task-role policy to read the incident SSM params + the AgentCore runtime ARN (for the synchronous webhook-path Triage; the heavy investigation runs in the SM Lambdas, not the web tier — thin-BFF rule).
- `scripts/v2/workers/dispatcher.py` — add the `type=='incident_stage'` branch → start the incident SM (`INCIDENT_STATE_MACHINE_ARN`, empty ⇒ drop). `noop`/`noop-heavy`/`action` UNCHANGED.
- `terraform/foundation/workers.tf` — add `INCIDENT_STATE_MACHINE_ARN` to the dispatcher env via the existing `merge(...)` (so the dispatcher routes incident jobs only when the flag is on; byte-identical merge when off, identical to the remediation pattern already there).

---

## Out of scope (state explicitly — DO NOT implement; all later / operator-gated)

- **Enabling any autonomous trigger.** `incident_lifecycle_enabled` ships `false`; the webhook route returns 503 when off; the dispatcher drops incident jobs when `INCIDENT_STATE_MACHINE_ARN` is empty. Flipping the flag is an explicit operator action, NOT part of this plan. **ZERO autonomous triggers fire from this plan.**
- **Autonomous un-gated remediation.** Mitigation is recommendation-only and routes through `/api/actions` (ADR-029/036), which itself stays `remediation_enabled=false`. The Lead agent NEVER executes a mutation. No new mutating capability is added here.
- **Phase 4 (Proactive Prevention feedback loop) beyond a trivial gated skeleton.** `prevention.py` writes ONE `prevention_recommendations` row from the RCA; no learning, no auto-tuning, no automated feedback into observability/tests. Full Phase 4 is a later task.
- **ADR-034 OpsCenter/Incident Manager/Slack write-back.** 034 owns the RCA output sink (Addendum #2). This plan persists RCA in Aurora (`incidents.rca`) and leaves a clean seam (`rootcause.py` returns a structured RCA the 034 writer will consume). No 034 integration here.
- **pgvector / semantic similar-incident RAG.** DEFERRED (see decision below). Phase-1 Triage uses the existing fingerprint/correlation-rule engine; no `vector` column, no pgvector extension.
- **Cross-account incident federation** beyond the existing ADR-008 multi-account model.
- **Learned/auto-tuned investigation skills** (explicit YAGNI in the ADR).
- **A new SQS queue / second orchestration spine.** The lifecycle reuses the P2 queue/dispatcher/reaper (Addendum #3).

---

## pgvector decision (justify)

**DEFERRED — Phase 1 uses the carried-forward fingerprint + correlation-rule Triage; add NO `vector` column and do NOT enable pgvector now.** Rationale: (1) the ADR's binding Phase-1 dedup requirement is satisfied by the **`correlation_key` unique index + `INSERT … ON CONFLICT`** (an exact/structured match), not by semantic similarity — pgvector would not strengthen the *dedup-race* guarantee. (2) v1's `findSimilarIncidents` (`alert-knowledge.ts`) is a *lexical/Jaccard* scorer over alert names/services/labels with a recency bonus — it ports cleanly to a SQL query over `incidents` + GIN indexes on `services[]`/`resources[]` (already present on `alert_diagnosis`) with NO vector store. (3) Enabling pgvector on Aurora PG 17.9 is a non-trivial migration (extension + index tuning + embedding pipeline) that would expand the always-present migration v5 beyond "harmless empty tables." The consensus-P5 RAG seam is preserved cleanly: `incidents` keeps a nullable `embedding_seam JSONB` comment-documented as the future pgvector landing spot, and `correlation.py`'s similar-incident lookup is a single function (`find_similar`) swappable for a vector query later. Net: Phase-1 correlation works without pgvector; the seam is explicit; no premature infra.

---

## Tasks

### Task 1: `variables.tf` + migration v5 schema (always-present domain tables)

**Files:** Modify `terraform/foundation/variables.tf`; Modify `terraform/foundation/data/schema.sql`

Read the v4 block (lines ~360–491) + the `remediation_enabled` variable (lines 104–108) for the exact idiom.

- [ ] **Step 1 (variable):** After the `remediation_enabled` variable add:
```hcl
variable "incident_lifecycle_enabled" {
  type        = bool
  description = "ADR-032 incident lifecycle gate. false (default) = 0 lifecycle infra, 0 cost, ZERO autonomous triggers. The always-present incident_* tables (migration v5) are harmless when off. REQUIRES workers_enabled=true to enable (reuses the P2 queue/dispatcher/reaper/status_updater/pg8000 layer)."
  default     = false
}
```
- [ ] **Step 2 (migration v5):** Append a new post-COMMIT idempotent block (mirror the v4 block style — `CREATE TABLE IF NOT EXISTS`, `touch_updated_at` triggers via the `DO $$ … pg_trigger` guard, end with the migration insert). The tables (the dedup-race key + checkpoint + idempotency are BINDING):
```sql
-- ============================================================================
-- ADR-032 (migration v5): incident lifecycle DOMAIN STATE — always-present,
-- inert when incident_lifecycle_enabled=false. Extends (does NOT replace)
-- alert_diagnosis. NO autonomous behavior; orchestration rides the P2 backbone.
-- ============================================================================

-- 1) incidents — one durable row per correlated incident (the lifecycle aggregate).
--    correlation_key is the dedup-race UNIQUE key (Addendum (a)): concurrent
--    alerts that both pass the look-back must NOT both create a 'New'.
CREATE TABLE IF NOT EXISTS incidents (
  id               UUID PRIMARY KEY,
  correlation_key  TEXT NOT NULL UNIQUE,                 -- dedup-race winner; rest resolve to Linked
  fingerprint      TEXT,                                 -- carried from alert_diagnosis correlation
  status           TEXT NOT NULL DEFAULT 'triaged'
                     CHECK (status IN ('triaged','investigating','root_cause',
                            'mitigation_planned','prevention','resolved','stalled','skipped')),
  severity         TEXT NOT NULL DEFAULT 'warning',
  trigger_source   TEXT NOT NULL,                        -- cloudwatch|alertmanager|grafana|generic|manual
  services         TEXT[] NOT NULL DEFAULT '{}',
  resources        TEXT[] NOT NULL DEFAULT '{}',
  agent_space_version TEXT,                              -- ADR-031 traceability
  rca              JSONB,                                -- ADR-034 seam (persist locally; 034 writes back later)
  mitigation_plan  JSONB,                                -- recommendation-only catalog action refs (NEVER executed here)
  embedding_seam   JSONB,                                -- pgvector future-landing seam (deferred; see plan)
  first_event_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_event_at    TIMESTAMPTZ NOT NULL DEFAULT now(),   -- look-back window anchor
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_incidents_active
  ON incidents (status, last_event_at) WHERE status IN ('triaged','investigating');
CREATE INDEX IF NOT EXISTS idx_incidents_services ON incidents USING GIN (services);
CREATE INDEX IF NOT EXISTS idx_incidents_resources ON incidents USING GIN (resources);

-- 2) incident_stages — per-stage checkpoint + idempotency (Addendum (b)+(c)).
--    stage_idempotency_key UNIQUE per (incident, stage) so a retried Investigation
--    resumes from the last checkpoint and never spawns duplicate Sub-agents.
CREATE TABLE IF NOT EXISTS incident_stages (
  id                   BIGSERIAL PRIMARY KEY,
  incident_id          UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  stage                TEXT NOT NULL
                         CHECK (stage IN ('triage','investigation','root_cause',
                                'mitigation_plan','prevention')),
  stage_idempotency_key TEXT NOT NULL,
  job_id               UUID,                             -- the worker_jobs orchestration row (P2 accounting)
  status               TEXT NOT NULL DEFAULT 'running'
                         CHECK (status IN ('running','succeeded','failed','stalled')),
  last_checkpoint_at   TIMESTAMPTZ NOT NULL DEFAULT now(),  -- watchdog anchor (Addendum (b))
  timeout_seconds      INTEGER,                          -- snapshot of the configurable stage timeout
  detail               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (incident_id, stage_idempotency_key)            -- stage-level idempotency (Addendum (c))
);
CREATE INDEX IF NOT EXISTS idx_incident_stages_watch
  ON incident_stages (status, last_checkpoint_at) WHERE status = 'running';

-- 3) incident_findings — compressed Sub-agent findings (Phase 2 fan-out).
CREATE TABLE IF NOT EXISTS incident_findings (
  id           BIGSERIAL PRIMARY KEY,
  incident_id  UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  sub_agent    TEXT NOT NULL,                            -- gateway/agent name (ADR-031)
  agent_version INT,
  skill_hashes JSONB NOT NULL DEFAULT '[]'::jsonb,       -- ADR-031 traceability
  findings     JSONB NOT NULL DEFAULT '{}'::jsonb,       -- compacted
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_findings_incident ON incident_findings (incident_id);

-- 4) incident_links — the 'Linked' alerts that lost the dedup race (Addendum (a)).
CREATE TABLE IF NOT EXISTS incident_links (
  id            BIGSERIAL PRIMARY KEY,
  incident_id   UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  correlation_key TEXT NOT NULL,                         -- the losing alert's would-be key
  reason        TEXT NOT NULL DEFAULT '',
  linked_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_links_incident ON incident_links (incident_id);

-- 5) prevention_recommendations — Phase-4 skeleton output.
CREATE TABLE IF NOT EXISTS prevention_recommendations (
  id           BIGSERIAL PRIMARY KEY,
  incident_id  UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  category     TEXT NOT NULL,                            -- observability|testing|code|infra
  recommendation TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_incidents_touch') THEN
    CREATE TRIGGER trg_incidents_touch BEFORE UPDATE ON incidents
      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
  END IF;
END $$;

INSERT INTO schema_migrations (version, description)
VALUES (5, 'ADR-032: incident lifecycle domain — incidents + incident_stages (checkpoint/idempotency) + findings + links + prevention (inert when off)')
ON CONFLICT (version) DO NOTHING;
```
- [ ] **Step 3 (validate):** `cd /home/atomoh/awsops/terraform/foundation && export PATH="$HOME/.local/bin:$PATH"; terraform fmt variables.tf; terraform validate`. Then a local SQL sanity parse if `psql`/`pg_query` available, else visually confirm idempotency (every `CREATE TABLE IF NOT EXISTS`, every `INSERT … ON CONFLICT DO NOTHING`).
- [ ] **Step 4 (Commit):** `git add terraform/foundation/variables.tf terraform/foundation/data/schema.sql && git commit -m "feat(v2-adr032): incident_lifecycle_enabled flag (default false) + migration v5 incident domain tables (dedup-race correlation_key UNIQUE + per-stage checkpoint/idempotency; inert when off)"`

---

### Task 2: web Triage — normalizers + dedup-race INSERT … ON CONFLICT (TDD)

**Files:** Create `web/lib/incident-normalize.ts`, `web/lib/incident-normalize.test.ts`, `web/lib/incident.ts`, `web/lib/incident.test.ts`

PORT from `src/lib/alert-types.ts` (normalizers, `detectAlertSource`, `extractServices`/`extractResources`) and `src/lib/alert-correlation.ts` (correlation rules) — read both, ADAPT to pure v2 functions (no `app-config`, no in-memory Map). Read `web/lib/remediation.ts` for the node-pg + `process.env.AURORA_ENDPOINT` degrade-safe idiom.

- [ ] **Step 1 (test first — normalize + isolate):** `incident-normalize.test.ts`: for each source (cloudwatch SNS, alertmanager, grafana, generic) a fixture payload → `normalizeAlert(body, source)` yields typed `AlertEvent[]` with severity/services/resources/labels/timestamp; `detectAlertSource` infers source; **`isolatePayload(raw)` (Addendum #6)** returns a structured, length-bounded view that strips/escapes any text that could read as an instruction (no raw alert text is ever concatenated into an agent prompt without going through this) and that carries NO permission/roster/approval fields.
- [ ] **Step 2 (impl normalize):** `incident-normalize.ts` — port the normalizers + `detectAlertSource`; implement `isolatePayload`: whitelist known fields, truncate strings to a hard cap, wrap free-text in a clearly-delimited block, and a `correlationKey(event)` builder (deterministic: e.g. `sha256(source + sorted(services) + sorted(resources) + alertName)` truncated) — this is the dedup-race UNIQUE key.
- [ ] **Step 3 (test first — dedup race):** `incident.test.ts`: mock `getPool().query`; `triageAndCreateOrLink(eventA)` with a fresh key → `New` (one INSERT); a SECOND call with the SAME `correlation_key` → the `INSERT … ON CONFLICT (correlation_key) DO NOTHING RETURNING id` returns 0 rows ⇒ resolve to `Linked` (insert into `incident_links`, update `incidents.last_event_at`); a call below `min-severity` → `Skipped`. Also test the flag-off path: when `INCIDENT_LIFECYCLE_ENABLED !== 'true'` → returns `{decision:'disabled'}` and performs NO writes.
- [ ] **Step 4 (impl incident.ts):** implement the dedup-race write exactly:
```ts
// triageAndCreateOrLink — Addendum (a): exactly one 'New' wins, the rest 'Linked'.
const id = randomUUID();
const { rows } = await getPool().query(
  `INSERT INTO incidents (id, correlation_key, fingerprint, status, severity, trigger_source, services, resources, agent_space_version)
   VALUES ($1,$2,$3,'triaged',$4,$5,$6,$7,$8)
   ON CONFLICT (correlation_key) DO NOTHING
   RETURNING id`,
  [id, key, fingerprint, severity, source, services, resources, agentSpaceVersion]);
if (rows.length === 0) {
  // lost the race (or look-back match): link to the existing active incident, bump last_event_at
  const { rows: ex } = await getPool().query(
    `UPDATE incidents SET last_event_at = now()
     WHERE correlation_key = $1 AND status IN ('triaged','investigating') RETURNING id`, [key]);
  const incidentId = ex[0]?.id;
  if (incidentId) await getPool().query(
    `INSERT INTO incident_links (incident_id, correlation_key, reason) VALUES ($1,$2,'dedup-race-or-lookback')`,
    [incidentId, key]);
  return { decision: 'Linked', incidentId };
}
return { decision: 'New', incidentId: id };
```
Plus `enqueueInitialStage(incidentId)` (insert `worker_jobs` `type='incident_stage'` queued + `SendMessage` to `JOBS_QUEUE_URL`, mirroring `web/app/api/actions/[id]/route.ts`), `listIncidents`/`getIncident`, the SSM config readers (window/min-severity/timeouts/caps — cached, mirror `agentcore.ts` TTL), all gated on `process.env.AURORA_ENDPOINT` + the env flag.
- [ ] **Step 5 (verify):** `cd /home/atomoh/awsops/web && npx vitest run lib/incident-normalize.test.ts lib/incident.test.ts` → all green. `npx tsc --noEmit` clean.
- [ ] **Step 6 (Commit):** `git add web/lib/incident*.ts web/lib/incident*.test.ts && git commit -m "feat(v2-adr032): web Triage — ported normalizers + payload isolation (#6) + dedup-race INSERT…ON CONFLICT (binding (a)); degrade-safe when flag off"`

---

### Task 3: web ingress routes — HMAC webhook + manual + reads (TDD)

**Files:** Create `web/app/api/incidents/webhook/route.ts` (+`.test.ts`), `web/app/api/incidents/route.ts` (+`.test.ts`), `web/app/api/incidents/[id]/route.ts` (+`.test.ts`)

PORT `verifySignature` (active/standby HMAC), the rate limiter, `extractClientIp`, and the SNS subscription-confirm from `src/app/api/alert-webhook/route.ts`. Read `web/app/api/actions/route.ts` for the admin-gate + `dynamic = 'force-dynamic'` idiom.

- [ ] **Step 1 (test first — webhook):** `webhook/route.test.ts`: flag OFF ⇒ `POST` returns **503** and does NOT call triage (BINDING: no autonomous accept when off); flag ON + bad HMAC ⇒ 401; flag ON + good HMAC ⇒ 202 + calls `triageAndCreateOrLink` then `enqueueInitialStage`; rate-limit over the cap ⇒ 429; SNS `SubscriptionConfirmation` ⇒ confirm path. The HMAC secret comes from SSM (read once, cached) — not from `app-config`.
- [ ] **Step 2 (impl webhook):** implement `POST` with the flag check FIRST (`if (process.env.INCIDENT_LIFECYCLE_ENABLED !== 'true') return 503`), then rate-limit → HMAC verify → `isolatePayload` → `normalizeAlert` → severity gate → `triageAndCreateOrLink` → on `New` `enqueueInitialStage`. No GET that triggers anything (a GET status is fine but read-only).
- [ ] **Step 3 (test first — manual + reads):** `route.test.ts`: `GET` list requires admin (403 otherwise); `POST` manual trigger requires admin + flag on (503 when off), free-text → synthetic event → triage. `[id]/route.test.ts`: `GET` detail admin-gated, returns stages/findings/rca/mitigation; the mitigation field is the recommended catalog action NAMES only (assert no execution call is made).
- [ ] **Step 4 (impl manual + reads):** implement both with `verifyUser` + `isAdmin` (reuse verbatim), `dynamic='force-dynamic'`, flag-off 503 on the trigger paths, read-only detail.
- [ ] **Step 5 (verify):** `cd /home/atomoh/awsops/web && npx vitest run app/api/incidents` → green; `npx tsc --noEmit` clean.
- [ ] **Step 6 (Commit):** `git add web/app/api/incidents && git commit -m "feat(v2-adr032): incident ingress — HMAC webhook (ADR-022 port) + manual trigger + admin-gated reads; 503 when flag off (no autonomous accept)"`

---

### Task 4: Python lifecycle core — correlation, lifecycle helpers, agent bridge, storm caps (TDD)

**Files:** Create `scripts/v2/incident/correlation.py`, `lifecycle.py`, `agent_bridge.py`, `requirements.txt`, `test_incident.py`

Read `scripts/v2/workers/db.py` (the pg8000 connect/claim/finish idiom — REUSE it; the incident Lambdas import `db.py` from the same zip) and `web/lib/agentcore.ts` (the invoke shape to mirror) and `src/lib/alert-correlation.ts` (`findCorrelatedIncident` rules to port).

- [ ] **Step 1 (test first):** `test_incident.py`: `ast.parse` every module; unit tests for `correlation.classify(conn, event, window_min)` returning `New|Linked|Skipped` over a fake active set (rules: shared resource → link; shared service within window → link; namespace within window → link; else New); `lifecycle.stage_idempotency_key(incident_id, stage, attempt)` deterministic; `lifecycle.read_caps(ssm_stub)` returns `{max_concurrent, fanout_max, window_min, stage_timeout_s, min_severity}` from SSM with safe defaults; `lifecycle.checkpoint(conn, stage_id)` advances `last_checkpoint_at`; `agent_bridge.build_prompt` ALWAYS prepends the SAFEGUARD_LINE and only ever embeds `isolated` (never raw) payload text.
- [ ] **Step 2 (impl correlation.py):** port the rule engine as a stateless Aurora query — the active set is `SELECT id, correlation_key, services, resources, first_event_at FROM incidents WHERE status IN ('triaged','investigating') AND last_event_at > now() - (:window || ' minutes')::interval`; apply the v1 rules in Python; return the decision + matched id. `find_similar(conn, event, limit)` = the lexical Jaccard scorer ported from `alert-knowledge.ts` (the pgvector seam — single swappable function).
- [ ] **Step 3 (impl lifecycle.py + agent_bridge.py):** lifecycle: idempotency-key (`sha256(f"{incident_id}:{stage}:{attempt}")`), `checkpoint`, `read_caps` (SSM `get_parameter` with defaults: window=20, stage_timeout=600, max_concurrent=5, fanout_max=4, min_severity='warning' — all from the gated SSM params; Addendum #4/#7), severity rank. agent_bridge: `invoke(gateway, messages, session_id, system_prompt_override)` via boto3 `bedrock-agentcore` `invoke_agent_runtime`, runtime ARN from SSM; `SAFEGUARD_LINE` constant (copy the wording from `web/lib/agent-resolver.ts`); `build_prompt(isolated_payload, persona)` that prepends SAFEGUARD_LINE.
- [ ] **Step 4 (requirements.txt):** `pg8000==1.31.2` + `boto3>=1.34` (matches `scripts/v2/workers/requirements.txt`).
- [ ] **Step 5 (verify):** `cd /home/atomoh/awsops && python3 scripts/v2/incident/test_incident.py` (or `python3 -m pytest scripts/v2/incident/test_incident.py`) → all pass; `python3 -c "import ast; [ast.parse(open(f).read()) for f in __import__('glob').glob('scripts/v2/incident/*.py')]; print('parse ok')"`.
- [ ] **Step 6 (Commit):** `git add scripts/v2/incident/correlation.py scripts/v2/incident/lifecycle.py scripts/v2/incident/agent_bridge.py scripts/v2/incident/requirements.txt scripts/v2/incident/test_incident.py && git commit -m "feat(v2-adr032): python lifecycle core — ported correlation engine (stateless Aurora) + idempotency/checkpoint + storm-cap SSM reader (#4/#7) + SAFEGUARD agent bridge (#6)"`

---

### Task 5: Python stage Lambdas — triage, lead, subagent, rootcause, mitigation_plan, prevention, fail, watchdog (TDD)

**Files:** Create `scripts/v2/incident/triage.py`, `lead.py`, `subagent.py`, `rootcause.py`, `mitigation_plan.py`, `prevention.py`, `incident_stage_failed.py`, `incident_watchdog.py`; extend `test_incident.py`

Read `scripts/v2/remediation/remediation_executor.py` for the Lambda-handler + db.py-usage shape, and `src/lib/alert-diagnosis.ts` (`buildAnalysisPrompt`, `extractField`/`extractCategory`/`extractConfidence`) to port the RCA prompt + parsing.

- [ ] **Step 1 (test first):** extend `test_incident.py`: `triage.lambda_handler` honors the severity gate (drop below min) + dedup ON CONFLICT (mirror the TS test in Python over a fake conn) + checkpoints; `lead.lambda_handler` resolves a roster from a fake `agents` table and **emits NO mutating tool call**, capping the roster at `fanout_max`; `subagent.lambda_handler` writes ONE `incident_findings` row, idempotent on `(incident_id, stage_idempotency_key)` (second call = no dup); `rootcause.lambda_handler` extracts ROOT_CAUSE/CATEGORY/CONFIDENCE and persists `incidents.rca` (the 034 seam); `mitigation_plan.lambda_handler` produces a plan whose actions are catalog NAMES + inputs and asserts it performs NO `/api/actions` execute and NO direct mutation; `incident_stage_failed` sets `incident_stages.status='failed'` terminal-immutable; `incident_watchdog` flips a `running` stage past `timeout_seconds` to `stalled` and never touches a terminal incident.
- [ ] **Step 2 (impl triage.py):** Lambda: read caps; severity gate; `isolate` the payload server-side too (defense-in-depth even though web isolated it); the dedup ON CONFLICT write (same SQL as web, in pg8000); create the `triage` `incident_stages` row + checkpoint; advance `incidents.status='investigating'` and return the SM the `{incident_id, roster_request:true}`.
- [ ] **Step 3 (impl lead.py + subagent.py):** lead resolves the roster (read enabled `agents` rows whose routing keywords match the incident signals — port `pickCustomAgent` logic to Python; built-in gateways are the fallback fleet logs/metrics/code-change/deploy-history), caps to `fanout_max`, builds compacted context, returns the roster list for the SM `Map`. **lead NEVER invokes a mutating gateway/tool** (Addendum #5) — it only delegates. subagent: invoke ONE gateway via `agent_bridge.invoke` with the SAFEGUARD prompt, compress the result, write `incident_findings` idempotently, checkpoint.
- [ ] **Step 4 (impl rootcause.py + mitigation_plan.py):** rootcause: gather findings, call agent_bridge with the ported analysis prompt, parse ROOT_CAUSE/CATEGORY/CONFIDENCE, persist `incidents.rca` (structured — the ADR-034 seam), advance status. mitigation_plan: from the RCA build a list of `{action: <action_catalog.name>, inputs: {...}, rationale}` — **recommendation-only**: write into `incidents.mitigation_plan`, NEVER call `/api/actions`/SSM/any mutation. Document the seam: a human reviews the plan and initiates `/api/actions` create-plan separately.
- [ ] **Step 5 (impl prevention.py + incident_stage_failed.py + incident_watchdog.py):** prevention (Phase-4 skeleton): write one `prevention_recommendations` row from the RCA category; trivial, gated by the SM only running when the flag is on. incident_stage_failed: terminal-immutable `incident_stages.status='failed'` + roll `incidents.status`. incident_watchdog: `UPDATE incident_stages SET status='stalled' WHERE status='running' AND last_checkpoint_at < now() - (timeout_seconds||' seconds')::interval RETURNING incident_id`; for each, set `incidents.status='stalled'` (never overwrite a terminal/`resolved`) + emit a notify marker (log/row). Addendum binding (b)+(d): resume-from-checkpoint is implicit (the SM re-enters a stage via its idempotency key; the watchdog only terminalizes the truly-stuck).
- [ ] **Step 6 (verify):** `cd /home/atomoh/awsops && python3 -m pytest scripts/v2/incident/test_incident.py -q` → all pass; parse-check all modules.
- [ ] **Step 7 (Commit):** `git add scripts/v2/incident/*.py && git commit -m "feat(v2-adr032): stage Lambdas — triage(dedup/severity) + Lead/Sub fan-out (#5 no direct mutate, capped #7) + RCA(034 seam) + mitigation-plan(recommendation-only via /api/actions) + prevention skeleton + stalled watchdog (binding (b)/(d))"`

---

### Task 6: incident SM ASL + dispatcher branch

**Files:** Create `scripts/v2/incident/incident.asl.json`; Modify `scripts/v2/workers/dispatcher.py`

Read `scripts/v2/workers/sfn.asl.json` (the Choice/Retry/Catch/MarkFailed idiom) and `scripts/v2/workers/dispatcher.py` (the `type=='action'` branch to mirror).

- [ ] **Step 1 (ASL):** `incident.asl.json` — `StartAt: Triage` (Lambda Task `${triage_fn_arn}`, Retry on Lambda transient, Catch → `StageFailed`) → Choice on `$.decision` (`Skipped`→`Done`, else `Lead`) → `Lead` (Task `${lead_fn_arn}` returns `roster[]` + `maxConcurrency`) → `Investigation` (**Map** state, `ItemsPath: $.roster`, `MaxConcurrency.$: $.maxConcurrency` = the fan-out cap, each iteration a `${subagent_fn_arn}` Task, Catch per-item → continue) → `RootCause` (`${rootcause_fn_arn}`) → `MitigationPlan` (`${mitigation_fn_arn}`) → `Prevention` (`${prevention_fn_arn}`) → `Done` (Succeed). `StageFailed` = Task `${incident_stage_failed_fn_arn}` then a Task to `${status_fn_arn}` (the reused P2 status_updater for the worker_jobs terminal-failed) → `Fail`. Templatefile vars: the 6 incident fn ARNs + the status_updater ARN.
- [ ] **Step 2 (dispatcher):** add to `dispatcher.py`, after the `action` branch and before `is_allowed`:
```python
            if type_ == "incident_stage":
                if not _INC_SM_ARN:
                    print(f"DROP incident job (lifecycle disabled) job_id={job_id}")
                    continue
                _sfn.start_execution(
                    stateMachineArn=_INC_SM_ARN,
                    name=job_id,  # idempotent: execution name == job_id
                    input=json.dumps({
                        "job_id": job_id,
                        "incident_id": body.get("incident_id"),
                        "payload": body.get("payload", {}),
                    }),
                )
                continue
```
and at module top: `_INC_SM_ARN = os.environ.get("INCIDENT_STATE_MACHINE_ARN", "")` (empty ⇒ drop, never loop). `noop`/`noop-heavy`/`action` paths UNCHANGED.
- [ ] **Step 3 (test):** extend `scripts/v2/workers` dispatcher test (or add a case to `test_incident.py`): `incident_stage` with empty `_INC_SM_ARN` ⇒ dropped (no start_execution); with an ARN ⇒ exactly one `start_execution(name=job_id)` on the incident SM; `ExecutionAlreadyExists` ⇒ success. `python3 -c "import json; json.load(open('scripts/v2/incident/incident.asl.json'))"` parses.
- [ ] **Step 4 (Commit):** `git add scripts/v2/incident/incident.asl.json scripts/v2/workers/dispatcher.py && git commit -m "feat(v2-adr032): sibling incident SM ASL (Triage→Lead→Map(Sub, MaxConcurrency=fanout cap)→RCA→Mitigation→Prevention; Catch→stage_failed+P2 status_updater) + dispatcher incident_stage branch (drop when SM ARN empty)"`

---

### Task 7: `incidents.tf` — all gated infra (sibling SM + stage Lambdas + watchdog + SSM windows + IAM)

**Files:** Create `terraform/foundation/incidents.tf`; Modify `terraform/foundation/workers.tf`, `terraform/foundation/workload.tf`

Read `terraform/foundation/remediation.tf` (the `local.re` gating, `archive_file` from `scripts/v2/...` + shared `workers/db.py`, the pg8000 layer reuse, the `one(...)` outputs, the SSM `ignore_changes=[value]` params, the sibling-SM resource) — MIRROR it for `local.il`.

- [ ] **Step 1 (locals + SSM params):** `local.il = var.incident_lifecycle_enabled ? 1 : 0`; `inc_src = "${path.module}/../../../scripts/v2/incident"`. Five `aws_ssm_parameter` (count `local.il`, `ignore_changes=[value]`): `/ops/${var.project}/incident/correlation-window-minutes` = "20", `.../stage-timeout-seconds` = "600", `.../max-concurrent-investigations` = "5", `.../subagent-fanout-max` = "4", `.../min-severity` = "warning" (Addendum #4/#7 — configurable, NOT hardcoded).
- [ ] **Step 2 (archive + IAM):** `archive_file.incident_src` (count `local.il`) zipping `workers/db.py` + all `incident/*.py`. The incident-Lambda role (least-privilege, Addendum #5): Aurora secret `GetSecretValue` + KMS `Decrypt` + `bedrock-agentcore:InvokeAgentRuntime` (Resource = the runtime ARN from the SSM param's value — or `*` scoped by account, documented) + `ssm:GetParameter` on the five incident params + the AgentCore runtime-ARN param + logs + VPC (attach `AWSLambdaVPCAccessExecutionRole`). **NO `ecs:*`, NO mutating actions, NO `states:StartExecution`** (the dispatcher starts the SM; the SM invokes the Lambdas). The incident SM role: `lambda:InvokeFunction` on the 7 incident Lambdas + the reused `status_updater` ARN + SfnLogging only.
- [ ] **Step 3 (Lambdas):** seven `aws_lambda_function` (count `local.il`, arm64, python3.12, handler `<mod>.lambda_handler`, the pg8000 layer `aws_lambda_layer_version.pg8000[0].arn`, VPC `local.private_subnet_ids` + `aws_security_group.service.id`, env `AURORA_ENDPOINT/DATABASE/SECRET_ARN` + the five SSM param names + `AGENTCORE_RUNTIME_ARN_PARAM`): triage, lead, subagent, rootcause, mitigation_plan, prevention, incident_stage_failed. (watchdog is #4.) Each `depends_on` its log group + `worker_lambda_vpc`-style attachment. REQUIRES `workers_enabled=true` for the pg8000 layer + service SG — document this in a header comment (mirror remediation.tf's note).
- [ ] **Step 4 (SM + watchdog + schedule):** `aws_sfn_state_machine.incident` (count `local.il`, STANDARD, `templatefile(incident.asl.json, {…7 fn arns + status_fn_arn})`, vended-logs group, `depends_on` the SM role policy). `aws_lambda_function.incident_watchdog` (count `local.il`) + `aws_cloudwatch_event_rule.incident_watchdog` (`rate(1 minute)`) + target + `aws_lambda_permission`. Log groups for each Lambda + the SM.
- [ ] **Step 5 (wire dispatcher + web env):** in `workers.tf` extend the dispatcher `merge(...)` env with `var.incident_lifecycle_enabled ? { INCIDENT_STATE_MACHINE_ARN = aws_sfn_state_machine.incident[0].arn } : {}` (byte-identical when off — same pattern as the remediation merge already there). In `workload.tf` extend the web container env `merge(..., var.incident_lifecycle_enabled ? { INCIDENT_LIFECYCLE_ENABLED="true", INCIDENT_* SSM names, AGENTCORE_RUNTIME_ARN_PARAM } : {})` and add a `local.il`-gated web-task-role policy for `ssm:GetParameter` on the incident params + the HMAC-secret param + `bedrock-agentcore:InvokeAgentRuntime` (the synchronous Triage path; heavy work is enqueued). Output `incident_state_machine_arn = one(aws_sfn_state_machine.incident[*].arn)`.
- [ ] **Step 6 (validate, flag OFF):** `cd /home/atomoh/awsops/terraform/foundation && export PATH="$HOME/.local/bin:$PATH"; terraform fmt incidents.tf workers.tf workload.tf; terraform validate; terraform plan -no-color -input=false -lock=false 2>&1 | grep -E "will be created|will be destroyed|will be updated|Plan:|No changes|Error" | head -40`. **EXPECTED with `incident_lifecycle_enabled=false` (and whatever the live workers/remediation flags are): NO incident.* resources created; the dispatcher/web task def merge is byte-identical (NO update); ideally `No changes` for the incident slice.** If the dispatcher/web show an update, inspect the diff to confirm it is NOT incident-related (it must be empty-merge → no diff). Do NOT apply here — the CONTROLLER task applies.
- [ ] **Step 7 (Commit):** `git add terraform/foundation/incidents.tf terraform/foundation/workers.tf terraform/foundation/workload.tf && git commit -m "feat(v2-adr032): incidents.tf — local.il-gated sibling SM + 7 stage Lambdas + watchdog(rate 1m) + configurable-window SSM params(#4/#7) + least-privilege IAM(#5); $0/No-changes when off"`

---

### Task 8: CONTROLLER — prove flag-off No-changes, apply migration v5, verify no autonomous trigger

**Files:** none (controller-run verification; no source edits)

> Run by the CONTROLLER (not a subagent — applies + in-VPC psql). Do NOT `-auto-approve` shared infra; use a saved tfplan.

- [ ] **Step 1 (No-changes when off):** `terraform -chdir=terraform/foundation plan -no-color -input=false` with `incident_lifecycle_enabled=false`. CONFIRM: zero `aws_sfn_state_machine.incident`, zero `aws_lambda_function.{triage,lead,subagent,rootcause,mitigation_plan,prevention,incident_stage_failed,incident_watchdog}`, zero incident SSM params, zero incident log groups; the dispatcher Lambda + web task def show **no diff** (empty merge). Capture the `Plan:` line — it must show **0 to add for the incident slice** (the only non-incident diffs, if any, are pre-existing/unrelated). This proves $0 + zero autonomous infra when off.
- [ ] **Step 2 (apply migration v5 — in-VPC psql):** run the psql command from "How schema.sql is applied" against the live Aurora cluster. Then verify: `SELECT version FROM schema_migrations ORDER BY version;` includes **5**; `SELECT count(*) FROM incidents;` = 0; `\d incidents` shows the `correlation_key` UNIQUE constraint and `\d incident_stages` shows the `(incident_id, stage_idempotency_key)` UNIQUE + the `idx_incident_stages_watch` partial index. The tables are empty + inert — no autonomous behavior from creating them.
- [ ] **Step 3 (verify no webhook accepts/triggers when off):** against the live web (flag off ⇒ `INCIDENT_LIFECYCLE_ENABLED` not "true"): `curl -sS -X POST https://awsops-v2.example.com/api/incidents/webhook -d '{}' -o /dev/null -w '%{http_code}\n'` ⇒ **503** (no accept, no triage, no enqueue). `curl` the manual `POST /api/incidents` ⇒ 503 (or 403 if unauthenticated — confirm it NEVER triages). Confirm `SELECT count(*) FROM incidents;` is still 0 and SQS `ApproximateNumberOfMessages` on the jobs queue is unchanged (no incident_stage enqueued). This proves ZERO autonomous triggers fire.
- [ ] **Step 4 (optional, enable in a sandbox ONLY — NOT part of shipping):** documented for later: set `incident_lifecycle_enabled=true` (requires `workers_enabled=true`) → saved tfplan apply → `make` build/push if any new image (none — Lambda-only) → smoke a manual trigger and watch one incident progress Triage→Done. **NOT executed in this plan.**
- [ ] **Step 5 (Commit if any controller-side tracking file changed):** none expected. Update `CLAUDE.md` status table P4 row / ADR-032 index note only if the user asks (out of scope of code).

---

## Self-Review (map every requirement → a task; then scan)

**Lifecycle stages → tasks:**
- Trigger (HMAC webhook / manual) → Task 3 (`webhook`/`route.ts`), ingress PORTED from ADR-022; flag-off ⇒ 503.
- Triage (~20-min look-back correlation → New/Linked/Skipped, dedup) → Task 2 (web dedup-race) + Task 4 (`correlation.py`) + Task 5 (`triage.py`); window configurable via SSM (Task 7).
- Investigation (Lead delegates to Sub-agents, compacted-context) → Task 5 (`lead.py`/`subagent.py`) + Task 6 (SM Map state); Phase 1 single-pass in `lead.py`, Phase 2 fan-out Map.
- Root Cause & Mitigation Plan (recommendation-only, gated by 029/036) → Task 5 (`rootcause.py`/`mitigation_plan.py`); mitigation = catalog action NAMES routed through `/api/actions`, never executed.
- Proactive Prevention → Task 5 (`prevention.py`) SKELETON (gated, trivial — one row).

**Binding failure semantics → tasks:**
- (a) Triage dedup race → unique `correlation_key` + `INSERT … ON CONFLICT` in BOTH web (Task 2) and python (Task 5 `triage.py`); exactly one `New`, rest `Linked`. Tested.
- (b) Per-stage checkpoint + watchdog → `incident_stages.last_checkpoint_at` (migration v5, Task 1) + `incident_watchdog.py` (Task 5) on a gated `rate(1 minute)` rule (Task 7) → terminal `stalled` + notify. Configurable timeout via SSM.
- (c) At-least-once + idempotency keys → SQS at-least-once (reused P2), dispatcher `name==job_id` idempotency (Task 6), `(incident_id, stage_idempotency_key)` UNIQUE (Task 1) so retried Investigation resumes / no duplicate Sub-agents (Task 5 subagent idempotent write).
- (d) Fargate task replacement → no Fargate in the lifecycle (Lambda Tasks only); resume-from-checkpoint is the SM re-entering a stage via its idempotency key; the watchdog only terminalizes truly-stuck. (Documented in Task 5.)

**Consensus addenda → tasks:**
- #2 (034 owns RCA output) → `rootcause.py` persists `incidents.rca` locally + returns a structured RCA = clean 034 seam; no 034 write-back implemented (out of scope).
- #2 (036 mitigation substrate) → `mitigation_plan.py` emits catalog action names routed through `/api/actions` (the just-built `web/app/api/actions/*` + `web/lib/remediation.ts`); the Lead NEVER executes (Task 5 test asserts no execute call).
- #3 (P2 backbone) → reuse the P2 SQS/dispatcher/status_updater/reaper; incident tables are domain state; the sibling SM rides P2. Decision section + Task 6/7.
- #4 (configurable windows) → five SSM params (Task 7), read by `lifecycle.read_caps` (Task 4) and web (Task 2). NO hardcoded constants (defaults live in SSM param values + safe code fallbacks).
- #5 (Lead least privilege) → the incident-Lambda IAM has NO mutating actions/`ecs:*`; `lead.py` only delegates; the SAFEGUARD_LINE non-overridable boundary on every agent prompt (Task 4 `agent_bridge`). Tested (lead emits no mutating tool call).
- #6 (prompt-injection) → `isolatePayload` (web Task 2) + python defense-in-depth isolate (Task 5) + SAFEGUARD_LINE prepend; isolated payload carries NO permission/roster/approval fields; sanity-check before any RCA persistence. Tested.
- #7 (alert-storm controls) → `min-severity` gate (Task 5 triage), `max-concurrent-investigations` (the active-set look-back + cap), `subagent-fanout-max` (the SM Map `MaxConcurrency`), the reused SQS DLQ + `maxReceiveCount=5` retry budget, ADR-033 token-budget hook left as the `agent_bridge` integration point. All SSM-configurable.
- #8 (schema via schema.sql + schema_migrations) → migration v5 (Task 1), idempotent, ON CONFLICT.

**Flag-off ⇒ no autonomy + $0 (confirm):**
- `incident_lifecycle_enabled=false` ⇒ every `incidents.tf` resource `count=local.il=0` ⇒ `terraform plan` = No changes for the incident slice (Task 7 Step 6 + CONTROLLER Step 1) ⇒ $0.
- The dispatcher/web merges are byte-identical when off (empty merge — same idiom as the GREEN remediation merge) ⇒ no task-def/Lambda revision.
- The webhook returns 503 when off (Task 3 test) ⇒ no accept, no triage, no enqueue ⇒ ZERO autonomous triggers (CONTROLLER Step 3).
- Migration v5 tables are always-present but empty + inert (no triggers fire, no rows) ⇒ harmless.

**Placeholder scan:** no `TODO`/`FIXME`/`<placeholder>`/`...` left in shipped code — the dedup SQL, the dispatcher branch, the watchdog UPDATE, the SM ASL skeleton, the IAM least-privilege, and the injection isolation are all concrete in the steps above. (Run `grep -rn "TODO\|FIXME\|placeholder\|XXX" web/lib/incident* web/app/api/incidents scripts/v2/incident terraform/foundation/incidents.tf` → expect none before each commit.)

**Type consistency:** web TS `decision: 'New'|'Linked'|'Skipped'|'disabled'`; `incidents.status` CHECK matches the SM state names; `incident_stages.status ∈ {running,succeeded,failed,stalled}`; the dispatcher `type=='incident_stage'`; the SM input `{job_id, incident_id, payload}`; SSM param names identical across `incidents.tf`, `incident.ts`, `lifecycle.py`, `workload.tf`. Python handlers return the shapes the ASL Choices read (`$.decision`, `$.roster`, `$.maxConcurrency`).

**No v1 mutation:** all PORTS read `src/lib/*` and `src/app/api/alert-webhook/route.ts` but write ONLY new `web/`/`scripts/v2/incident/` files. `src/` is never edited.
