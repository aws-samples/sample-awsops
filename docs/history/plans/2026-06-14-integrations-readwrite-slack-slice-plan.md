# Plan: Integrations READ_WRITE — Slack governed-write vertical slice (ADR-040/041)

> First vertical slice of the data-write integration feature. Connector = **Slack message** (reuses ADR-012 approach). Governed by ADR-040 (7 conditions) under ADR-041 (data-write ≠ resource-mutation). Ships **flag-OFF**. Branch `fix/v2-upgrade-snapshot-id`.

## Goal
An agent can **propose** posting a Slack message (incident note / summary); a human **plans → approves (4-eyes) → executes** through the existing action gate; the message is **DLP-redacted + channel-allowlisted** before send. The model never writes directly. AWS-resource mutation stays frozen.

## Critical design decision — DECOUPLE from the frozen AWS-resource gate (ADR-040 §4)
The existing `/api/actions/[id]` execute gates on `REMEDIATION_ENABLED` (shared by AWS-resource actions) → reusing it as-is would un-freeze AWS-resource mutation. So:
- **New flag `INTEGRATIONS_WRITE_ENABLED`** (default OFF), separate from `REMEDIATION_ENABLED` (which stays permanently OFF / do-not-enable for AWS-resource).
- **Executor-class split by `target_resource_type` prefix `external:`**: an action is a *data-write* iff `target_resource_type` starts with `external:` (e.g. `external:slack`). The execute route gates a data-write action on `INTEGRATIONS_WRITE_ENABLED`; an AWS-resource action stays gated on `REMEDIATION_ENABLED`. The external executor **refuses** any non-`external:` action (defense-in-depth). → turning on data-write can NEVER enable AWS-resource mutation.
- Reuse the rest of the gate verbatim (admin + kill-switch + 4-eyes + not-expired + dry-run + audit + worker_jobs/SQS/dispatcher) — that's the value of the action_catalog facade (ADR-040 §3); only the flag + executor are new/scoped.

**Decoupling completeness (R1 gate — gemini/glm found these; all required for the slice to actually work AND stay safe):**
- **Executor INFRA count-gate (gemini CRITICAL):** `remediation.tf` count-gates the SM + executor Lambda on `var.remediation_enabled`. Keeping that OFF (to freeze AWS-resource) means the executor **doesn't exist** → the Slack slice can't run. Fix: count-gate the *shared executor infra* on `(var.remediation_enabled || var.integrations_write_enabled)`. **Infra existing ≠ AWS-resource enabled** — AWS-resource safety stays at the flag (`REMEDIATION_ENABLED` off) + `action_catalog.enabled=false`, NOT at infra-existence.
- **Executor-side flag (gemini CRITICAL):** the Python `action_catalog.py gate()`/`flag_enabled()` hardcodes `REMEDIATION_ENABLED`. The executor must branch the flag by `external:` prefix too (else it refuses the Slack job with flag_off). 
- **Strict prefix + mis-impl test (glm CRITICAL):** use `targetResourceType.startsWith('external:')` (NEVER `includes('external')`); add an explicit test that a NON-`external:` action gates on `REMEDIATION_ENABLED` even under a sloppy flag-branch, and the executor **refuses** a non-`external:` action before any side effect. → a data-write flag can never route an AWS-resource action.
- **Exfiltration = DLP + HUMAN backstop (glm CRITICAL, honest):** the DLP regex is **best-effort** (a determined prompt-injected agent could base64-encode). So: DLP applies to **ALL string fields** (text, channel, blocks, attachments) not just the body; AND the **mandatory human 4-eyes review of the dry-run preview is the real backstop** (a human sees the rendered message before any send); AND the agent has **no raw-secret-read tool** (integration read tools return observability data, not secret values); AND the channel allowlist bounds destinations. Documented as defense-in-depth, not a regex silver bullet — if insufficient in practice → ADR-040 Option-4 draft-only.

**TWO FULLY-INDEPENDENT CONTROL PLANES (R2 gate — kiro-opus found the flag-branch alone is insufficient; the env/kill-switch/IAM all currently couple to `remediation_enabled`). The data-write plane must NOT share ANY enabling control with the AWS-resource plane:**
- **Flag env tracks the VAR, not infra-existence (R2 CRITICAL-1):** `remediation.tf` hardcodes `REMEDIATION_ENABLED="true"` on the executor (safe today only because the infra is `count=0` when the var is false). After OR-gating the infra, that hardcoded env would make the AWS-resource flag-branch PASS. Fix: set `REMEDIATION_ENABLED = var.remediation_enabled` (dynamic — `"false"` when off) AND add `INTEGRATIONS_WRITE_ENABLED = var.integrations_write_enabled`, on BOTH the executor and the web task. AWS-resource branch reads the former (false), external branch the latter.
- **Separate kill-switch (R2 MAJOR):** the kill-switch is the shared SSM param `/ops/${project}/mutating-actions/enabled`. Add a SEPARATE `/ops/${project}/integrations-write/enabled`; the `external:` branch checks the new one, the AWS-resource branch keeps `mutating-actions/enabled`. Operating Slack must NEVER require turning the AWS-mutation kill-switch on.
- **Split executor IAM (R2 CRITICAL-2):** the executor role's `remediation_lambda_extra` policy grants `sts:AssumeRole` into AWS-action roles + `ssm:StartAutomationExecution` + `iam:PassRole`. The OR-gated external slice must grant ONLY `sts:AssumeRole` to the new Slack per-action role + `secretsmanager:GetSecretValue`/`kms:Decrypt` (inc2 integrations KMS); the SSM-automation / AWS-action-role-assume / PassRole statements stay `remediation_enabled`-only. The data-write executor role must carry ZERO AWS-mutation capability.
- **Web kill-switch env (R2 MAJOR):** `workload.tf` injects `MUTATING_ACTIONS_SSM` into the web task only under `remediation_enabled` → without it `killSwitchOn()` returns false → Slack execute 403s. Surface the external kill-switch param to the web task under `integrations_write_enabled` too.
- **Net invariant to test:** with `integrations_write_enabled=true` + `remediation_enabled=false` — Slack execute works (own flag+kill-switch+IAM); an AWS-resource action is denied at the flag (`REMEDIATION_ENABLED=false`) AND has no executor IAM AND its kill-switch is off. Defended on THREE independent axes, not by `action_catalog.enabled` alone.

## Non-goals (this slice)
- Other connectors (Jira/Notion/Confluence) — later slices, same pattern.
- AWS-resource mutation / autonomy — stays frozen (ADR-041).
- Un-freezing `REMEDIATION_ENABLED` — untouched.
- Autonomous writes — the model only *proposes*; a human gates every send.

## Tasks (TDD; per-task commit; web vitest + agent/py unittest green each task)

### Task 1: ULID migration — seed the Slack data-write action + channel allowlist
**Files:**
- Create: `terraform/foundation/migrations/<ULID>_integrations_write_slack.sql`
- Test: `scripts/v2/migrations-readwrite-slack.itest.mjs`
- [ ] Failing itest (PG17 container, mirror `migrations-p1.itest.mjs`): after apply, `action_catalog` has row `slack.post_message` (`executor_type='lambda'`, `target_resource_type='external:slack'`, `approval_mode='four_eyes'`, `enabled=false`, `dry_run_contract` with mode=preview, `rollback_ref=null`); re-run is a no-op (idempotent); `integrations` row for Slack carries an allowlist (reuse `source_allowlist` JSONB as the **channel allowlist** for egress-write, documented).
- [ ] Implement idempotent migration (`INSERT … ON CONFLICT (name) DO NOTHING`); `enabled=false` (do-not-enable). NO change to existing AWS-resource rows.
- [ ] Commit: `feat(agent-platform): RW-slice T1 — slack.post_message action_catalog seed (flag-off) + channel allowlist`.

### Task 2: egress DLP/redaction + channel allowlist (pure)
**Files:**
- Create: `web/lib/egress-dlp.ts`
- Test: `web/lib/egress-dlp.test.ts`
- [ ] Failing tests: `redactEgress(payload)` masks secrets-like tokens (AWS keys `AKIA…`/`ASIA…`, `aws_secret`, bearer/JWT, `arn:aws:…`, private IPs 10./172.16-31./192.168./169.254., **long base64/hex blobs** as an encoded-secret heuristic), applied to **ALL string fields** (text, channel, blocks/attachments — recurse), enforces a size cap (e.g. 3000 chars → truncate + marker); returns `{payload, redactions:[…]}`. `assertChannelAllowed(channel, allowlist)` throws on a channel not in the allowlist; empty allowlist ⇒ deny-all (fail-closed). Idempotent on already-clean text. **Test: a base64-encoded AWS key in any field is caught by the blob heuristic.**
- [ ] Implement (pure, no I/O). **Document the honest limit:** DLP is **best-effort** — the mandatory human 4-eyes review of the dry-run preview is the real exfiltration backstop (ADR-040 §2 + the panel dissent); regex catches the obvious, the human catches the subtle, the allowlist bounds destinations, and the agent has no raw-secret-read tool.
- [ ] Commit: `feat(agent-platform): RW-slice T2 — egress DLP/redaction + channel allowlist (ADR-040 §2)`.

### Task 3: /api/actions execute — decouple external data-writes + apply DLP
**Files:**
- Modify: `web/app/api/actions/[id]/route.ts`
- Modify: `web/lib/remediation.ts`
- Test: `web/app/api/actions/[id]/route.test.ts`
- [ ] Failing tests: for an action whose `target_resource_type` **`startsWith('external:')`** (strict — NOT `includes`), execute gates on **`INTEGRATIONS_WRITE_ENABLED`** (503 when off) — NOT `REMEDIATION_ENABLED`; an AWS-resource action (non-`external:`) still gates on `REMEDIATION_ENABLED` (unchanged); **explicit adversarial test: an action like `ec2-…`/`external-ec2-backdoor` (no `external:` prefix) MUST gate on `REMEDIATION_ENABLED`** (the prefix split can never route AWS-resource through the data-write flag); both paths still require admin + kill-switch + 4-eyes + not-expired; the enqueued `worker_jobs`/SQS payload for `external:slack` carries the **DLP-redacted (all fields)** message + channel (allowlist-checked at plan time); a channel not in the integration allowlist → 400 at plan, never enqueued.
- [ ] Implement: branch BOTH the flag AND the kill-switch by `action.targetResourceType.startsWith('external:')` — external: → `INTEGRATIONS_WRITE_ENABLED` + the external kill-switch param (`INTEGRATIONS_WRITE_SSM`); AWS-resource → `REMEDIATION_ENABLED` + `MUTATING_ACTIONS_SSM` (unchanged). `killSwitchOn()` takes the param name by branch. Apply `redactEgress` + `assertChannelAllowed` on the slack inputs at plan/execute; keep all other gates verbatim. Test: external execute with the external kill-switch OFF → 403; AWS-resource path still reads the mutating-actions kill-switch.
- [ ] Commit: `feat(agent-platform): RW-slice T3 — decouple external data-write flag + DLP at the action gate`.

### Task 4: Slack external executor (worker) + executor-side flag decouple + Python DLP port
**Files:**
- Create: `scripts/v2/remediation/external_slack_executor.py`
- Create: `scripts/v2/remediation/egress_dlp.py` (Python parity port of `web/lib/egress-dlp.ts`)
- Modify: `scripts/v2/remediation/remediation_executor.py` (route `target_resource_type='external:slack'` → this executor; precedent = `(c) opscenter-create-opsitem`)
- Modify: `scripts/v2/remediation/action_catalog.py` (gate(): branch the flag by `external:` prefix — see below)
- Test: `scripts/v2/remediation/test_external_slack_executor.py`, `scripts/v2/remediation/test_egress_dlp.py`
- [ ] **Executor-side flag + kill-switch decouple (gemini+opus CRITICAL):** `action_catalog.py gate()`/`flag_enabled()`/`killswitch_on()` hardcode `REMEDIATION_ENABLED` + `MUTATING_ACTIONS_SSM`; branch BOTH by `external:` prefix → `INTEGRATIONS_WRITE_ENABLED` + the external kill-switch param. Test both branches independently. **Relies on T6 making the executor's `REMEDIATION_ENABLED` env track `var.remediation_enabled` (not hardcoded "true") + injecting `INTEGRATIONS_WRITE_ENABLED` + the external kill-switch param.**
- [ ] **Python DLP port (gemini MAJOR):** `egress_dlp.py` mirrors `egress-dlp.ts` (same patterns: AWS keys/secret/JWT/arn/private-IP/base64-blob, all-fields recurse, size cap, channel allowlist). Test parity with the TS cases (same fixtures → same redactions).
- [ ] Failing tests (stdlib unittest, inject http+secrets): executor **refuses** any non-`external:` action (raises before any side effect); **re-applies `egress_dlp` redact + channel-allowlist** (defense-in-depth — never trusts the web layer); posts to Slack via token from Secrets Manager (mocked); dry-run returns the rendered preview WITHOUT posting; on success writes audit.
- [ ] Implement; reuse the ADR-012 Slack post shape (v1 `src/lib/slack-notification.ts`) ported minimally. Token via Secrets Manager (`ops/${project}/integrations/slack-*`).
- [ ] Commit: `feat(agent-platform): RW-slice T4 — Slack executor + executor-side flag decouple + Python DLP port`.

### Task 5: chat propose-only wiring (READ_WRITE → suggest action, never write)
**Files:**
- Modify: `web/app/api/chat/route.ts`
- Modify: `web/lib/agent-resolver.ts`
- Test: `web/app/api/chat/route.test.ts`, `web/lib/agent-resolver.test.ts`
- [ ] Failing tests: a `read_write` integration's `write_action_refs`/`exposedTools` **NEVER enter `toolAllowlist`** (no live write tool — gemini MINOR: the resolver tool-union must only ever see `capability==='read'` integrations); `read_write` is surfaced on a **SEPARATE propose-only channel** (action_name + inputs metadata) that the operator acts on via /api/actions; the existing egress-READ tool-injection path is byte-identical (read-only integrations still pass `capability==='read'` filter). Adversarial test: a `read_write` integration passed anywhere near the resolver does not add its tools to the live set.
- [ ] Implement: keep the chat→resolver tool-injection path filtered to `capability==='read'` (unchanged); add `read_write` propose-surfacing as a distinct map that does NOT flow into `resolveAgent`'s tool union. Document: the model proposes; humans gate every send.
- [ ] Commit: `feat(agent-platform): RW-slice T5 — chat surfaces READ_WRITE as propose-only (no live write tool)`.

### Task 6: terraform — INTEGRATIONS_WRITE_ENABLED flag + Slack secret + executor IAM + INFRA count-gate decouple
**Files:**
- Modify: `terraform/foundation/remediation.tf`, `terraform/foundation/variables.tf`, `terraform/foundation/workload.tf` (web env), `terraform/foundation/workers.tf` (dispatcher SM-ARN env)
- [ ] **Dispatcher SM-ARN env (R3 opus MAJOR — functional):** `dispatcher.py` DROPS every `action` job when `REMEDIATION_STATE_MACHINE_ARN` is empty, and `workers.tf:~407` injects it only under `var.remediation_enabled` → with iw=true/re=false the Slack job is silently dropped (fails-closed, no AWS mutation, but the slice is dead). Change that env to `(var.remediation_enabled || var.integrations_write_enabled) ? {…} : {}`; add a plan-assertion that the dispatcher gets the SM ARN under iw-only.
- [ ] `variable "integrations_write_enabled" { bool default false }`; `local.iw = var.integrations_write_enabled ? 1 : 0`; `local.re_or_iw = (var.remediation_enabled || var.integrations_write_enabled) ? 1 : 0`.
- [ ] **INFRA count-gate decouple (gemini CRITICAL-A):** the *shared* executor infra (SM, executor Lambda, audit bucket, dispatcher routing) → `count = local.re_or_iw`. AWS-resource-mutation-specific resources (SSM runbooks, `AutomationAssumeRole`, per-AWS-action roles) → keep `count = local.re`.
- [ ] **Flag env tracks the VAR (opus CRITICAL-1):** stop hardcoding `REMEDIATION_ENABLED="true"` on the executor/web — set `REMEDIATION_ENABLED = tostring(var.remediation_enabled)` (dynamic) AND add `INTEGRATIONS_WRITE_ENABLED = tostring(var.integrations_write_enabled)` on BOTH the executor task/lambda env and the web task.
- [ ] **Separate kill-switch (opus MAJOR):** new SSM param `/ops/${project}/integrations-write/enabled` (own resource, `local.iw`-gated, default disabled). Surface its name as `INTEGRATIONS_WRITE_SSM` to BOTH executor + web (web under `local.iw`, alongside the existing `MUTATING_ACTIONS_SSM` under `local.re`). The AWS-mutation kill-switch is untouched.
- [ ] **Split executor IAM (opus CRITICAL-2):** the OR-gated external slice grants the executor ONLY `sts:AssumeRole` → the new Slack per-action role + `secretsmanager:GetSecretValue` (`ops/${project}/integrations/slack-*`) + `kms:Decrypt` (inc2 integrations KMS) + the external-kill-switch `ssm:GetParameter`. The `ssm:StartAutomationExecution` / AWS-action-role `sts:AssumeRole` / `iam:PassRole` statements STAY `local.re`-only. The data-write executor role carries ZERO AWS-mutation capability.
- [ ] `terraform fmt` + `validate` clean; a targeted plan with ONLY `integrations_write_enabled=true` (remediation_enabled=false) creates the executor infra + external kill-switch + the scoped Slack IAM, and **0 AWS-resource-mutation resources / 0 AWS-mutation IAM statements** (verify the plan diff).
- [ ] Commit: `feat(agent-platform): RW-slice T6 — integrations_write_enabled flag + Slack secret IAM (apply deferred)`.

### Task 7: docs
**Files:**
- Modify: `docs/decisions/040-…md` (implementation note), `docs/superpowers/specs/2026-06-12-…md` (§7 P3 — Slack slice landed flag-off)
- [ ] Commit: `docs(agent-platform): RW-slice — Slack governed-write vertical slice recorded`.

## Apply / deploy (controller-gated, flag-OFF)
1. `make migrate` (Slack action row, enabled=false).
2. `terraform -target=<new flag/secret/IAM>` apply (0 destroy) — flags default OFF → no behavior change.
3. `make deploy` (web) + worker image if needed. **All flags OFF** — the slice is dark until owner enables `INTEGRATIONS_WRITE_ENABLED` + the action `enabled=true` + a channel allowlist.

## Verification
- web vitest green (+ new), agent/py unittest green, migration itest GREEN, tf validate.
- Flag-OFF: execute on a slack action → 503 (disabled). With flag ON + allowlisted channel + 4-eyes → posts a redacted message; a secret in the proposed text → redacted; a non-allowlisted channel → 400; a non-external action → still gated on REMEDIATION_ENABLED (frozen).

## Risks / reviewer pre-empts
- **Exfiltration (ADR-040 §2 / the dissent):** DLP redaction + channel allowlist + size cap + dry-run preview + human 4-eyes; redaction re-applied in the executor (never trust upstream). Residual → Option-4 draft-only fallback.
- **Decoupling correctness:** the `external:` prefix split + separate flag must guarantee AWS-resource mutation can NEVER be enabled by the data-write flag — explicit tests (T3) + executor refusal (T4).
- **ADR-012 ownership:** system notifications stay ADR-012 (one-way templated); this is agent-proposed governed writes — distinct path, reuses the client/credential only.
