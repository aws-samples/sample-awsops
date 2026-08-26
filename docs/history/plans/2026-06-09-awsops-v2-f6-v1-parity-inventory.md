# F6 — v1-Parity Inventory Fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. The authoritative per-type target columns are the table in `docs/superpowers/specs/2026-06-09-awsops-v2-f6-v1-parity-inventory-design.md`. Steps `- [ ]`. ec2 is already done — do NOT touch the ec2 entry.

**Goal:** Expand the 21 non-ec2 inventory types' sync SELECTs (→ rich `data` for the detail panel) + table columns to **v1 parity** per the spec table. No feature reduced vs v1.

**Invariants:** follow the spec's exclusions EXACTLY (s3 = arn only, no per-bucket Get*; rds/elasticache = NO CloudWatch metric JOIN; JSONB columns selected as objects not ::text); id_col/region_col unchanged; existing 22-type registry stays (only columns grow); 119 tests stay green; build clean.

---

### Task 1: `sync_lambda.py` — expand 21 SELECTs to v1-parity

**Files:** Modify `scripts/v2/steampipe/sync_lambda.py`

- [ ] **Step 1:** For each of the 21 non-ec2 types in the spec table, rewrite its `QUERIES["<type>"]` SQL to `SELECT <identity + target data columns> FROM <table> [ORDER BY <stable col>]`, using the spec's "target data SELECT" column list verbatim. Keep `id_col`/`region_col` unchanged. Add `(tags ->> 'Name') AS name` only where the spec lists `name` (ebs_volume, vpc, subnet, security_group, cloudfront). Select JSONB columns (ip_permissions, provisioned, origins, settings, key_schema, etc.) **as-is** (no `::text`). **s3 = add ONLY `arn`** (keep `name, region, account_id, creation_date, arn`; do NOT add versioning/policy/tags). **rds/elasticache = the spec's non-metric fields only** (NO cloudwatch metric join).
- [ ] **Step 2:** Sanity — `python3 -c "import ast; ast.parse(open('scripts/v2/steampipe/sync_lambda.py').read()); print('ok')"` + visually confirm all 22 keys still present (ec2 unchanged) and each value is a 3-tuple.
- [ ] **Step 3: Commit** — `git add scripts/v2/steampipe/sync_lambda.py && git commit -m "feat(v2-f6): expand 21 inventory sync queries to v1-parity detail fields (+arn/tags, JSONB as objects); s3 arn-only (deny-safe), rds/elasticache metrics excluded (F5)"`

---

### Task 2: `inventory-types.ts` — expand table columns to v1 `list`

**Files:** Modify `web/lib/inventory-types.ts`, `web/lib/inventory-types.test.ts`

- [ ] **Step 1:** For each of the 21 non-ec2 types, set `columns` to the spec's "table columns" list (`{key,label}` each; resource_id+region are auto-prepended by the page). Add a `name` column where the spec lists it. Keep `group`/`stateKey`/`distKey` as-is.
- [ ] **Step 2:** Keep `inventory-types.test.ts` green (22 types, each `columns.length>0`, key/label non-empty). Add no new failing assertion. Run `cd web && npx vitest run lib/inventory-types.test.ts`.
- [ ] **Step 3: build + full test** — `cd web && npm run test && npm run build` green.
- [ ] **Step 4: Commit** — `git add web/lib/inventory-types.ts web/lib/inventory-types.test.ts && git commit -m "feat(v2-f6): expand inventory table columns to v1 list parity (name/arn-era fields per type)"`

---

### Task 3: Re-sync all + deploy + verify (CONTROLLER)
- [ ] **Step 1:** full gate `cd web && npm run test && npm run build`.
- [ ] **Step 2:** `terraform plan -out` (visible) → `apply` (inv_sync Lambda code update from Task 1). 
- [ ] **Step 3:** invoke `{type:"all"}` → wait ~90s → query `inventory_sync_runs`: **all 22 succeeded?** Any `failed` → read its `error`, fix that type's SELECT in sync_lambda.py (drop the offending column / adjust), re-apply + re-invoke that type. (Expected risk: a per-resource-API-heavy or deny-prone column.) Spot-check 3 types' `data` field counts ⊇ v1.
- [ ] **Step 4:** `make deploy` (table columns). Edge check `/inventory/<type>` 302. Report GREEN + per-type field counts.

---

## Self-Review
- Covers all 21 non-ec2 types to v1 detail+list parity per the spec table; ec2 already done.
- Safety exclusions honored (s3 deny, rds/elasticache live-metrics) — documented as NOT reductions.
- Re-sync is the live gate; per-type failure is isolated + fixable.
