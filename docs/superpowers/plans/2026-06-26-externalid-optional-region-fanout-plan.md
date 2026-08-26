# ExternalId-optional + Steampipe All-Region Inventory Fan-out — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Implement task-by-task; each task is failing-test-first. Steps use `- [ ]`.

**Goal:** Close the two v1-parity gaps on cross-account access — (1) make ExternalId OPTIONAL (1st-party), (2) make Steampipe inventory fan out across all enabled accounts × regions — building on the already-merged `account_regions` model.

**Architecture:** Spec = `docs/superpowers/specs/2026-06-26-externalid-optional-and-region-fanout-design.md` (panel-reviewed). Read-only inventory broadening only; ADR-005 (mutation/autonomy) untouched. ExternalId-optional is a security-posture change → ADR-011 + BASELINE updated first.

**Tech Stack:** Next.js 14 (Vitest), node-pg, Aurora SQL migrations (ULID), Steampipe 0.22 (aws.spc + entrypoint), Python (sync_lambda, render_spc), Terraform.

---

## Tasks

### Task 1: ADR-011 + BASELINE governance update

**Files:**
- Modify: `docs/decisions/011-multi-account.md`
- Modify: `docs/decisions/BASELINE.md`

- [ ] Modify `docs/decisions/011-multi-account.md`: state ExternalId is OPTIONAL for 1st-party accounts whose target trust policy **pins the exact AWSops task-role ARN** (never account-root/org/wildcard); REQUIRED for 3rd-party/shared/wildcard principals. Keep the confused-deputy rationale. Include both trust-policy variants inline (the in-repo CFN template (infra/cfn/awsops-target-account-role.yaml) is updated to make ExternalId optional + trust both host task roles) and state the 1st/3rd-party distinction is **administrative (trust-policy-enforced), not code-enforced**.
- [ ] Modify `docs/decisions/BASELINE.md`: update the ExternalId line in the invariant/register to match (anti-drift).
- [ ] Doc-only task (`test_required:false`): verify both files mention "1st-party", "optional", and "pins … task-role ARN", and stay internally consistent.

### Task 2: Drop external_id_required_for_target constraint

**Files:**
- Create: `terraform/foundation/migrations/01KW2EXTIDOPT0000000000000_externalid_optional.sql`
- Test: `web/lib/accounts.test.ts`

- [ ] Add a failing assertion (in `web/lib/accounts.test.ts` or a SQL-shape test) that a target account row with `external_id IS NULL` is accepted (constraint gone).
- [ ] Create the migration: `ALTER TABLE accounts DROP CONSTRAINT IF EXISTS external_id_required_for_target;` (idempotent); (accounts is migration-defined — schema.sql baseline intentionally omits it, see its line ~244 note, so no baseline change).
- [ ] Confirm the test passes.

### Task 3: Accounts BFF — ExternalId optional

**Files:**
- Modify: `web/app/api/accounts/route.ts`
- Test: `web/app/api/accounts/route.test.ts`

- [ ] Add a failing test in `web/app/api/accounts/route.test.ts`: POST add-account with empty `externalId` returns ok (mock STS assume succeeds) and persists `external_id = NULL`; with-externalId path unchanged. Remove/replace the `400 missing externalId` test.
- [ ] Run `npm test -- app/api/accounts/route.test.ts --run`; confirm failure.
- [ ] Modify `web/app/api/accounts/route.ts`: drop the required guard; pass `ExternalId` to the verify AssumeRole only when non-empty; insert `externalId || null`.
- [ ] Re-run targeted test; confirm pass.

### Task 4: aws-assume — conditional ExternalId

**Files:**
- Modify: `web/lib/aws-assume.ts`
- Test: `web/lib/aws-assume.test.ts`

- [ ] Add failing tests in `web/lib/aws-assume.test.ts`: assume WITHOUT externalId omits the `ExternalId` param and succeeds; WITH externalId includes it; cache keys distinct.
- [ ] Run `npm test -- lib/aws-assume.test.ts --run`; confirm failure.
- [ ] Modify `web/lib/aws-assume.ts`: replace `if (!acct.externalId) throw` with conditional inclusion.
- [ ] Re-run; confirm pass.

### Task 5: Accounts page — ExternalId optional UI

**Files:**
- Modify: `web/app/accounts/page.tsx`

- [ ] Modify `web/app/accounts/page.tsx`: ExternalId input no longer required; add helper text ("Optional — required only if the target role's trust enforces sts:ExternalId").
- [ ] UI task (`test_required:false`): confirm no required-attribute/validation blocks empty submit; existing page tests (if any) still pass.

### Task 6: account_regions — all-regions semantics

**Files:**
- Create: `terraform/foundation/migrations/01KW2ALLRGN00000000000000_accounts_all_regions.sql`
- Modify: `web/lib/account-regions.ts`
- Test: `web/lib/account-regions.test.ts`

> **Note (gate fix):** a `*` value is **invalid** — `account_regions.region` has CHECK
> `region ~ '^[a-z]{2}-[a-z]+-[0-9]+$'`. Use a boolean **`all_regions` column on
> `accounts`** (NOT a sentinel region row), which needs a migration.

- [ ] Create migration `…_accounts_all_regions.sql`: `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS all_regions boolean NOT NULL DEFAULT false;` (M1: do not flip existing explicit-region accounts) (idempotent); accounts is migration-defined (not in schema.sql baseline by design) so no baseline change.
- [ ] Add failing tests in `web/lib/account-regions.test.ts`: `listScanScope()` returns `["*"]` when `accounts.all_regions` is true, the explicit enabled `account_regions` set when false, and **skips** an account with `all_regions=false` and an empty enabled set (not `["*"]`).
- [ ] Run `npm test -- lib/account-regions.test.ts --run`; confirm failure.
- [ ] Modify `web/lib/account-regions.ts`: add `listScanScope()` reading the `all_regions` flag; all_regions defaults to false (explicit opt-in); existing explicit account_regions selections are preserved.
- [ ] Re-run; confirm pass.

### Task 7: Steampipe render_spc + entrypoint + Dockerfile

**Files:**
- Create: `scripts/v2/steampipe/spc_render.py`
- Create: `scripts/v2/steampipe/gen_spc_entrypoint.py`
- Modify: `scripts/v2/steampipe/Dockerfile`
- Test: `scripts/v2/steampipe/test_spc_render.py`

> **Note (gate fix):** use a **single Python entrypoint** (connect via `pg8000` →
> render → `os.execvp` steampipe), NOT a bash script that parses SQL-client stdout
> (brittle). `pg8000` is already used by `sync_lambda`.

- [ ] Create failing tests in `scripts/v2/steampipe/test_spc_render.py` for `render_spc(rows)`: host-only (no role_arn/external_id), non-host with/without external_id, multi-region list, all-regions→`["*"]`, empty enabled set → connection skipped, name `aws_<account_id>`, HCL escaping, aggregator block present.
- [ ] Run the python test; confirm failure.
- [ ] Create `scripts/v2/steampipe/spc_render.py` with pure `render_spc(rows) -> str`.
- [ ] Create `scripts/v2/steampipe/gen_spc_entrypoint.py`: read Aurora (env `AURORA_ENDPOINT`/`AURORA_DATABASE` + secret via env injected by task-def `secrets`), query accounts⋈account_regions, call `render_spc`, write `aws.spc`, bounded retry then fail-closed on Aurora-unreachable, then `os.execvp("steampipe", ["steampipe","service","start","--database-listen","network","--database-port","9193","--foreground"])`.
- [ ] Modify `scripts/v2/steampipe/Dockerfile`: add `pg8000` (pip); replace static `COPY aws.spc` + direct ENTRYPOINT with `ENTRYPOINT ["python3","/app/gen_spc_entrypoint.py"]`.
- [ ] Re-run render tests; confirm pass.

### Task 8: Steampipe terraform — env, IAM, SG

**Files:**
- Modify: `terraform/foundation/steampipe.tf`
- Test: `tests/structure/test-steampipe-fanout.sh`

- [ ] Create a failing structure test `tests/structure/test-steampipe-fanout.sh` asserting `steampipe.tf`: (a) adds `AURORA_ENDPOINT`/`AURORA_DATABASE` env + the **Aurora master secret as a task-def `secrets`/valueFrom entry** on the steampipe task (alongside `STEAMPIPE_DATABASE_PASSWORD`); (b) the execution role can read the Aurora secret (the shared `execution_secrets` policy already covers it — assert it's wired, don't duplicate); (c) scopes the steampipe **task role** `sts:AssumeRole` to `role/AWSopsReadOnlyRole`; (d) opens Aurora SG ingress 5432 from the steampipe task SG — all `steampipe_enabled`-gated.
- [ ] Modify `terraform/foundation/steampipe.tf` accordingly (Aurora secret via task-def `secrets`/execution role; new task-role `sts:AssumeRole` policy; SG ingress in-place with description unchanged — SG description is immutable).
- [ ] Run `terraform -chdir=terraform/foundation validate` and the structure test; confirm pass.

### Task 9: sync_lambda — account scoping + pushdown

**Files:**
- Modify: `scripts/v2/steampipe/sync_lambda.py`
- Test: `scripts/v2/steampipe/test_sync_lambda_queries.py`

- [ ] Add failing tests in `scripts/v2/steampipe/test_sync_lambda_queries.py`: run-ledger upsert + stale-delete key by the row's real `account_id` (not `'self'`); cross-account same-resource-id rows coexist (PK isolation); `ebs_snapshot` owner pushdown is per-account.
- [ ] Run the python test; confirm failure.
- [ ] Modify `scripts/v2/steampipe/sync_lambda.py`: replace the `account_id='self'` literals in the ledger/stale-delete with per-row account scoping; make the ebs pushdown per-connection/per-account.
- [ ] Re-run; confirm pass.

---

## Verification

- `tests/run-all.sh` green on main after each task.
- ExternalId: add account with/without ExternalId both verify; NULL persisted when empty.
- Inventory: with ≥1 target account + multiple regions enabled, `inventory_resources` shows rows for all, attributed to the correct `account_id`, stale rows pruned per-account.
- ADR-011 + BASELINE consistent; ADR-005 untouched; all steampipe infra `steampipe_enabled`-gated.
