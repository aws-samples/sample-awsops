# ADR-029+036 Remediation Substrate (v2, flag-gated) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is the **v2-native** plan — it targets `terraform/foundation/` + `scripts/v2/` + `web/` + Aurora, NOT v1 `src/`/`data/config.json`. Do **NOT** touch v1 `src/`. **This is the first time AWSops could mutate customer infra — build the FULL substrate but ship it OFF: `remediation_enabled=false` (default) ⇒ `terraform plan` = No changes, $0, ZERO live AWS mutation. Nothing mutates AWS until an operator flips the flag AND approves an action.**

**Goal:** Build the complete ADR-029 (six controls) + ADR-036 (hybrid SSM/Change-Manager × P2-code execution) remediation substrate **as a gated skeleton**, mirroring exactly how `workers_enabled` gates `workers.tf` (`local.we = var.workers_enabled ? 1 : 0`, every resource `count = local.we`). The catalog/approval/audit *data tables* are always-present and harmless (idempotent migration v4, all rows `enabled=false`); every *piece of live AWS infrastructure* (SSM runbook, Change template, AutomationAssumeRole, per-action task roles, audit bucket, kill-switch param, EventBridge resume rule, resume Lambda, the remediation SFN) is `remediation_enabled`-gated. Plan→execute flows extend the **existing P2 ledger** (`worker_jobs`), never duplicate it.

**Architecture (v2):** This **extends P2, it does not fork it.** P2 (`worker_jobs` Aurora ledger + SQS + dispatcher + Step Functions + reaper) stays the single mutation control-plane and ledger (ADR-036 Decision rule 1: no mutating path starts an executor outside `POST /api/jobs` → `worker_jobs`). On top of it we add: (a) an always-present **Action Catalog** (`action_catalog`) + **action plans** (`action_plans`) + **audit** (`remediation_audit`) in Aurora — the typed facade binding `executor_type ∈ {ssm,lambda,fargate}`, target role, approval mode, dry-run contract, paired rollback, and account/region/resource conditions per ADR-036 Decision rule 2; (b) a **sibling remediation Step Functions** state machine (justified below — *not* the workers SFN) adding dry-run-first → approval Task-Token wait (fail-closed) → an `$.runtime` **SSM branch** (`aws-sdk:ssm:startAutomationExecution`, request-response + `.waitForTaskToken` resumed by an EventBridge rule on SSM Automation `status-change`) alongside lambda/fargate code branches → Catch → rollback → terminal `MANUAL_INTERVENTION_REQUIRED`; (c) the gated AWS-resource executor (SSM Automation doc + Change Manager template + per-runbook `AutomationAssumeRole`), the gated P2-code executor (per-action task role, NOT the shared worker role), the gated S3 Object-Lock audit bucket, the gated kill-switch SSM param, and `ALLOW_CROSS_ACCOUNT_MUTATION`. **`remediation_enabled=false` ⇒ all of (b)+(c) have `count=0` ⇒ `plan` = No changes ⇒ $0.** The data tables in (a) cost nothing and execute nothing.

**Tech Stack:** Terraform (`terraform/foundation/`, partial S3 backend, provider `~>6.0`, every resource `count`/`for_each`-gated on `local.re`); Aurora PostgreSQL 17.9 via node-pg (`web/lib/db.ts` `getPool()`) for the web side and pg8000 (`scripts/v2/workers/db.py`) for the executors; Python 3.12 arm64 Lambda + Fargate (CMD, never ENTRYPOINT); Step Functions Standard ASL; Next.js 14 App Router (TS, `web/`, root path — no basePath); vitest for web, `ast.parse` + unit tests for Python. Admin gate reuses `web/lib/admin.ts` `isAdmin` (ADR-031) + `web/lib/auth.ts` `verifyUser`.

**Key contracts (do not break):**
- **P2 single front-door + ledger (ADR-036 rule 1):** `web/app/api/jobs/route.ts` `POST` writes a `worker_jobs` row (`status='queued'`, `idempotency_key` ON CONFLICT) then `SendMessage` to `JOBS_QUEUE_URL`; the remediation `execute` step **enqueues into this same ledger/queue** (a `worker_jobs` row + SQS message), it does not start any SFN/SSM directly.
- **Dispatcher idempotency:** `scripts/v2/workers/dispatcher.py` starts ONE SFN execution per message, `name == job_id`, `ExecutionAlreadyExists` = success. It reads `handlers.is_allowed(type_)` + `handlers.runtime_for(type_)` to build the SFN input `{job_id,type,payload,dry_run,runtime}`. The remediation path adds an **`action`** type family routed by the catalog (Task 6) — the dispatcher resolves the catalog entry → `runtime = executor_type` and starts the **remediation** state machine (selected by the catalog), NOT the workers SM.
- **`worker_jobs` lifecycle:** `db.py` `claim_running` (queued|running → running, terminal-immutable), `finish_job` (→ succeeded|failed|canceled, terminal-immutable), `get_job`. Status set in CHECK: `('queued','running','succeeded','failed','canceled')`. Migration v4 **adds** `'awaiting_approval'` and `'manual_intervention'` to this CHECK and adds remediation columns; it does NOT rename existing columns.
- **SFN `$.runtime` Choice:** `scripts/v2/workers/sfn.asl.json` routes `lambda`→RunLambda, `fargate`→FargateRoute, else→UnknownRuntime→MarkFailed (status_updater sets `failed`; SFN cannot write VPC Aurora). The remediation SM (`scripts/v2/remediation/remediation.asl.json`) is a **separate** ASL with its own Choice that adds the `ssm` branch and the approval/dry-run/rollback states, reusing `status_updater` for terminal failures.
- **Workers gating idiom (mirror exactly):** `terraform/foundation/workers.tf` `local.we = var.workers_enabled ? 1 : 0`; every resource `count = local.we`; outputs use `one(aws_*.x[*].attr)`; web env added via `concat([...base], var.workers_enabled ? [..] : [])` so `false` ⇒ byte-identical task def. The new `remediation.tf` uses `local.re = var.remediation_enabled ? 1 : 0` identically.
- **Admin gate (ADR-031, reuse verbatim):** `web/lib/admin.ts` `isAdmin(user)` — `cognito:groups ∋ ADMIN_GROUP` OR email ∈ SSM allowlist (`SSM_ADMIN_EMAILS_PARAM`), fail-closed. `web/lib/auth.ts` `verifyUser(cookie)` → `{sub,email?,groups?}` or null.
- **Aurora data-layer style (ADR-031, reuse):** `web/lib/catalog.ts` `getPool().query(sql, params)`, `writeAudit(...)`, `computeSkillHash(...)`. The remediation web lib mirrors this (`web/lib/remediation.ts`). Gate on `process.env.AURORA_ENDPOINT` (there is NO `isAuroraEnabled()` in v2).
- **Schema file shape:** `terraform/foundation/data/schema.sql` is one idempotent file: a `BEGIN;…COMMIT;` block (migration v1) then post-COMMIT `CREATE TABLE IF NOT EXISTS` blocks (P2 `worker_jobs`, D1 inventory, ADR-031 v2, ADR-033 v3, each ending `INSERT INTO schema_migrations VALUES (N,…) ON CONFLICT DO NOTHING`). Migration **v4** is a new post-COMMIT idempotent block following the ADR-031 block style.
- **Container rules:** all images arm64 (`buildx --platform linux/arm64`); Fargate executor Dockerfile uses **CMD not ENTRYPOINT** (SFN `containerOverrides.command` replaces CMD but doubles an exec-form ENTRYPOINT → argparse dies). The P2-code executor Fargate path reuses the existing worker image build (`scripts/v2/workers/Dockerfile` already CMD) — the remediation executor module is added to that image.
- **SSM reserved prefix:** ops params live under `/ops/${var.project}/…` (a leading `aws…` component is rejected). Kill-switch = `/ops/awsops-v2/mutating-actions/enabled`.

---

## How schema.sql is applied in v2 (discovered)

Aurora has **no migration Lambda** in v2. `terraform/foundation/data/schema.sql` is applied by **`psql` from an in-VPC deploy host** (the controller's box, inside `mgmt-vpc`). The file is **idempotent** (`CREATE TABLE IF NOT EXISTS` throughout) and tracked by `schema_migrations`. So "apply the migration" = the controller runs `psql` against the cluster endpoint with the RDS-managed master secret. Migration v4 is harmless when `remediation_enabled=false` (it only creates empty tables + seeds disabled catalog rows — no infra, no execution).

The exact apply command (controller, final task):
```bash
PGPASSWORD="$(aws secretsmanager get-secret-value \
  --secret-id "$(terraform -chdir=terraform/foundation output -raw aurora_secret_arn)" \
  --query SecretString --output text | python3 -c 'import sys,json;print(json.load(sys.stdin)["password"])')" \
psql -v ON_ERROR_STOP=1 \
  "host=$(terraform -chdir=terraform/foundation output -raw aurora_endpoint) port=5432 dbname=awsops user=awsops_admin sslmode=require" \
  -f terraform/foundation/data/schema.sql
# verify: SELECT version FROM schema_migrations;  -> includes 4
```

---

## Decision: sibling remediation SFN vs extend the workers SFN

**Decision: add a SIBLING `awsops-v2-remediation` state machine; reuse everything else (P2 ledger, dispatcher, SQS, status_updater, reaper).**

Why sibling, not extend `awsops-v2-workers`:
1. **$0-when-off is structurally clean.** The workers SM is `workers_enabled`-gated and is GREEN/in-use; folding approval-wait + SSM `.waitForTaskToken` + rollback states into it would either (a) change the live workers SM definition (risking the GREEN P2 path and breaking its tests) or (b) require `templatefile` conditionals that still render those states when `workers_enabled=true && remediation_enabled=false`. A separate ASL file rendered by a `remediation_enabled`-gated `aws_sfn_state_machine` resource means **No-changes-when-off is trivially provable** (count=0).
2. **Different IAM surface.** The remediation SM role needs `ssm:StartAutomationExecution`, `ssm:GetAutomationExecution`, `states:SendTaskSuccess/Failure` (via the resume Lambda), and `iam:PassRole` for the per-action task roles + AutomationAssumeRole — a strictly larger, more dangerous role than the workers SM role. Keeping it on a separate role bounds blast radius and keeps the workers role minimal (Terraform discipline: least privilege per machine).
3. **Different failure semantics.** Workers terminal = succeeded|failed. Remediation adds `awaiting_approval` and the terminal `manual_intervention` (rollback failed → MANUAL_INTERVENTION_REQUIRED, never infinite retry — ADR-029 control 5 / ADR-036 addendum). A separate SM keeps these state graphs independent and independently monitored (separate vended-logs group).

What is **reused** (no duplication — ADR-036 rule 1): the `worker_jobs` Aurora ledger, the `idempotency = execution-name == job_id` invariant, the dispatcher (extended to resolve the catalog and pick the SM), the SQS queue + ESM kill-switch, `status_updater` (Catch → failed), and the reaper (extended to reconcile `awaiting_approval`/`running` remediation rows with an `AutomationExecutionId`). The remediation SM is the only new orchestration resource, and it is fully gated.

---

## File map

**Create (Terraform):**
- `terraform/foundation/remediation.tf` — ALL `remediation_enabled`-gated infra: SSM Automation document (Git→SSM sync of `scripts/v2/remediation/runbooks/ec2-create-tags.yaml`), Change Manager change template (`AutoApprove=false`, approvers exclude the AWSops principal), per-runbook `AutomationAssumeRole` (scoped), per-action P2 task role(s), remediation SFN (`remediation.asl.json`), the EventBridge rule on SSM Automation `status-change` → `status_resume` Lambda (SendTaskSuccess/Failure), the S3 Object-Lock audit bucket (governance, 1yr), the kill-switch SSM param `/ops/awsops-v2/mutating-actions/enabled` (default `false`, ignore_changes on value), `ALLOW_CROSS_ACCOUNT_MUTATION` SSM param, CloudWatch log groups, IAM. Outputs `one(…)`-wrapped.

**Create (Python — `scripts/v2/remediation/`):**
- `action_catalog.py` — catalog loader (reads `action_catalog` via `db.py`-style pg8000) → resolves `name → {executor_type, runbook, assume_role_arn, task_role_arn, approval_mode, dry_run_contract, rollback_ref, conditions, enabled}`; enforces `enabled` + kill-switch + flag gates.
- `ssm_bridge.py` — dispatcher-path helper: given a resolved `ssm` action, builds the `StartAutomationExecution` parameters (DocumentName, `AutomationAssumeRole`, `TargetLocations` only if cross-account allowed); used by the SFN `ssm` branch via an inline Lambda task that records the `AutomationExecutionId` into `worker_jobs` immediately.
- `remediation_executor.py` — P2-code executor skeleton for the example app-state action (`dry_run`/`execute`/`rollback`), assumes its **per-action task role** (not the shared worker role), terminal-immutable writes via `db.py`.
- `status_resume.py` — EventBridge SSM Automation `status-change` handler → `SendTaskSuccess`/`SendTaskFailure` on the stored task token; poll `getAutomationExecution` fallback.
- `record_ssm_start.py` — tiny Lambda the SFN `ssm` branch calls to (1) start the automation, (2) persist `AutomationExecutionId` + the SFN task token into `worker_jobs`, returning so the SM enters `.waitForTaskToken`.
- `runbooks/ec2-create-tags.yaml` — the example SSM Automation document body (AWS-resource action; `aws:executeAwsApi` ec2 CreateTags + a Describe-based dry-run + `onFailure` delete-tags rollback step).
- `requirements.txt` — `pg8000==1.31.2`, `boto3>=1.34` (matches workers).
- Tests: `scripts/v2/remediation/test_remediation.py` (ast.parse compile + unit tests for catalog gating, executor dry-run/rollback, status_resume token routing).

**Create (web):**
- `web/lib/remediation.ts` — Aurora data layer: `listCatalog()`, `getAction(name)`, `createPlan(...)` (dry-run + idempotency token + paired rollback + 5-min expiry, NO mutation), `getPlan(id)`, `recordAudit(...)`, `setPlanApproved(...)`, status helpers. Gated on `process.env.AURORA_ENDPOINT`.
- `web/app/api/actions/route.ts` — `GET` catalog (admin-gated) + `POST` create-plan (admin-gated via `isAdmin`).
- `web/app/api/actions/[id]/route.ts` — `GET` plan status; `POST` `{op:'execute'|'cancel'}` — execute requires a DIFFERENT approver admin email (4-eyes) + kill-switch + flag checks, then enqueues into `worker_jobs`+SQS; cancel marks the plan canceled.
- Tests: `web/lib/remediation.test.ts`, `web/app/api/actions/route.test.ts`, `web/app/api/actions/[id]/route.test.ts`.

**Modify:**
- `terraform/foundation/variables.tf` — add `variable "remediation_enabled" { default = false }` (+ `remediation_image_tag` unused-now but reserved? No — reuse worker image; do not add).
- `terraform/foundation/data/schema.sql` — append migration v4 block (3 tables + status CHECK widen + remediation columns on `worker_jobs` + 3 seed rows, all `enabled=false`) + `schema_migrations` v4.
- `terraform/foundation/workload.tf` — add `REMEDIATION_ENABLED`, `MUTATING_ACTIONS_SSM` env to the web container via `concat(..., var.remediation_enabled ? [..] : [])` (byte-identical when off); add a `remediation_enabled`-gated web-task-role policy to read the kill-switch param.
- `scripts/v2/workers/dispatcher.py` — catalog-aware: for `type` in the catalog with `executor_type`, set `runtime = executor_type` and start the **remediation** SM (env `REMEDIATION_STATE_MACHINE_ARN`); else the existing P2 behavior is unchanged. Backward compatible (noop/noop-heavy untouched).
- `scripts/v2/workers/handlers.py` — keep as-is; the remediation executor registry lives in `action_catalog.py` (separate import). (No mutation handlers added to the read-only P2 registry.)
- `scripts/v2/workers/reaper.py` — reconcile remediation rows: `running`/`awaiting_approval` rows with an `automation_execution_id` older than `RUNNING_STALE_MIN` → `failed` (only when not driven by a live SSM execution; poll fallback), never reap `manual_intervention`.
- `scripts/v2/workers/Dockerfile` — `COPY` the remediation executor modules into the worker image so the Fargate code-executor path can run them (still CMD).

---

## Out of scope (state explicitly — DO NOT implement; all later / operator-gated)
- **Enabling any live action.** Every seeded catalog row ships `enabled=false`; the kill-switch SSM param ships `false`; `remediation_enabled` ships `false`. Flipping any of these is an explicit operator action, NOT part of this plan.
- **Real customer-infra mutation / a real execution against live AWS.** This plan ships the substrate skeleton. The example actions are wired end-to-end in code but cannot run until flag + kill-switch + per-action `enabled` + 4-eyes approval all pass.
- **The full action fleet** (autoscaling, RDS modify, MSK, EBS, ALB modify, the ~10 ADR-010 Phase 3 actions, ADR-032 mitigation actions, ADR-034 OpsItem write-back). Only **2–3 example definitions** are seeded. New actions = new catalog rows + new runbooks/task roles in a later phase.
- **KEDA installation** — out-of-band setup (ADR-029 control 7); the runtime path only patches an EXISTING `ScaledObject`, and no KEDA action is seeded here.
- **Cross-account mutation ON.** `ALLOW_CROSS_ACCOUNT_MUTATION` ships `false`; `TargetLocations` wiring exists in `ssm_bridge.py` but is dormant until the toggle is lifted (a later ADR/operator action, per ADR-029 control 8 / ADR-036).
- **The right-dock chat "remediation suggestion" UI / one-click from alerts.** This plan adds `/api/actions/*` + a catalog read; the rich UI surface (P3/P4) is separate.
- **ADR-032/034 routing.** Their actions will route through this substrate later; this plan only proves the substrate with example actions.
- **Change calendars / maintenance windows** beyond the bare `AutoApprove=false` template (later hardening).

---

## Task 1: `remediation_enabled` variable + `local.re` skeleton in `remediation.tf`

**Files:**
- Modify: `terraform/foundation/variables.tf`
- Create: `terraform/foundation/remediation.tf` (header + locals only in this task)

- [ ] **Step 1: Add the gate variable** (mirror `workers_enabled` exactly).

```hcl
# terraform/foundation/variables.tf  (append after workers_enabled / worker_image_tag)
variable "remediation_enabled" {
  type        = bool
  description = "ADR-029+036 remediation/mutation substrate gate. false (default) = 0 mutating resources, 0 cost, ZERO live AWS mutation. The always-present catalog/plan/audit tables (migration v4) are harmless when off. Enable ONLY after the catalog + controls are reviewed AND an operator accepts the first mutating capability."
  default     = false
}
```

- [ ] **Step 2: Create `remediation.tf` header + locals** (the gating idiom, copied from `workers.tf`).

```hcl
# terraform/foundation/remediation.tf
# AWSops v2 ADR-029+036 — remediation / mutation execution substrate.
# EVERY resource here is gated by var.remediation_enabled (default false → count=0 → ZERO AWS
# resources, ZERO cost, ZERO live mutation). This EXTENDS the P2 backbone (workers.tf): it reuses
# the worker_jobs Aurora ledger, the SQS queue + dispatcher + status_updater + reaper, and the
# idempotency invariant (SFN execution name == job_id). It adds ONE sibling Step Functions machine
# (remediation), an SSM Automation/Change Manager AWS-resource executor, a per-action P2-code
# executor task role, an S3 Object-Lock audit bucket, an EventBridge SSM status-change resume
# Lambda, and the kill-switch SSM param. Nothing here mutates customer infra until an operator
# flips remediation_enabled, sets the kill-switch true, enables a catalog row, AND a 4-eyes
# approval passes. Design refs: ADR-029 (6 controls) + ADR-036 (hybrid substrate).
locals {
  re             = var.remediation_enabled ? 1 : 0
  rem_src        = "${path.module}/../../../scripts/v2/remediation"
  workers_src_re = "${path.module}/../../../scripts/v2/workers" # reuse db.py/status_updater
  rem_acct       = data.aws_caller_identity.current.account_id
}
```

- [ ] **Step 3: Verify No-changes when off.** `terraform -chdir=terraform/foundation plan` after this task (with `remediation_enabled=false`) must show **No changes** (the variable + locals + a guarded file add nothing while every resource is count=0; locals are inert). Record this in the commit message.

---

## Task 2: Aurora migration v4 — catalog / plans / audit tables (always-present, harmless)

**Files:**
- Modify: `terraform/foundation/data/schema.sql`
- Test: `scripts/v2/remediation/test_schema_v4.py` (a lightweight grep/sql-shape assertion; ast not applicable to SQL — assert idempotent markers + status values present)

**Decision:** These tables are **data, not infrastructure** — they cost nothing and execute nothing. They are always present so the web `plan` endpoint and the catalog UI work the moment the flag is flipped, and so the migration is decoupled from the gated infra. All seeded rows are `enabled=false`.

- [ ] **Step 1: Append the migration v4 block** (post-COMMIT, idempotent, ADR-031 block style).

```sql
-- ============================================================================
-- ADR-029+036 (migration v4): remediation/mutation substrate — catalog + plans + audit.
-- ALWAYS PRESENT (data only; zero infra, zero execution). Every catalog row ships
-- enabled=false; no action is executable until remediation_enabled + the kill-switch
-- + the row's enabled flag are all true AND a 4-eyes approval passes. Idempotent.
-- ============================================================================

-- 1) The typed Action Catalog — the single facade (ADR-029 control #1, ADR-036 rule #2).
CREATE TABLE IF NOT EXISTS action_catalog (
  name                TEXT PRIMARY KEY,
  description         TEXT NOT NULL DEFAULT '',
  executor_type       TEXT NOT NULL CHECK (executor_type IN ('ssm','lambda','fargate')),
  target_resource_type TEXT NOT NULL,                     -- e.g. 'ec2:instance', 'k8s:scaledobject'
  iam_actions         JSONB NOT NULL DEFAULT '[]'::jsonb, -- per-action IAM decomposition (doc only; real IAM is in TF)
  assume_role_ref     TEXT,                               -- SSM: AutomationAssumeRole logical name; lambda/fargate: task-role logical name
  required_inputs     JSONB NOT NULL DEFAULT '[]'::jsonb, -- e.g. ["resourceArn","tags"]
  dry_run_contract    JSONB NOT NULL DEFAULT '{}'::jsonb, -- {"mode":"native|describe|check","describe":"..."} (ADR-029 #3 / ADR-036 #2)
  rollback_ref        TEXT,                               -- runbook onFailure step name OR executor rollback fn id
  approval_mode       TEXT NOT NULL DEFAULT 'four_eyes'
                        CHECK (approval_mode IN ('four_eyes','change_manager')),
  conditions          JSONB NOT NULL DEFAULT '{}'::jsonb, -- {"accounts":["self"],"regions":["ap-northeast-2"],"resourceArns":[...]}
  enabled             BOOLEAN NOT NULL DEFAULT false,      -- HARD OFF by default
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2) Action plans — the two-step plan→execute artifact (ADR-029 control #2).
CREATE TABLE IF NOT EXISTS action_plans (
  plan_id            UUID PRIMARY KEY,
  action_name        TEXT NOT NULL REFERENCES action_catalog(name) ON DELETE RESTRICT,
  idempotency_token  TEXT NOT NULL UNIQUE,                -- replay-safe; 5-min expiry below
  inputs             JSONB NOT NULL DEFAULT '{}'::jsonb,
  dry_run            JSONB NOT NULL DEFAULT '{}'::jsonb,   -- the dry-run result captured at plan time
  rollback_plan      JSONB NOT NULL DEFAULT '{}'::jsonb,   -- paired, separately-validated rollback (ADR-029 #5)
  status             TEXT NOT NULL DEFAULT 'planned'
                        CHECK (status IN ('planned','approved','executing','succeeded','failed','canceled','expired')),
  created_by         TEXT NOT NULL,                        -- authenticated principal (admin email/sub)
  approved_by        TEXT,                                 -- MUST differ from created_by (4-eyes)
  job_id             UUID,                                 -- the worker_jobs row enqueued at execute time
  expires_at         TIMESTAMPTZ NOT NULL,                 -- created_at + 5 min
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_action_plans_status ON action_plans (status, expires_at);
CREATE INDEX IF NOT EXISTS idx_action_plans_action ON action_plans (action_name, created_at DESC);

-- 3) Synchronous authenticated-principal audit sink (ADR-029 control #6; the S3 Object-Lock
--    bucket is the second synchronous sink, CloudTrail is defense-in-depth, NOT a sync gate).
CREATE TABLE IF NOT EXISTS remediation_audit (
  id            BIGSERIAL PRIMARY KEY,
  plan_id       UUID,
  job_id        UUID,
  action_name   TEXT,
  phase         TEXT NOT NULL,        -- plan|approve|execute|dry_run|rollback|terminal
  principal     TEXT NOT NULL,        -- authenticated email/sub (NOT "the task role")
  decision      TEXT,                 -- approved|denied|expired|killswitch_blocked|flag_off
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
  at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rem_audit_plan ON remediation_audit (plan_id, at);
CREATE INDEX IF NOT EXISTS idx_rem_audit_at   ON remediation_audit (at DESC);

-- 4) Extend worker_jobs for the remediation lifecycle WITHOUT renaming anything (additive).
--    Widen the status CHECK to add awaiting_approval + manual_intervention.
ALTER TABLE worker_jobs ADD COLUMN IF NOT EXISTS automation_execution_id TEXT; -- SSM AutomationExecutionId
ALTER TABLE worker_jobs ADD COLUMN IF NOT EXISTS task_token             TEXT;  -- SFN .waitForTaskToken token (ssm branch)
ALTER TABLE worker_jobs ADD COLUMN IF NOT EXISTS plan_id                UUID;  -- link back to action_plans
DO $$ BEGIN
  ALTER TABLE worker_jobs DROP CONSTRAINT IF EXISTS worker_jobs_status_check;
  ALTER TABLE worker_jobs ADD CONSTRAINT worker_jobs_status_check
    CHECK (status IN ('queued','running','awaiting_approval','manual_intervention',
                      'succeeded','failed','canceled'));
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_action_catalog_touch') THEN
    CREATE TRIGGER trg_action_catalog_touch BEFORE UPDATE ON action_catalog
      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_action_plans_touch') THEN
    CREATE TRIGGER trg_action_plans_touch BEFORE UPDATE ON action_plans
      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
  END IF;
END $$;

-- 5) Seed 2-3 EXAMPLE action definitions — ALL enabled=false, ALL approval-required.
--    These are DEFINITIONS only; nothing runs until enabled + flag + kill-switch + approval.
INSERT INTO action_catalog
  (name, description, executor_type, target_resource_type, iam_actions, assume_role_ref,
   required_inputs, dry_run_contract, rollback_ref, approval_mode, conditions, enabled)
VALUES
  -- (a) AWS-resource action via SSM Automation + Change Manager (the canonical Modify* case).
  ('ec2-create-tags',
   'Add tags to a specific EC2 instance via an SSM Automation runbook (Change-Manager 4-eyes).',
   'ssm', 'ec2:instance',
   '["ec2:CreateTags","ec2:DeleteTags","ec2:DescribeTags"]'::jsonb,
   'ec2-create-tags',                                  -- AutomationAssumeRole logical name (remediation.tf)
   '["resourceArn","tags"]'::jsonb,
   '{"mode":"describe","describe":"ec2:DescribeTags"}'::jsonb,
   'RollbackDeleteTags',                               -- runbook onFailure step name
   'change_manager',
   '{"accounts":["self"],"regions":["ap-northeast-2"],"resourceArnAllowlist":[]}'::jsonb,
   false),
  -- (b) App-state action via the P2 lambda code executor (per-action task role).
  ('app-feature-flag-set',
   'Set an application feature flag row in Aurora (app-state mutation; P2 lambda executor).',
   'lambda', 'app:feature_flag',
   '[]'::jsonb,
   'app-feature-flag',                                 -- per-action task-role logical name (remediation.tf)
   '["flagKey","value"]'::jsonb,
   '{"mode":"check"}'::jsonb,
   'rollback_feature_flag',                            -- remediation_executor.py rollback fn id
   'four_eyes',
   '{"accounts":["self"]}'::jsonb,
   false),
  -- (c) Observability-write via the P2 lambda executor with the reduced control subset (ADR-036 #5).
  ('opscenter-create-opsitem',
   'Create an OpsCenter OpsItem (low-risk observability write; reduced control subset, no SSM runbook).',
   'lambda', 'ssm:opsitem',
   '["ssm:CreateOpsItem"]'::jsonb,
   'opscenter-write',
   '["title","source","severity"]'::jsonb,
   '{"mode":"check"}'::jsonb,
   NULL,                                               -- create is non-destructive; rollback = resolve (manual)
   'four_eyes',
   '{"accounts":["self"]}'::jsonb,
   false)
ON CONFLICT (name) DO NOTHING;

INSERT INTO schema_migrations (version, description)
VALUES (4, 'ADR-029+036: remediation substrate — action_catalog + action_plans + remediation_audit + worker_jobs cols (all disabled)')
ON CONFLICT (version) DO NOTHING;
```

- [ ] **Step 2: Test** `scripts/v2/remediation/test_schema_v4.py` — assert the migration block contains `version, description)\nVALUES (4`, that every seeded `VALUES` group ends with `false)`, that the status CHECK lists `'awaiting_approval'` and `'manual_intervention'`, and that all `CREATE TABLE` use `IF NOT EXISTS`. (Read the file, regex-assert; no DB needed.)

```python
# scripts/v2/remediation/test_schema_v4.py
import re, pathlib
SQL = pathlib.Path(__file__).parents[2].joinpath("terraform/foundation/data/schema.sql").read_text()
def test_migration_v4_present():
    assert re.search(r"VALUES \(4,\s*'ADR-029\+036", SQL)
def test_all_seeds_disabled():
    block = SQL[SQL.index("INSERT INTO action_catalog"):SQL.index("INSERT INTO schema_migrations (version, description)\nVALUES (4")]
    # every seeded action tuple must end its VALUES group with the enabled=false literal
    assert block.count("false)") >= 3 and "true)" not in block
def test_status_check_widened():
    assert "'awaiting_approval'" in SQL and "'manual_intervention'" in SQL
def test_tables_idempotent():
    for t in ("action_catalog","action_plans","remediation_audit"):
        assert re.search(rf"CREATE TABLE IF NOT EXISTS {t}", SQL)
```

---

## Task 3: Action catalog loader + gating (`scripts/v2/remediation/action_catalog.py`)

**Files:**
- Create: `scripts/v2/remediation/action_catalog.py`
- Create: `scripts/v2/remediation/requirements.txt`
- Test: `scripts/v2/remediation/test_remediation.py` (catalog section)

- [ ] **Step 1: requirements** — `pg8000==1.31.2` + `boto3>=1.34` (mirror workers).

- [ ] **Step 2: Loader + gate.** Reuse the pg8000 connection from the worker `db.py` (the remediation modules ship in the same Lambda layer/image, so `import db` works). Gating is **defense in depth**: flag (env), kill-switch (SSM), row `enabled`.

```python
# scripts/v2/remediation/action_catalog.py
"""ADR-029+036 — resolve a catalog action by name into an executor binding, and gate it.
Gating layers (ALL must pass before any mutation): (1) REMEDIATION_ENABLED env (the TF flag,
surfaced to the Lambda), (2) the SSM kill-switch /ops/awsops-v2/mutating-actions/enabled == true,
(3) the catalog row's enabled flag. Read-only here; execution lives in remediation_executor.py
and the SSM runbook. Reuses scripts/v2/workers/db.py for the pg8000 connection."""
import json
import os
import boto3
import db  # scripts/v2/workers/db.py (shipped in the same artifact)

_ssm = boto3.client("ssm", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))
_KILL_SWITCH = os.environ.get("MUTATING_ACTIONS_SSM", "/ops/awsops-v2/mutating-actions/enabled")

_COLS = ["name", "executor_type", "target_resource_type", "assume_role_ref",
         "required_inputs", "dry_run_contract", "rollback_ref", "approval_mode",
         "conditions", "enabled"]


def load_action(conn, name):
    rows = conn.run(
        f"SELECT {','.join(_COLS)} FROM action_catalog WHERE name=:n", n=name)
    if not rows:
        return None
    d = dict(zip(_COLS, rows[0]))
    for j in ("required_inputs", "dry_run_contract", "conditions"):
        if isinstance(d[j], str):
            d[j] = json.loads(d[j])
    return d


def flag_enabled():
    # The TF flag is surfaced as an env on every remediation Lambda; default OFF.
    return os.environ.get("REMEDIATION_ENABLED", "false").lower() == "true"


def killswitch_on():
    try:
        return _ssm.get_parameter(Name=_KILL_SWITCH)["Parameter"]["Value"].lower() == "true"
    except Exception:
        return False  # fail-closed: cannot confirm the switch is on → treat as off


def gate(conn, name):
    """Return (action_dict, reason). reason is None iff the action may execute."""
    if not flag_enabled():
        return None, "flag_off"
    if not killswitch_on():
        return None, "killswitch_off"
    a = load_action(conn, name)
    if a is None:
        return None, "unknown_action"
    if not a["enabled"]:
        return None, "action_disabled"
    return a, None
```

- [ ] **Step 3: Test** (in `test_remediation.py`) — `ast.parse` the module compiles; with a fake `conn`/monkeypatched `_ssm`, assert `gate` returns `flag_off` when env unset, `killswitch_off` when the param is `false`, `action_disabled` when the row `enabled=False`, and `(action, None)` only when all three pass.

---

## Task 4: P2-code executor skeleton (`remediation_executor.py`) — per-action role, dry-run/execute/rollback

**Files:**
- Create: `scripts/v2/remediation/remediation_executor.py`
- Test: `scripts/v2/remediation/test_remediation.py` (executor section)

**Decision:** The example app-state action (`app-feature-flag-set`) and the observability write (`opscenter-create-opsitem`) run on the **P2 lambda code executor**. Per ADR-036 addendum #3, each gets a **per-action task role** (Task 8 builds them); the executor assumes that role via STS at the start, so one action's executor cannot call another's APIs. Every action implements `dry_run` (no side effect), `execute`, and `rollback`. Terminal writes via `db.py` (terminal-immutable).

- [ ] **Step 1: Executor.**

```python
# scripts/v2/remediation/remediation_executor.py
"""ADR-029+036 — P2 'lambda'/'fargate' code executor for K8s/app-state/composite + observability
actions. Invoked by the remediation SFN's code branch. Input:
  {job_id, plan_id, action, payload, dry_run, phase}  phase ∈ {dry_run, execute, rollback}
Each action: dry_run/execute/rollback. Uses a PER-ACTION task role (NOT the shared worker role) —
the role ARN comes from the env ACTION_ROLE_<ACTION> set by the catalog-pinned Lambda alias, or
is assumed here when the executor runs the shared worker image. Terminal-immutable via db.py."""
import json
import os
import boto3
import db
import action_catalog as cat

_sts = boto3.client("sts", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))


def _assume(role_arn, session="awsops-remediation"):
    """Assume the per-action role; return a boto3 Session scoped to it (NOT the worker role)."""
    c = _sts.assume_role(RoleArn=role_arn, RoleSessionName=session)["Credentials"]
    return boto3.Session(
        aws_access_key_id=c["AccessKeyId"], aws_secret_access_key=c["SecretAccessKey"],
        aws_session_token=c["SessionToken"], region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))


# ---- example: app-state feature flag (Aurora row) ----
def _flag_dry_run(payload, _sess):
    return {"would_set": payload.get("flagKey"), "to": payload.get("value"), "mutates": False}

def _flag_execute(conn, payload, _sess):
    prev = conn.run("SELECT config FROM report_schedules WHERE user_sub='__feature_flags__' LIMIT 1") or [[{}]]
    conn.run("UPDATE feature_flags SET value=:v WHERE key=:k", k=payload["flagKey"], v=json.dumps(payload["value"]))
    return {"set": payload["flagKey"], "prev_captured": True}

def _flag_rollback(conn, rollback_plan, _sess):
    conn.run("UPDATE feature_flags SET value=:v WHERE key=:k",
             k=rollback_plan["flagKey"], v=json.dumps(rollback_plan["prev"]))
    return {"rolled_back": rollback_plan["flagKey"]}


# ---- example: observability write (reduced control subset, ADR-036 #5) ----
def _opsitem_dry_run(payload, _sess):
    return {"would_create_opsitem_title": payload.get("title"), "mutates": False}

def _opsitem_execute(_conn, payload, sess):
    ssm = sess.client("ssm")
    r = ssm.create_ops_item(Title=payload["title"], Source=payload["source"],
                            Severity=str(payload.get("severity", "3")), Description=payload.get("title"))
    return {"ops_item_id": r["OpsItemId"]}


_EXEC = {
    "app-feature-flag-set":     {"dry": _flag_dry_run,    "run": _flag_execute,   "rb": _flag_rollback},
    "opscenter-create-opsitem": {"dry": _opsitem_dry_run, "run": _opsitem_execute, "rb": None},
}


def lambda_handler(event, _ctx):
    job_id, action, phase = event["job_id"], event["action"], event.get("phase", "execute")
    payload, dry_run = event.get("payload", {}), bool(event.get("dry_run", False))
    conn = db.connect()
    try:
        a, reason = cat.gate(conn, action)
        if reason:
            # blocked by flag/kill-switch/disabled — record + fail closed (NO mutation)
            raise RuntimeError(f"blocked:{reason}")
        sess = _assume(os.environ[f"ACTION_ROLE_{action.upper().replace('-', '_')}"])
        fns = _EXEC[action]
        if phase == "dry_run" or dry_run:
            return {"job_id": job_id, "phase": "dry_run", "result": fns["dry"](payload, sess)}
        if phase == "rollback":
            if fns["rb"] is None:
                raise RuntimeError("MANUAL_INTERVENTION_REQUIRED: no rollback for action")
            res = fns["rb"](conn, event.get("rollback_plan", {}), sess)
            return {"job_id": job_id, "phase": "rollback", "result": res}
        if db.claim_running(conn, job_id, runtime="lambda") == 0:
            return {"job_id": job_id, "status": "skipped"}  # already terminal (C7)
        res = fns["run"](conn, payload, sess)
        db.finish_job(conn, job_id, "succeeded", result=res)
        return {"job_id": job_id, "status": "succeeded", "result": res}
    finally:
        conn.close()
```

- [ ] **Step 2: Test** — `ast.parse` compiles; unit-test the dry-run functions return `{"mutates": False}` and never touch boto3; test that `lambda_handler` with a gate-blocked action raises `blocked:<reason>` and writes NO terminal status; test `phase=='rollback'` with `rb is None` raises MANUAL_INTERVENTION_REQUIRED. (Monkeypatch `db.connect`, `cat.gate`, `_assume`.)

> Note for the implementer: `feature_flags` is referenced by the example only; it is NOT created by this plan (the example action is a definition skeleton). If a real run is ever attempted, the table must exist. This is intentional — the executor is wired but the action is `enabled=false`.

---

## Task 5: SSM Automation runbook + record-start + status-resume Lambdas

**Files:**
- Create: `scripts/v2/remediation/runbooks/ec2-create-tags.yaml`
- Create: `scripts/v2/remediation/record_ssm_start.py`
- Create: `scripts/v2/remediation/status_resume.py`
- Create: `scripts/v2/remediation/ssm_bridge.py`
- Test: `scripts/v2/remediation/test_remediation.py` (ssm section)

- [ ] **Step 1: The example runbook** — AWS-resource action with native describe dry-run + `onFailure` rollback step (ADR-029 #3/#5; ADR-036 #4 native rollback).

```yaml
# scripts/v2/remediation/runbooks/ec2-create-tags.yaml
schemaVersion: '0.3'
description: 'AWSops remediation: add tags to ONE EC2 instance (Change-Manager 4-eyes; dry-run via DescribeTags; onFailure delete-tags rollback).'
assumeRole: '{{ AutomationAssumeRole }}'
parameters:
  AutomationAssumeRole: { type: String }
  ResourceId:          { type: String, allowedPattern: '^i-[0-9a-f]{8,17}$' }
  Tags:                { type: StringMap }
  DryRun:              { type: String, default: 'true', allowedValues: ['true', 'false'] }
mainSteps:
  - name: PreflightDescribe          # dry-run: read current tags, never mutate
    action: 'aws:executeAwsApi'
    inputs: { Service: ec2, Api: DescribeTags, Filters: [{ Name: resource-id, Values: ['{{ ResourceId }}'] }] }
  - name: GateDryRun                 # if DryRun=true, stop here cleanly (no mutation)
    action: 'aws:branch'
    inputs:
      Choices: [{ NextStep: ApplyTags, Variable: '{{ DryRun }}', StringEquals: 'false' }]
      Default: DoneDryRun
  - name: ApplyTags
    action: 'aws:executeAwsApi'
    onFailure: 'step:RollbackDeleteTags'
    inputs: { Service: ec2, Api: CreateTags, Resources: ['{{ ResourceId }}'], Tags: '{{ Tags }}' }
    isEnd: true
  - name: RollbackDeleteTags         # paired rollback (ADR-029 #5); terminal if it fails → MANUAL
    action: 'aws:executeAwsApi'
    inputs: { Service: ec2, Api: DeleteTags, Resources: ['{{ ResourceId }}'], Tags: '{{ Tags }}' }
    isEnd: true
  - name: DoneDryRun
    action: 'aws:sleep'
    inputs: { Duration: 'PT0S' }
    isEnd: true
```

- [ ] **Step 2: record_ssm_start.py** — the SFN `ssm` branch calls this Lambda (request-response): it starts the automation, then writes `automation_execution_id` + the SFN task token into `worker_jobs` **immediately** (ADR-036 negative-consequence mitigation), and returns so the SM enters `.waitForTaskToken`.

```python
# scripts/v2/remediation/record_ssm_start.py
"""ADR-036 ssm branch: start the SSM Automation, persist AutomationExecutionId + the SFN task
token to worker_jobs IMMEDIATELY (so a SFN timeout cannot orphan a running automation; the reaper
reconciles), then return. The SM stays in .waitForTaskToken until status_resume sends the token.
Gated: cat.gate must pass (flag + kill-switch + enabled) BEFORE any StartAutomationExecution."""
import os
import boto3
import db
import action_catalog as cat
import ssm_bridge

_ssm = boto3.client("ssm", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))


def lambda_handler(event, _ctx):
    job_id, action = event["job_id"], event["action"]
    token = event["taskToken"]                    # passed by the SFN .waitForTaskToken Parameters
    conn = db.connect()
    try:
        a, reason = cat.gate(conn, action)
        if reason:
            raise RuntimeError(f"blocked:{reason}")  # SFN Catch → status_updater failed (NO start)
        if db.claim_running(conn, job_id, runtime="ssm") == 0:
            return {"status": "skipped"}             # already terminal (idempotent re-entry)
        params = ssm_bridge.build_start_params(a, event.get("payload", {}), dry_run=bool(event.get("dry_run")))
        exec_id = _ssm.start_automation_execution(**params)["AutomationExecutionId"]
        conn.run("UPDATE worker_jobs SET automation_execution_id=:e, task_token=:t, status='running' "
                 "WHERE job_id=:j AND status NOT IN ('succeeded','failed','canceled')",
                 e=exec_id, t=token, j=job_id)
        return {"automation_execution_id": exec_id}
    finally:
        conn.close()
```

- [ ] **Step 3: ssm_bridge.py** — pure param builder (TargetLocations dormant unless cross-account allowed).

```python
# scripts/v2/remediation/ssm_bridge.py
"""Build SSM StartAutomationExecution params from a resolved catalog action. Cross-account
(TargetLocations) is DORMANT: only emitted when ALLOW_CROSS_ACCOUNT_MUTATION=true AND the action's
conditions list non-self accounts. Default = host-account-only (ADR-029 #8 toggle, not a limit)."""
import os

def build_start_params(action, payload, dry_run):
    doc = os.environ["EC2_CREATE_TAGS_DOC"] if action["name"] == "ec2-create-tags" \
        else os.environ.get(f"DOC_{action['name'].upper().replace('-', '_')}")
    role = os.environ[f"ASSUME_ROLE_{action['assume_role_ref'].upper().replace('-', '_')}"]
    params = {
        "DocumentName": doc,
        "Parameters": {
            "AutomationAssumeRole": [role],
            "ResourceId": [payload.get("resourceId", "")],
            "Tags": [],  # StringMap params are passed via the doc-specific shape; left to the runbook contract
            "DryRun": ["true" if dry_run else "false"],
        },
    }
    allow_xacct = os.environ.get("ALLOW_CROSS_ACCOUNT_MUTATION", "false").lower() == "true"
    accts = [a for a in action.get("conditions", {}).get("accounts", ["self"]) if a != "self"]
    if allow_xacct and accts:
        params["TargetLocations"] = [{"Accounts": accts,
                                      "Regions": action["conditions"].get("regions", []),
                                      "ExecutionRoleName": action["assume_role_ref"]}]
    return params
```

```python
# scripts/v2/remediation/status_resume.py
"""EventBridge rule on SSM Automation 'EC2 Automation Step Status-change'/'status-change' →
resume the parked SFN task. Looks up the worker_jobs row by automation_execution_id, then
SendTaskSuccess (Success/CompletedWithSuccess) or SendTaskFailure (Failed/TimedOut/Cancelled).
Poll getAutomationExecution as a fallback when the event lacks a terminal status."""
import json
import os
import boto3
import db

_sfn = boto3.client("stepfunctions", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))
_ssm = boto3.client("ssm", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))
_TERMINAL_OK = {"Success", "CompletedWithSuccess"}
_TERMINAL_BAD = {"Failed", "TimedOut", "Cancelled", "CompletedWithFailure"}


def lambda_handler(event, _ctx):
    detail = event.get("detail", {})
    exec_id = detail.get("ExecutionId") or detail.get("automation-execution-id")
    status = detail.get("Status")
    if exec_id and status not in (_TERMINAL_OK | _TERMINAL_BAD):
        status = _ssm.get_automation_execution(AutomationExecutionId=exec_id)[
            "AutomationExecution"]["AutomationExecutionStatus"]
    conn = db.connect()
    try:
        rows = conn.run("SELECT job_id, task_token FROM worker_jobs WHERE automation_execution_id=:e", e=exec_id)
        if not rows:
            return {"matched": False, "exec_id": exec_id}
        job_id, token = rows[0]
        if not token:
            return {"matched": True, "no_token": True}  # reaper backstop
        if status in _TERMINAL_OK:
            db.finish_job(conn, job_id, "succeeded", result={"automation_execution_id": exec_id})
            _sfn.send_task_success(taskToken=token, output=json.dumps({"job_id": job_id, "status": "succeeded"}))
        else:
            _sfn.send_task_failure(taskToken=token, error="SsmAutomationFailed", cause=f"status={status}")
        return {"matched": True, "status": status}
    finally:
        conn.close()
```

- [ ] **Step 4: Test** — `ast.parse` all four; unit-test `build_start_params` omits `TargetLocations` when `ALLOW_CROSS_ACCOUNT_MUTATION` unset (host-only), and includes it only when the env is `true` AND a non-self account is in conditions; test `status_resume` routes `Success`→send_task_success and `Failed`→send_task_failure; test `record_ssm_start` raises `blocked:<reason>` (and never calls `start_automation_execution`) when `cat.gate` returns a reason.

---

## Task 6: Catalog-aware dispatcher + reaper reconciliation (extend P2 Python, backward-compatible)

**Files:**
- Modify: `scripts/v2/workers/dispatcher.py`
- Modify: `scripts/v2/workers/reaper.py`
- Test: `scripts/v2/remediation/test_remediation.py` (dispatcher/reaper section)

- [ ] **Step 1: Dispatcher** — for a remediation job, route to the remediation SM. The web `execute` enqueues `{job_id, type:'action', action:<name>, payload, dry_run, plan_id}`. Keep the existing noop/noop-heavy path byte-identical.

```python
# scripts/v2/workers/dispatcher.py  — add the remediation branch (preserve the rest)
# ... existing imports + _sfn + _SM_ARN ...
_REM_SM_ARN = os.environ.get("REMEDIATION_STATE_MACHINE_ARN", "")  # empty when remediation off

def lambda_handler(event, _ctx):
    failures = []
    for rec in event.get("Records", []):
        msg_id = rec["messageId"]; job_id = None
        try:
            body = json.loads(rec["body"]); job_id, type_ = body["job_id"], body["type"]
            if type_ == "action":
                # Remediation job: the action name + executor_type drive the remediation SM Choice.
                if not _REM_SM_ARN:
                    print(f"DROP action job (remediation disabled) job_id={job_id}"); continue
                _sfn.start_execution(
                    stateMachineArn=_REM_SM_ARN, name=job_id,
                    input=json.dumps({"job_id": job_id, "plan_id": body.get("plan_id"),
                                      "action": body["action"], "payload": body.get("payload", {}),
                                      "dry_run": bool(body.get("dry_run", False)),
                                      "runtime": body.get("executor_type", "lambda")}))
                continue
            if not handlers.is_allowed(type_):
                print(f"DROP unknown type={type_} job_id={job_id}"); continue
            _sfn.start_execution(stateMachineArn=_SM_ARN, name=job_id, input=json.dumps({
                "job_id": job_id, "type": type_, "payload": body.get("payload", {}),
                "dry_run": bool(body.get("dry_run", False)), "runtime": handlers.runtime_for(type_)}))
        except _sfn.exceptions.ExecutionAlreadyExists:
            print(f"DUP execution exists job_id={job_id}")
        except Exception as e:  # noqa: BLE001
            print(f"FAIL msg={msg_id} job_id={job_id}: {e}"); failures.append({"itemIdentifier": msg_id})
    return {"batchItemFailures": failures}
```

> The dispatcher does NOT itself resolve the catalog (no Aurora access in the dispatcher — it stays minimal/no-VPC). The catalog gate runs inside `record_ssm_start`/`remediation_executor` (in-VPC). The web `execute` route already injected `action`/`executor_type` from the catalog (Task 9), so the dispatcher only needs to pick the SM.

- [ ] **Step 2: Reaper** — never reap `manual_intervention`; reconcile remediation `running` rows that carry an `automation_execution_id` by polling SSM (don't blindly fail a still-running automation).

```python
# scripts/v2/workers/reaper.py — extend lambda_handler (add after the existing running/queued reap).
# Remediation rows carry an automation_execution_id. The EventBridge status_resume path is the
# PRIMARY completion mechanism; the reaper is only the slow backstop. It SELECTs stale remediation
# rows for visibility (count) and explicitly NEVER touches 'manual_intervention' (a terminal operator
# state). It does NOT blindly fail them: a still-running SSM automation must not be reaped — the
# resume Lambda owns the terminal write. (The existing 'running' reap above already excludes rows
# whose status is not 'running'; 'awaiting_approval'/'manual_intervention' are untouched there.)
        rem = conn.run(
            "SELECT job_id, automation_execution_id FROM worker_jobs "
            "WHERE status IN ('running','awaiting_approval') "
            "AND automation_execution_id IS NOT NULL "
            "AND updated_at < now() - make_interval(mins => :m)", m=R)
        out["stale_remediation_rows"] = len(rem)
        for job_id, _exec_id in rem:
            print(f"REMEDIATION stale (resume Lambda should finalize) job_id={job_id}")
```

> Implementer note: the reaper's SSM poll is best-effort; the EventBridge `status_resume` is the primary completion path. Keep the existing `RUNNING_STALE_MIN=75` semantics; add a `MANUAL_INTERVENTION` guard so those rows are never auto-failed. Do not over-engineer the SSM poll in this skeleton — a `print` + count is sufficient (the resume Lambda + the 5-min EventBridge event handle the happy path).

- [ ] **Step 3: Test** — `ast.parse` both; assert the dispatcher routes `type:'action'` to `_REM_SM_ARN` and DROPS it when `_REM_SM_ARN` is empty (remediation off); assert noop/noop-heavy still route to `_SM_ARN`; assert the reaper SELECT excludes `manual_intervention`.

---

## Task 7: Remediation SFN ASL (`remediation.asl.json`) — dry-run → approval → ssm/lambda/fargate → rollback → MANUAL

**Files:**
- Create: `scripts/v2/remediation/remediation.asl.json`
- Test: `scripts/v2/remediation/test_remediation.py` (asl section — JSON parse + state assertions)

- [ ] **Step 1: The ASL.** States: `DryRunFirst` (always; ADR-029 #3) → `ApprovalWait` (Task-Token, fail-closed on expiry; ADR-029 #4 / ADR-036 #2) → `Route` Choice on `$.runtime` with the **SSM branch** + lambda/fargate branches → on Catch, `Rollback` → on rollback failure, terminal `ManualIntervention`. `${...}` are `templatefile` vars filled by `remediation.tf`.

```json
{
  "Comment": "AWSops v2 ADR-029+036 remediation SM. Reuses the P2 ledger (worker_jobs) + idempotency (execution name == job_id). Flow: mandatory dry-run -> 4-eyes approval Task-Token (fail-closed on timeout) -> route by $.runtime (ssm via startAutomationExecution + .waitForTaskToken/EventBridge, OR lambda/fargate code executor) -> Catch -> rollback -> terminal MANUAL_INTERVENTION_REQUIRED on rollback failure (never infinite retry). status_updater (P2) records terminal failures (SFN cannot write VPC Aurora).",
  "StartAt": "DryRunFirst",
  "States": {
    "DryRunFirst": {
      "Type": "Task",
      "Resource": "arn:aws:states:::lambda:invoke",
      "TimeoutSeconds": 120,
      "Parameters": { "FunctionName": "${executor_fn_arn}", "Payload": { "job_id.$": "$.job_id", "plan_id.$": "$.plan_id", "action.$": "$.action", "payload.$": "$.payload", "phase": "dry_run", "dry_run": true } },
      "ResultPath": "$.dryRunResult",
      "Catch": [ { "ErrorEquals": ["States.ALL"], "ResultPath": "$.errorInfo", "Next": "MarkFailed" } ],
      "Next": "ApprovalWait"
    },
    "ApprovalWait": {
      "Type": "Task",
      "Resource": "arn:aws:states:::lambda:invoke.waitForTaskToken",
      "TimeoutSeconds": 86400,
      "Comment": "4-eyes approval. The approval-notifier Lambda records 'awaiting_approval' + persists the token; an operator approves via /api/actions/[id] execute (P2-path) which SendTaskSuccess. Timeout fails CLOSED (no execution).",
      "Parameters": { "FunctionName": "${approval_fn_arn}", "Payload": { "job_id.$": "$.job_id", "plan_id.$": "$.plan_id", "action.$": "$.action", "taskToken.$": "$$.Task.Token" } },
      "Catch": [ { "ErrorEquals": ["States.Timeout"], "ResultPath": "$.errorInfo", "Next": "MarkFailed" }, { "ErrorEquals": ["States.ALL"], "ResultPath": "$.errorInfo", "Next": "MarkFailed" } ],
      "Next": "Route"
    },
    "Route": {
      "Type": "Choice",
      "Choices": [
        { "Variable": "$.runtime", "StringEquals": "ssm", "Next": "RunSsm" },
        { "Variable": "$.runtime", "StringEquals": "lambda", "Next": "RunCodeLambda" },
        { "Variable": "$.runtime", "StringEquals": "fargate", "Next": "RunCodeFargate" }
      ],
      "Default": "UnknownRuntime"
    },
    "RunSsm": {
      "Type": "Task",
      "Resource": "arn:aws:states:::lambda:invoke.waitForTaskToken",
      "TimeoutSeconds": 3600,
      "Comment": "SSM Automation is NOT a SFN .sync integration. record_ssm_start starts the automation (request-response), persists AutomationExecutionId + this task token, returns. The EventBridge status-change rule -> status_resume SendTaskSuccess/Failure resumes us.",
      "Parameters": { "FunctionName": "${record_ssm_fn_arn}", "Payload": { "job_id.$": "$.job_id", "action.$": "$.action", "payload.$": "$.payload", "dry_run": false, "taskToken.$": "$$.Task.Token" } },
      "Catch": [ { "ErrorEquals": ["States.ALL"], "ResultPath": "$.errorInfo", "Next": "Rollback" } ],
      "End": true
    },
    "RunCodeLambda": {
      "Type": "Task",
      "Resource": "arn:aws:states:::lambda:invoke",
      "TimeoutSeconds": 900,
      "Parameters": { "FunctionName": "${executor_fn_arn}", "Payload": { "job_id.$": "$.job_id", "plan_id.$": "$.plan_id", "action.$": "$.action", "payload.$": "$.payload", "phase": "execute" } },
      "Catch": [ { "ErrorEquals": ["States.ALL"], "ResultPath": "$.errorInfo", "Next": "Rollback" } ],
      "End": true
    },
    "RunCodeFargate": {
      "Type": "Task",
      "Resource": "arn:aws:states:::ecs:runTask.sync",
      "TimeoutSeconds": 3600,
      "Parameters": {
        "Cluster": "${cluster_arn}", "TaskDefinition": "${task_def_arn}", "LaunchType": "FARGATE",
        "NetworkConfiguration": { "AwsvpcConfiguration": { "Subnets": ${subnets_json}, "SecurityGroups": ["${sg_id}"], "AssignPublicIp": "DISABLED" } },
        "Overrides": { "ContainerOverrides": [ { "Name": "${container_name}", "Command.$": "States.Array('python', 'remediation_executor_cli.py', '--job-id', $.job_id, '--action', $.action)" } ] }
      },
      "Catch": [ { "ErrorEquals": ["States.ALL"], "ResultPath": "$.errorInfo", "Next": "Rollback" } ],
      "End": true
    },
    "UnknownRuntime": {
      "Type": "Pass", "Result": { "Error": "UnknownRuntime", "Cause": "runtime is not ssm|lambda|fargate" }, "ResultPath": "$.errorInfo", "Next": "MarkFailed"
    },
    "Rollback": {
      "Type": "Task",
      "Resource": "arn:aws:states:::lambda:invoke",
      "TimeoutSeconds": 900,
      "Comment": "Paired rollback (ADR-029 #5): a separately-validated artifact captured at plan time. On rollback SUCCESS -> MarkFailed (forward failed but state restored). On rollback FAILURE -> ManualIntervention (NEVER infinite retry).",
      "Parameters": { "FunctionName": "${executor_fn_arn}", "Payload": { "job_id.$": "$.job_id", "plan_id.$": "$.plan_id", "action.$": "$.action", "phase": "rollback", "rollback_plan.$": "$.payload.rollback_plan" } },
      "Retry": [ { "ErrorEquals": ["Lambda.ServiceException", "Lambda.TooManyRequestsException"], "IntervalSeconds": 2, "MaxAttempts": 2, "BackoffRate": 2.0 } ],
      "Catch": [ { "ErrorEquals": ["States.ALL"], "ResultPath": "$.rollbackError", "Next": "ManualIntervention" } ],
      "Next": "MarkFailed"
    },
    "ManualIntervention": {
      "Type": "Task",
      "Resource": "arn:aws:states:::lambda:invoke",
      "TimeoutSeconds": 60,
      "Comment": "Terminal: rollback failed. Set worker_jobs.status='manual_intervention' (NOT 'failed') so the reaper never touches it and an operator must resolve. status_updater handles the write with a manual flag.",
      "Parameters": { "FunctionName": "${status_fn_arn}", "Payload": { "job_id.$": "$.job_id", "error.$": "$.rollbackError.Cause", "manual_intervention": true } },
      "Retry": [ { "ErrorEquals": ["States.ALL"], "IntervalSeconds": 2, "MaxAttempts": 6, "BackoffRate": 2.0 } ],
      "Next": "JobManual"
    },
    "MarkFailed": {
      "Type": "Task",
      "Resource": "arn:aws:states:::lambda:invoke",
      "TimeoutSeconds": 60,
      "Parameters": { "FunctionName": "${status_fn_arn}", "Payload": { "job_id.$": "$.job_id", "error.$": "$.errorInfo.Cause" } },
      "Retry": [ { "ErrorEquals": ["States.ALL"], "IntervalSeconds": 2, "MaxAttempts": 6, "BackoffRate": 2.0 } ],
      "Next": "JobFailed"
    },
    "JobFailed":  { "Type": "Fail", "Error": "RemediationFailed", "Cause": "Forward failed; rollback (if any) succeeded; status_updater set failed." },
    "JobManual":  { "Type": "Fail", "Error": "ManualInterventionRequired", "Cause": "Rollback failed; operator must resolve. status='manual_intervention'." }
  }
}
```

- [ ] **Step 2: Extend `status_updater.py`** to honor a `manual_intervention` flag (set `status='manual_intervention'` instead of `failed`). Add to `db.py` a `set_manual_intervention(conn, job_id, error)` (terminal-immutable, like `finish_job` but the status is `'manual_intervention'`). Keep the existing failed path unchanged.

```python
# scripts/v2/workers/status_updater.py — extend
def lambda_handler(event, _ctx):
    job_id = event["job_id"]; err = event.get("error")
    if isinstance(err, (dict, list)): err = json.dumps(err)[:2000]
    conn = db.connect()
    try:
        if event.get("manual_intervention"):
            n = db.set_manual_intervention(conn, job_id, err or "rollback failed (MANUAL_INTERVENTION_REQUIRED)")
        else:
            n = db.finish_job(conn, job_id, "failed", error=(err or "worker failed (SFN catch)"))
        return {"job_id": job_id, "updated": n}
    finally:
        conn.close()
```

```python
# scripts/v2/workers/db.py — add (terminal-immutable; 'manual_intervention' is terminal)
_TERMINAL = ("succeeded", "failed", "canceled", "manual_intervention")  # widen the terminal set

def set_manual_intervention(conn, job_id, error):
    rows = conn.run(
        "UPDATE worker_jobs SET status='manual_intervention', error=:e "
        "WHERE job_id=:id AND status NOT IN ('succeeded','failed','canceled','manual_intervention') RETURNING job_id",
        e=error, id=job_id)
    return len(rows)
```

- [ ] **Step 3: Test** — JSON-parse `remediation.asl.json`; assert `StartAt=='DryRunFirst'`, the `Route` Choice has an `ssm` branch, `RunSsm` uses `lambda:invoke.waitForTaskToken`, `ApprovalWait` is `.waitForTaskToken` with a finite `TimeoutSeconds` and a `States.Timeout` Catch → MarkFailed (fail-closed), `Rollback` Catch → `ManualIntervention`, and `JobManual` is a terminal `Fail`. Assert `db._TERMINAL` includes `manual_intervention` (ast/grep).

---

## Task 8: `remediation.tf` — all gated infra (SSM doc + Change template + roles + SFN + bucket + kill-switch)

**Files:**
- Modify: `terraform/foundation/remediation.tf` (the bulk)

> Everything in this task is `count = local.re`. With `remediation_enabled=false` ⇒ `local.re=0` ⇒ every resource is absent ⇒ `plan` = No changes.

- [ ] **Step 1: Kill-switch + cross-account toggle SSM params** (default OFF; ignore_changes on value, mirror the agentcore param style).

```hcl
resource "aws_ssm_parameter" "mutating_enabled" {
  count       = local.re
  name        = "/ops/${var.project}/mutating-actions/enabled"
  description = "ADR-029 kill-switch. 'false' (default) blocks ALL mutating execution (planning/dry-run still work). Operator-toggled; ignore drift."
  type        = "String"
  value       = "false"
  lifecycle { ignore_changes = [value] }
}

resource "aws_ssm_parameter" "allow_cross_account" {
  count       = local.re
  name        = "/ops/${var.project}/mutating-actions/allow-cross-account"
  description = "ADR-029 #8 toggle. 'false' (default) = host-account-only mutation. Lifting requires a follow-up ADR + member-account AutomationAssumeRole."
  type        = "String"
  value       = "false"
  lifecycle { ignore_changes = [value] }
}
```

- [ ] **Step 2: S3 Object-Lock audit bucket** (governance mode, 1yr; ADR-029 #6 second synchronous sink).

```hcl
resource "aws_s3_bucket" "remediation_audit" {
  count               = local.re
  bucket              = "${var.project}-remediation-audit-${local.rem_acct}"
  object_lock_enabled = true
  force_destroy       = false
}
resource "aws_s3_bucket_versioning" "remediation_audit" {
  count  = local.re
  bucket = aws_s3_bucket.remediation_audit[0].id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_object_lock_configuration" "remediation_audit" {
  count  = local.re
  bucket = aws_s3_bucket.remediation_audit[0].id
  rule { default_retention { mode = "GOVERNANCE" days = 365 } }
}
resource "aws_s3_bucket_public_access_block" "remediation_audit" {
  count                   = local.re
  bucket                  = aws_s3_bucket.remediation_audit[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
```

- [ ] **Step 3: SSM Automation document (Git→SSM sync) for the example AWS action.**

```hcl
resource "aws_ssm_document" "ec2_create_tags" {
  count           = local.re
  name            = "${var.project}-ec2-create-tags"
  document_type   = "Automation"
  document_format = "YAML"
  content         = file("${local.rem_src}/runbooks/ec2-create-tags.yaml")
}
```

- [ ] **Step 4: Per-runbook `AutomationAssumeRole` (scoped, exact-ARN/allowlist where Modify* lacks tag conditions — ADR-029 #5 revision).**

```hcl
data "aws_iam_policy_document" "ssm_assume" {
  count = local.re
  statement {
    actions = ["sts:AssumeRole"]
    principals { type = "Service" identifiers = ["ssm.amazonaws.com"] }
  }
}
resource "aws_iam_role" "automation_ec2_tags" {
  count              = local.re
  name               = "${var.project}-automation-ec2-create-tags"
  assume_role_policy = data.aws_iam_policy_document.ssm_assume[0].json
}
resource "aws_iam_role_policy" "automation_ec2_tags" {
  count = local.re
  name  = "${var.project}-automation-ec2-create-tags"
  role  = aws_iam_role.automation_ec2_tags[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # ec2:CreateTags/DeleteTags accept a resource-level scope; pin to the host region.
      # (No tag-on-create condition: CreateTags is the tag op itself — use region + the
      #  catalog's resourceArnAllowlist enforced in the runbook allowedPattern + web validation.)
      { Effect = "Allow", Action = ["ec2:CreateTags", "ec2:DeleteTags"], Resource = "arn:aws:ec2:${var.region}:${local.rem_acct}:instance/*",
        Condition = { StringEquals = { "aws:RequestedRegion" = var.region } } },
      { Effect = "Allow", Action = ["ec2:DescribeTags"], Resource = "*" }
    ]
  })
}
```

- [ ] **Step 5: Per-action P2-code task roles** (NOT the shared worker role — ADR-036 #3). The remediation executor assumes these via STS.

```hcl
resource "aws_iam_role" "action_app_feature_flag" {
  count              = local.re
  name               = "${var.project}-action-app-feature-flag"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow",
    Principal = { AWS = aws_iam_role.worker_lambda[0].arn }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy" "action_app_feature_flag" {
  count = local.re
  name  = "${var.project}-action-app-feature-flag"
  role  = aws_iam_role.action_app_feature_flag[0].id
  # App-state only: Aurora secret + KMS (the flag row lives in Aurora). NO AWS-resource mutate.
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = aws_rds_cluster.aurora.master_user_secret[0].secret_arn },
    { Effect = "Allow", Action = ["kms:Decrypt"], Resource = aws_kms_key.aurora.arn } ] })
}
resource "aws_iam_role" "action_opscenter_write" {
  count              = local.re
  name               = "${var.project}-action-opscenter-write"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow",
    Principal = { AWS = aws_iam_role.worker_lambda[0].arn }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy" "action_opscenter_write" {
  count = local.re
  name  = "${var.project}-action-opscenter-write"
  role  = aws_iam_role.action_opscenter_write[0].id
  # ADR-036 #5 reduced subset: a single non-destructive observability write.
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["ssm:CreateOpsItem"], Resource = "*" } ] })
}
```

- [ ] **Step 6: Change Manager change template** (`AutoApprove=false`, approvers exclude the AWSops principal — ADR-036 #2). Created via `aws_ssm_document` of type `Automation.ChangeTemplate`.

```hcl
resource "aws_ssm_document" "change_template" {
  count           = local.re
  name            = "${var.project}-remediation-change-template"
  document_type   = "Automation.ChangeTemplate"
  document_format = "YAML"
  content = yamlencode({
    schemaVersion = "0.3"
    description   = "AWSops remediation change template — 4-eyes (AutoApprove=false; approvers must be HUMAN IAM principals, NOT the AWSops task role)."
    templateInformation = "AWSops mutating action. Requires a human approver (Change Manager approver role + ssm:SendAutomationSignal). The requesting AWSops principal is excluded from the approver set."
    executableRunBooks = [{ name = aws_ssm_document.ec2_create_tags[0].name, version = "$DEFAULT" }]
    # AutoApprove is FALSE by omitting any auto-approval rule; approver groups are configured
    # out-of-band by the operator (human IAM principals only). The template enforces the gate.
  })
}
```

- [ ] **Step 7: CloudWatch log groups + remediation SFN role + the SFN itself** (the sibling SM, Task 7's ASL).

```hcl
resource "aws_cloudwatch_log_group" "remediation_sfn" {
  count             = local.re
  name              = "/aws/vendedlogs/states/${var.project}-remediation"
  retention_in_days = 90 # longer than workers: mutation audit
}
resource "aws_cloudwatch_log_group" "remediation_lambdas" {
  count             = local.re
  name              = "/aws/lambda/${var.project}-remediation"
  retention_in_days = 90
}

resource "aws_iam_role" "remediation_sfn" {
  count = local.re
  name  = "${var.project}-remediation-sfn"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow",
    Principal = { Service = "states.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy" "remediation_sfn" {
  count = local.re
  name  = "${var.project}-remediation-sfn"
  role  = aws_iam_role.remediation_sfn[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Sid = "InvokeRemediationLambdas", Effect = "Allow", Action = ["lambda:InvokeFunction"],
      Resource = [aws_lambda_function.remediation_executor[0].arn, aws_lambda_function.record_ssm_start[0].arn,
                  aws_lambda_function.approval_notifier[0].arn, aws_lambda_function.status_updater[0].arn] },
    { Sid = "RunFargateExecutor", Effect = "Allow", Action = ["ecs:RunTask"],
      Resource = "arn:aws:ecs:${var.region}:${local.rem_acct}:task-definition/${var.project}-worker:*" },
    { Sid = "ControlTasks", Effect = "Allow", Action = ["ecs:StopTask", "ecs:DescribeTasks"], Resource = "*" },
    { Sid = "PassTaskRoles", Effect = "Allow", Action = ["iam:PassRole"],
      Resource = [aws_iam_role.execution.arn, aws_iam_role.worker_task[0].arn],
      Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } } },
    { Sid = "EcsSyncManagedRule", Effect = "Allow", Action = ["events:PutTargets", "events:PutRule", "events:DescribeRule"],
      Resource = "arn:aws:events:${var.region}:${local.rem_acct}:rule/StepFunctionsGetEventsForECSTaskRule" },
    { Sid = "SfnLogging", Effect = "Allow", Action = ["logs:CreateLogDelivery", "logs:GetLogDelivery", "logs:UpdateLogDelivery", "logs:DeleteLogDelivery", "logs:ListLogDeliveries", "logs:PutResourcePolicy", "logs:DescribeResourcePolicies", "logs:DescribeLogGroups"], Resource = "*" } ] })
}

resource "aws_sfn_state_machine" "remediation" {
  count    = local.re
  name     = "${var.project}-remediation"
  role_arn = aws_iam_role.remediation_sfn[0].arn
  type     = "STANDARD"
  definition = templatefile("${local.rem_src}/remediation.asl.json", {
    executor_fn_arn   = aws_lambda_function.remediation_executor[0].arn
    record_ssm_fn_arn = aws_lambda_function.record_ssm_start[0].arn
    approval_fn_arn   = aws_lambda_function.approval_notifier[0].arn
    status_fn_arn     = aws_lambda_function.status_updater[0].arn
    cluster_arn       = aws_ecs_cluster.main.arn
    task_def_arn      = aws_ecs_task_definition.worker[0].arn
    subnets_json      = jsonencode(local.private_subnet_ids)
    sg_id             = aws_security_group.service.id
    container_name    = local.worker_cname
  })
  logging_configuration { log_destination = "${aws_cloudwatch_log_group.remediation_sfn[0].arn}:*" include_execution_data = true level = "ALL" }
  depends_on = [aws_iam_role_policy.remediation_sfn]
}
```

- [ ] **Step 8: The remediation Lambdas** (executor, record_ssm_start, approval_notifier, status_resume) — packaged from `scripts/v2/remediation/` + the shared `scripts/v2/workers/db.py`. They are VPC (Aurora) + reuse the pg8000 layer + `aws_security_group.service`. The executor role is `worker_lambda` (it only needs Aurora + STS:AssumeRole on the per-action roles); add an inline STS policy.

```hcl
data "archive_file" "remediation_src" {
  count       = local.re
  type        = "zip"
  output_path = "${path.module}/.build/remediation_src.zip"
  source { content = file("${local.workers_src_re}/db.py")                    filename = "db.py" }
  source { content = file("${local.rem_src}/action_catalog.py")               filename = "action_catalog.py" }
  source { content = file("${local.rem_src}/remediation_executor.py")         filename = "remediation_executor.py" }
  source { content = file("${local.rem_src}/record_ssm_start.py")             filename = "record_ssm_start.py" }
  source { content = file("${local.rem_src}/status_resume.py")                filename = "status_resume.py" }
  source { content = file("${local.rem_src}/ssm_bridge.py")                   filename = "ssm_bridge.py" }
  source { content = file("${local.rem_src}/approval_notifier.py")            filename = "approval_notifier.py" }
}

# Remediation executor needs STS:AssumeRole on the per-action roles + SSM start/get + kill-switch read.
resource "aws_iam_role_policy" "remediation_lambda_extra" {
  count = local.re
  name  = "${var.project}-remediation-lambda-extra"
  role  = aws_iam_role.worker_lambda[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Sid = "AssumePerActionRoles", Effect = "Allow", Action = ["sts:AssumeRole"],
      Resource = [aws_iam_role.action_app_feature_flag[0].arn, aws_iam_role.action_opscenter_write[0].arn] },
    { Sid = "StartSsmAutomation", Effect = "Allow", Action = ["ssm:StartAutomationExecution", "ssm:GetAutomationExecution"],
      Resource = "*" },
    { Sid = "PassAutomationRole", Effect = "Allow", Action = ["iam:PassRole"],
      Resource = [aws_iam_role.automation_ec2_tags[0].arn],
      Condition = { StringEquals = { "iam:PassedToService" = "ssm.amazonaws.com" } } },
    { Sid = "ReadKillSwitch", Effect = "Allow", Action = ["ssm:GetParameter"],
      Resource = [aws_ssm_parameter.mutating_enabled[0].arn, aws_ssm_parameter.allow_cross_account[0].arn] },
    { Sid = "ResumeSfn", Effect = "Allow", Action = ["states:SendTaskSuccess", "states:SendTaskFailure"],
      Resource = aws_sfn_state_machine.remediation[0].arn },
    { Sid = "AuditBucket", Effect = "Allow", Action = ["s3:PutObject"],
      Resource = "${aws_s3_bucket.remediation_audit[0].arn}/*" } ] })
}

locals {
  rem_env = local.re == 1 ? {
    AURORA_ENDPOINT       = aws_rds_cluster.aurora.endpoint
    AURORA_DATABASE       = aws_rds_cluster.aurora.database_name
    AURORA_SECRET_ARN     = aws_rds_cluster.aurora.master_user_secret[0].secret_arn
    REMEDIATION_ENABLED   = "true" # the Lambda only EXISTS when the flag is on; the kill-switch is the live gate
    MUTATING_ACTIONS_SSM  = aws_ssm_parameter.mutating_enabled[0].name
    EC2_CREATE_TAGS_DOC   = aws_ssm_document.ec2_create_tags[0].name
    ASSUME_ROLE_EC2_CREATE_TAGS         = aws_iam_role.automation_ec2_tags[0].arn
    ACTION_ROLE_APP_FEATURE_FLAG_SET    = aws_iam_role.action_app_feature_flag[0].arn
    ACTION_ROLE_OPSCENTER_CREATE_OPSITEM = aws_iam_role.action_opscenter_write[0].arn
    AUDIT_BUCKET          = aws_s3_bucket.remediation_audit[0].id
    REMEDIATION_STATE_MACHINE_ARN = aws_sfn_state_machine.remediation[0].arn
  } : {}
}

resource "aws_lambda_function" "remediation_executor" {
  count            = local.re
  function_name    = "${var.project}-remediation-executor"
  role             = aws_iam_role.worker_lambda[0].arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "remediation_executor.lambda_handler"
  filename         = data.archive_file.remediation_src[0].output_path
  source_code_hash = data.archive_file.remediation_src[0].output_base64sha256
  timeout          = 900
  memory_size      = 256
  layers           = [aws_lambda_layer_version.pg8000[0].arn]
  vpc_config { subnet_ids = local.private_subnet_ids security_group_ids = [aws_security_group.service.id] }
  environment { variables = local.rem_env }
  depends_on = [aws_cloudwatch_log_group.remediation_lambdas, aws_iam_role_policy_attachment.worker_lambda_vpc]
}
# record_ssm_start, approval_notifier, status_resume: same shape (handler/timeout differ). [Implementer:
# copy the block above 3x with handler = record_ssm_start.lambda_handler / approval_notifier.lambda_handler
# / status_resume.lambda_handler, timeouts 60/60/120, same role/layer/vpc/env.]
```

- [ ] **Step 9: EventBridge rule on SSM Automation `status-change` → `status_resume`.**

```hcl
resource "aws_cloudwatch_event_rule" "ssm_status_change" {
  count       = local.re
  name        = "${var.project}-ssm-automation-status"
  description = "ADR-036: SSM Automation execution status-change → resume the parked remediation SFN task."
  event_pattern = jsonencode({
    source        = ["aws.ssm"]
    "detail-type" = ["EC2 Automation Execution Status-change Notification", "SSM Automation Execution Status-change Notification"]
  })
}
resource "aws_cloudwatch_event_target" "ssm_status_change" {
  count     = local.re
  rule      = aws_cloudwatch_event_rule.ssm_status_change[0].name
  target_id = "status-resume"
  arn       = aws_lambda_function.status_resume[0].arn
}
resource "aws_lambda_permission" "ssm_status_change" {
  count         = local.re
  statement_id  = "AllowEventBridgeResume"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.status_resume[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.ssm_status_change[0].arn
}
```

- [ ] **Step 10: Reaper env + dispatcher env wiring** (gated). Add `REMEDIATION_STATE_MACHINE_ARN` to the dispatcher's env via a gated `merge`, and feed the reaper the remediation SM ARN. Because `workers.tf` owns the dispatcher resource, add the env with a gated local merge there OR define the env override in `remediation.tf` is not possible (same resource) — so **modify `workers.tf`'s dispatcher `environment` to merge `var.remediation_enabled ? {REMEDIATION_STATE_MACHINE_ARN=...} : {}`**. (Implementer: this is the one cross-file edit; keep it byte-identical when off via `merge({STATE_MACHINE_ARN=...}, var.remediation_enabled ? {...} : {})`.)

```hcl
# workers.tf, dispatcher environment — change to:
  environment {
    variables = merge(
      { STATE_MACHINE_ARN = aws_sfn_state_machine.workers[0].arn },
      var.remediation_enabled ? { REMEDIATION_STATE_MACHINE_ARN = aws_sfn_state_machine.remediation[0].arn } : {},
    )
  }
```

> Note: this dispatcher edit only renders the extra env when `remediation_enabled=true`. When false, `merge(base, {})==base` → no dispatcher change. The dispatcher already exists only when `workers_enabled=true`; remediation requires workers (document this dependency).

- [ ] **Step 11: approval_notifier.py** (create) — the `ApprovalWait` Task-Token target: records `awaiting_approval` + persists the token + `plan_id` link to `worker_jobs`, returns nothing (parks the SM). The actual approval (SendTaskSuccess) comes from the web `execute` route (Task 9) or an operator tool. Fail-closed: the SM `ApprovalWait` `TimeoutSeconds` expiry → MarkFailed.

```python
# scripts/v2/remediation/approval_notifier.py
"""ApprovalWait Task-Token target. Records awaiting_approval + the token (so the web execute route
can SendTaskSuccess to the SAME token) and returns — the SM parks until the token resolves or the
ApprovalWait TimeoutSeconds expires (fail-closed → no execution). 4-eyes (a DIFFERENT approver) is
enforced by the web execute route (ADR-029 #4 / ADR-036 #2)."""
import db

def lambda_handler(event, _ctx):
    job_id, token = event["job_id"], event["taskToken"]
    conn = db.connect()
    try:
        conn.run("UPDATE worker_jobs SET status='awaiting_approval', task_token=:t, plan_id=:p "
                 "WHERE job_id=:j AND status NOT IN ('succeeded','failed','canceled','manual_intervention')",
                 t=token, p=event.get("plan_id"), j=job_id)
        return {"job_id": job_id, "awaiting_approval": True}
    finally:
        conn.close()
```

- [ ] **Step 12: Gated outputs** (mirror workers `one(...)` style).

```hcl
output "remediation_state_machine_arn" { value = one(aws_sfn_state_machine.remediation[*].arn) }
output "remediation_audit_bucket"      { value = one(aws_s3_bucket.remediation_audit[*].id) }
output "mutating_kill_switch_param"    { value = one(aws_ssm_parameter.mutating_enabled[*].name) }
```

- [ ] **Step 13: `terraform validate` + `terraform plan` with `remediation_enabled=false` ⇒ No changes.** (Run by the implementer before the CONTROLLER task; the CONTROLLER re-proves it.)

---

## Task 9: web `/api/actions` — plan (admin) + execute (4-eyes) + status/cancel + catalog read

**Files:**
- Create: `web/lib/remediation.ts`
- Create: `web/app/api/actions/route.ts`
- Create: `web/app/api/actions/[id]/route.ts`
- Modify: `terraform/foundation/workload.tf` (web env, gated)
- Test: `web/lib/remediation.test.ts`, `web/app/api/actions/route.test.ts`, `web/app/api/actions/[id]/route.test.ts`

- [ ] **Step 1: web env (gated, byte-identical when off).** In `workload.tf`, extend the existing `concat([...base], var.workers_enabled ? [...] : [])` with a remediation tail:

```hcl
        ], var.workers_enabled ? [
        { name = "JOBS_QUEUE_URL", value = one(aws_sqs_queue.jobs[*].url) }
      ] : [], var.remediation_enabled ? [
        { name = "REMEDIATION_ENABLED", value = "true" },
        { name = "MUTATING_ACTIONS_SSM", value = one(aws_ssm_parameter.mutating_enabled[*].name) }
      ] : [])
```

And a gated web-task-role policy to read the kill-switch (only when on):

```hcl
resource "aws_iam_role_policy" "web_killswitch_read" {
  count = local.re
  name  = "${var.project}-web-killswitch-read"
  role  = aws_iam_role.task.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow",
    Action = ["ssm:GetParameter"], Resource = aws_ssm_parameter.mutating_enabled[0].arn }] })
}
```

- [ ] **Step 2: `web/lib/remediation.ts`** — Aurora data layer (mirror `web/lib/catalog.ts`).

```typescript
// web/lib/remediation.ts
// ADR-029+036 — Aurora data layer for the remediation substrate. Plan creation is dry-run-only
// (NO mutation); execute enqueues into the P2 ledger. Degrade-safe when AURORA unconfigured.
import { randomUUID } from 'crypto';
import { getPool } from '@/lib/db';

export interface CatalogRow { name: string; description: string; executorType: 'ssm'|'lambda'|'fargate'; targetResourceType: string; approvalMode: string; requiredInputs: string[]; enabled: boolean; }

export async function listCatalog(): Promise<CatalogRow[]> {
  if (!process.env.AURORA_ENDPOINT) return [];
  const { rows } = await getPool().query(
    `SELECT name, description, executor_type, target_resource_type, approval_mode, required_inputs, enabled
     FROM action_catalog ORDER BY name`);
  return rows.map((r: Record<string, unknown>) => ({
    name: r.name as string, description: r.description as string,
    executorType: r.executor_type as CatalogRow['executorType'],
    targetResourceType: r.target_resource_type as string, approvalMode: r.approval_mode as string,
    requiredInputs: (r.required_inputs as string[]) ?? [], enabled: r.enabled as boolean }));
}

export async function getAction(name: string): Promise<CatalogRow | null> {
  const all = await listCatalog();
  return all.find((a) => a.name === name) ?? null;
}

// Plan = capture a dry-run + a PAIRED rollback artifact + a 5-min idempotency token. NO mutation.
export async function createPlan(input: { action: string; inputs: Record<string, unknown>; createdBy: string;
  dryRun: Record<string, unknown>; rollbackPlan: Record<string, unknown>; }): Promise<{ planId: string; idempotencyToken: string; expiresAt: string }> {
  const planId = randomUUID();
  const idempotencyToken = randomUUID();
  const { rows } = await getPool().query(
    `INSERT INTO action_plans (plan_id, action_name, idempotency_token, inputs, dry_run, rollback_plan, status, created_by, expires_at)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,'planned',$7, NOW() + INTERVAL '5 minutes')
     RETURNING expires_at`,
    [planId, input.action, idempotencyToken, JSON.stringify(input.inputs), JSON.stringify(input.dryRun),
     JSON.stringify(input.rollbackPlan), input.createdBy]);
  return { planId, idempotencyToken, expiresAt: rows[0].expires_at };
}

export async function getPlan(planId: string) {
  const { rows } = await getPool().query(
    `SELECT plan_id, action_name, status, created_by, approved_by, job_id, dry_run, rollback_plan,
            expires_at, (expires_at < NOW()) AS expired, created_at, updated_at
     FROM action_plans WHERE plan_id = $1`, [planId]);
  return rows[0] ?? null;
}

export async function setApprovedAndExecuting(planId: string, approvedBy: string, jobId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE action_plans SET status='executing', approved_by=$2, job_id=$3
     WHERE plan_id=$1 AND status='planned' AND expires_at > NOW() AND created_by <> $2`, // 4-eyes + not expired
    [planId, approvedBy, jobId]);
  return (rowCount ?? 0) > 0;
}

export async function recordAudit(a: { planId?: string; jobId?: string; actionName?: string; phase: string;
  principal: string; decision?: string; detail?: Record<string, unknown>; }): Promise<void> {
  if (!process.env.AURORA_ENDPOINT) return;
  await getPool().query(
    `INSERT INTO remediation_audit (plan_id, job_id, action_name, phase, principal, decision, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [a.planId ?? null, a.jobId ?? null, a.actionName ?? null, a.phase, a.principal, a.decision ?? null, JSON.stringify(a.detail ?? {})]);
}
```

- [ ] **Step 3: `web/app/api/actions/route.ts`** — `GET` catalog + `POST` plan (admin-gated; plan never mutates).

```typescript
// web/app/api/actions/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { listCatalog, getAction, createPlan, recordAudit } from '@/lib/remediation';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await verifyUser(req.headers.get('cookie'));
  if (!user || !(await isAdmin(user))) return NextResponse.json({ message: 'admin required' }, { status: 403 });
  return NextResponse.json({ catalog: await listCatalog() });
}

export async function POST(req: NextRequest) {
  const user = await verifyUser(req.headers.get('cookie'));
  if (!user || !(await isAdmin(user))) return NextResponse.json({ message: 'admin required' }, { status: 403 });
  let body: any; try { body = await req.json(); } catch { return NextResponse.json({ message: 'invalid JSON' }, { status: 400 }); }
  const action = await getAction(String(body?.action ?? ''));
  if (!action) return NextResponse.json({ message: 'unknown action' }, { status: 400 });
  if (!action.enabled) return NextResponse.json({ message: 'action disabled (catalog enabled=false)' }, { status: 409 });
  const inputs = (body?.inputs && typeof body.inputs === 'object') ? body.inputs : {};
  for (const k of action.requiredInputs) if (!(k in inputs)) return NextResponse.json({ message: `missing input: ${k}` }, { status: 400 });
  // Plan-time dry-run + paired rollback are computed here WITHOUT mutation. In this skeleton the
  // dry-run is a contract echo (the live dry-run runs in the SFN DryRunFirst state at execute time).
  const dryRun = { mode: 'plan', action: action.name, inputs, mutates: false };
  const rollbackPlan = { action: action.name, captured_at: new Date().toISOString(), inputs };
  const plan = await createPlan({ action: action.name, inputs, createdBy: user.email ?? user.sub, dryRun, rollbackPlan });
  await recordAudit({ planId: plan.planId, actionName: action.name, phase: 'plan', principal: user.email ?? user.sub, detail: { inputs } });
  return NextResponse.json({ ...plan, dryRun, rollbackPlan, status: 'planned' }, { status: 201 });
}
```

- [ ] **Step 4: `web/app/api/actions/[id]/route.ts`** — `GET` status; `POST` execute (4-eyes + kill-switch + flag) / cancel.

```typescript
// web/app/api/actions/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { getPool } from '@/lib/db';
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { getPlan, getAction, setApprovedAndExecuting, recordAudit } from '@/lib/remediation';

export const dynamic = 'force-dynamic';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let ssm: SSMClient | null = null; let sqs: SQSClient | null = null;
async function killSwitchOn(): Promise<boolean> {
  const name = process.env.MUTATING_ACTIONS_SSM;
  if (!name) return false; // fail-closed
  if (!ssm) ssm = new SSMClient({ region: process.env.AWS_REGION || 'ap-northeast-2' });
  try { const r = await ssm.send(new GetParameterCommand({ Name: name })); return (r.Parameter?.Value ?? '').toLowerCase() === 'true'; }
  catch { return false; }
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await verifyUser(req.headers.get('cookie'));
  if (!user || !(await isAdmin(user))) return NextResponse.json({ message: 'admin required' }, { status: 403 });
  if (!UUID_RE.test(params.id)) return NextResponse.json({ message: 'invalid plan id' }, { status: 400 });
  const plan = await getPlan(params.id);
  return plan ? NextResponse.json(plan) : NextResponse.json({ message: 'plan not found' }, { status: 404 });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await verifyUser(req.headers.get('cookie'));
  if (!user || !(await isAdmin(user))) return NextResponse.json({ message: 'admin required' }, { status: 403 });
  if (!UUID_RE.test(params.id)) return NextResponse.json({ message: 'invalid plan id' }, { status: 400 });
  let body: any; try { body = await req.json(); } catch { return NextResponse.json({ message: 'invalid JSON' }, { status: 400 }); }
  const op = body?.op;
  const plan = await getPlan(params.id);
  if (!plan) return NextResponse.json({ message: 'plan not found' }, { status: 404 });
  const approver = user.email ?? user.sub;

  if (op === 'cancel') {
    await getPool().query(`UPDATE action_plans SET status='canceled' WHERE plan_id=$1 AND status IN ('planned','approved')`, [params.id]);
    await recordAudit({ planId: params.id, phase: 'approve', principal: approver, decision: 'canceled' });
    return NextResponse.json({ status: 'canceled' });
  }
  if (op !== 'execute') return NextResponse.json({ message: 'op must be execute|cancel' }, { status: 400 });

  // ---- Hard gates: flag (env) + kill-switch (SSM) + 4-eyes (different approver) + not expired ----
  if (process.env.REMEDIATION_ENABLED !== 'true') {
    await recordAudit({ planId: params.id, phase: 'execute', principal: approver, decision: 'flag_off' });
    return NextResponse.json({ message: 'remediation disabled (flag off)' }, { status: 503 });
  }
  if (!(await killSwitchOn())) {
    await recordAudit({ planId: params.id, phase: 'execute', principal: approver, decision: 'killswitch_blocked' });
    return NextResponse.json({ message: 'kill-switch is off' }, { status: 403 });
  }
  if (plan.expired) return NextResponse.json({ message: 'plan expired (>5 min)' }, { status: 410 });
  if (plan.created_by === approver) {
    await recordAudit({ planId: params.id, phase: 'execute', principal: approver, decision: 'denied_self_approval' });
    return NextResponse.json({ message: '4-eyes: approver must differ from creator' }, { status: 403 });
  }
  const action = await getAction(plan.action_name);
  if (!action || !action.enabled) return NextResponse.json({ message: 'action disabled' }, { status: 409 });

  const jobId = randomUUID();
  const ok = await setApprovedAndExecuting(params.id, approver, jobId); // atomic 4-eyes + not-expired guard in SQL
  if (!ok) return NextResponse.json({ message: 'plan not in an approvable state (re-fetch)' }, { status: 409 });

  // Enqueue into the P2 ledger (worker_jobs) + SQS — the dispatcher routes 'action' to the remediation SM.
  await getPool().query(
    `INSERT INTO worker_jobs (job_id, type, payload, dry_run, status, plan_id) VALUES ($1,'action',$2::jsonb,false,'queued',$3)`,
    [jobId, JSON.stringify({ rollback_plan: plan.rollback_plan, ...plan.dry_run, inputs: plan.dry_run?.inputs ?? {} }), params.id]);
  const queueUrl = process.env.JOBS_QUEUE_URL;
  if (queueUrl) {
    if (!sqs) sqs = new SQSClient({ region: process.env.AWS_REGION || 'ap-northeast-2' });
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify({
      job_id: jobId, type: 'action', action: plan.action_name, executor_type: action.executorType,
      plan_id: params.id, payload: { rollback_plan: plan.rollback_plan, ...(plan.dry_run?.inputs ?? {}) }, dry_run: false }) }));
  }
  await recordAudit({ planId: params.id, jobId, actionName: plan.action_name, phase: 'execute', principal: approver, decision: 'approved' });
  return NextResponse.json({ status: 'executing', job_id: jobId, approved_by: approver }, { status: 202 });
}
```

- [ ] **Step 5: Tests** (vitest, mock `@/lib/auth`, `@/lib/admin`, `@/lib/db`, `@aws-sdk/client-ssm`, `@aws-sdk/client-sqs`):
  - `route.test.ts`: non-admin → 403 on GET+POST; POST unknown action → 400; POST disabled action → 409; POST missing required input → 400; POST valid → 201 with `dryRun.mutates===false`, `idempotencyToken`, `expiresAt`, and `recordAudit('plan')` called.
  - `[id]/route.test.ts`: execute with `REMEDIATION_ENABLED!=='true'` → 503 (flag_off audit); execute with kill-switch off → 403; execute by the SAME principal who created → 403 (4-eyes); execute expired → 410; execute happy path (different approver, flag on, kill-switch on, action enabled) → 202 with `job_id`, `worker_jobs` insert + SQS send issued, `setApprovedAndExecuting` returned true, `recordAudit('execute','approved')`. cancel → canceled.
  - `remediation.test.ts`: `listCatalog`/`createPlan`/`setApprovedAndExecuting` SQL shape; `createPlan` returns a 5-min expiry; `setApprovedAndExecuting` SQL includes `created_by <> $2` and `expires_at > NOW()` and `status='planned'`.

---

## Task 10: Fargate executor CLI shim (CMD path) + image wiring

**Files:**
- Create: `scripts/v2/remediation/remediation_executor_cli.py`
- Modify: `scripts/v2/workers/Dockerfile`
- Test: `scripts/v2/remediation/test_remediation.py` (cli section)

- [ ] **Step 1: CLI shim** — the `RunCodeFargate` ASL command is `python remediation_executor_cli.py --job-id X --action Y`. Reuse `remediation_executor.lambda_handler` by building the event from argv.

```python
# scripts/v2/remediation/remediation_executor_cli.py
"""Fargate entrypoint for the P2-code remediation executor (long/composite/OOM-prone actions).
Args: --job-id <id> --action <name> [--phase execute|rollback]. Builds the lambda-style event and
delegates to remediation_executor.lambda_handler. CMD (not ENTRYPOINT) — the SFN command replaces CMD."""
import argparse
import remediation_executor as ex
import db


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job-id", required=True)
    ap.add_argument("--action", required=True)
    ap.add_argument("--phase", default="execute")
    args = ap.parse_args()
    conn = db.connect()
    try:
        job = db.get_job(conn, args.job_id) or {}
        payload = job["payload"] if isinstance(job.get("payload"), dict) else {}
    finally:
        conn.close()
    ex.lambda_handler({"job_id": args.job_id, "action": args.action, "phase": args.phase, "payload": payload}, None)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Dockerfile** — add the remediation modules to the worker image (still CMD).

```dockerfile
# scripts/v2/workers/Dockerfile — add after the existing COPY (keep CMD; do NOT add ENTRYPOINT)
COPY db.py handlers.py fargate_worker.py ./
# ADR-029+036 remediation P2-code executor (Fargate path). Same image; SFN command selects the module.
COPY ../remediation/action_catalog.py ../remediation/remediation_executor.py ../remediation/remediation_executor_cli.py ./
```

> Implementer note: Docker `COPY` cannot reach a parent dir of the build context. The workers build context is `scripts/v2/workers/`. Either (a) change the `make workers`/`scripts/v2/workers.mjs` build context to `scripts/v2/` and adjust paths, OR (b) copy the 3 remediation modules into `scripts/v2/workers/` at build time. Choose (b) for the skeleton (a pre-build `cp` in `workers.mjs`, gated on remediation files existing) to avoid disturbing the GREEN worker image path. Document the chosen approach in the commit.

- [ ] **Step 3: Test** — `ast.parse` the CLI; assert it imports `remediation_executor` and forwards `--phase`.

---

## Task 11: CONTROLLER — prove $0-when-off, apply migration, verify nothing live mutates

> Run by the controller (shared infra; subagent idle-timeout). **No `-auto-approve`.** This task PROVES the safety invariant before anything is enabled. Apply order: confirm No-changes (flag off) → migration v4 (in-VPC psql) → (optional, separate operator decision) flip the flag.

- [ ] **Step 1: Prove `$0` / No-changes with the flag OFF (the core safety gate).**

```bash
git checkout feat/v2-architecture-design && git branch --show-current   # must be feat/v2-architecture-design
terraform -chdir=terraform/foundation init -backend-config=backend.hcl
terraform -chdir=terraform/foundation validate
# remediation_enabled defaults false; do NOT set it. Expect: "No changes." (modulo the always-present
# data tables, which are NOT terraform-managed — they are applied via psql, see Step 2).
terraform -chdir=terraform/foundation plan -out tfplan
# REQUIRED OUTCOME: plan shows 0 to add / 0 to change / 0 to destroy for ALL remediation.* resources.
# If anything in remediation.tf appears in the plan, a count gate is wrong — STOP and fix before proceeding.
```

- [ ] **Step 2: Apply the Aurora migration v4 (in-VPC psql).** Harmless when the flag is off — creates empty tables + 3 disabled catalog rows, no infra, no execution.

```bash
PGPASSWORD="$(aws secretsmanager get-secret-value \
  --secret-id "$(terraform -chdir=terraform/foundation output -raw aurora_secret_arn)" \
  --query SecretString --output text | python3 -c 'import sys,json;print(json.load(sys.stdin)["password"])')" \
psql -v ON_ERROR_STOP=1 \
  "host=$(terraform -chdir=terraform/foundation output -raw aurora_endpoint) port=5432 dbname=awsops user=awsops_admin sslmode=require" \
  -f terraform/foundation/data/schema.sql
# verify migration + that EVERY seeded action is DISABLED:
psql "...dbname=awsops..." -c "SELECT version FROM schema_migrations ORDER BY version;"              # includes 4
psql "...dbname=awsops..." -c "SELECT name, executor_type, enabled FROM action_catalog ORDER BY name;" # 3 rows, enabled=f
psql "...dbname=awsops..." -c "SELECT count(*) FROM action_catalog WHERE enabled=true;"               # MUST be 0
```

- [ ] **Step 3: Verify the kill-switch defaults false (only meaningful once the flag is flipped — verify the value in code/plan now).** Confirm `aws_ssm_parameter.mutating_enabled` declares `value = "false"` + `ignore_changes=[value]`; confirm `web` execute route returns 503 (`flag_off`) when `REMEDIATION_ENABLED!=='true'` and 403 (`killswitch_blocked`) when the param is `false` — by running the web vitest suite:

```bash
cd web && npx vitest run app/api/actions lib/remediation.test.ts
# all green; the execute tests assert 503 (flag off) and 403 (kill-switch off / self-approval)
python3 -m pytest scripts/v2/remediation/test_remediation.py -q    # executors + ASL + schema asserts green
```

- [ ] **Step 4: Confirm nothing live mutates (negative verification).** With the flag off there is NO remediation SFN, NO SSM doc, NO Change template, NO audit bucket, NO kill-switch param — the substrate cannot be invoked. Prove it:

```bash
aws stepfunctions list-state-machines --query "stateMachines[?contains(name,'remediation')]"   # MUST be []
aws ssm list-documents --filters Key=Name,Values=awsops-v2-ec2-create-tags --query 'DocumentIdentifiers' # []
aws ssm get-parameter --name /ops/awsops-v2/mutating-actions/enabled 2>&1 | grep -q ParameterNotFound && echo "kill-switch absent (flag off) ✓"
```

- [ ] **Step 5: Commit (substrate OFF).** The deliverable is the skeleton, gated. Do NOT flip the flag.

```bash
git add terraform/foundation/{remediation.tf,variables.tf,workload.tf,data/schema.sql,workers.tf} \
        scripts/v2/remediation/ scripts/v2/workers/{dispatcher.py,reaper.py,status_updater.py,db.py,Dockerfile} \
        web/lib/remediation.ts web/app/api/actions/
git commit -m "feat(v2-p3/adr-029-036): remediation substrate skeleton — gated by remediation_enabled (default OFF; plan=No-changes; \$0; zero live mutation)"
```

- [ ] **Step 6 (OPTIONAL — separate operator decision, NOT part of shipping this plan):** Only if an operator explicitly accepts the first mutating capability: set `remediation_enabled=true` in tfvars → `plan -out tfplan` (controller reviews) → `apply tfplan` → flip the kill-switch (`aws ssm put-parameter --name /ops/awsops-v2/mutating-actions/enabled --overwrite --value true`) → enable ONE catalog row (`UPDATE action_catalog SET enabled=true WHERE name='opscenter-create-opsitem'`) → configure the Change Manager approver group (human IAM principals, excluding the AWSops task role) → end-to-end test plan→approve(by a DIFFERENT admin)→execute on the lowest-risk action. **This step is explicitly out of scope for the substrate build.**

---

## Self-Review

**Controls coverage (ADR-029's six controls + ADR-036 routing → task):**

| Control | Where satisfied | Task |
|---|---|---|
| 029 #1 Typed Action Catalog + per-action IAM decomposition | `action_catalog` table (facade) + per-runbook `AutomationAssumeRole` (SSM) + per-action STS task roles (lambda/fargate, NOT shared worker role — ADR-036 #3) | T2, T8 (steps 4–5), T3 |
| 029 #2 Two-step plan→execute + idempotency token (5-min, replay-safe) | `action_plans.idempotency_token UNIQUE` + `expires_at = NOW()+5min`; `/api/actions` POST=plan (no mutation), `/api/actions/[id]` POST=execute; P2 idempotency (execution name == job_id) | T2, T9 |
| 029 #3 Mandatory dry-run | `DryRunFirst` SFN state (always first) + catalog `dry_run_contract` + executor `dry_run`/runbook `DryRun` param + describe preflight | T7, T3/T4, T5 |
| 029 #4 4-eyes approval | `ApprovalWait` Task-Token (fail-closed timeout) + web execute `created_by <> approver` (SQL-atomic in `setApprovedAndExecuting`) + Change Manager `AutoApprove=false`, approvers exclude AWSops principal (ADR-036 #2) | T7, T9, T8 (step 6) |
| 029 #5 Rollback as a paired first-class plan; failure → MANUAL_INTERVENTION_REQUIRED (no infinite retry) | `action_plans.rollback_plan` (captured at plan time) + `Rollback` SFN state → on failure `ManualIntervention` terminal + `worker_jobs.status='manual_intervention'` (reaper never touches it) | T2, T7, T6 |
| 029 #6 Three audit sinks (S3 Object-Lock 1yr + Aurora authenticated-principal [sync] + CloudTrail [defense-in-depth, NOT sync gate]) | S3 Object-Lock GOVERNANCE 365d bucket + `remediation_audit` (principal=authenticated email/sub, NOT task role) written synchronously by web + executor; CloudTrail/SSM execution-history are intrinsic (not gated on) | T8 (step 2), T2, T9 |
| 029 #7 KEDA out-of-band | Out of scope (no KEDA action seeded; documented) | Out of scope |
| 029 #8 Cross-account = toggle | `ALLOW_CROSS_ACCOUNT_MUTATION` SSM param (default false) + dormant `TargetLocations` in `ssm_bridge.py` | T8 (step 1), T5 |
| 029 #9 Kill switch | `/ops/awsops-v2/mutating-actions/enabled` SSM (default false, ignore_changes) gated by `local.re`; checked in `action_catalog.gate` (executors) + web execute | T8 (step 1), T3, T9 |
| 036 routing: AWS-resource → SSM Automation + Change Manager | `ec2-create-tags` (executor_type='ssm') → SSM doc + Change template + AutomationAssumeRole + the SFN `ssm` branch (`startAutomationExecution` request-response + `.waitForTaskToken`/EventBridge status-change) | T2, T5, T7, T8 |
| 036 routing: K8s/app-state/composite/observability → P2 Lambda/Fargate code | `app-feature-flag-set` + `opscenter-create-opsitem` (executor_type='lambda') → `remediation_executor.py` w/ per-action role; observability write = reduced subset (ADR-036 #5) | T2, T4, T8 |
| 036 #1 P2 single front-door + ledger | web execute enqueues into `worker_jobs`+SQS (no direct SSM/SFN start); dispatcher routes; `AutomationExecutionId` written to `worker_jobs` on start; reaper reconciles | T6, T5 (record_ssm_start), T9 |

**Extend-not-duplicate (ADR-036 rule 1):** No new SQS/dispatcher/reaper/ledger. The ONE new orchestration resource is the sibling `awsops-v2-remediation` SFN (justified above). `worker_jobs` is the single ledger; `status_updater`/`db.py`/`reaper` are reused (extended additively for `manual_intervention`).

**Gating → $0 / No-changes when `remediation_enabled=false`:**
- *Always-present (data, $0, no execution):* the three Aurora tables (`action_catalog`, `action_plans`, `remediation_audit`) + the `worker_jobs` additive columns + the 3 seeded `enabled=false` rows. These are applied by psql (not Terraform); they cost nothing and run nothing.
- *Gated (`count = local.re`, absent when off):* the remediation SFN, SSM Automation doc, Change Manager template, `AutomationAssumeRole`, per-action STS task roles, S3 Object-Lock bucket, kill-switch + cross-account SSM params, EventBridge status-change rule, resume/executor/record-start/approval Lambdas, all remediation IAM + log groups, the web kill-switch-read policy, the web `REMEDIATION_ENABLED`/`MUTATING_ACTIONS_SSM` env (via `concat(..., var.remediation_enabled ? [...] : [])` → byte-identical web task def when off), and the dispatcher `REMEDIATION_STATE_MACHINE_ARN` env (via `merge(base, var.remediation_enabled ? {...} : {})` → byte-identical when off). With the flag off every one is `count=0`/`merge(.,{})`/`concat(.,[])` ⇒ `plan` = No changes (proven in T11 step 1).
- *Triple-lock even when the flag IS on:* nothing mutates until (flag on) AND (kill-switch SSM = true) AND (catalog row `enabled=true`) AND (a 4-eyes approval by a DIFFERENT admin). All four are independent and default-deny.

**Placeholder scan:** No "TBD"/"...". Every step has real HCL, SQL, TS, Python, YAML, or ASL JSON. Two explicit implementer adaptation notes are flagged (not placeholders): T8 step 8 ("copy the Lambda block 3× for record_ssm_start/approval_notifier/status_resume" — the template block is concrete) and T10 step 2 (Docker COPY-from-parent: choose option (b), a pre-build `cp` in `workers.mjs`). Both name the exact change.

**Type consistency:**
- `CatalogRow` defined once in `web/lib/remediation.ts`, consumed by both API routes. `executorType ∈ {'ssm','lambda','fargate'}` matches `action_catalog.executor_type` CHECK and the SFN `Route` Choice + dispatcher `executor_type`.
- `worker_jobs.status` values are the single source: migration v4 CHECK = `db._TERMINAL` widened set + `awaiting_approval`/`running`/`queued`. `set_manual_intervention` and `status_updater` `manual_intervention` flag agree.
- Idempotency: web `execute` enqueues `{job_id, type:'action', action, executor_type, plan_id, payload}`; dispatcher reads exactly those keys → SFN input `{job_id, plan_id, action, payload, dry_run, runtime}`; the SFN states read `$.job_id/$.plan_id/$.action/$.payload/$.runtime`. Names match end-to-end.
- SSM env keys (`EC2_CREATE_TAGS_DOC`, `ASSUME_ROLE_EC2_CREATE_TAGS`, `ACTION_ROLE_APP_FEATURE_FLAG_SET`, `ACTION_ROLE_OPSCENTER_CREATE_OPSITEM`, `MUTATING_ACTIONS_SSM`, `REMEDIATION_STATE_MACHINE_ARN`) are produced in `remediation.tf` `local.rem_env` and read by the Python (`ssm_bridge.py`, `remediation_executor.py`, `action_catalog.py`, `dispatcher.py`). The action-name → ENV-suffix transform is `upper().replace('-', '_')` consistently on both sides.
- Aurora access: web uses `getPool().query(sql, params)` (node-pg) gated on `process.env.AURORA_ENDPOINT`; Python uses `scripts/v2/workers/db.py` pg8000. No `isAuroraEnabled()` (does not exist in v2).
- Paths are v2: `terraform/foundation/*`, `scripts/v2/remediation/*`, `web/lib/remediation.ts`, `web/app/api/actions/*`. No `src/`, no `data/config.json`, no `/awsops` fetch prefix (fetch `/api/actions`). arm64 + CMD (not ENTRYPOINT) honored.

**Flag-off ⇒ $0 confirmed:** Yes — proven structurally (count/merge/concat gating) and operationally (T11 step 1 plan = No changes; step 4 negative verification: no SFN/doc/param exists). The migration tables are data-only and free.

**Task count:** 11 (10 implementation tasks + 1 CONTROLLER task).
