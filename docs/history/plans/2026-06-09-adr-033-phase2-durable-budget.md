# ADR-033 Phase 2 — Durable Token Budget (Aurora) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the v1 AI assistant's per-user daily token budget survive process restarts by persisting it to Aurora (dual-write + cold-start hydrate), closing the "restart resets the cap" gap from ADR-033 Phase 1.

**Architecture:** Aurora `ai_token_budget` is the source of truth; the existing in-process `Map` in `src/lib/ai-cost/token-budget.ts` is a per-process fast-path cache. `recordSpend` keeps updating the Map (sync) while `route.ts` also fires a non-blocking Aurora UPSERT (mirrors ADR-030's `agentcore-stats-writer`). At request entry, `hydrateBudget` seeds the Map from Aurora once per `(account,user,day)` via `max(existing, auroraTotal)` so a restart reconciles instead of resetting. Semantic pgvector answer cache is OUT (deferred to a future phase tied to a v2 AI route).

**Tech Stack:** TypeScript, `pg` (Aurora node-pg via `@/lib/db` `getDb`/`isAuroraEnabled`), drift counters (`@/lib/db/drift`), vitest (mocked pg). All behind the existing `aiCost.budget` flag (default off → no-op). Branch `feat/v2-architecture-design` (v1 `src/` is the live legacy prod app).

---

### Task 1: Aurora `ai_token_budget` table

**Files:**
- Modify: `terraform/foundation/data/schema.sql`

- [ ] **Step 1: Find the current max schema_migrations version**

Run: `grep -nE "schema_migrations|INSERT INTO schema_migrations|VALUES \(" terraform/foundation/data/schema.sql | tail -20`
Note the highest version `N` currently inserted (look at how the file records applied migrations — an `INSERT INTO schema_migrations (version) VALUES (...)` list or per-table). Use `N+1` below.

- [ ] **Step 2: Add the table near the other CREATE TABLE blocks (after `worker_jobs` / `inventory_*`)**

```sql
-- ADR-033 Phase 2: durable per-(account,user,day) AI token budget.
-- Source of truth for the daily token cap; the app keeps an in-process Map as a
-- fast-path cache seeded from this table on cold start (see token-budget.ts).
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

If the file maintains a `schema_migrations` version list, append (with `N+1` from Step 1, matching the file's existing insert style):
```sql
INSERT INTO schema_migrations (version) VALUES (N+1) ON CONFLICT DO NOTHING;
```

- [ ] **Step 3: Verify the table + PK are present and idempotent**

Run: `grep -nE "ai_token_budget|PRIMARY KEY \(account_id, user_sub, day\)" terraform/foundation/data/schema.sql`
Expected: the `CREATE TABLE IF NOT EXISTS ai_token_budget` and its composite PK appear. (No DB available in tests; the column/PK contract is exercised by Task 2's writer SQL assertions and by `tests/unit/db-drift.test.ts` conventions.)

- [ ] **Step 4: Commit**

```bash
git add terraform/foundation/data/schema.sql
git commit -m "feat(adr-033-p2): ai_token_budget Aurora table (durable daily token budget)"
```

---

### Task 2: `token-budget-writer.ts` (Aurora UPSERT + read)

**Files:**
- Create: `src/lib/db/token-budget-writer.ts`
- Test: `tests/unit/ai-cost-token-budget-writer.test.ts`

- [ ] **Step 1: Write the failing test (mirrors `agentcore-stats-writer.test.ts`)**

```typescript
// tests/unit/ai-cost-token-budget-writer.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockQuery = vi.fn();
const isAuroraEnabledMock = vi.fn(() => true);
vi.mock('@/lib/db', () => ({
  isAuroraEnabled: () => isAuroraEnabledMock(),
  getDb: async () => ({ query: mockQuery }),
}));

import { recordSpendToAurora, fireAndForgetSpendToAurora, readBudgetTotalFromAurora } from '@/lib/db/token-budget-writer';
import { getDriftCounters, _resetForTests } from '@/lib/db/drift';

describe('token-budget-writer', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    isAuroraEnabledMock.mockReturnValue(true);
    _resetForTests();
  });

  it('no-ops when Aurora disabled', async () => {
    isAuroraEnabledMock.mockReturnValue(false);
    await recordSpendToAurora('acc', 'u', '2026-06-09', 10, 20);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(getDriftCounters()).toEqual([]);
  });

  it('UPSERTs accumulating tokens with the composite key params', async () => {
    await recordSpendToAurora('acc', 'u', '2026-06-09', 10, 20);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO ai_token_budget/);
    expect(sql).toMatch(/ON CONFLICT \(account_id, user_sub, day\) DO UPDATE/);
    expect(sql).toMatch(/input_tokens = ai_token_budget\.input_tokens \+ EXCLUDED\.input_tokens/);
    expect(params).toEqual(['acc', 'u', '2026-06-09', 10, 20]);
    expect(getDriftCounters()[0]).toMatchObject({ source: 'ai_token_budget', writes: 1, failures: 0 });
  });

  it('records a drift failure and re-throws on error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('boom'));
    await expect(recordSpendToAurora('acc', 'u', '2026-06-09', 1, 1)).rejects.toThrow('boom');
    expect(getDriftCounters()[0]).toMatchObject({ source: 'ai_token_budget', writes: 0, failures: 1 });
  });

  it('readBudgetTotalFromAurora returns input+output, 0 when none/disabled', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '1500' }], rowCount: 1 });
    expect(await readBudgetTotalFromAurora('acc', 'u', '2026-06-09')).toBe(1500);
    isAuroraEnabledMock.mockReturnValue(false);
    expect(await readBudgetTotalFromAurora('acc', 'u', '2026-06-09')).toBe(0);
  });

  it('fireAndForgetSpendToAurora returns void and does not throw on failure', async () => {
    mockQuery.mockRejectedValueOnce(new Error('x'));
    expect(fireAndForgetSpendToAurora('acc', 'u', '2026-06-09', 1, 1)).toBeUndefined();
    await new Promise((r) => setImmediate(r));
    expect(getDriftCounters()[0].failures).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/ai-cost-token-budget-writer.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/db/token-budget-writer"`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/lib/db/token-budget-writer.ts
// ADR-033 Phase 2 dual-write — durable per-(account,user,day) token budget.
// Source of truth = Aurora ai_token_budget; token-budget.ts keeps an in-process
// Map fast-path seeded from here on cold start. Mirrors agentcore-stats-writer.
import { getDb, isAuroraEnabled } from '@/lib/db';
import { recordWrite, recordFailure } from '@/lib/db/drift';

const SOURCE = 'ai_token_budget';

const UPSERT_SQL = `
  INSERT INTO ai_token_budget (account_id, user_sub, day, input_tokens, output_tokens)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (account_id, user_sub, day) DO UPDATE SET
    input_tokens  = ai_token_budget.input_tokens  + EXCLUDED.input_tokens,
    output_tokens = ai_token_budget.output_tokens + EXCLUDED.output_tokens,
    updated_at    = now()
`;

const READ_SQL = `
  SELECT (input_tokens + output_tokens)::text AS total
  FROM ai_token_budget WHERE account_id = $1 AND user_sub = $2 AND day = $3
`;

export async function recordSpendToAurora(
  accountId: string, userSub: string, day: string, inputTokens: number, outputTokens: number,
): Promise<void> {
  if (!isAuroraEnabled()) return;
  try {
    const db = await getDb();
    await db.query(UPSERT_SQL, [accountId, userSub, day, Math.max(0, inputTokens), Math.max(0, outputTokens)]);
    recordWrite(SOURCE);
  } catch (err) {
    recordFailure(SOURCE, err);
    throw err;
  }
}

export function fireAndForgetSpendToAurora(
  accountId: string, userSub: string, day: string, inputTokens: number, outputTokens: number,
): void {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  recordSpendToAurora(accountId, userSub, day, inputTokens, outputTokens).catch(() => {
    // drift counter already incremented inside the writer
  });
}

export async function readBudgetTotalFromAurora(accountId: string, userSub: string, day: string): Promise<number> {
  if (!isAuroraEnabled()) return 0;
  const db = await getDb();
  const r = await db.query<{ total: string }>(READ_SQL, [accountId, userSub, day]);
  return Number(r.rows[0]?.total ?? 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/ai-cost-token-budget-writer.test.ts`
Expected: PASS (5 passed).

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/token-budget-writer.ts tests/unit/ai-cost-token-budget-writer.test.ts
git commit -m "feat(adr-033-p2): token-budget Aurora writer (UPSERT + read, drift-tracked, TDD)"
```

---

### Task 3: `hydrateBudget` in `token-budget.ts` (pure, injected reader)

**Files:**
- Modify: `src/lib/ai-cost/token-budget.ts`
- Test: `tests/unit/ai-cost-token-budget.test.ts`

- [ ] **Step 1: Add the failing tests (append to the existing describe block)**

```typescript
// add to tests/unit/ai-cost-token-budget.test.ts
import { checkBudget, recordSpend, hydrateBudget, _reset } from '@/lib/ai-cost/token-budget';
const LIMITS = { dailyTokens: 1000, warnPct: 0.8, overrideEmails: ['oncall@x.com'] };

describe('hydrateBudget', () => {
  beforeEach(() => _reset());
  it('seeds the in-process Map from the Aurora total so a restart does not reset the cap', async () => {
    await hydrateBudget('acc', 'u', async () => 900);
    // 900 already spent (durable) → only 100 remains; >=80% so warn
    const r = checkBudget('acc', 'u', 'u@x.com', LIMITS);
    expect(r.remaining).toBe(100);
    expect(r.warn).toBe(true);
  });
  it('never lowers an in-flight count (max of existing Map and Aurora)', async () => {
    recordSpend('acc', 'u', 950);            // in-flight, higher than Aurora
    await hydrateBudget('acc', 'u', async () => 200);
    expect(checkBudget('acc', 'u', 'u@x.com', LIMITS).remaining).toBe(50); // 1000-950, not 1000-200
  });
  it('is memoized per (account,user,day) — calls the reader once', async () => {
    const reader = vi.fn(async () => 100);
    await hydrateBudget('acc', 'u', reader);
    await hydrateBudget('acc', 'u', reader);
    expect(reader).toHaveBeenCalledTimes(1);
  });
});
```

(Ensure `vi` is imported: `import { describe, it, expect, beforeEach, vi } from 'vitest';`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/ai-cost-token-budget.test.ts`
Expected: FAIL — `hydrateBudget` is not exported.

- [ ] **Step 3: Implement (add to `src/lib/ai-cost/token-budget.ts`, keep existing exports unchanged)**

```typescript
// --- ADR-033 Phase 2: cold-start hydrate from durable Aurora state ---
// Pure: the Aurora read is injected so this module keeps zero db/ coupling.
type BudgetReader = (accountId: string, userSub: string, day: string) => Promise<number>;
const hydrated = new Set<string>();

export async function hydrateBudget(accountId: string, userSub: string, read: BudgetReader): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const k = `${accountId}:${userSub}:${day}`;
  if (hydrated.has(k)) return;          // once per process per (account,user,day)
  hydrated.add(k);
  try {
    const auroraTotal = await read(accountId, userSub, day);
    // max() so a transient/stale read can never LOWER a live in-flight count.
    spent.set(k, Math.max(spent.get(k) || 0, auroraTotal));
  } catch {
    hydrated.delete(k);               // allow a later retry; degrade to in-process behavior
  }
}
```

Also update `_reset()` to clear the memo so tests are isolated:
```typescript
export function _reset(): void { spent.clear(); hydrated.clear(); } // test-only
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/ai-cost-token-budget.test.ts`
Expected: PASS (existing 3 + 3 new = 6 passed).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai-cost/token-budget.ts tests/unit/ai-cost-token-budget.test.ts
git commit -m "feat(adr-033-p2): hydrateBudget seeds the daily cap from Aurora on cold start (TDD)"
```

---

### Task 4: Wire into `route.ts` (hydrate at entry + dual-write spend)

**Files:**
- Modify: `src/app/api/ai/route.ts`

- [ ] **Step 1: Add imports (near the other ai-cost / db imports)**

```typescript
import { hydrateBudget } from '@/lib/ai-cost/token-budget'; // extend the existing { checkBudget, recordSpend } import
import { fireAndForgetSpendToAurora, readBudgetTotalFromAurora } from '@/lib/db/token-budget-writer';
```

- [ ] **Step 2: Hydrate before the budget gate at POST entry**

Find the existing budget gate (`const aiCost = getConfig().aiCost;` → `if (aiCost?.budget) { ... checkBudget ... 429 }`). Insert a hydrate before `checkBudget`:

```typescript
  const aiCost = getConfig().aiCost;
  if (aiCost?.budget) {
    const limits = { dailyTokens: aiCost.budget.dailyTokens, warnPct: aiCost.budget.warnPct ?? 0.8, overrideEmails: aiCost.budget.overrideEmails ?? [] };
    // ADR-033 Phase 2: seed the in-process cap from durable Aurora state so a
    // restart doesn't reset it (best-effort; degrades to in-process on failure).
    await hydrateBudget(accountId || 'all', currentUser.email, readBudgetTotalFromAurora);
    const b = checkBudget(accountId || 'all', currentUser.email, currentUser.email, limits);
    if (!b.allowed) {
      return NextResponse.json({ error: 'Daily AI token budget exceeded. Contact on-call for an override.', code: 'BUDGET_EXCEEDED' }, { status: 429 });
    }
  }
```

(Note: `checkBudget` is the committed 4-arg signature `(accountId, userSub, userEmail, limits)`; pass `currentUser.email` for both the Map key and the override match, consistent with the Phase-1 wiring.)

- [ ] **Step 3: Dual-write spend in `recordAndSave`**

Find the existing `recordSpend(...)` line in `recordAndSave` (guarded by `getConfig().aiCost?.budget`). Add the fire-and-forget Aurora UPSERT beside it:

```typescript
  const _budget = getConfig().aiCost?.budget;
  if (_budget && p.userId) {
    recordSpend('all', p.userId, (p.inputTokens || 0) + (p.outputTokens || 0));
    fireAndForgetSpendToAurora('all', p.userId, new Date().toISOString().slice(0, 10), p.inputTokens || 0, p.outputTokens || 0);
  }
```

(`recordAndSave` buckets under `'all'` + user as in Phase 1; the hydrate at entry uses the same `'all'` bucket so reads and writes line up.)

- [ ] **Step 4: Verify build + suite**

Run: `npm test 2>&1 | tail -5 ; npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "route\.ts|token-budget" || echo "no type errors in touched files"`
Expected: ai-cost + writer tests pass; no type errors in `route.ts`/`token-budget*`. (Pre-existing branch reds — `docs-site/.../ArchitectureFlow.tsx:335` build error and the 7 date-sensitive `alert-knowledge.test.ts` failures — are unrelated; confirm via `git stash` if unsure.) With `aiCost.budget` unset (default), hydrate + dual-write are no-ops → behavior unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/ai/route.ts
git commit -m "feat(adr-033-p2): hydrate budget from Aurora at entry + dual-write spend"
```

---

### Task 5: Re-scope ADR-033 + index

**Files:**
- Modify: `docs/decisions/033-aiops-llm-cost-optimization.md`
- Modify: `docs/decisions/CLAUDE.md`

- [ ] **Step 1: Update ADR-033 Phase 2 wording**

In `docs/decisions/033-aiops-llm-cost-optimization.md`, in the Decision's Phase 2 description and Consequences, change "Phase 2 (v2, Aurora): semantic answer cache via Aurora pgvector, durable per-tenant budget/cache state" to reflect the split:

```markdown
- **Phase 2 (Aurora durable token budget)** — implemented: `ai_token_budget` table + dual-write + cold-start hydrate (the in-process budget no longer resets on restart). See `docs/superpowers/plans/2026-06-09-adr-033-phase2-durable-budget.md`.
- **Phase 3 (deferred) — semantic answer cache** (Bedrock Titan embeddings + Aurora pgvector + similarity threshold/TTL/fingerprint invalidation): re-opened when a v2 AI route exists, where multi-runtime makes it worthwhile. Deferred per the 2026-06-09 `/co-agent` decision (single-EC2 v1's node-cache already covers exact repeats; staleness risk; YAGNI).
```

- [ ] **Step 2: Update the ADR index note**

In `docs/decisions/CLAUDE.md`, append to the ADR-033 row's status note: `; Phase 2 (Aurora durable budget) 구현, 의미 캐시는 v2 AI 라우트 동반 후속 페이즈로 연기`.

- [ ] **Step 3: Commit**

```bash
git add docs/decisions/033-aiops-llm-cost-optimization.md docs/decisions/CLAUDE.md
git commit -m "docs(adr-033): Phase 2 = durable Aurora budget; semantic cache → deferred phase"
```

---

## Self-Review

**1. Spec coverage:** ai_token_budget table → Task 1. Writer (UPSERT/read/fire-and-forget, drift, isAuroraEnabled guard) → Task 2. Pure `hydrateBudget` with injected reader + `max` + memo → Task 3. route.ts hydrate-at-entry + dual-write spend → Task 4. ADR re-scope + index → Task 5. Error handling (degrade to in-process on Aurora failure; `max` fail-safe) → Task 2 (no-op/throw paths) + Task 3 (catch → delete memo). Flag-gated no-op → Task 4 Step 4. ✅ All spec sections covered.

**2. Placeholder scan:** No "TBD"/"handle errors"/"similar to". Task 1's `N+1` is a concrete "read current max, use next" instruction (DDL can't hardcode an unknown existing version), not a code placeholder. ✅

**3. Type consistency:** `recordSpendToAurora(accountId,userSub,day,inputTokens,outputTokens)` / `readBudgetTotalFromAurora(accountId,userSub,day)` / `fireAndForgetSpendToAurora(...)` (Task 2) are called with exactly those arg shapes in Task 4. `hydrateBudget(accountId,userSub,read)` with `BudgetReader = (accountId,userSub,day)=>Promise<number>` (Task 3) matches `readBudgetTotalFromAurora`'s signature passed in Task 4. `checkBudget` stays the committed 4-arg form. `_reset` clears both `spent` + `hydrated`. ✅
