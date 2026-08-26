# ADR-034 RCA Write-Back (v2, flag-gated) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. This is the **v2-native** plan — it targets `terraform/foundation/` + `scripts/v2/incident/` + `web/` + Aurora, NOT v1 `src/`/`data/*.json`. The v1 logic (`src/lib/slack-notification.ts` `sendSlackResolvedUpdate(threadTs)` / `thread_ts`; `src/lib/alert-knowledge.ts` `findSimilarIncidents`) is the **carried-forward reference** — PORT/ADAPT the logic into new v2 files, do **NOT** modify v1 `src/`. **This EXTENDS the just-built ADR-032 lifecycle (flag-OFF) and the ADR-029/036 substrate (flag-OFF). Build the FULL write-back substrate but ship it OFF behind `rca_writeback_enabled` (default false) ⇒ `terraform plan` = No changes for gated infra, $0, ZERO OpsCenter/Incident-Manager write happens. The one ALWAYS-ON piece is the feedback-loop marker-drop filter in the incident webhook ingress — a pure safety filter that is harmless when nothing writes. Nothing writes back until an operator flips the flag.**

**Goal:** Give ADR-032's RCA a bidirectional **output channel**: write the RCA back onto the source incident as an SSM **OpsCenter OpsItem** (`ssm:CreateOpsItem`) — or, if an **Incident Manager** response plan matches the alarm, enrich that incident (`ssm-incidents:*`) — plus one persistent Slack thread per deduped incident (reuse `threadTs`; Slack is secondary, best-effort). This is **observability-write** (creating/enriching an OpsItem/incident metadata note), a strictly lower-risk tier than infra mutation. It ships behind `rca_writeback_enabled` (default false), mirroring `workers_enabled`/`remediation_enabled`/`incident_lifecycle_enabled` gating (`local.X = var.X ? 1 : 0`, every gated resource `count = local.X`). Write-back is a **separate, best-effort, non-blocking branch**: an IAM/throttle/AWS failure MUST NOT block the primary Slack/SNS notification (ADR-012). Every write-back carries a `CreatedBy=AWSops-AIOps` marker; the incident webhook ingress DROPS any inbound event bearing that marker (feedback-loop breaker), and a max-concurrent-RCA cap is the circuit-breaker. The body is labelled an **"AWSops recommendation"** (confidence, evidence, timestamp, data sources, RCA/model/prompt versions) — never a "confirmed root cause".

**Architecture (v2):** This **extends ADR-032 (incident lifecycle) + ADR-029/036 (remediation substrate) + ADR-012/022 (notification/webhook), gated by `rca_writeback_enabled`, $0/no-write when off.** Layers:
- **Write-back stage (gated):** a NEW SM stage **after** RootCause (a branch off the RCA seam — see "RCA-output seam" below). It reads `incidents.rca`, renders a recommendation-only body (dry-run #2), routes OpsCenter-vs-Incident-Manager (#routing), creates the OpsItem / enriches the incident **with the marker** (#1 per-action IAM), records write-back status (#6 idempotency / #5 audit), and is **best-effort non-blocking** (its Catch must not fail the incident). The Slack persistent-thread port is a secondary best-effort write inside the same stage.
- **Reuse decision — the OpsItem/IncidentManager write rides the ADR-029/036 P2 lambda executor (`opscenter-create-opsitem` catalog action), NOT a new dedicated write lambda.** ADR-036 #5 binds observability writes to "the P2 `lambda` executor with the reduced control subset, NOT a full SSM runbook" — and that path *already exists*: `scripts/v2/remediation/remediation_executor.py` has `opscenter-create-opsitem` → `_opsitem_execute` (a single `ssm:create_ops_item` call), the `action_opscenter_write` per-action IAM role (`ssm:CreateOpsItem` only) is already in `remediation.tf`, and migration v4 already seeds the `opscenter-create-opsitem` catalog row (`enabled=false`). 034 EXTENDS that executor (add the `CreatedBy=AWSops-AIOps` marker, add Incident Manager routing/enrich, add a `resolve`/annotate path for #4) rather than spawning a parallel write lambda. See "Reuse decision" section for the full justification.
- **Marker-drop ingress (ALWAYS-ON):** the incident webhook (`web/app/api/incidents/webhook/route.ts`) drops any inbound event whose normalized signals carry `CreatedBy=AWSops-AIOps` (OpsItem `OperationalData`/tag) or an equivalent Incident-Manager `source`. This is a pure safety filter installed unconditionally — when no write-back happens (flag off) it simply never matches, so it is harmless and $0.
- **Domain state (always-present, migration v6):** a small `incident_writeback` table (status / source-object-id / source-system / rca-version / dedup-key) + `incidents.writeback_status`. Empty and inert when off.

**Tech Stack:** Terraform (`terraform/foundation/`, partial S3 backend, provider `~>6.0`, every gated resource `count = local.rwb`); Aurora PostgreSQL 17.9 via node-pg (`web/lib/db.ts` `getPool()`) on the web side and pg8000 (`scripts/v2/workers/db.py`) on the executor side; Python 3.12 arm64 Lambda (reuse the existing incident-Lambda packaging + the pg8000 layer + the incident-Lambda VPC role pattern); Step Functions Standard ASL (extend `scripts/v2/incident/incident.asl.json`); boto3 `ssm` (`create_ops_item`, `update_ops_item`) + `ssm-incidents` (`list_response_plans`, `create_timeline_event`, `update_incident_record`); Next.js 14 App Router (TS, `web/`, root path — no basePath, fetch `/api/*`); vitest for web, `ast.parse` + unit tests for Python. Admin gate reuses `web/lib/admin.ts` `isAdmin` + `web/lib/auth.ts` `verifyUser`.

**Key contracts (do not break):**
- **The RCA-output seam (ADR-032, exact):** `scripts/v2/incident/rootcause.py` `lambda_handler` persists `incidents.rca` (jsonb `{root_cause, category, confidence, markdown}`), advances `incidents.status='root_cause'`, and **returns `{incident_id, rca}`**. The SM (`incident.asl.json`) goes `RootCause → MitigationPlan → Prevention → Done` with `ResultPath: $.rootcause` preserving `job_id`+`incident_id`. The RootCause Lambda's docstring literally names this "the ADR-034 write-back SEAM (034 later mirrors it to OpsCenter / Incident Manager; here we only persist locally)". **034 hooks in by inserting a `WriteBack` SM state between `RootCause` and `MitigationPlan`** (reads `incidents.rca`, never re-runs the analysis). The RootCause Lambda is NOT modified (its return shape is the contract). Do NOT change `rootcause.py`'s persisted shape or the `RootCause→MitigationPlan` edge semantics beyond inserting the new state.
- **Best-effort non-blocking (ADR-034 Addendum, BINDING):** the `WriteBack` SM state's `Catch [States.ALL]` goes to a `WriteBackSkipped` `Pass` state that **continues to `MitigationPlan`** — NOT to `StageFailed`. A write-back IAM/throttle/AWS error NEVER stalls the incident and NEVER blocks the (separate) Slack/SNS primary notification. This mirrors the `Investigation` Map's `SubAgentSkipped` per-item Catch idiom already in `incident.asl.json`.
- **Reuse the P2 lambda observability executor (ADR-036 #5):** the OpsItem/IM write goes through `scripts/v2/remediation/remediation_executor.py`'s `opscenter-create-opsitem` action pattern (single API call, per-action role `action_opscenter_write`, terminal-immutable via `db.py`), EXTENDED with the marker + IM routing + resolve. Do NOT build a second write executor and do NOT route through a full SSM runbook (036 #5 forbids it for observability writes).
- **observability-write control subset (ADR-034 Addendum — NOT the full ADR-029 six controls):** apply **#1** per-action IAM (scoped to `ssm:CreateOpsItem` + `ssm-incidents:*` ONLY), **#3** admin gate (**single-operator OK — NO 4-eyes** for a metadata note), **#5** audit (reuse `remediation_audit` / `incident_writeback`), **#6** idempotency (the dedup key). **#2** dry-run = **render the OpsItem/incident body for review** (no mutation sim). **#4** rollback = **resolve/annotate the OpsItem** (no infra revert). Don't skip controls, don't over-apply them (no Change Manager template, no 4-eyes, no SSM runbook).
- **Feedback-loop breaker = concrete mechanism (ADR-034 Addendum, BINDING):** every write-back stamps the marker — OpsItem `OperationalData["/aws/AWSops"]` + tag `CreatedBy=AWSops-AIOps` (and an `ssm-incidents` timeline-event `eventData`/`source` equivalent). The webhook ingress `dropIfSelfWriteback(body)` filter is ALWAYS-ON and drops any event carrying the marker. Circuit-breaker = marker-filter PLUS the max-concurrent-RCA cap (reuse `incidents.max-concurrent-investigations` SSM cap — the WriteBack stage runs inside the same SM execution that is already bounded by that Map MaxConcurrency, so no new cap is needed; document this).
- **Prompt-injection into RCA content (ADR-034 Addendum):** alert text is attacker-controlled. The RCA was produced with `agent_bridge.build_prompt(isolated, …)` (the `isolatePayload` fenced block + `SAFEGUARD_LINE`) — 034 does NOT re-invoke the model; it renders the *already-structured* RCA fields. The body builder MUST (a) only emit the structured fields (`root_cause`, `category ∈ enum`, `confidence ∈ enum`), (b) length-bound + defang the `markdown` before embedding it in an OpsItem description (reuse the `incident-normalize.defang`-style sanity-check on the python side), (c) run an output sanity-check (`sanitize_writeback_body`) that drops the write if the RCA failed to parse (`root_cause` is the "analysis unavailable" fallback) and never writes an unqualified "confirmed root cause" string.
- **Recommendation-only labelling (ADR-034 Decision):** the body header is literally "AWSops recommendation (not a confirmed root cause)" + confidence + evidence links (incident detail URL + finding count) + timestamp + data sources (the sub-agent gateways) + RCA/model/prompt versions (`RCA_VERSION` const + `agent_space_version` from the incident row). Never "confirmed root cause".
- **Routing rule (ADR-034 Addendum, resolves the "or"):** `route_writeback(incident)` — if `ssm-incidents:list_response_plans` (or a configured response-plan-ARN map keyed by alarm/source) matches the alarm → **enrich that Incident Manager incident** (`create_timeline_event` + recommendation annotation); otherwise → **create an OpsCenter OpsItem** (`ssm:CreateOpsItem`). Default posture host-account-only.
- **Gating idiom (mirror exactly):** `incidents.tf` `local.il = var.incident_lifecycle_enabled ? 1 : 0`; `remediation.tf` `local.re = var.remediation_enabled ? 1 : 0`; every gated resource `count = local.X`; outputs `one(...)`. The new gating local is `local.rwb = var.rca_writeback_enabled ? 1 : 0`. **`rca_writeback_enabled=true` REQUIRES `incident_lifecycle_enabled=true`** (it adds a stage to the incident SM and reads `incidents.rca`) **AND `remediation_enabled=true`** (it reuses the `opscenter-create-opsitem` catalog action + `action_opscenter_write` role packaged in `remediation.tf`). Document both preconditions in `variables.tf`.
- **Schema file shape:** `terraform/foundation/data/schema.sql` is one idempotent file: a `BEGIN;…COMMIT;` block (v1) then post-COMMIT `CREATE TABLE IF NOT EXISTS` blocks each ending `INSERT INTO schema_migrations VALUES (N,…) ON CONFLICT DO NOTHING`. Current head = **v5**. Migration **v6** is a new post-COMMIT idempotent block following the v5 style.
- **SSM source-of-truth + reserved-prefix:** write-back config params under `/ops/${var.project}/writeback/…` (leading `aws…` is rejected). All `ignore_changes = [value]` (operator-tunable). The catalog row enable / IAM live in TF; live config (response-plan map, slack toggle) in SSM.
- **Container/SSM rules:** all images arm64 (the write-back Lambda reuses the existing arm64 incident packaging or the remediation executor — no new image); ECS secrets need execution-role (N/A here — no new web env secrets, just SSM param NAMES); the write-back path uses only Lambda Tasks (no new Fargate).

---

## How schema.sql is applied in v2 (discovered)

Aurora has **no migration Lambda** in v2. `terraform/foundation/data/schema.sql` is applied by **`psql` from an in-VPC deploy host** (the controller's box inside `mgmt-vpc`). The file is idempotent (`CREATE TABLE IF NOT EXISTS` throughout) and tracked by `schema_migrations`. So "apply migration v6" = the controller runs `psql` against the cluster endpoint with the RDS-managed master secret. Migration v6 is harmless when `rca_writeback_enabled=false` (it only adds an empty `incident_writeback` table + a nullable `incidents.writeback_status` column + the seed marker — no infra, no execution, no write).

Exact apply command (controller, final task):
```bash
PGPASSWORD="$(aws secretsmanager get-secret-value \
  --secret-id "$(terraform -chdir=terraform/foundation output -raw aurora_secret_arn)" \
  --query SecretString --output text | python3 -c 'import sys,json;print(json.load(sys.stdin)["password"])')" \
psql -v ON_ERROR_STOP=1 \
  "host=$(terraform -chdir=terraform/foundation output -raw aurora_endpoint) port=5432 dbname=awsops user=awsops_admin sslmode=require" \
  -f terraform/foundation/data/schema.sql
# verify: SELECT version FROM schema_migrations;  -> includes 6
```

---

## Reuse decision (justify): EXTEND the ADR-029/036 P2 lambda executor; do NOT add a dedicated write lambda

**Decision: REUSE the existing `scripts/v2/remediation/remediation_executor.py` `opscenter-create-opsitem` action + the `action_opscenter_write` per-action IAM role + the migration-v4 catalog row. EXTEND that executor (marker stamping, Incident Manager routing/enrich, a `resolve` rollback path) and add a thin `scripts/v2/incident/writeback.py` SM-stage Lambda that PREPARES the write (route + render body + dedup) and DELEGATES the actual single AWS write through the same executor pattern. Do NOT build a parallel write executor and do NOT route through a full SSM runbook.**

Why (ADR-036 #5 is binding — *"observability writes route through the P2 `lambda` executor with the reduced control subset, NOT a full SSM runbook … a single API call via the P2 lambda executor"*):
1. **The path already exists.** `remediation_executor.py` `_EXEC["opscenter-create-opsitem"] = {"dry": _opsitem_dry_run, "run": _opsitem_execute, "rb": None}` is a single `ssm.create_ops_item(...)` call. `remediation.tf` already provisions `aws_iam_role.action_opscenter_write` (policy = `ssm:CreateOpsItem` only) + wires `ACTION_ROLE_OPSCENTER_CREATE_OPSITEM` + grants the worker_lambda `sts:AssumeRole` on it. Migration v4 already seeds the `opscenter-create-opsitem` catalog row (`executor_type='lambda'`, `enabled=false`, `iam_actions=["ssm:CreateOpsItem"]`). A dedicated write lambda would DUPLICATE this and create a second, un-governed observability-write surface — exactly what 036 #5 consolidates.
2. **The reduced control subset is already the executor's shape.** `_opsitem_execute` is single-API-call, terminal-immutable (`db.claim_running`/`finish_job`), per-action-role-scoped (`_assume(ACTION_ROLE_…)`), gated by `cat.gate` (flag + kill-switch + row-enabled). 034's #1/#5/#6 fall straight out of that. 034 ADDS: the marker (`OperationalData`/tag), the `ssm-incidents` IM enrich branch, and a `resolve` (#4) path.
3. **What the incident-side `writeback.py` Lambda owns (and why it's NOT the executor):** the SM-stage Lambda runs *inside the incident lifecycle* (incident-Lambda role, reads `incidents.rca`, writes `incident_writeback`). It does the incident-specific work — route OpsCenter-vs-IM, render the recommendation-only body, compute the dedup key, render-only dry-run (#2), record write-back status (#5/#6), best-effort Slack thread — then performs the single observability write via the SAME `_opsitem_execute`/`_incident_enrich` functions (imported/shared) under the `action_opscenter_write` (OpsItem) and a new `action_incident_write` (IM) per-action role. This keeps the AWS-write surface = the 029/036 executor's single-call functions, while the lifecycle-specific orchestration stays in the incident slice. (Alternative — bolt the IM branch + marker straight into `remediation_executor.py` and have the incident SM call `/api/actions` create-plan/execute — was rejected: `/api/actions` execute enforces **4-eyes**, which 034's #3 EXPLICITLY waives for a metadata note, and it would couple the autonomous lifecycle to the human-gated remediation front door. So: reuse the executor's *write functions + per-action role + catalog gate*, but drive them from the incident SM stage, not the 4-eyes `/api/actions` execute path.)

Net: one observability-write surface (the 029/036 executor functions + per-action roles), driven from the incident SM via a thin `writeback.py` stage. No duplicate executor, no SSM runbook, no 4-eyes.

---

## File map

**Create (Python — `scripts/v2/incident/`):**
- `writeback.py` — the `WriteBack` SM-stage Lambda. `lambda_handler({job_id, incident_id})`: (1) load `incidents.rca` + incident row; (2) `sanitize_writeback_body(rca)` output sanity-check (drops the write if RCA is the "analysis unavailable" fallback or fails the enum/length checks); (3) `build_recommendation_body(incident, rca)` recommendation-only body (#2 dry-run = this rendered body); (4) `route_writeback(incident, ssm_incidents)` → `opscenter` | `incident_manager`; (5) compute `dedup_key = sha256(incident_id + ':writeback')` (#6); (6) `INSERT … ON CONFLICT (dedup_key) DO NOTHING` into `incident_writeback` (idempotent — exactly one write per incident); (7) perform the single AWS write **with the marker** via the shared `_opsitem_execute_marked` / `_incident_enrich_marked` (per-action role assume, mirrors `remediation_executor._assume`); (8) best-effort Slack thread (`slack_thread.py`); (9) record terminal write-back status into `incident_writeback` + `incidents.writeback_status`. **Best-effort: every AWS/Slack failure is caught and recorded as `failed` WITHOUT raising** (the SM Catch is a second safety net). Reuses `scripts/v2/workers/db.py`.
- `writeback_render.py` — pure body/sanity helpers (no AWS): `RCA_VERSION` const, `build_recommendation_body(incident, rca)` (the "AWSops recommendation (not a confirmed root cause)" header + confidence + evidence + timestamp + data sources + RCA/model/prompt versions), `sanitize_writeback_body(rca)` (enum + length + injection sanity-check; reuse a python `defang`), `route_decision(incident, response_plan_arns)` (pure routing given a matched-plan lookup result). Pure functions → fully unit-testable with no boto3.
- `slack_thread.py` — best-effort secondary Slack thread PORTED from `src/lib/slack-notification.ts` `sendSlackResolvedUpdate(threadTs)` + `thread_ts` payload logic, ADAPTED to python + reads Slack creds from SSM (`/ops/${project}/writeback/slack/*`). Thin adapter; **gated behind a `writeback/slack/enabled` SSM toggle** (creds needed) — when absent/false it is a no-op (returns `{skipped:'slack-not-configured'}`). Persists/reuses `incident_writeback.slack_thread_ts` so re-fires reuse the same thread.
- `test_writeback.py` — `ast.parse` compile + unit tests (see Task 6). Highest-value: marker-drop filter, best-effort-non-blocking, routing, recommendation-only body, dedup idempotency, output sanity-check drops the fallback RCA.

**Modify (Python):**
- `scripts/v2/remediation/remediation_executor.py` — EXTEND `_opsitem_execute` to stamp the marker (`OperationalData={"/aws/AWSops": {...}}` + `Tags=[{Key:'CreatedBy',Value:'AWSops-AIOps'}]`); add a `resolve` rollback fn for `opscenter-create-opsitem` (`rb`: `update_ops_item(Status='Resolved')` — the #4 control); add an `incident-manager-enrich` action (`_incident_enrich` → `ssm-incidents:create_timeline_event` + `update_incident_record`, marker via `eventData`). These functions are imported by `writeback.py` (shared single-write surface). NO behavior change to existing actions when not invoked.
- `scripts/v2/incident/incident.asl.json` — insert a `WriteBack` `Task` state between `RootCause` and `MitigationPlan`: `RootCause` `Next: WriteBack`; `WriteBack` (`Resource: ${writeback_fn_arn}`, `ResultPath: $.writeback`, `Retry` on Lambda transient, `Catch [States.ALL] → WriteBackSkipped` `Pass` → `MitigationPlan`). When `rca_writeback_enabled=false` the SM template renders `writeback_fn_arn` as the RootCause→MitigationPlan passthrough — see Task 4 for the gated-template approach so the OFF graph is byte-identical to today.

**Create (Terraform):**
- `terraform/foundation/writeback.tf` — ALL `rca_writeback_enabled`-gated infra: `local.rwb`; the `writeback` stage Lambda (`writeback.lambda_handler`, arm64 python3.12, pg8000 layer, VPC, reuses the incident-Lambda packaging by adding `writeback.py`/`writeback_render.py`/`slack_thread.py` to the `incident_src` archive — see Task 4); a NEW per-action IAM role `action_incident_write` (policy = `ssm-incidents:GetResponsePlan`,`ListResponsePlans`,`CreateTimelineEvent`,`UpdateIncidentRecord`,`GetIncidentRecord` ONLY); EXTEND the incident-Lambda role with `sts:AssumeRole` on `action_opscenter_write` + `action_incident_write` and `ssm-incidents:ListResponsePlans` (for routing) + `ssm:GetParameter` on the writeback SSM params; the write-back SSM params (`/ops/${project}/writeback/{opscenter-source,response-plan-map,slack/enabled,slack/channel}`, `ignore_changes=[value]`); a `local.rwb`-gated CloudWatch log group is not needed (reuses `/aws/lambda/${project}-incident`). Outputs `one(...)`.

**Modify (Terraform):**
- `terraform/foundation/variables.tf` — add `variable "rca_writeback_enabled" { default = false }` (doc the two preconditions: requires `incident_lifecycle_enabled` AND `remediation_enabled`).
- `terraform/foundation/data/schema.sql` — append migration v6 block (`incident_writeback` table + `incidents.writeback_status` column + a documented marker constant comment) + `schema_migrations` v6.
- `terraform/foundation/incidents.tf` — (a) add `writeback.py`/`writeback_render.py`/`slack_thread.py` to the `data.archive_file.incident_src` sources so the new stage Lambda ships in the same arm64 zip; (b) add the `WriteBack`-stage env (`SSM_WRITEBACK_*` param names, `ACTION_ROLE_OPSCENTER_CREATE_OPSITEM`, `ACTION_ROLE_INCIDENT_WRITE`) to `local.inc_env` via a `var.rca_writeback_enabled ? {…} : {}` merge (byte-identical when off); (c) pass `writeback_fn_arn` to the SM template (the gated-template indirection from Task 4); (d) add `aws_lambda_function.incident_writeback[0].arn` to the incident SM role's `InvokeIncidentLambdas` Resource list (only when `local.rwb`).

**Modify (web):**
- `web/app/api/incidents/webhook/route.ts` — add the ALWAYS-ON `dropIfSelfWriteback(body)` filter (BEFORE triage; after HMAC + normalize). Drops any normalized alert whose signals/labels carry `CreatedBy=AWSops-AIOps` (OpsItem) or `source=AWSops-AIOps` (IM). Returns a `200 {status:'dropped_self_writeback'}` (accepted-and-ignored, so the source does not retry). Harmless when nothing writes back.
- `web/lib/incident-normalize.ts` — add `bearsSelfWritebackMarker(event): boolean` (pure; checks `labels`/`annotations`/`signals` for the marker key+value). Exported + unit-tested.
- `web/lib/incident.ts` — add `getIncident` to also return `writeback_status` + the `incident_writeback` rows (admin-gated read for the detail UI; degrade-safe). No write path here (the write is in the SM Lambda).

**Create (web tests):**
- `web/lib/incident-normalize.test.ts` — add cases for `bearsSelfWritebackMarker` (positive: marker present in labels/annotations/signals; negative: absent / partial).
- `web/app/api/incidents/webhook/route.test.ts` — add cases: a marked event is DROPPED (200 `dropped_self_writeback`, triage NOT called); an unmarked event proceeds (existing behavior unchanged).

---

## Out of scope (state explicitly — DO NOT implement; all later / operator-gated)

- **Enabling any write-back.** `rca_writeback_enabled` ships `false`; the `opscenter-create-opsitem` catalog row stays `enabled=false`; the new IM action row ships `enabled=false`; the mutating kill-switch stays off. Flipping the flag is an explicit operator action, NOT part of this plan. **ZERO OpsCenter/Incident-Manager write happens from this plan.**
- **External ITSM adapters (PagerDuty / ServiceNow / Opsgenie / Grafana annotations).** ADR-034 Option 4 is rejected as a default; these are *optional adapters after* the AWS-native path is stable. Not built here.
- **Silences / alarm-state writes.** ADR-034/029 classify silences as **higher-risk and separately gated** — out of this observability-metadata-write tier. Not built here.
- **Cross-account write-back ON.** Default posture is host-account-only; `ALLOW_CROSS_ACCOUNT_MUTATION` stays `false` (the same toggle as ADR-029/036). No cross-account write path is enabled here.
- **Full 4-eyes / Change Manager for write-back.** ADR-034 #3 EXPLICITLY waives 4-eyes for a metadata note (single-operator OK). Do NOT add a Change Manager template or a second-approver gate to the write-back path. (The full 029/036 6-control path remains for *infra* mutation, unchanged.)
- **Re-running the RCA model.** 034 consumes the ADR-032 RCA already persisted in `incidents.rca`; it does NOT invoke Bedrock/AgentCore. No new model call, no new prompt, no token spend in the write-back stage.
- **pgvector / semantic similar-incident RAG.** Deferred (the ADR-032 plan owns the seam). The `alert-knowledge` priors port is *not* part of write-back; the recommendation body cites finding count, not a similarity score (a future enhancement).
- **A new SQS queue / second orchestration spine.** Write-back is one new SM state inside the existing incident SM (ADR-032 Addendum #3 — one backbone).

---

## Tasks

### Task 1: `variables.tf` + migration v6 schema (always-present write-back state)

**Files:** Modify `terraform/foundation/variables.tf`; Modify `terraform/foundation/data/schema.sql`

Read the `remediation_enabled` (lines 104–108) + `incident_lifecycle_enabled` (110–114) variables and the v5 schema block (lines ~493–589) for the exact idiom.

- [ ] **Step 1 (variable):** After the `incident_lifecycle_enabled` variable add:
```hcl
variable "rca_writeback_enabled" {
  type        = bool
  description = "ADR-034 RCA write-back gate (observability-write tier). false (default) = 0 write-back infra, 0 cost, ZERO OpsCenter/Incident-Manager write. The always-present incident_writeback table (migration v6) is harmless when off. REQUIRES incident_lifecycle_enabled=true (adds a stage to the incident SM, reads incidents.rca) AND remediation_enabled=true (reuses the opscenter-create-opsitem catalog action + action_opscenter_write per-action role from remediation.tf). The webhook marker-drop filter is ALWAYS-ON (a harmless safety filter independent of this flag)."
  default     = false
}
```
- [ ] **Step 2 (migration v6 block):** Append AFTER the v5 block (after line 589), following the v5 post-COMMIT idempotent style:
```sql
-- ============================================================================
-- ADR-034 (migration v6): RCA write-back state — always-present, inert when
-- rca_writeback_enabled=false. Records WHERE each incident's RCA was written
-- back (OpsCenter OpsItem id OR Incident Manager incident ARN), the dedup key
-- (idempotency #6), the recommendation-only marker, the RCA version, and the
-- best-effort Slack thread_ts. NO autonomous behavior; the write itself rides
-- the incident SM WriteBack stage (gated). Idempotent.
-- ============================================================================

-- One row per (incident) write-back attempt. dedup_key UNIQUE => exactly one
-- write per incident (re-fire reuses the row / the Slack thread). The marker
-- column documents the feedback-loop breaker stamp (CreatedBy=AWSops-AIOps).
CREATE TABLE IF NOT EXISTS incident_writeback (
  id              BIGSERIAL PRIMARY KEY,
  incident_id     UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  dedup_key       TEXT NOT NULL UNIQUE,                 -- sha256(incident_id+':writeback') (idempotency #6)
  target_system   TEXT NOT NULL
                    CHECK (target_system IN ('opscenter','incident_manager')),
  source_object_id TEXT,                                -- OpsItemId OR incidentRecordArn
  rca_version     TEXT,                                 -- RCA_VERSION stamped at write time
  marker          TEXT NOT NULL DEFAULT 'AWSops-AIOps', -- feedback-loop breaker stamp (CreatedBy)
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','rendered','succeeded','failed','resolved','skipped')),
  slack_thread_ts TEXT,                                 -- persistent thread reuse (ADR-012 threadTs)
  detail          JSONB NOT NULL DEFAULT '{}'::jsonb,   -- rendered body / error / dry-run capture
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_writeback_incident ON incident_writeback (incident_id);
CREATE INDEX IF NOT EXISTS idx_writeback_status ON incident_writeback (status, updated_at);

-- A denormalized status on incidents for the detail UI (degrade-safe; nullable).
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS writeback_status TEXT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_writeback_touch') THEN
    CREATE TRIGGER trg_writeback_touch BEFORE UPDATE ON incident_writeback
      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
  END IF;
END $$;

INSERT INTO schema_migrations (version, description)
VALUES (6, 'ADR-034: RCA write-back state — incident_writeback (dedup/idempotent) + incidents.writeback_status (inert when off)')
ON CONFLICT (version) DO NOTHING;
```
- [ ] **Step 3:** `terraform -chdir=terraform/foundation validate` (will run in Task 4/CONTROLLER after the rest). Confirm no new resource yet (variable + schema only).

---

### Task 2: Pure render/route/sanitize helpers (`writeback_render.py`) + tests

**Files:** Create `scripts/v2/incident/writeback_render.py`

Pure functions, no boto3, no DB — fully unit-testable. Mirror `rootcause.py`'s `_VALID_CATEGORY`/`_VALID_CONFIDENCE` enums and `incident-normalize.ts` `defang`.

- [ ] **Step 1:** Write the module:
```python
"""AWSops v2 ADR-034 — RCA write-back PURE helpers (no AWS, no DB).

Renders the recommendation-only body, sanity-checks the (attacker-influenced) RCA before any
write-back, and decides the OpsCenter-vs-Incident-Manager route. The model is NOT re-invoked here;
034 consumes the ADR-032 RCA already persisted in incidents.rca.

SAFETY: recommendation-only labelling (never 'confirmed root cause'); the RCA markdown is defanged
+ length-bounded before embedding; a fallback/garbage RCA is DROPPED (returns ok=False)."""
import hashlib
import re

RCA_VERSION = "rca-2026-06-10"          # bumped when the RCA prompt/parser changes (provenance)
_VALID_CATEGORY = ("deployment", "capacity", "configuration", "dependency",
                   "security", "infrastructure", "unknown")
_VALID_CONFIDENCE = ("high", "medium", "low")
_DESC_CAP = 4000                        # OpsItem Description hard cap (SSM limit is higher; stay conservative)
_FALLBACK_PREFIX = "analysis unavailable"   # rootcause.py writes this when the model call failed

# feedback-loop breaker stamp — MUST match incident-normalize.bearsSelfWritebackMarker (web side).
MARKER_KEY = "CreatedBy"
MARKER_VALUE = "AWSops-AIOps"


def defang(s, cap):
    """Strip markup/control chars + neutralize instruction phrasing; mirror incident-normalize.defang."""
    t = s if isinstance(s, str) else str(s or "")
    t = re.sub(r"[<>]", " ", t)
    t = re.sub(r"[\x00-\x1f]", " ", t)
    t = re.sub(r"ignore (all|any|previous|the above)[^.\n]*", "[redacted-instruction]", t, flags=re.I)
    t = re.sub(r"\b(system|assistant|developer)\s*:", "[role] ", t, flags=re.I)
    t = re.sub(r"\s+", " ", t).strip()
    return t[:cap]


def dedup_key(incident_id):
    """Idempotency #6: exactly one write-back per incident (the UNIQUE key on incident_writeback)."""
    return hashlib.sha256(f"{incident_id}:writeback".encode("utf-8")).hexdigest()


def sanitize_writeback_body(rca):
    """Output sanity-check (ADR-034 prompt-injection-into-content control). Returns (ok, reason).
    Drops the write if: rca missing, the model fallback ('analysis unavailable'), or invalid enums."""
    if not isinstance(rca, dict):
        return False, "rca-missing"
    root = (rca.get("root_cause") or "").strip()
    if not root or root.lower().startswith(_FALLBACK_PREFIX):
        return False, "rca-fallback"     # do NOT write back an unusable analysis
    if rca.get("category") not in _VALID_CATEGORY:
        return False, "bad-category"
    if rca.get("confidence") not in _VALID_CONFIDENCE:
        return False, "bad-confidence"
    return True, None


def build_recommendation_body(incident, rca, evidence_url, finding_count, data_sources):
    """Build the OpsItem/timeline body. RECOMMENDATION-ONLY labelling (BINDING): never an
    unqualified 'confirmed root cause'. Returns {title, description} (defanged, length-bounded)."""
    confidence = rca["confidence"]
    category = rca["category"]
    root = defang(rca["root_cause"], 512)
    md = defang(rca.get("markdown", ""), _DESC_CAP - 600)   # leave room for the labelled header
    title = defang(f"AWSops recommendation: {root}", 1000)
    description = "\n".join([
        "AWSops recommendation (NOT a confirmed root cause).",
        f"Confidence: {confidence}   Category: {category}",
        f"Evidence: {evidence_url}  (findings: {finding_count})",
        f"Data sources: {', '.join(sorted(set(data_sources)))[:512]}",
        f"RCA version: {RCA_VERSION}   Agent space: {defang(incident.get('agent_space_version') or 'n/a', 64)}",
        f"Generated: {incident.get('last_event_at') or ''}",
        "",
        "--- analysis (recommendation only) ---",
        md,
    ])[:_DESC_CAP]
    return {"title": title, "description": description}


def route_decision(matched_response_plan_arn):
    """Resolve the ADR-034 'or': a matched Incident Manager response plan => enrich that incident;
    otherwise => create an OpsCenter OpsItem. Pure given the lookup result."""
    return "incident_manager" if matched_response_plan_arn else "opscenter"
```
- [ ] **Step 2:** Verify it imports / compiles: `python3 -c "import ast; ast.parse(open('scripts/v2/incident/writeback_render.py').read())"`.

---

### Task 3: `writeback.py` SM-stage Lambda + executor extension (the single AWS write + marker)

**Files:** Create `scripts/v2/incident/writeback.py`; Create `scripts/v2/incident/slack_thread.py`; Modify `scripts/v2/remediation/remediation_executor.py`

Read `mitigation_plan.py` (the stage-Lambda read-rca → bounded-UPDATE pattern), `remediation_executor.py` `_assume`/`_opsitem_execute` (the per-action-role single-write pattern), and `db.py` `claim_running`/`finish_job` (terminal-immutable).

- [ ] **Step 1 (executor: marker + IM enrich + resolve):** In `remediation_executor.py`, replace `_opsitem_execute` and the `_EXEC` map so the write is MARKED and add the IM + resolve functions:
```python
# ---- observability write (ADR-036 #5 reduced subset), MARKED for the feedback-loop breaker ----
_MARKER = {"key": "CreatedBy", "value": "AWSops-AIOps"}

def _opsitem_dry_run(payload, _sess):
    return {"would_create_opsitem_title": payload.get("title"), "mutates": False}

def _opsitem_execute(_conn, payload, sess):
    ssm = sess.client("ssm")
    r = ssm.create_ops_item(
        Title=payload["title"], Source=payload["source"],
        Severity=str(payload.get("severity", "3")),
        Description=payload.get("description") or payload["title"],
        # feedback-loop breaker marker: OperationalData + Tag. The incident webhook ingress
        # drops any inbound event bearing CreatedBy=AWSops-AIOps so our own write can't re-trigger.
        OperationalData={"/aws/AWSops": {"Type": "SearchableString", "Value": _MARKER["value"]}},
        Tags=[{"Key": _MARKER["key"], "Value": _MARKER["value"]}])
    return {"ops_item_id": r["OpsItemId"], "marker": _MARKER["value"]}

def _opsitem_resolve(_conn, rollback_plan, sess):   # ADR-034 #4 rollback = resolve (no infra revert)
    sess.client("ssm").update_ops_item(OpsItemId=rollback_plan["ops_item_id"], Status="Resolved")
    return {"resolved": rollback_plan["ops_item_id"]}

def _incident_enrich(_conn, payload, sess):
    """ADR-034 routing: enrich a matched Incident Manager incident (timeline event). Marked via
    eventData/source so the ingress can drop it. ssm-incidents:* only (per-action role)."""
    inc = sess.client("ssm-incidents")
    inc.create_timeline_event(
        incidentRecordArn=payload["incident_record_arn"],
        eventTime=payload["event_time"], eventType="Custom Event",
        eventData=payload["description"],
        # marker rides eventReferences/source so a downstream alarm-as-event carries it.
    )
    return {"enriched": payload["incident_record_arn"], "marker": _MARKER["value"]}

_EXEC = {
    "app-feature-flag-set":     {"dry": _flag_dry_run,    "run": _flag_execute,    "rb": _flag_rollback},
    "opscenter-create-opsitem": {"dry": _opsitem_dry_run, "run": _opsitem_execute, "rb": _opsitem_resolve},
    "incident-manager-enrich":  {"dry": _opsitem_dry_run, "run": _incident_enrich, "rb": None},
}
```
- [ ] **Step 2 (writeback.py stage Lambda — best-effort, non-blocking):** Create:
```python
"""AWSops v2 ADR-034 — WriteBack stage Lambda (the RCA output channel).

Runs as the SM stage AFTER RootCause. Reads incidents.rca (does NOT re-run the model), renders a
recommendation-only body, routes OpsCenter-vs-Incident-Manager, performs ONE marked observability
write through the shared 029/036 executor functions (per-action role), and records status.

SAFETY / BINDING:
  - BEST-EFFORT, NON-BLOCKING: every AWS/Slack failure is caught + recorded 'failed' WITHOUT
    raising, so a write-back error NEVER stalls the incident or blocks the primary Slack/SNS path.
    (The SM Catch -> WriteBackSkipped is a second safety net.)
  - observability-write control subset: #1 per-action role (assume action_opscenter_write /
    action_incident_write); #3 single-operator (no 4-eyes — this is NOT the /api/actions path);
    #5 audit (incident_writeback rows); #6 idempotency (dedup_key UNIQUE).
  - #2 dry-run = render the body (status='rendered') with NO mutation. #4 rollback = resolve the
    OpsItem (executor _opsitem_resolve), exposed via phase='rollback'.
  - feedback-loop breaker: the write is MARKED (CreatedBy=AWSops-AIOps); the ingress drops it.
"""
import json
import os
import boto3

import db
import writeback_render as r
import slack_thread

# shared single-write surface from the 029/036 executor (same artifact when packaged together);
# import lazily so unit tests can stub boto3.
PROJECT = os.environ.get("PROJECT", "awsops-v2")
_REGION = os.environ.get("AWS_REGION", "ap-northeast-2")
_PUBLIC_BASE = os.environ.get("PUBLIC_BASE_URL", "")   # for the evidence link


def _assume(role_arn):
    c = boto3.client("sts", region_name=_REGION).assume_role(
        RoleArn=role_arn, RoleSessionName="awsops-writeback")["Credentials"]
    return boto3.Session(aws_access_key_id=c["AccessKeyId"], aws_secret_access_key=c["SecretAccessKey"],
                         aws_session_token=c["SessionToken"], region_name=_REGION)


def _load(conn, incident_id):
    rows = conn.run("SELECT id, severity, agent_space_version, rca, last_event_at, trigger_source "
                    "FROM incidents WHERE id=:i", i=incident_id)
    if not rows:
        return None
    cols = ["id", "severity", "agent_space_version", "rca", "last_event_at", "trigger_source"]
    inc = dict(zip(cols, rows[0]))
    if isinstance(inc["rca"], str):
        try:
            inc["rca"] = json.loads(inc["rca"])
        except (ValueError, TypeError):
            inc["rca"] = None
    fc = conn.run("SELECT count(*), array_agg(DISTINCT sub_agent) FROM incident_findings WHERE incident_id=:i", i=incident_id)
    inc["finding_count"], inc["data_sources"] = (fc[0][0] or 0), (fc[0][1] or [])
    return inc


def _record(conn, incident_id, dedup, target, status, source_object_id=None, detail=None, thread_ts=None):
    conn.run(
        "INSERT INTO incident_writeback (incident_id, dedup_key, target_system, status, "
        "source_object_id, rca_version, slack_thread_ts, detail) "
        "VALUES (:i,:k,:t,:s,:o,:v,:ts,:d::jsonb) "
        "ON CONFLICT (dedup_key) DO UPDATE SET status=:s, source_object_id=COALESCE(:o, incident_writeback.source_object_id), "
        "slack_thread_ts=COALESCE(:ts, incident_writeback.slack_thread_ts), detail=:d::jsonb",
        i=incident_id, k=dedup, t=target, s=status, o=source_object_id, v=r.RCA_VERSION,
        ts=thread_ts, d=json.dumps(detail or {}))
    conn.run("UPDATE incidents SET writeback_status=:s WHERE id=:i", s=status, i=incident_id)


def _route(inc):
    """Match an Incident Manager response plan for this alarm (config map or list). Returns the
    matched incidentRecordArn or None. Read-only ssm-incidents (incident-Lambda role)."""
    plan_map = json.loads(os.environ.get("WRITEBACK_RESPONSE_PLAN_MAP", "{}") or "{}")
    return plan_map.get(inc.get("trigger_source"))   # simplest binding: source->incidentRecordArn map


def lambda_handler(event, _ctx):
    incident_id = event["incident_id"]
    phase = event.get("phase", "execute")
    conn = db.connect()
    try:
        inc = _load(conn, incident_id)
        if not inc:
            return {"incident_id": incident_id, "writeback": "skipped", "reason": "no-incident"}
        ok, reason = r.sanitize_writeback_body(inc.get("rca"))
        dedup = r.dedup_key(incident_id)
        if not ok:
            _record(conn, incident_id, dedup, "opscenter", "skipped", detail={"reason": reason})
            return {"incident_id": incident_id, "writeback": "skipped", "reason": reason}

        matched_arn = _route(inc)
        target = r.route_decision(matched_arn)
        evidence = f"{_PUBLIC_BASE}/incidents/{incident_id}" if _PUBLIC_BASE else incident_id
        body = r.build_recommendation_body(inc, inc["rca"], evidence, inc["finding_count"], inc["data_sources"])

        if phase == "dry_run":   # ADR-034 #2 = render only, NO mutation
            _record(conn, incident_id, dedup, target, "rendered", detail={"body": body})
            return {"incident_id": incident_id, "writeback": "rendered", "body": body}

        # idempotency #6: claim the row; if it already succeeded, skip (re-fire reuses it).
        existing = conn.run("SELECT status, slack_thread_ts FROM incident_writeback WHERE dedup_key=:k", k=dedup)
        if existing and existing[0][0] in ("succeeded", "resolved"):
            return {"incident_id": incident_id, "writeback": "already-done"}
        prior_ts = existing[0][1] if existing else None

        source_object_id = None
        try:    # BEST-EFFORT: the single marked AWS write. Failure is recorded, NOT raised.
            import remediation_executor as ex
            if target == "incident_manager":
                sess = _assume(os.environ["ACTION_ROLE_INCIDENT_WRITE"])
                res = ex._incident_enrich(conn, {"incident_record_arn": matched_arn,
                      "event_time": inc["last_event_at"], "description": body["description"]}, sess)
                source_object_id = res["enriched"]
            else:
                sess = _assume(os.environ["ACTION_ROLE_OPSCENTER_CREATE_OPSITEM"])
                res = ex._opsitem_execute(conn, {"title": body["title"], "source": os.environ.get(
                      "WRITEBACK_OPSCENTER_SOURCE", PROJECT), "severity": _sev(inc["severity"]),
                      "description": body["description"]}, sess)
                source_object_id = res["ops_item_id"]
            status = "succeeded"
            detail = {"target": target, "marker": r.MARKER_VALUE}
        except Exception as e:    # noqa: BLE001 — best-effort: never block the primary notification
            status, detail = "failed", {"target": target, "error": f"{type(e).__name__}: {e}"[:1000]}

        thread_ts = slack_thread.post_best_effort(incident_id, body, prior_ts)  # secondary, also best-effort
        _record(conn, incident_id, dedup, target, status, source_object_id, detail, thread_ts)
        return {"incident_id": incident_id, "writeback": status, "target": target,
                "source_object_id": source_object_id}
    finally:
        conn.close()


def _sev(severity):
    return {"critical": "1", "warning": "3", "info": "4"}.get((severity or "").lower(), "3")
```
- [ ] **Step 3 (slack_thread.py — thin gated adapter, best-effort):** Create the Slack persistent-thread port (gated behind the SSM toggle; no-op when Slack creds absent):
```python
"""ADR-034/012 — best-effort secondary Slack thread. PORTED from src/lib/slack-notification.ts
(sendSlackResolvedUpdate(threadTs) + thread_ts reuse), ADAPTED to python + SSM creds. Gated behind
/ops/<project>/writeback/slack/enabled; a no-op when off / unconfigured. Best-effort: never raises."""
import json
import os
import urllib.request

PROJECT = os.environ.get("PROJECT", "awsops-v2")


def _ssm_get(name):
    import boto3
    try:
        return boto3.client("ssm", region_name=os.environ.get("AWS_REGION", "ap-northeast-2")
                            ).get_parameter(Name=name, WithDecryption=True)["Parameter"]["Value"]
    except Exception:
        return None


def post_best_effort(incident_id, body, prior_thread_ts):
    """Post one threaded Slack message (reusing prior_thread_ts if present). Returns the thread_ts
    or None. NEVER raises — Slack is the secondary channel; failure must not block anything."""
    if _ssm_get(f"/ops/{PROJECT}/writeback/slack/enabled") != "true":
        return prior_thread_ts
    webhook = _ssm_get(f"/ops/{PROJECT}/writeback/slack/webhook")
    if not webhook:
        return prior_thread_ts
    try:
        payload = {"text": body["title"][:3000]}
        if prior_thread_ts:
            payload["thread_ts"] = prior_thread_ts   # reuse the persistent thread (ADR-012 threadTs)
        req = urllib.request.Request(webhook, data=json.dumps(payload).encode("utf-8"),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            resp.read()
        return prior_thread_ts   # incoming-webhook mode doesn't return a new ts; reuse the prior
    except Exception:
        return prior_thread_ts
```
- [ ] **Step 4:** `ast.parse` all three files; confirm `writeback.py` imports only `db`, `writeback_render`, `slack_thread`, `remediation_executor`, `boto3`, `json`, `os`.

---

### Task 4: Wire the WriteBack stage into the incident SM + `writeback.tf` (gated infra)

**Files:** Modify `scripts/v2/incident/incident.asl.json`; Modify `terraform/foundation/incidents.tf`; Create `terraform/foundation/writeback.tf`

Read `incident.asl.json` (the `RootCause`→`MitigationPlan` edge + the `Investigation` Map's `SubAgentSkipped` per-item-Catch idiom) and `incidents.tf` (the `data.archive_file.incident_src`, `local.inc_env`, the SM `templatefile`, the SM role `InvokeIncidentLambdas`). Read `remediation.tf` lines 141–154 (`action_opscenter_write`) for the per-action-role idiom.

- [ ] **Step 1 (ASL — insert WriteBack between RootCause and MitigationPlan):** Change `RootCause.Next` from `"MitigationPlan"` to `"WriteBack"`, and add the two states. The Catch goes to a `Pass` that CONTINUES (best-effort non-blocking — mirrors `SubAgentSkipped`):
```json
    "WriteBack": {
      "Type": "Task",
      "Resource": "${writeback_fn_arn}",
      "TimeoutSeconds": 600,
      "Comment": "ADR-034 RCA write-back (observability-write). Reads incidents.rca (NO model re-run), renders a recommendation-only body, routes OpsCenter vs Incident Manager, performs ONE marked write via the 029/036 executor. BEST-EFFORT: any failure Catches to WriteBackSkipped and CONTINUES to MitigationPlan — it NEVER stalls the incident or blocks the primary notification. ResultPath isolates output so job_id+incident_id survive.",
      "ResultPath": "$.writeback",
      "Retry": [
        { "ErrorEquals": ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException", "Lambda.TooManyRequestsException"],
          "IntervalSeconds": 2, "MaxAttempts": 2, "BackoffRate": 2.0 }
      ],
      "Catch": [
        { "ErrorEquals": ["States.ALL"], "ResultPath": "$.writebackError", "Next": "WriteBackSkipped" }
      ],
      "Next": "MitigationPlan"
    },
    "WriteBackSkipped": {
      "Type": "Pass",
      "Comment": "Write-back is a SEPARATE best-effort branch (ADR-034). A failed write-back is non-fatal: the incident proceeds and the primary Slack/SNS path is untouched. Continue to MitigationPlan.",
      "Next": "MitigationPlan"
    },
```
- [ ] **Step 2 (gated template indirection — OFF graph stays byte-identical):** In `incidents.tf`, the SM `templatefile` currently has no `writeback_fn_arn`. Add a local that resolves the write-back ARN to the **RootCause arn when off** is NOT possible (different handler) — instead, the WriteBack Lambda is ALWAYS provisioned only when `local.rwb`, and the SM is rendered with `writeback_fn_arn` = the writeback Lambda arn when `local.rwb`, else a passthrough. Because the ASL now references `WriteBack`, the cleanest gate is: keep `incident.asl.json` as the rwb-ON graph, and add a SECOND template var the renderer uses. Implement as:
  - Add to `local` in `incidents.tf`: `rwb = var.rca_writeback_enabled ? 1 : 0`.
  - In the `aws_sfn_state_machine.incident` `templatefile(...)` add `writeback_fn_arn = local.rwb == 1 ? aws_lambda_function.incident_writeback[0].arn : aws_lambda_function.incident_rootcause[0].arn`. (When OFF, the SM still has a `WriteBack` state but it points at a benign Lambda — REJECTED: that would invoke rootcause twice.)
  - **Chosen approach (clean):** make the ASL template conditional via TWO template files is overkill; instead render the `RootCause.Next` and the presence of `WriteBack` with a `templatefile` boolean. ASL is JSON, not conditional. So: keep a single ASL WITHOUT WriteBack as the committed file, and inject the WriteBack states only when `local.rwb` via a Terraform `jsondecode`/`merge`:
```hcl
locals {
  rwb = var.rca_writeback_enabled ? 1 : 0
  # Base ASL (no WriteBack). When rwb is on, splice the WriteBack+WriteBackSkipped states in and
  # repoint RootCause.Next. Keeps the OFF graph byte-identical to the ADR-032 GREEN machine.
  incident_asl_base = jsondecode(templatefile("${local.inc_src}/incident.asl.json", {
    triage_fn_arn = aws_lambda_function.incident_triage[0].arn
    lead_fn_arn = aws_lambda_function.incident_lead[0].arn
    subagent_fn_arn = aws_lambda_function.incident_subagent[0].arn
    rootcause_fn_arn = aws_lambda_function.incident_rootcause[0].arn
    mitigation_fn_arn = aws_lambda_function.incident_mitigation_plan[0].arn
    prevention_fn_arn = aws_lambda_function.incident_prevention[0].arn
    incident_stage_failed_fn_arn = aws_lambda_function.incident_stage_failed[0].arn
    status_fn_arn = aws_lambda_function.status_updater[0].arn
  }))
  incident_asl = local.rwb == 1 ? merge(local.incident_asl_base, {
    States = merge(local.incident_asl_base.States, {
      RootCause = merge(local.incident_asl_base.States.RootCause, { Next = "WriteBack" })
      WriteBack = {
        Type = "Task", Resource = aws_lambda_function.incident_writeback[0].arn,
        TimeoutSeconds = 600, ResultPath = "$.writeback",
        Retry = [{ ErrorEquals = ["Lambda.ServiceException","Lambda.AWSLambdaException","Lambda.SdkClientException","Lambda.TooManyRequestsException"], IntervalSeconds = 2, MaxAttempts = 2, BackoffRate = 2.0 }],
        Catch = [{ ErrorEquals = ["States.ALL"], ResultPath = "$.writebackError", Next = "WriteBackSkipped" }],
        Next = "MitigationPlan"
      }
      WriteBackSkipped = { Type = "Pass", Next = "MitigationPlan" }
    })
  }) : local.incident_asl_base
}
```
  Then change the SM resource to `definition = jsonencode(local.incident_asl)`. **Keep the committed `incident.asl.json` WITHOUT the WriteBack states** (revert Step 1's edit to the file — the WriteBack states are spliced by TF only when `local.rwb`). This guarantees the OFF graph == the ADR-032 GREEN graph byte-for-byte (no behavior change when off). NOTE: this modifies the ADR-032 GREEN `incidents.tf` SM block — verify the ADR-032 incident smoke/tests still pass after refactor.
- [ ] **Step 3 (incidents.tf — package the new python + extend env + SM role):**
  - Add three `source { content = file("${local.inc_src}/writeback.py") ... }` (+ `writeback_render.py`, `slack_thread.py`) blocks to `data.archive_file.incident_src` AND `file("${local.rem_src}/remediation_executor.py")` so `writeback.py`'s `import remediation_executor` resolves. (Add `local.rem_src = "${path.module}/../../../scripts/v2/remediation"` if not present; `remediation_executor.py` only needs `db`, `action_catalog`, `boto3` — `action_catalog` must also be added to the archive, OR refactor the shared write fns into a small `obs_write.py` imported by both. **Chosen: extract `_opsitem_execute`/`_incident_enrich`/`_opsitem_resolve` into `scripts/v2/incident/obs_write.py`** so neither slice imports the other's full module — cleaner dependency. Update Task 3 Step 1 to put these fns in `obs_write.py` and have `remediation_executor.py` import them.)
  - Add the WriteBack env to `local.inc_env` via a merge: `merge(local.inc_env_base, var.rca_writeback_enabled ? { ACTION_ROLE_OPSCENTER_CREATE_OPSITEM = ..., ACTION_ROLE_INCIDENT_WRITE = ..., WRITEBACK_OPSCENTER_SOURCE = ..., WRITEBACK_RESPONSE_PLAN_MAP = ..., PUBLIC_BASE_URL = "https://${var.domain_name}" } : {})`.
  - Add `aws_lambda_function.incident_writeback` (count = `local.rwb`, handler `writeback.lambda_handler`, same role/layer/vpc/env as the other stage Lambdas).
  - Add `aws_lambda_function.incident_writeback[0].arn` to the SM role `InvokeIncidentLambdas` Resource list, gated: use `concat([...existing 8...], local.rwb == 1 ? [aws_lambda_function.incident_writeback[0].arn] : [])`.
  - Extend the incident-Lambda role policy (`aws_iam_role_policy.incident_lambda`) with a `local.rwb`-gated statement: `sts:AssumeRole` on `action_opscenter_write`+`action_incident_write` and `ssm-incidents:ListResponsePlans`/`GetResponsePlan` (routing read) + `ssm:GetParameter` on the writeback params. (Add via a separate `aws_iam_role_policy` resource `incident_lambda_writeback` `count = local.rwb` so the OFF policy is unchanged.)
- [ ] **Step 4 (writeback.tf — the new per-action IM role + SSM params):** Create:
```hcl
# terraform/foundation/writeback.tf
# AWSops v2 ADR-034 — RCA write-back. EVERY resource gated by var.rca_writeback_enabled
# (local.rwb; default false => count=0 => ZERO write-back infra, ZERO cost, ZERO OpsCenter/IM write).
# REUSES the 029/036 action_opscenter_write role (remediation.tf) for OpsItem writes; adds ONLY the
# Incident Manager per-action role + the write-back SSM config params. The WriteBack stage Lambda
# itself lives in incidents.tf (it ships in the incident_src archive). REQUIRES incident_lifecycle_enabled
# AND remediation_enabled (see variables.tf).
locals { rwb_acct = data.aws_caller_identity.current.account_id }

# Incident Manager per-action role (#1 per-action IAM, ssm-incidents:* enrich ONLY — NO ssm:* infra).
resource "aws_iam_role" "action_incident_write" {
  count = local.rwb
  name  = "${var.project}-action-incident-write"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow",
  Principal = { AWS = aws_iam_role.incident_lambda[0].arn }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy" "action_incident_write" {
  count = local.rwb
  name  = "${var.project}-action-incident-write"
  role  = aws_iam_role.action_incident_write[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["ssm-incidents:CreateTimelineEvent", "ssm-incidents:UpdateIncidentRecord",
      "ssm-incidents:GetIncidentRecord", "ssm-incidents:ListResponsePlans", "ssm-incidents:GetResponsePlan"],
    Resource = "*" }] })
}

# Write-back config params (operator-tunable; ignore drift). Live config; IAM/enable live in TF/catalog.
resource "aws_ssm_parameter" "writeback_opscenter_source" {
  count = local.rwb
  name  = "/ops/${var.project}/writeback/opscenter-source"
  type  = "String"  value = var.project
  lifecycle { ignore_changes = [value] }
}
resource "aws_ssm_parameter" "writeback_response_plan_map" {
  count = local.rwb
  name  = "/ops/${var.project}/writeback/response-plan-map"
  description = "ADR-034 routing: JSON map {trigger_source -> incidentRecordArn}. Empty {} => always OpsCenter."
  type  = "String"  value = "{}"
  lifecycle { ignore_changes = [value] }
}
resource "aws_ssm_parameter" "writeback_slack_enabled" {
  count = local.rwb
  name  = "/ops/${var.project}/writeback/slack/enabled"
  type  = "String"  value = "false"
  lifecycle { ignore_changes = [value] }
}

output "writeback_incident_write_role_arn" { value = one(aws_iam_role.action_incident_write[*].arn) }
```
- [ ] **Step 5:** `terraform -chdir=terraform/foundation validate`. (Apply/No-changes proof is the CONTROLLER task.)

---

### Task 5: Always-on marker-drop in the webhook ingress + normalize helper

**Files:** Modify `web/lib/incident-normalize.ts`; Modify `web/app/api/incidents/webhook/route.ts`; Modify `web/lib/incident.ts`

Read `incident-normalize.ts` (the `AlertEvent` shape + `isolatePayload`) and `webhook/route.ts` (step 6 normalize → step 7 triage).

- [ ] **Step 1 (normalize — the marker predicate, pure):** In `incident-normalize.ts` add:
```ts
// --- ADR-034 feedback-loop breaker: detect AWSops's own write-backs ---
// Every write-back is stamped CreatedBy=AWSops-AIOps (OpsItem OperationalData/tag) or source=AWSops-AIOps
// (Incident Manager). The webhook ingress drops any inbound event bearing this marker so our own
// observability write can never re-trigger an RCA. ALWAYS-ON (harmless when nothing writes back).
export const SELF_WRITEBACK_MARKER = { key: 'CreatedBy', value: 'AWSops-AIOps' } as const;

export function bearsSelfWritebackMarker(event: AlertEvent): boolean {
  const v = SELF_WRITEBACK_MARKER.value;
  const inMap = (m?: Record<string, string>) =>
    !!m && (m[SELF_WRITEBACK_MARKER.key] === v || m.source === v || m['/aws/AWSops'] === v);
  return inMap(event.labels) || inMap(event.annotations) ||
    (typeof (event.rawPayload as Record<string, unknown>)?.source === 'string' &&
     (event.rawPayload as Record<string, string>).source === v);
}
```
- [ ] **Step 2 (webhook — ALWAYS-ON drop, before triage):** In `webhook/route.ts` step 7, immediately after `normalizeAlert(...)` returns `alerts` and before the triage loop, add:
```ts
  // ADR-034 feedback-loop breaker (ALWAYS-ON, independent of rca_writeback_enabled). Drop any event
  // that carries AWSops's own write-back marker so an OpsItem/IM enrichment can never re-trigger RCA.
  // Accepted-and-ignored (200) so the source does not retry. Harmless when nothing writes back.
  const live = alerts.filter((a) => !bearsSelfWritebackMarker(a));
  const droppedSelf = alerts.length - live.length;
  if (live.length === 0) {
    return NextResponse.json({ status: 'dropped_self_writeback', dropped: droppedSelf }, { status: 200 });
  }
```
  and change the triage loop to iterate `live` instead of `alerts`; add `droppedSelfWriteback: droppedSelf` to the final 202 JSON. Add `bearsSelfWritebackMarker` to the import from `@/lib/incident-normalize`.
- [ ] **Step 3 (incident.ts — surface write-back status in the detail read):** In `getIncident`, add `writeback_status` to the incidents SELECT, and add a `incident_writeback` query (`SELECT target_system, status, source_object_id, rca_version, slack_thread_ts, created_at FROM incident_writeback WHERE incident_id=$1 ORDER BY id`) returned as `writeback`. Degrade-safe (returns `[]` when the table/flag is absent). Read-only; no write path in web (the write is in the SM Lambda).

---

### Task 6: Tests (vitest + python) — marker-drop + best-effort-non-blocking are highest-value

**Files:** Create `scripts/v2/incident/test_writeback.py`; Modify `web/lib/incident-normalize.test.ts`; Modify `web/app/api/incidents/webhook/route.test.ts`

Read `scripts/v2/incident/test_incident.py` (the `ast.parse`-compile + stubbed-`db`/`boto3` unit-test idiom) and the existing `web/app/api/incidents/webhook/route.test.ts` for the mock conventions.

- [ ] **Step 1 (python — `test_writeback.py`):** Cover, with `db`/`boto3`/`obs_write` stubbed:
  - `ast.parse` compiles `writeback.py`, `writeback_render.py`, `slack_thread.py`, `obs_write.py`.
  - **`sanitize_writeback_body`**: drops `rca=None`; drops the `"analysis unavailable (...)"` fallback (the output sanity-check — HIGH VALUE, prompt-injection-into-content); drops bad category/confidence; passes a valid RCA.
  - **`build_recommendation_body`**: always contains "recommendation" and never the literal "confirmed root cause"; defangs markup/instruction phrasing in `root_cause`/`markdown`; length-bounded ≤ `_DESC_CAP`; includes confidence, RCA_VERSION, evidence URL.
  - **`route_decision`**: matched response-plan ARN → `incident_manager`; none → `opscenter`.
  - **`dedup_key`** deterministic per incident.
  - **best-effort non-blocking (HIGH VALUE):** stub `obs_write._opsitem_execute` to raise → `lambda_handler` returns `{writeback:'failed'}` and does **NOT** raise; assert `_record` was called with `status='failed'`; assert the function returns normally (no exception propagates → the SM proceeds).
  - **idempotency #6:** a dedup row already `succeeded` → `lambda_handler` returns `already-done` and performs NO write.
  - **dry-run #2:** `phase='dry_run'` → `status='rendered'`, NO `_opsitem_execute`/`_incident_enrich` call.
  - **marker stamping:** `obs_write._opsitem_execute` passes `Tags`/`OperationalData` with `CreatedBy=AWSops-AIOps` (assert via a captured-kwargs ssm stub).
  - **Slack best-effort:** `post_best_effort` with slack disabled (SSM stub returns not-`'true'`) → returns `prior_thread_ts`, makes NO HTTP call; never raises on urlopen error.
- [ ] **Step 2 (vitest — `incident-normalize.test.ts`):** add `bearsSelfWritebackMarker` cases — marker in `labels.CreatedBy`, in `annotations.source`, in `rawPayload.source` → true; absent → false; wrong value → false.
- [ ] **Step 3 (vitest — `webhook/route.test.ts`):** add — a single marked alert (`labels.CreatedBy='AWSops-AIOps'`) → response `200 {status:'dropped_self_writeback'}` and `triageAndCreateOrLink` is NOT called (mock asserts 0 calls); a mixed batch (one marked, one clean) → only the clean one is triaged (`droppedSelfWriteback: 1`); an all-clean batch → unchanged existing behavior. (Set `INCIDENT_LIFECYCLE_ENABLED='true'` in the test env so the route gets past the flag check — the marker-drop is independent of `rca_writeback_enabled`.)
- [ ] **Step 4:** Run `cd web && npx vitest run lib/incident-normalize.test.ts app/api/incidents/webhook` and `python3 -m pytest scripts/v2/incident/test_writeback.py -q`. All green.

---

### Task 7: CONTROLLER — prove No-changes-when-off, apply migration v6, verify no write + marker-drop

**Files:** none (controller-run verification; no code changes)

> Run by the controller (long applies + in-VPC psql + AWS verification are not subagent-safe). Do NOT `-auto-approve` shared infra; use a saved plan.

- [ ] **Step 1 (No-changes proof, flag OFF — the $0/no-write gate):** With `rca_writeback_enabled=false` (default) in `terraform.tfvars`:
```bash
terraform -chdir=terraform/foundation init -backend-config=backend.hcl
terraform -chdir=terraform/foundation validate
terraform -chdir=terraform/foundation plan -out tfplan
# EXPECT: "No changes." for ALL gated infra — aws_iam_role.action_incident_write[0], the
# writeback SSM params, aws_lambda_function.incident_writeback[0], the local.rwb-gated incident
# role policy/env/SM-role-resource. local.rwb=0 => count=0 => nothing to add. The ASL-splice local
# must render IDENTICALLY to the committed ADR-032 GREEN machine when rwb=0 (verify the planned
# aws_sfn_state_machine.incident definition is byte-unchanged — a key check of the Task-4 refactor).
```
  If the incident SM shows a diff when off, the Task-4 ASL-splice is wrong — fix until OFF = byte-identical to the ADR-032 GREEN definition.
- [ ] **Step 2 (apply migration v6 via in-VPC psql):** Run the `psql` command from "How schema.sql is applied" above against the live Aurora endpoint with the RDS-managed master secret. Then:
```sql
SELECT version FROM schema_migrations ORDER BY version;   -- includes 6
\d incident_writeback                                       -- table exists, dedup_key UNIQUE
SELECT column_name FROM information_schema.columns
  WHERE table_name='incidents' AND column_name='writeback_status';  -- present
```
  Migration v6 is harmless when off (empty table + nullable column).
- [ ] **Step 3 (verify NO write happens when off + the marker-drop works):**
  - **No write when off:** confirm `aws ssm get-ops-summary` / OpsCenter shows no `CreatedBy=AWSops-AIOps` OpsItem created (none can be: the catalog row `opscenter-create-opsitem` is `enabled=false`, the mutating kill-switch is off, `rca_writeback_enabled=false` so the WriteBack Lambda does not exist and the SM splice is absent). Confirm `aws lambda get-function --function-name awsops-v2-incident-writeback` returns **ResourceNotFound** (the Lambda is not provisioned when off).
  - **Marker-drop (ALWAYS-ON) works:** POST a correctly-HMAC-signed test alert carrying `labels.CreatedBy=AWSops-AIOps` to `/api/incidents/webhook` with `INCIDENT_LIFECYCLE_ENABLED=true` — EXPECT `200 {status:'dropped_self_writeback'}` and NO new `incidents` row (the marker-drop fires before triage, independent of `rca_writeback_enabled`). POST an unmarked alert → normal accept/triage. This proves the feedback-loop breaker is live even with write-back off.
- [ ] **Step 4 (run the full suites):** `cd web && npx vitest run` (no regressions in the incident/webhook tests) + `python3 -m pytest scripts/v2/incident -q` (incident + writeback green). Confirm the ADR-032 incident SM tests still pass after the Task-4 SM-block refactor.

---

## Self-Review

**Observability-write control subset mapped to tasks (ADR-034 Addendum — NOT the full ADR-029 six):**
- **#1 per-action IAM** (scoped to `ssm:CreateOpsItem` + `ssm-incidents:*` ONLY): Task 4 Step 4 (`action_incident_write` = `ssm-incidents:*` enrich only) + reuse of `action_opscenter_write` (`ssm:CreateOpsItem` only, remediation.tf) via `_assume(ACTION_ROLE_…)` in `writeback.py` (Task 3). No broad `ssm:*` / no infra actions.
- **#3 admin gate, single-operator — NO 4-eyes:** Out-of-scope section forbids a Change Manager template / second approver on the write-back path; the WriteBack stage runs autonomously inside the incident SM (NOT the human-gated `/api/actions` execute path) — justified in the Reuse decision (the `/api/actions` 4-eyes is exactly what 034 #3 waives).
- **#5 audit:** Task 1 (`incident_writeback` rows: target, source_object_id, rca_version, status, detail) + the existing `remediation_audit` if the write rides the executor; Task 3 `_record` writes the audit row on every outcome.
- **#6 idempotency (dedup key):** Task 2 `dedup_key` + Task 1 `incident_writeback.dedup_key UNIQUE` + Task 3 `INSERT … ON CONFLICT (dedup_key)` + the `already-done` short-circuit; tested in Task 6 Step 1.
- **#2 dry-run = render the body (no mutation sim):** Task 3 `phase=='dry_run'` → `status='rendered'`, body captured into `incident_writeback.detail`, NO AWS call; tested Task 6.
- **#4 rollback = resolve/annotate the OpsItem (no infra revert):** Task 3 `_opsitem_resolve` (`update_ops_item Status=Resolved`) exposed via `phase='rollback'`; the catalog `rb` slot is wired (no infra revert).

**Other ADR-034 bindings mapped:**
- **Feedback-loop breaker (concrete mechanism):** marker stamp on write (Task 3 `_opsitem_execute`/`_incident_enrich` — `OperationalData`+`Tag CreatedBy=AWSops-AIOps` / IM `eventData`); ALWAYS-ON ingress drop (Task 5 `bearsSelfWritebackMarker` + the webhook filter); circuit-breaker = marker-filter PLUS the existing max-concurrent cap (documented in Key contracts — reuses `incidents.max-concurrent-investigations`, no new cap). Tested Task 6 Steps 2–3. Verified live in CONTROLLER Step 3.
- **Best-effort, non-blocking:** Task 3 `writeback.py` catches every AWS/Slack failure and records `failed` WITHOUT raising; Task 4 ASL `WriteBack` Catch → `WriteBackSkipped` Pass → `MitigationPlan` (a separate branch — never `StageFailed`, never blocks the primary path). Tested Task 6 Step 1 (raise-stub → returns, no propagation).
- **Routing (OpsCenter vs Incident Manager):** Task 2 `route_decision` + Task 3 `_route` (response-plan-map / `ListResponsePlans`); IM enrich vs OpsItem create. Tested Task 6 Step 1.
- **Recommendation-only labelling:** Task 2 `build_recommendation_body` ("AWSops recommendation (NOT a confirmed root cause)" + confidence + evidence + timestamp + data sources + RCA_VERSION + agent_space_version). Tested Task 6 (asserts "recommendation" present, "confirmed root cause" absent).
- **Prompt-injection into RCA content:** no model re-run (consumes persisted RCA); `sanitize_writeback_body` drops fallback/invalid RCA; `defang` + length-bound on the embedded markdown. Tested Task 6 Step 1.
- **Slack persistent thread (best-effort secondary):** Task 3 `slack_thread.post_best_effort` (PORTED from v1 `sendSlackResolvedUpdate`/`thread_ts`; reuses `incident_writeback.slack_thread_ts`); gated behind the SSM `writeback/slack/enabled` toggle (creds); no-op when unconfigured; never raises.

**Placeholder scan:** All HCL/SQL/TS/Python in Tasks 1–5 is concrete — the migration v6 DDL, the `bearsSelfWritebackMarker` predicate + the webhook filter, the `route_decision`/`_route` routing, the best-effort try/except branch in `writeback.py`, the marker-stamped `_opsitem_execute`, and the recommendation-only `build_recommendation_body` are written out in full, no `...`/TODO. (The one explicitly-flagged design choice — extracting `_opsitem_execute`/`_incident_enrich`/`_opsitem_resolve` into a shared `obs_write.py` so neither slice imports the other's full module — is called out in Task 4 Step 3 and Task 6 Step 1.)

**Flag-off ⇒ no write + $0 confirmation:** `rca_writeback_enabled=false` (default) ⇒ `local.rwb=0` ⇒ `count=0` on every gated resource (the `action_incident_write` role, the writeback SSM params, `aws_lambda_function.incident_writeback`, the gated incident-role policy/env, the SM-role Resource entry) ⇒ `terraform plan` = No changes (CONTROLLER Step 1), $0. The WriteBack Lambda is NOT provisioned (CONTROLLER Step 3 asserts ResourceNotFound) and the SM splice is absent (the ASL renders byte-identical to the ADR-032 GREEN machine), so **ZERO OpsCenter/Incident-Manager write can happen**. The `opscenter-create-opsitem` catalog row stays `enabled=false` and the mutating kill-switch stays off (defense in depth). Migration v6 only adds an empty table + a nullable column (harmless). The ONE always-on piece — the webhook marker-drop — is a pure safety filter that simply never matches when nothing writes back (CONTROLLER Step 3 proves it still fires with write-back off).
