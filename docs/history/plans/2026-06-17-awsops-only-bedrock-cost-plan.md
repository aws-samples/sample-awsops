# Plan: awsops-only Bedrock token-cost on the AI 분석 overview card (v2 — scheduled aggregator)

**Date:** 2026-06-17
**Branch:** `feat/awsops-bedrock-cost` (worktree off `feat/v2-architecture-design` @ 8a48022)
**Base trunk:** `feat/v2-architecture-design`

## Goal
Surface **awsops-only** Bedrock token cost (default 30d) on the overview "AI 분석" card. Source =
Bedrock model invocation logs, **pre-aggregated by a scheduled worker into Aurora**; the BFF only
does a fast cached `SELECT`.

## P2 consensus-gate redesign (round 1 → round 2)
Round-1 gate (gemini CRITICAL + 2 MAJOR, kiro MINORs) rejected the original "query Logs Insights inline
in the GET handler" design. Confirmed against `GEMINI.md:36`/`CLAUDE.md:38`: *heavy/long AWS calls inline
in a request handler are a defect — enqueue.* This plan moves the heavy log scan OFF the request path:

- **thin-BFF (CRITICAL)** → a **scheduled EventBridge Lambda** (modeled on the existing `reaper`) runs the
  Logs Insights query; the BFF reads pre-aggregated rows from Aurora (fast `SELECT`).
- **unbounded scan cost / query limits (MAJOR)** → the aggregator scans only an **incremental window**
  (last ~7h with 1h overlap) each run and **upserts daily token sums**; 30d reads hit Aurora, not logs.
- **missing cache fields** → query uses `if(ispresent(field), field, 0)` (Logs Insights has NO `coalesce`).
- **idempotency (round-2 MAJOR, gemini+kiro convergent)** → each run re-queries the **last 3 FULL UTC days**
  and `UPSERT`-overwrites (`SET = EXCLUDED`), so today/yesterday progressively complete with **no overlap
  double-count and no data loss**; `bin(1d)` is UTC and the epoch is converted to a UTC `DATE` before upsert.
- **StopQuery cleanup / backoff (MINOR)** → aggregator polls with backoff and calls `StopQuery` on timeout.
- **default pricing (MINOR)** → unknown modelId falls back to a defined default + logs the id.
- **error/loading state (MINOR)** → card keeps "보기 →" on loading/error (no fake number).

## Why this design (grounded)
- Bedrock invocation logging is enabled in **ap-northeast-2** (`/aws/bedrock/invocation-logs`); events carry
  `identity.arn`, `modelId`, `input.inputTokenCount`, `input.cacheReadInputTokenCount`,
  `input.cacheWriteInputTokenCount`, `output.outputTokenCount`, `timestamp`.
- After the `us.*→global.*` migration (8a48022) awsops invokes from ap-northeast-2 so its calls land here;
  awsops callers are IAM roles named `awsops-v2-*` (the account is shared, e.g. `ttobak-crawler-role`), so
  filtering `identity.arn` by `awsops-v2` isolates awsops.
- Pattern precedent: cc-on-bedrock (`03-usage-tracking-stack.ts`: tracker → DynamoDB → dashboard reads) and
  awsops's own `reaper` (EventBridge Lambda + VPC + Aurora via pg8000 layer).
- **Pricing single-sourced**: the aggregator stores RAW token sums; the BFF prices them via the existing,
  tested `web/lib/bedrock.ts` (`MODEL_PRICING`/`getModelPricing`/`computeCost`) — no duplicate pricing.

## Security / mandates
- New flag **`ai_cost_tracking_enabled`** (bool, default **false**) gates ALL new infra → `plan` = no-op, $0.
- Aggregator IAM is **read-only**: `logs:StartQuery`/`GetQueryResults`/`StopQuery` on the invocation log
  group only, + the shared worker Aurora-secret/KMS/VPC role. No mutation, no `0.0.0.0/0`, no `Principal:"*"`.
- BFF `/api/ai-usage` auth-gated (`verifyUser` → 401); read-only `SELECT`; clamps `range` to `RANGE_CONFIGS`.

## Tasks

### Task 1: Aurora migration — ai_usage_daily
**Files:**
- Create: `terraform/foundation/migrations/01KVEBZ1R01MH35A9DDH0VR9JB_ai_usage_daily.sql`

- [ ] Add migration (real ULID filename per project rule `migrations/<ULID>_ai_usage_daily.sql`, NOT a schema.sql append): `CREATE TABLE IF NOT EXISTS ai_usage_daily (day DATE NOT NULL, model TEXT NOT NULL, input_tokens BIGINT NOT NULL DEFAULT 0, output_tokens BIGINT NOT NULL DEFAULT 0, cache_read_tokens BIGINT NOT NULL DEFAULT 0, cache_write_tokens BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (day, model));` + `CREATE INDEX IF NOT EXISTS idx_ai_usage_day ON ai_usage_daily (day DESC);`. Apply path: the migration runner (`make migrate` / the ULID migrations dir already wired in this repo) picks up new `migrations/*.sql` and records them in `schema_migrations` — verify the file is discovered (matches the existing ULID-migration glob), no manual seed needed.

### Task 2: aggregator pure helpers + tests (Python)
**Files:**
- Create: `scripts/v2/workers/ai_cost/aggregate.py`
- Test: `scripts/v2/workers/ai_cost/test_aggregate.py`

- [ ] Write `test_aggregate.py` FIRST: `build_query(match, start_ms, end_ms)` emits a Logs Insights query that filters `identity.arn like /awsops-v2/`, wraps all 4 token fields in `if(ispresent(field), field, 0)` (NOT `coalesce` — absent in Insights), and `stats sum(...) by bin(1d) as day, modelId`; `parse_rows(results)` maps Insights result rows → `[{day(UTC date str), model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens}]` (missing cols → 0; epoch/bin → UTC date).
- [ ] Implement `aggregate.py` (pure, no boto3): `AWSOPS_IDENTITY_MATCH='awsops-v2'`, `build_query`, `parse_rows`.
- [ ] `cd scripts/v2/workers && python3 -m pytest ai_cost/ -q` green; commit this task only.

### Task 3: aggregator Lambda handler + terraform (flag-gated, default off)
**Files:**
- Create: `scripts/v2/workers/ai_cost_aggregator.py`
- Modify: `terraform/foundation/workers.tf`
- Modify: `terraform/foundation/variables.tf`

- [ ] `ai_cost_aggregator.py` handler: window = the **last 3 FULL UTC days** (`start = midnight_utc(today) - 3d`, `end = now`); `StartQuery` on `/aws/bedrock/invocation-logs` with `build_query`; poll `GetQueryResults` with backoff (500ms→, ≤~10 polls / 30s), `StopQuery` on timeout; `parse_rows` → **idempotent overwrite** upsert into `ai_usage_daily` (pg8000, `ON CONFLICT (day,model) DO UPDATE SET input_tokens=EXCLUDED.input_tokens, …, updated_at=NOW()`). Re-querying full UTC days each run progressively completes today + re-affirms the prior days → no overlap double-count, no data loss. Never throws past the handler boundary (log + return).
- [ ] `variables.tf`: add `variable "ai_cost_tracking_enabled" { type=bool, default=false }`.
- [ ] `workers.tf`: add the aggregator Lambda (reuse the worker/reaper VPC+pg8000-layer+Aurora-secret role), an `aws_cloudwatch_event_rule` (rate(6 hours)) + target, and an IAM statement granting `logs:StartQuery`/`GetQueryResults`/`StopQuery` on the invocation log group ARN — ALL `count = var.ai_cost_tracking_enabled ? 1 : 0`.
- [ ] `terraform -chdir=terraform/foundation validate` green (flag off AND `-var ai_cost_tracking_enabled=true`); `fmt`; commit this task only.

### Task 4: web/lib/ai-usage.ts pricing-aggregation + tests
**Files:**
- Create: `web/lib/ai-usage.ts`
- Test: `web/lib/ai-usage.test.ts`

- [ ] Write `web/lib/ai-usage.test.ts` FIRST: given `ai_usage_daily` rows (model + token sums), `priceUsage(rows)` returns `{models, totalCost}` matching `bedrock.ts` pricing; unknown modelId → default pricing; empty → `{models:[],totalCost:0}`.
- [ ] Implement `web/lib/ai-usage.ts`: `priceUsage(rows)` reusing `getModelPricing`/`computeCost` from `./bedrock`. Pure — no pg, no SDK.
- [ ] `cd web && npm run test -- ai-usage` green; commit this task only.

### Task 5: /api/ai-usage route (fast Aurora SELECT) + tests
**Files:**
- Create: `web/app/api/ai-usage/route.ts`
- Test: `web/app/api/ai-usage/route.test.ts`

- [ ] Write `route.test.ts` FIRST (mock `@/lib/db` getPool): 401 unauthenticated; `range` clamp to `30d`; `SELECT ... FROM ai_usage_daily WHERE day >= now()-interval` → `priceUsage` shape; empty → `totalCost:0`.
- [ ] Implement `web/app/api/ai-usage/route.ts`: `GET` → `verifyUser` (401); clamp `range`; explicit fast SELECT `SELECT model, SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens, SUM(cache_read_tokens) cache_read_tokens, SUM(cache_write_tokens) cache_write_tokens FROM ai_usage_daily WHERE day >= CURRENT_DATE - ($1::int * INTERVAL '1 day') GROUP BY model ORDER BY model` (param = range days); `priceUsage(rows)` → `Response.json({range, totalCost, models})`; 500 on failure. Fast SELECT only (thin-BFF compliant).
- [ ] `cd web && npm run test -- ai-usage` green; commit this task only.

### Task 6: wire the figure into the AI 분석 card
**Files:**
- Modify: `web/components/overview/AiOps.tsx`

- [ ] Fetch `/api/ai-usage?range=30d` (client); render awsops-only 30d total in the "Bedrock 토큰 비용" row as `$X.XX` (still `<a href="/bedrock">`); on loading/error keep "보기 →" (no crash, no fake number).
- [ ] `cd web && npm run test` + `npm run build` green; commit this task only.

## Out of scope / activation (deploys — controller/user-run on shared infra)
- `terraform apply` with `ai_cost_tracking_enabled=true` (aggregator Lambda + schedule + IAM) — then the
  migration runs and the aggregator begins populating `ai_usage_daily`.
- `make workers` (worker image incl. the aggregator) + `make deploy` (web).
- The `us.*→global.*` migration (8a48022) must be deployed first so awsops calls appear in the log.
- Live routing-accuracy metric (the "게이트 96.9%" row) — separate telemetry, not this plan.

## Verification
- `cd web && npm run test` + `npm run build` green; `python3 -m pytest scripts/v2/workers/ai_cost` green;
  `terraform validate` green (flag off and on).
- Manual (post-deploy): after a chat/diagnosis call + one aggregator run, `/api/ai-usage?range=30d`
  returns a non-zero awsops-only total; the card shows the figure; with the flag OFF, `plan` = no-op.
