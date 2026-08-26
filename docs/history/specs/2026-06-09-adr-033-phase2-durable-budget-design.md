# ADR-033 Phase 2 — Durable Token Budget (Aurora) Design

**Date:** 2026-06-09 · **Status:** Approved (design) · **Spec for:** writing-plans → implementation
**Decides:** the v2-Aurora half of ADR-033. Re-scoped via `/co-agent` decision support.

## Decision (scope)

ADR-033 Phase 2 is **durable per-tenant token budget state in Aurora** — and *only* that. The semantic answer cache (pgvector) originally bundled into "Phase 2" is **deferred to a future phase tied to a v2 AI route**, on the multi-AI panel's recommendation (gemini + kiro → Option A; codex no usable output this round).

**Why (panel + chair):** (1) the in-process token budget resets on every v1 process restart — a real correctness gap *today*; an Aurora upsert with cold-start reconciliation closes it with minimal surface area, reusing the live ADR-030 v1→Aurora dual-write bridge. (2) A semantic cache pays off mainly in **multi-runtime** (v2's N Fargate tasks); on the single-EC2 v1 the existing in-process `node-cache` already dedupes exact repeats, so semantic adds little while carrying the staleness risk flagged as Phase-1's #1 concern. (3) YAGNI — v2 has **no AI route yet**, so building pgvector + an embedding pipeline now designs against an unspecified shape. **Key trade-off accepted:** near-duplicate dedup + cross-restart *answer* caching wait until a v2 AI route justifies them; the interim token cost on paraphrased repeats is negligible on low-concurrency v1.

## Context

ADR-033 Phase 1 (Accepted, in `src/app/api/ai/route.ts` + `src/lib/ai-cost/`): heuristic→Haiku→Sonnet classification, prompt caching, exact-match `node-cache` answer cache, and an **in-process (volatile)** per-`(accountId,userSub)` daily token budget (`src/lib/ai-cost/token-budget.ts`, a `Map` reset on restart). The budget gate (`checkBudget`) and recorder (`recordSpend`) are wired in `route.ts` (POST entry returns 429 `BUDGET_EXCEEDED`; `recordAndSave` records spend), all behind the `aiCost.budget` config flag (default off).

v1 already talks to Aurora: `src/lib/db.ts` (`getDb`, `isAuroraEnabled`) + `src/lib/db/*-writer.ts` fire-and-forget dual-write shadows (ADR-030). Aurora = Serverless v2 PG17. There is no token-budget table yet.

## Architecture — dual-write + cold-start hydrate (mirrors ADR-030 stats-writer)

Aurora is the **source of truth**; the in-process `Map` is a per-process **fast-path cache** seeded from Aurora. Three moving parts:

1. **Write (fire-and-forget):** `recordSpend(account,user,tokens)` updates the in-process `Map` (unchanged, sync) **and** fires a non-blocking Aurora UPSERT that accumulates the day's tokens. Failures increment the ADR-030 drift counter; they never block the request.
2. **Hydrate (cold-start / once per process per `(account,user,day)`):** at AI-request entry, before `checkBudget`, `await hydrateBudget(account,user)` reads the day's accumulated total from Aurora and seeds the `Map` (idempotent: takes `max(Map, Aurora)` so a hot in-flight count is never lowered). Cached per `(account,user,day)` with a short TTL so it runs once per process per day, not per request.
3. **Check (sync, unchanged):** `checkBudget` reads the `Map`. After hydrate, the `Map` reflects durable state, so a restart no longer resets the cap to zero.

Multi-runtime note: for a future v2 multi-Fargate AI route, the hydrate TTL bounds the cross-task staleness window (two tasks could each under-count for ≤TTL). Accepted + documented; the daily cap is a soft cap, not a hard financial gate.

## Components / files

- **MODIFY `terraform/foundation/data/schema.sql`** — add table + bump `schema_migrations`:
  ```sql
  CREATE TABLE IF NOT EXISTS ai_token_budget (
    account_id    TEXT        NOT NULL,
    user_sub      TEXT        NOT NULL,
    day           DATE        NOT NULL,
    input_tokens  BIGINT      NOT NULL DEFAULT 0,
    output_tokens BIGINT      NOT NULL DEFAULT 0,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, user_sub, day)
  );
  ```
- **CREATE `src/lib/db/token-budget-writer.ts`** (mirrors `agentcore-stats-writer.ts`):
  - `recordSpendToAurora(accountId, userSub, day, inputTokens, outputTokens): Promise<void>` — `isAuroraEnabled()` guard; `INSERT ... ON CONFLICT (account_id,user_sub,day) DO UPDATE SET input_tokens = ai_token_budget.input_tokens + EXCLUDED.input_tokens, output_tokens = ... + EXCLUDED.output_tokens, updated_at = now()`; `recordWrite('ai_token_budget')` / `recordFailure(...)`.
  - `fireAndForgetSpendToAurora(...): void` — non-blocking wrapper (`.catch(()=>{})`).
  - `readBudgetTotalFromAurora(accountId, userSub, day): Promise<number>` — `SELECT input_tokens+output_tokens` for the row, 0 if none / Aurora disabled.
- **MODIFY `src/lib/ai-cost/token-budget.ts`** — add ONE function `hydrateBudget(accountId, userSub, readFn): Promise<void>` that seeds the Map via `max(existing, auroraTotal)` (memoized per `(account,user,day)`), taking the Aurora reader as an injected `readFn` so the lib stays **pure** (no `db/` import → unit-testable with a fake reader). `checkBudget`/`recordSpend`/`_reset` are **unchanged** (Map-only, sync). The Aurora *write* is NOT added here — it is done in `route.ts` (below) right beside the existing `recordSpend` call, so the lib has zero Aurora coupling.
- **MODIFY `src/app/api/ai/route.ts`** — at POST entry, when `aiCost.budget` is set, `await hydrateBudget(accountId||'all', currentUser.email, (a,u,d)=>readBudgetTotalFromAurora(a,u,d))` before `checkBudget`; in `recordAndSave`, alongside the existing `recordSpend`, call `fireAndForgetSpendToAurora(...)`.
- **CREATE `tests/unit/ai-cost-token-budget-writer.test.ts`** — assert the UPSERT SQL shape + params + drift accounting with a mocked `getDb` (pattern: existing `tests/unit/*-writer.test.ts`).
- **MODIFY `tests/unit/ai-cost-token-budget.test.ts`** — add `hydrateBudget` cases (seeds from Aurora total; `max` never lowers an in-flight count; memoized per day).
- **MODIFY `docs/decisions/033-aiops-llm-cost-optimization.md`** + `docs/decisions/CLAUDE.md` — re-scope Phase 2 to "durable budget"; record that the semantic cache moves to a future phase (v2 AI route) with the co-agent rationale.

## Error handling
- Aurora unreachable / not configured → `isAuroraEnabled()` false or query throws → drift counter increments; budget **degrades to Phase-1 in-process behavior** (no hard failure, no request block). Fire-and-forget writes and hydrate reads are both best-effort.
- Hydrate uses `max(Map, Aurora)` so a transient read of a stale/zero Aurora value can never *lower* a live count (fail-safe toward over-counting, i.e., toward enforcing the cap).

## Testing
- Unit (vitest, mocked pg): writer UPSERT SQL/params + drift; `hydrateBudget` seeding/`max`/memoization; `checkBudget` unchanged.
- No integration against real Aurora (per tests/CLAUDE.md — fixtures/mocks only).
- Gated: with `aiCost.budget` unset, hydrate + dual-write are no-ops → behavior identical to today.

## Out of scope (future phase, tied to v2 AI route)
Semantic answer cache (Bedrock Titan embeddings + Aurora pgvector + similarity threshold + TTL/fingerprint invalidation). Re-open when a v2 AI route exists and multi-runtime makes it worthwhile.
