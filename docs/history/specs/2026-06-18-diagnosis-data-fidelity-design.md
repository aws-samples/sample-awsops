# Design — AI Diagnosis data fidelity (stop the generic, infra-blind reports)

> Date 2026-06-18 · Branch `fix/v2-diagnosis-data` (worktree) · Owner session: AI-diag.
> Symptom (user): v2 diagnosis output is **always ~the same and does not match my actual infra** —
> unlike v1. Not hardcoded — the LLM simply receives almost no specifics about the account.

## Root cause

`render_section` feeds each section ONLY the `data` from its declared `sources`. The `inventory`
source feeds **almost every section** (executive_summary, security_posture, network, compute,
database, recommendations, and most deep sections) — but `collect_inventory()` returns ONLY
**counts by type** (`SELECT resource_type, count(*) … GROUP BY resource_type`). It throws away the
rich per-resource `data` JSONB (region, state, encryption, MFA, public-exposure, runtime, instance
type, …) that the live `/inventory` pages use. So the LLM sees "you have N ec2, M ebs" and nothing
specific → it fills the gap with generic AWS advice that's identical run-to-run.

Two concrete bugs compound it:
1. **`collect_cw_metrics` resource_type mismatch** — it looks for instance ids in
   `resource_type IN ('ec2_instance','aws_ec2_instance','instance')`, but the synced type is **`ec2`**
   (per `web/lib/inventory-types.ts` + `/api/inventory` queries). → always 0 ids → CPU metrics
   **permanently empty** ("no ec2 instance ids in inventory").
2. **No `account_id='self'` filter** in `collect_inventory`/`collect_cw_metrics`, while the web
   inventory consistently scopes `account_id='self'` — risks counting stale/other-account rows.

Most other collectors (cost / X-Ray service_map / Security Hub posture / CloudTrail) are
account-dependent and frequently degrade, but the keystone gap is the **inventory detail**.

## Goal

Feed the diagnosis LLM the **actual resources** of the account (bounded + PII-redacted), fix the
metric-collection bug, and make data coverage **visible** so a thin report is self-explaining rather
than mysteriously generic. Read-only throughout (no new AWS mutation, no new IAM).

## Changes

### 1. `collect_inventory(conn)` — return real resource detail (keystone)
- Scope `WHERE account_id='self'` (align with the web inventory).
- Keep `by_type` counts (cheap top-line signal).
- ADD a bounded `resources` sample: per resource_type, up to `DIAG_INV_PER_TYPE` (default 15) rows
  projecting `resource_id, region, data` (the rich JSONB). Parse `data` if pg returns it as text.
  Enforce a global byte cap `DIAG_INV_MAX_BYTES` (default ~24KB) — once exceeded, stop adding detail
  and note truncation (so a 5000-resource account can't blow the context/token budget).
- Result shape: `{by_type:{...}, resources:{<type>:[{resource_id,region,data},…]}, truncated:bool}`.
- **[P2 gate] Field-filter sensitive data AT THE COLLECTOR** (not just post-hoc `_redact`, which
  misses custom secrets): a `_safe_data()` helper drops denylisted keys (`environment`, `env`,
  `variables`, `user_data`, `policy`, `policy_document`, `inline_policies`, + any
  `password|secret|token|credential` key) and truncates string values >500 chars, before the row
  enters the result. `_redact` (report.py) remains the second layer.
- **[P2 gate] pg8000 named params**: `conn.run("… resource_type = :rtype …", rtype=t)` — NOT `$1`,
  never string-interpolate the type (injection-safe).

### 2. `collect_cw_metrics(conn)` — fix the instance lookup
- `resource_type = 'ec2'` (was the never-matching `('ec2_instance','aws_ec2_instance','instance')`),
  `account_id='self'`. Everything else (CloudWatch get_metric_data, graceful degrade) unchanged.

### 3. Surface data coverage in the report
- `report.generate`/`build_markdown` append a short **"데이터 커버리지 / Data coverage"** note listing
  each collector as `ok | degraded(reason) | empty`, so a reader sees exactly what the LLM did/didn't
  have. Turns a silent generic report into an explained one. (The `degraded` list already exists in
  `generate`; just render it.)

### Out of scope
- New collectors / new AWS APIs / new IAM (read-only, same perms).
- Changing the LLM prompts beyond what's needed to consume the new detail (prompts already say
  "데이터에 근거 — 추측 금지"; richer data makes that bite).
- v1 parity beyond data fidelity; the section set/tiers stay as-is.

## Testing
- `collect_inventory`: with a fake conn returning typed rows + `data`, asserts `resources` is
  populated per type, `account_id='self'` is in the SQL, the byte cap truncates, and counts still work.
- `collect_cw_metrics`: asserts the query uses `resource_type = 'ec2'` (not `ec2_instance`) and that
  ids found → metrics requested; no ids → graceful empty.
- coverage note: a report with a degraded collector renders the coverage line.
- All collectors still NEVER raise (degrade-only contract preserved).

## Deploy
Worker-image change → `make workers` (arm64 build/push) after merge; no terraform/apply (the worker
task def + IAM are unchanged — same read-only perms). Diagnosis runs pick it up on next invocation.
