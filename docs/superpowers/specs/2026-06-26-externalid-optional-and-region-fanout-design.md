# Design: ExternalId-optional + Steampipe all-region inventory fan-out

- **Date**: 2026-06-26
- **Branch**: `feat/v2-externalid-optional-region-fanout` (off `feat/v2-architecture-design`)
- **Status**: Draft, revised after multi-AI panel review (codex / agy / kiro). Verified
  corrections folded in: schema CHECK-constraint migration + ADR-011 governance (Gap 1);
  account-id connection naming, region-sentinel semantics, Aurora-boot env + fallback,
  sync_lambda account scoping, and dropping the BFF→ECS regen mutation (Gap 2).

## Context & motivation

v1's account connection was simpler than v2's: you connected an IAM role (no
ExternalId) and Steampipe queried **all regions** (`regions = ["*"]`). v2
regressed on both axes — ExternalId is mandatory, and inventory is hardcoded to a
single region (`ap-northeast-2`).

The multi-region **model + UI** is already shipped on `feat` (the
`account_regions` table, `/api/accounts/regions` route, `lib/account-regions.ts`,
and the accounts-page scope selector — merged via PR #108/#109). This spec covers
**only the two remaining gaps** needed for v1 parity. It does not re-design the
already-merged region model.

## Goals (the two gaps)

1. **ExternalId optional** — add/verify a cross-account connection without an
   ExternalId (the 1st-party case). When an ExternalId *is* supplied, behavior is
   unchanged (passed to `AssumeRole`, enforced by the target role's trust policy).
2. **Steampipe all-region + multi-account inventory fan-out** — inventory /
   security / compliance read across **all enabled accounts × their enabled
   regions** (from `account_regions`), like v1's `regions = ["*"]`, by generating
   the Steampipe connection config at container start.

## Non-goals

- AgentCore live-query (chat) multi-region fan-out — separate effort "C".
- Re-designing the `account_regions` model/UI (already shipped).
- Any AWS-resource mutation. This broadens **read-only** inventory only; ADR-005
  (mutation/autonomy FROZEN) is untouched.

---

## Gap 1 — ExternalId optional

### Changes

- **`web/app/api/accounts/route.ts`**
  - Remove the `if (!externalId) return err('externalId is required …', 400)`
    guard (line ~42).
  - Pass `ExternalId` to the verification `AssumeRoleCommand` **only when
    non-empty**.
  - Coerce empty → `NULL` **explicitly** (`externalId || null`) before the INSERT —
    an empty string would persist `''` (not `NULL`), still satisfy the CHECK below,
    and later be sent as a blank `ExternalId`. [agy]
- **`web/lib/aws-assume.ts`**
  - Replace `if (!acct.externalId) throw …` (line ~32) with a conditional:
    include `ExternalId` in the `AssumeRoleCommand` only when present; otherwise
    assume without it. The cache key already concatenates `arn | externalId`
    (empty segment when absent), so no cache-collision risk.
- **`agent/lambda/cross_account.py`** — already conditional
  (`if _EXTERNAL_ID: assume_params['ExternalId'] = _EXTERNAL_ID`). No change;
  covered by a regression assertion.
- **`web/app/accounts/page.tsx`** — ExternalId input no longer required (drop the
  required marker / client-side block). Helper text: *"Optional — required only
  if the target role's trust policy enforces `sts:ExternalId` (recommended for
  3rd-party / shared accounts)."*

### Schema constraint + governance (CORRECTED after panel review)

- **A migration IS required** (the original spec was wrong to claim none). The
  `accounts` table has `CONSTRAINT external_id_required_for_target CHECK (is_host OR
  external_id IS NOT NULL)` (`migrations/01KVGR8ER0Y8RX3TG07B9G86C5_accounts.sql:21`).
  Persisting `NULL` for a target account violates it. Add an idempotent ULID-named
  migration that **drops/replaces** this constraint (drop it outright, or replace with
  a softer documentation-only check). [codex]
- **ADR-011 update is mandatory in the same PR.** `docs/decisions/011-multi-account.md`
  states *"ExternalId required (confused-deputy mitigation — mandatory, not optional)."*
  Making it optional is a **security-posture decision**, not a code tweak: it requires
  amending ADR-011 + the `BASELINE.md` register in the same PR (anti-drift rule), and
  the no-ExternalId path must be explicitly labeled **1st-party only**. [codex, kiro]
- **1st-party safety condition**: omitting ExternalId is safe only when the target
  role's trust policy pins the **exact AWSops task-role ARN** (not account root / org /
  wildcard). Document this; provide/keep a CFN trust-policy variant that omits the
  `sts:ExternalId` condition for 1st-party onboarding and one that includes it for
  3rd-party. [kiro]

### Behavior

- Add account, **no** ExternalId → verify runs `AssumeRole` without `ExternalId`
  → succeeds iff the target trust policy has no `sts:ExternalId` condition →
  stored `verified`, `external_id = NULL`.
- Add account **with** ExternalId → unchanged from today.

### Tests

- `web/app/api/accounts/route.test.ts` — add-account success with no externalId
  (mock STS assume OK); existing with-externalId path still passes; empty string
  persists as `NULL`.
- `web/lib/aws-assume.test.ts` — assume **without** externalId omits the
  `ExternalId` param; **with** externalId includes it; cache keys stay distinct.

---

## Gap 2 — Steampipe all-region / multi-account inventory fan-out

Decisions taken in brainstorming: **① entrypoint self-generates `aws.spc`**;
**② inventory covers all enabled regions** (the form's per-account region is only
a default/display value).

### Approach

Replace the baked static `aws.spc` with a config generated at container start
from Aurora — the same mechanism class v1 used (Steampipe connection config), so
**no inventory SQL changes**.

- **`scripts/v2/steampipe/Dockerfile`**
  - Add a minimal Postgres client for the entrypoint (`python3` + `pg8000`, or
    `postgresql-client`).
  - Replace the static `COPY aws.spc …` + direct `steampipe service start`
    ENTRYPOINT with a wrapper `gen-spc-and-start.sh`.
- **`scripts/v2/steampipe/gen-spc-and-start.sh`** (new)
  1. Read Aurora creds from the secret ARN env (same secret the sync path uses);
     connect.
  2. Query enabled accounts joined to their enabled regions:
     ```sql
     SELECT a.account_id, a.alias, a.role_name, a.external_id, a.is_host,
            COALESCE(array_agg(r.region) FILTER (WHERE r.enabled), '{}') AS regions
       FROM accounts a
       LEFT JOIN account_regions r ON r.account_id = a.account_id
      WHERE a.enabled
      GROUP BY a.account_id, a.alias, a.role_name, a.external_id, a.is_host;
     ```
  3. Render `/home/steampipe/.steampipe/config/aws.spc`:
     - One connection per account, **named `aws_<account_id>`** (not the alias —
       aliases aren't unique and can sanitize to collisions/empty). The 12-digit
       account id is already a valid, unique connection-name suffix. [codex, agy, kiro]
       `connection "aws_<account_id>" { plugin = "aws@0.142.0"; regions = [<regions, see below>]; ` then for **non-host**: `role_arn = "arn:aws:iam::<acct>:role/<role_name>"` and, only when set, `external_id = "<value>"` `}`.
       Host account uses the task role's default chain (no `role_arn`).
     - **HCL-escape every rendered value** (`external_id`, `role_name`, region ids) —
       render via a quoting helper, never raw string-concat. [codex]
     - **Region semantics** (the naive `["*"]`-when-empty fallback is backwards — it
       would make "disable all regions" scan *everything*). Use an explicit model:
       a per-account `all_regions` flag (or sentinel row) means `regions = ["*"]`;
       otherwise `regions = [<enabled account_regions>]`; an account with an empty
       enabled set is **skipped** (no connection), not expanded to `*`. v1 "all-region"
       parity = setting `all_regions` (the default for a freshly-added account). [codex]
     - Aggregator so existing `aws.*` queries transparently span every account +
       region: `connection "aws" { type = "aggregator"; connections = ["aws_*"] }`.
  4. `exec steampipe service start --database-listen network --database-port 9193 --foreground`.
- **Boot failure mode** — if Aurora is unreachable at container start, bounded
  retry/backoff, then fail-closed with a clear log + (optionally) the CloudWatch alarm
  the steampipe service already has. Do **not** silently start with an empty/stale
  config. [codex, kiro]
- **`terraform/foundation/steampipe.tf`** — all `steampipe_enabled`-gated. The
  task today has only `AWS_REGION` env + `STEAMPIPE_DATABASE_PASSWORD` secret (its own
  DB password), so the entrypoint cannot reach Aurora yet. Add:
  - **Task-def env/secrets for Aurora**: `AURORA_ENDPOINT`, `AURORA_DATABASE`, and the
    Aurora secret. Prefer injecting the secret via the task def `secrets`/`valueFrom`
    (resolved by the **execution role**) over `boto3`/awscli in the container. [codex, agy]
  - **`sts:AssumeRole` scoped to `arn:aws:iam::*:role/AWSopsReadOnlyRole`** (the role
    name is hardcoded in `route.ts`), not a wildcard role name. [codex, agy]
  - **Aurora SG ingress 5432 from the steampipe task SG** — VPC membership alone does
    not open DB ingress; add the rule (in-place, immutable SG description). [agy]
- **Regen trigger** — **do NOT** call `ecs:UpdateService --force-new-deployment` from
  the web BFF: that is live control-plane mutation from the app runtime and violates
  the v2 read-only / ADR-005 posture. [codex] Instead regenerate **eventually** — the
  entrypoint re-reads Aurora on the next task restart/deploy — or via a
  controller/admin-operated path **outside** the BFF (e.g. the existing reaper/sync
  cadence triggering a restart, or a manual `make` target). Immediacy is the only thing
  lost; new regions appear on next steampipe task cycle.
- **`scripts/v2/steampipe/sync_lambda.py`** — **SQL change IS required** (the original
  spec was wrong to say none). Today the sync hardcodes `account_id='self'` for the
  run-ledger upsert and the stale-delete (`sync_lambda.py:511,540,543,545,549`). Under
  multi-account aggregator fan-out this (a) never prunes stale target-account rows and
  (b) mis-keys the per-type sync run. Rework to key the run ledger + stale-delete by the
  **real per-row `account_id`** returned by each connection (the `inventory_resources`
  PK already includes `account_id`, so inserts are collision-safe — only the
  bookkeeping/delete scoping is broken). [codex]
  - **Per-account pushdown queries**: the `ebs_snapshot` query injects
    `_caller_account()` into `owner_id = '{account_id}'`; under an aggregator this
    filters every connection by the host account and misses target snapshots. Make
    account-scoped pushdowns per-connection/per-account (or drop the literal pushdown).
    [codex]
  - Result volume grows ≈ (#accounts × #regions) — acceptable, bounded by
    `steampipe_enabled`.

### Tests

- Pure render function `render_spc(rows) -> str` unit tests:
  - host-only (no `role_arn`, no `external_id`);
  - non-host **with** `external_id`;
  - non-host **without** `external_id` (line omitted);
  - multi-region list rendering;
  - `all_regions` flag → `["*"]`; empty enabled set → connection **skipped**;
  - connection name = `aws_<account_id>` (no alias collision);
  - HCL escaping of values.
- Migration test: drop/replace of `external_id_required_for_target` (idempotent).
- `sync_lambda` tests: run-ledger + stale-delete keyed by **real account_id**;
  cross-account resource-id collision is isolated by PK; `ebs_snapshot` pushdown
  per-account.
- Boot-failure test: Aurora unreachable → bounded retry then fail-closed.

### Dependency & migrations (CORRECTED)

- Builds on `account_regions`, already in `feat` (PR #109).
- **A migration IS needed** — drop/replace `external_id_required_for_target` (Gap 1).
  If the `all_regions` model uses a new column/sentinel, that is a second idempotent
  ULID migration (Gap 2).

---

## Rollout & safety

- Entirely read-only; no AWS-resource mutation (ADR-005 untouched). Broadening
  regions only increases inventory reads. Cost: more Steampipe queries; bounded by
  the `steampipe_enabled` gate (live = true).
- Region semantics (corrected): the **host** always scans all regions (`["*"]`); a
  **target** with `all_regions=false` and no enabled `account_regions` is **skipped**
  (NOT expanded to `["*"]`). `all_regions` defaults to false so existing explicit-region
  selections are preserved.
- **Out of scope / follow-up**: readers (`web/lib/inventory.ts`, `security-findings.ts`,
  topology) still query `account_id='self'`, so TARGET-account inventory is written but
  not yet surfaced in the UI — a separate reader PR makes it visible. The SDK syncs
  (`s3_public_access`, `alb_listener_rule`, `cloudfront_vpc_origin`) remain host/single-region.
- ExternalId change is backward compatible: existing accounts keep their stored
  ExternalId and continue to send it.

## Out of scope / follow-ups

- AgentCore chat live-query multi-region ("C").
- Confirm Powerpipe/compliance inherits the aggregator fan-out for free (same
  `aws.spc`); if not, a follow-up wires it.
