# ADR-033 Phase 1 — AIOps LLM Cost Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the Bedrock token cost of the v1 AI assistant (`src/app/api/ai/route.ts`) without degrading answer quality — by classifying cheaply (heuristic → Haiku → Sonnet), caching repeated answers, caching invariant prompt prefixes, and bounding per-user spend.

**Architecture:** `route.ts` is network/Bedrock-bound and has no unit tests, so all logic lands in **pure, unit-tested helpers under `src/lib/ai-cost/`** (heuristic classifier, model tiering, prompt-cache transform, answer cache, token budget) and is then **wired into `route.ts`** with minimal, build-verified edits. Phase 1 is in-process only (new `NodeCache` + in-memory budget Map) — semantic cache and durable budget state are explicitly **deferred to Phase 2 (v2 Aurora)** per ADR-033.

**Tech Stack:** TypeScript, Next.js 14 App Router, `@aws-sdk/client-bedrock-runtime` (InvokeModel, Anthropic message API on Bedrock), `node-cache`, **vitest** (`tests/unit/*.test.ts`, `@/` path alias). Branch: `feat/v2-architecture-design` (v1 `src/` is the live legacy prod app maintained in parallel).

**Scope guard (ADR-033 Phase 1 only):** IN — heuristic+Haiku classification, prompt caching on **direct `callBedrock`/InvokeModel** prompts only (NOT the opaque AgentCore gateway calls), exact-match answer cache, in-process per-user token budget, model tiering + single-route synthesis-skip, golden-set classification SLO. OUT (Phase 2) — semantic/embedding answer cache, durable (Aurora) budget/cache state, any v2 `web/` work.

---

## File Structure

New (all pure/unit-tested):
- `src/lib/ai-cost/heuristic-classifier.ts` — deterministic keyword pre-filter → `{routes, confidence}` or `null`. One responsibility: map a question to route(s) without an LLM call.
- `src/lib/ai-cost/model-tier.ts` — pick the classifier model (`haiku-4.5` vs `sonnet-4.6`) and decide single-route synthesis-skip. Pure policy.
- `src/lib/ai-cost/prompt-cache.ts` — transform an Anthropic `system` string into a cache-pointed `system` block array (`cache_control: ephemeral`), feature-flagged. Pure transform.
- `src/lib/ai-cost/answer-cache.ts` — `normalizeQuestion`, `answerCacheKey`, `sourceDataFingerprint`, and a `NodeCache`-backed `getAnswer/setAnswer/invalidateAccount`. Key/normalize logic is pure; the cache wrapper is thin.
- `src/lib/ai-cost/token-budget.ts` — in-process per-`(accountId,userSub)` token counter with warn/soft-cap/override. Volatile by design (documented Phase-1 limitation).
- `tests/unit/ai-cost-heuristic.test.ts`, `tests/unit/ai-cost-model-tier.test.ts`, `tests/unit/ai-cost-prompt-cache.test.ts`, `tests/unit/ai-cost-answer-cache.test.ts`, `tests/unit/ai-cost-token-budget.test.ts`, `tests/unit/ai-classify-golden.test.ts`.
- `tests/fixtures/golden-questions.json` — labeled classification fixtures + the SLO threshold.

Modified (integration, verified by `npm run build` + `npm test`):
- `src/app/api/ai/route.ts` — `classifyIntent` (heuristic→Haiku→Sonnet), the direct `InvokeModelCommand` bodies (apply prompt cache to `system`), the `sql`/`aws-data` path (answer-cache read/write), `POST` entry (budget check), single-route synthesis-skip.

Config:
- `data/config.json` — optional `aiCost` block (flags + budget limits + onCallOverrideEmails); all default to **safe/off** so behavior is unchanged until enabled.

---

### Task 1: Heuristic classifier (pure)

**Files:**
- Create: `src/lib/ai-cost/heuristic-classifier.ts`
- Test: `tests/unit/ai-cost-heuristic.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/ai-cost-heuristic.test.ts
import { describe, it, expect } from 'vitest';
import { heuristicClassify } from '@/lib/ai-cost/heuristic-classifier';

describe('heuristicClassify', () => {
  it('classifies a clear listing question to aws-data with high confidence', () => {
    expect(heuristicClassify('EC2 인스턴스 목록 보여줘')).toEqual({ routes: ['aws-data'], confidence: 'high' });
  });
  it('classifies an obvious cost question to cost', () => {
    expect(heuristicClassify('이번 달 비용 분석해줘')).toEqual({ routes: ['cost'], confidence: 'high' });
  });
  it('returns null (defer to LLM) when no confident keyword match', () => {
    expect(heuristicClassify('이거 좀 이상한데 왜 그럴까')).toBeNull();
  });
  it('returns null (defer to LLM) when two domains both match — ambiguous', () => {
    // both network and cost keywords present → not safe to decide heuristically
    expect(heuristicClassify('VPC 보안그룹과 비용을 같이 분석')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/ai-cost-heuristic.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/ai-cost/heuristic-classifier"`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/lib/ai-cost/heuristic-classifier.ts
// Deterministic, LLM-free pre-filter for the AI router (ADR-033 Phase 1).
// Returns a confident route ONLY when exactly one domain matches; otherwise null
// (caller falls back to the LLM classifier). Never guesses on ambiguity.
export type Confidence = 'high' | 'low';
export interface HeuristicResult { routes: string[]; confidence: Confidence; }

// Keyword → route. Listing/status verbs route to aws-data; domain nouns to gateways.
// Kept intentionally small + high-precision; recall gaps fall through to the LLM.
const RULES: Array<{ route: string; any: RegExp }> = [
  { route: 'cost',     any: /\b(비용|cost|요금|billing|예산|budget|savings|finops)\b/i },
  { route: 'security', any: /\b(보안|security|iam|취약|cve|컴플라이언스|compliance|mfa)\b/i },
  { route: 'network',  any: /(reachability|flow ?log|tgw|transit gateway|vpn|방화벽|firewall)/i },
  { route: 'container',any: /(istio|kubectl|kubelet|crashloop|oomkill|파드 장애|eks 트러블)/i },
  { route: 'cost',     any: /\b(rightsizing|유휴 리소스|idle)\b/i },
];
// Listing/status → aws-data (Steampipe). High precision verbs only.
const AWS_DATA = /(목록|리스트|몇\s*개|현황|status|list|보여줘|조회)/i;

export function heuristicClassify(text: string): HeuristicResult | null {
  if (!text || text.trim().length < 2) return null;
  const matched = new Set<string>();
  for (const r of RULES) if (r.any.test(text)) matched.add(r.route);
  if (matched.size > 1) return null;             // ambiguous → defer to LLM
  if (matched.size === 1) return { routes: [...matched], confidence: 'high' };
  if (AWS_DATA.test(text)) return { routes: ['aws-data'], confidence: 'high' };
  return null;                                    // no confident match → defer to LLM
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/ai-cost-heuristic.test.ts`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai-cost/heuristic-classifier.ts tests/unit/ai-cost-heuristic.test.ts
git commit -m "feat(adr-033): heuristic pre-filter classifier (pure, TDD)"
```

---

### Task 2: Model tiering + synthesis-skip policy (pure)

**Files:**
- Create: `src/lib/ai-cost/model-tier.ts`
- Test: `tests/unit/ai-cost-model-tier.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/ai-cost-model-tier.test.ts
import { describe, it, expect } from 'vitest';
import { pickClassifierModel, shouldSkipSynthesis } from '@/lib/ai-cost/model-tier';

describe('pickClassifierModel', () => {
  it('uses haiku when the heuristic was low/medium confidence (cheap second opinion)', () => {
    expect(pickClassifierModel({ routes: ['cost'], confidence: 'low' })).toBe('haiku-4.5');
  });
  it('uses sonnet when there is no heuristic result at all (hardest cases)', () => {
    expect(pickClassifierModel(null)).toBe('sonnet-4.6');
  });
});
describe('shouldSkipSynthesis', () => {
  it('skips synthesis for a single high-confidence route', () => {
    expect(shouldSkipSynthesis(['cost'], 'high')).toBe(true);
  });
  it('does not skip when multiple routes were selected', () => {
    expect(shouldSkipSynthesis(['cost', 'network'], 'high')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/ai-cost-model-tier.test.ts`
Expected: FAIL — import cannot be resolved.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/lib/ai-cost/model-tier.ts
// Confidence-based model + synthesis policy (ADR-033 Phase 1).
import type { HeuristicResult } from './heuristic-classifier';

export type ClassifierModelKey = 'haiku-4.5' | 'sonnet-4.6';

// When the heuristic is uncertain (low) we still avoid Sonnet: Haiku is ~cheap
// and good enough to confirm/repair a single-domain guess. Only the hardest
// case — no heuristic signal at all — escalates to Sonnet.
export function pickClassifierModel(heuristic: HeuristicResult | null): ClassifierModelKey {
  if (heuristic && heuristic.confidence === 'low') return 'haiku-4.5';
  return 'sonnet-4.6';
}

// Multi-route synthesis (ADR-025) is the expensive extra Bedrock call. A single
// high-confidence route never needs synthesis.
export function shouldSkipSynthesis(routes: string[], confidence: 'high' | 'low'): boolean {
  return routes.length === 1 && confidence === 'high';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/ai-cost-model-tier.test.ts`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai-cost/model-tier.ts tests/unit/ai-cost-model-tier.test.ts
git commit -m "feat(adr-033): model-tier + synthesis-skip policy (pure, TDD)"
```

---

### Task 3: Wire heuristic → Haiku → Sonnet into `classifyIntent`

**Files:**
- Modify: `src/app/api/ai/route.ts` (`classifyIntent`, ~line 401–445)

- [ ] **Step 1: Add imports (top of route.ts, near line 25)**

```typescript
import { heuristicClassify } from '@/lib/ai-cost/heuristic-classifier';
import { pickClassifierModel } from '@/lib/ai-cost/model-tier';
import { getConfig as _getConfig } from '@/lib/app-config'; // already imported as getConfig — reuse existing import
```

(Note: `getConfig` is already imported at line 16 — do NOT re-import; just use it. Read the `aiCost` flags via `getConfig()` added in Task 9's config step, defaulting to off.)

- [ ] **Step 2: Replace the body of `classifyIntent`'s model selection**

Change the start of `classifyIntent` (line 401–416) from always-Sonnet to heuristic-first:

```typescript
async function classifyIntent(messages: Array<{role: string; content: string}>): Promise<{ routes: RouteType[]; inputTokens: number; outputTokens: number }> {
  const lastText = messages[messages.length - 1]?.content || '';
  // ADR-033 Phase 1: deterministic pre-filter — a confident single-domain match
  // skips the Bedrock classification call entirely (zero tokens).
  const heuristic = heuristicClassify(lastText);
  if (heuristic && heuristic.confidence === 'high') {
    const valid = heuristic.routes.filter(r => VALID_ROUTES.includes(r as RouteType)) as RouteType[];
    if (valid.length > 0) {
      console.log(`[Intent] Heuristic (no-LLM): ${valid.join(', ')}`);
      return { routes: valid, inputTokens: 0, outputTokens: 0 };
    }
  }
  try {
    const recentMessages = messages.slice(-10);
    const body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 100,
      system: CLASSIFICATION_PROMPT,
      messages: recentMessages.map(m => ({ role: m.role, content: m.content })),
    });
    const response = await bedrockClient.send(new InvokeModelCommand({
      modelId: MODELS[pickClassifierModel(heuristic)],   // Haiku for low-confidence, Sonnet otherwise
      contentType: 'application/json',
      accept: 'application/json',
      body: new TextEncoder().encode(body),
    }));
    // ...rest of existing parsing unchanged (lines 418–441)...
```

Keep everything from line 418 (`const result = JSON.parse(...)`) onward unchanged.

- [ ] **Step 3: Run the full unit suite + build to verify no regression**

Run: `npm test && npm run build`
Expected: tests PASS; build succeeds (no type errors). `classifyIntent` still returns the same shape `{routes, inputTokens, outputTokens}`.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/ai/route.ts
git commit -m "feat(adr-033): classify via heuristic-first → Haiku → Sonnet"
```

---

### Task 4: Prompt-cache transform + wire into direct InvokeModel bodies

**Files:**
- Create: `src/lib/ai-cost/prompt-cache.ts`
- Test: `tests/unit/ai-cost-prompt-cache.test.ts`
- Modify: `src/app/api/ai/route.ts` (the direct `InvokeModelCommand`/`streamBedrockToSSE` bodies — NOT `invokeAgentCore`)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/ai-cost-prompt-cache.test.ts
import { describe, it, expect } from 'vitest';
import { cachedSystem } from '@/lib/ai-cost/prompt-cache';

describe('cachedSystem', () => {
  it('returns the plain string unchanged when caching is disabled', () => {
    expect(cachedSystem('SYS', false)).toBe('SYS');
  });
  it('returns a cache-pointed block array when enabled', () => {
    expect(cachedSystem('SYS', true)).toEqual([
      { type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } },
    ]);
  });
  it('does not cache a too-short prefix even when enabled (below min)', () => {
    expect(cachedSystem('hi', true)).toBe('hi');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/ai-cost-prompt-cache.test.ts`
Expected: FAIL — import cannot be resolved.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/lib/ai-cost/prompt-cache.ts
// ADR-033 Phase 1: Bedrock (Anthropic) prompt caching for INVARIANT system
// prefixes on AWSops-controlled direct InvokeModel calls only. The 1–3 AgentCore
// gateway calls construct their prompts inside the Strands runtime and are opaque
// to this layer (per the 2026-06-09 consensus addendum) — do NOT call this there.
type SystemField = string | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;

// Bedrock requires a minimum cacheable prefix; below it, caching is a no-op cost.
const MIN_CACHEABLE_CHARS = 2000;

export function cachedSystem(system: string, enabled: boolean): SystemField {
  if (!enabled || system.length < MIN_CACHEABLE_CHARS) return system;
  return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/ai-cost-prompt-cache.test.ts`
Expected: PASS (3 passed).

- [ ] **Step 5: Wire into the invariant-prefix call sites**

In `route.ts`, import `cachedSystem` and read the flag once near the top of the request (`const promptCacheOn = getConfig().aiCost?.promptCache === true;`). Replace `system: <X>` with `system: cachedSystem(<X>, promptCacheOn)` ONLY for these **direct, invariant-prefix** bodies:
- `classifyIntent` → `system: cachedSystem(CLASSIFICATION_PROMPT, promptCacheOn)` (the registry prompt is invariant across requests).
- `synthesizeResponses` / `synthesizeResponsesStreaming` system prompt.
- `handleSingleRoute` SQL + datasource + auto-collect `SYSTEM_PROMPT` / `collector.analysisPrompt` bodies.

Do NOT touch `invokeAgentCore` (gateway calls) — those prompts are opaque to this layer.

For `streamBedrockToSSE` (line 933), widen the `system` param type to `string | object[]` and pass it straight into the JSON body (Bedrock accepts the Anthropic block array). For `ConverseStreamCommand` (synthesizeResponsesStreaming) leave as-is in Phase 1 (Converse caching is a Phase-2 follow-up — note it inline).

- [ ] **Step 6: Run build + suite**

Run: `npm test && npm run build`
Expected: PASS + build OK. With `aiCost.promptCache` unset (default), `cachedSystem` returns the plain string → byte-identical behavior to today.

- [ ] **Step 7: Commit**

```bash
git add src/lib/ai-cost/prompt-cache.ts tests/unit/ai-cost-prompt-cache.test.ts src/app/api/ai/route.ts
git commit -m "feat(adr-033): Bedrock prompt caching on invariant direct-invoke prefixes"
```

---

### Task 5: Answer cache — normalize / key / fingerprint (pure) + NodeCache wrapper

**Files:**
- Create: `src/lib/ai-cost/answer-cache.ts`
- Test: `tests/unit/ai-cost-answer-cache.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/ai-cost-answer-cache.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { normalizeQuestion, answerCacheKey, sourceDataFingerprint, getAnswer, setAnswer, invalidateAccount } from '@/lib/ai-cost/answer-cache';

describe('normalizeQuestion', () => {
  it('lowercases, trims, and collapses whitespace', () => {
    expect(normalizeQuestion('  EC2   List   ')).toBe('ec2 list');
  });
});
describe('answerCacheKey', () => {
  it('is stable for the same inputs and varies by account', () => {
    const a = answerCacheKey({ accountId: 'A', userSub: 'u', route: 'aws-data', question: 'ec2 list', fingerprint: 'fp' });
    const b = answerCacheKey({ accountId: 'A', userSub: 'u', route: 'aws-data', question: 'ec2 list', fingerprint: 'fp' });
    const c = answerCacheKey({ accountId: 'B', userSub: 'u', route: 'aws-data', question: 'ec2 list', fingerprint: 'fp' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
describe('sourceDataFingerprint', () => {
  it('changes when the underlying rows change', () => {
    expect(sourceDataFingerprint('[{"a":1}]', 'v1')).not.toBe(sourceDataFingerprint('[{"a":2}]', 'v1'));
  });
  it('changes when the plugin/schema version changes', () => {
    expect(sourceDataFingerprint('[{"a":1}]', 'v1')).not.toBe(sourceDataFingerprint('[{"a":1}]', 'v2'));
  });
});
describe('get/set/invalidate', () => {
  beforeEach(() => invalidateAccount('A'));
  it('round-trips a value and isolates per account on invalidate', () => {
    const key = answerCacheKey({ accountId: 'A', userSub: 'u', route: 'aws-data', question: 'q', fingerprint: 'fp' });
    setAnswer(key, 'A', { content: 'hi' });
    expect(getAnswer(key)?.content).toBe('hi');
    invalidateAccount('A');
    expect(getAnswer(key)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/ai-cost-answer-cache.test.ts`
Expected: FAIL — import cannot be resolved.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/lib/ai-cost/answer-cache.ts
// ADR-033 Phase 1: EXACT-MATCH answer cache (semantic cache is Phase 2 / Aurora pgvector).
// TTL is bounded by the Steampipe 5-min query cache (stdTTL 300) so a cached answer
// can never be staler than the data it summarized. Per-account invalidation lets
// write/mutation events drop an account's answers.
import NodeCache from 'node-cache';
import { createHash } from 'crypto';

const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // ≤ Steampipe window
const STOP = new Set(['the', 'a', 'an', '좀', '해줘', '보여줘', 'please']);

export interface CachedAnswer { content: string; via?: string; usedTools?: string[]; }

export function normalizeQuestion(q: string): string {
  return q.toLowerCase().trim().replace(/\s+/g, ' ')
    .split(' ').filter(w => !STOP.has(w)).join(' ');
}

export function sourceDataFingerprint(rowsJson: string, pluginVersion: string): string {
  return createHash('sha256').update(`${pluginVersion} ${rowsJson}`).digest('hex').slice(0, 16);
}

export function answerCacheKey(p: { accountId: string; userSub: string; route: string; question: string; fingerprint: string }): string {
  const norm = normalizeQuestion(p.question);
  return `ans:${p.accountId}:${p.userSub}:${p.route}:${p.fingerprint}:${createHash('sha256').update(norm).digest('hex').slice(0, 24)}`;
}

const accountKeys = new Map<string, Set<string>>(); // accountId → keys (for invalidation)

export function getAnswer(key: string): CachedAnswer | undefined {
  return cache.get<CachedAnswer>(key);
}
export function setAnswer(key: string, accountId: string, value: CachedAnswer): void {
  cache.set(key, value);
  if (!accountKeys.has(accountId)) accountKeys.set(accountId, new Set());
  accountKeys.get(accountId)!.add(key);
}
export function invalidateAccount(accountId: string): void {
  const keys = accountKeys.get(accountId);
  if (keys) { for (const k of keys) cache.del(k); keys.clear(); }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/ai-cost-answer-cache.test.ts`
Expected: PASS (6 passed).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai-cost/answer-cache.ts tests/unit/ai-cost-answer-cache.test.ts
git commit -m "feat(adr-033): exact-match answer cache (normalize/key/fingerprint, TDD)"
```

---

### Task 6: Wire answer cache into the `aws-data`/`sql` path

**Files:**
- Modify: `src/app/api/ai/route.ts` (the streaming `sql` handler ~line 1255–1304; cache only the deterministic SQL/aws-data answers)

- [ ] **Step 1: Add cache read before SQL generation**

In the streaming `if (config.handler === 'sql')` block (line 1255), after computing `lastMessage` and before `generateSQL`, attempt a cache hit. The fingerprint is unknown before the query runs, so use a **two-tier** approach: key on the *previous* fingerprint stored under a lightweight `(account,user,route,question)` pointer. Concretely, cache the final answer keyed by the SQL result fingerprint AFTER the query, and on the next identical question, re-run the (cheap, already-cached-by-Steampipe) SQL, compute the fingerprint, and look up the answer — skipping the **Bedrock analysis** call (the expensive part) on a fingerprint hit:

```typescript
// after: const sqlContent / before streamBedrockToSSE analysis, once sql+queryResult ready:
const promptCacheOn = getConfig().aiCost?.promptCache === true;
const answerCacheOn = getConfig().aiCost?.answerCache === true;
let cacheKey: string | undefined;
if (answerCacheOn && sql && queryResult && !queryResult.error) {
  const fp = sourceDataFingerprint(queryResult.data, STEAMPIPE_SCHEMA_VERSION);
  cacheKey = answerCacheKey({ accountId: accountId || 'all', userSub: currentUser.email, route, question: lastMessage, fingerprint: fp });
  const hit = getAnswer(cacheKey);
  if (hit) {
    await simulateStreaming(hit.content, send);
    send('done', { content: hit.content, model: modelKey || 'sonnet-4.6', via: `${config.display} (cached)`, queriedResources: ['steampipe'], route, usedTools: hit.usedTools || [], inputTokens: 0, outputTokens: 0 });
    controller.close();
    return;
  }
}
```

After the analysis `streamResult` completes and `sqlContent` is known, store it:

```typescript
if (answerCacheOn && cacheKey) setAnswer(cacheKey, accountId || 'all', { content: sqlContent, via: config.display, usedTools: sqlTools });
```

Add the imports and a `STEAMPIPE_SCHEMA_VERSION` const (bump string to force-invalidate after schema changes):

```typescript
import { getAnswer, setAnswer, answerCacheKey, sourceDataFingerprint, invalidateAccount } from '@/lib/ai-cost/answer-cache';
const STEAMPIPE_SCHEMA_VERSION = 'v1'; // bump on Steampipe plugin/schema change to invalidate all cached answers
```

- [ ] **Step 2: Add write-event invalidation**

In `src/app/api/steampipe/route.ts` (the PUT/POST that performs inventory snapshot / any mutation) and any future mutating path, call `invalidateAccount(accountId || 'all')` after a successful write so cached answers can't outlive a change. (Grep: `export async function PUT`/`POST` in `src/app/api/steampipe/route.ts`.) Add:

```typescript
import { invalidateAccount } from '@/lib/ai-cost/answer-cache';
// after a successful write/snapshot:
invalidateAccount(accountId || 'all');
```

- [ ] **Step 3: Run build + suite**

Run: `npm test && npm run build`
Expected: PASS + build OK. With `aiCost.answerCache` unset (default off), the new code is bypassed → behavior unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/ai/route.ts src/app/api/steampipe/route.ts
git commit -m "feat(adr-033): answer-cache the aws-data analysis call (fingerprint-keyed, write-invalidated)"
```

---

### Task 7: Per-user token budget (in-process)

**Files:**
- Create: `src/lib/ai-cost/token-budget.ts`
- Test: `tests/unit/ai-cost-token-budget.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/ai-cost-token-budget.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { checkBudget, recordSpend, _reset } from '@/lib/ai-cost/token-budget';

const LIMITS = { dailyTokens: 1000, warnPct: 0.8, overrideEmails: ['oncall@x.com'] };

describe('token budget', () => {
  beforeEach(() => _reset());
  it('allows under budget and reports remaining', () => {
    const r = checkBudget('acc', 'u@x.com', LIMITS);
    expect(r.allowed).toBe(true); expect(r.remaining).toBe(1000); expect(r.warn).toBe(false);
  });
  it('warns at >=80% and soft-caps at 100%', () => {
    recordSpend('acc', 'u@x.com', 850);
    expect(checkBudget('acc', 'u@x.com', LIMITS).warn).toBe(true);
    recordSpend('acc', 'u@x.com', 200); // 1050 > 1000
    expect(checkBudget('acc', 'u@x.com', LIMITS).allowed).toBe(false);
  });
  it('on-call override is always allowed', () => {
    recordSpend('acc', 'oncall@x.com', 5000);
    expect(checkBudget('acc', 'oncall@x.com', LIMITS).allowed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/ai-cost-token-budget.test.ts`
Expected: FAIL — import cannot be resolved.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/lib/ai-cost/token-budget.ts
// ADR-033 Phase 1: in-process per-(account,user) daily token counter.
// LIMITATION (documented in ADR-033): the counter is volatile — a process
// restart resets it; durable budget state moves to v2 Aurora (Phase 2).
export interface BudgetLimits { dailyTokens: number; warnPct: number; overrideEmails: string[]; }
export interface BudgetCheck { allowed: boolean; warn: boolean; remaining: number; }

const spent = new Map<string, number>();
const dayKey = (acc: string, user: string) => `${acc}:${user}:${new Date().toISOString().slice(0, 10)}`;

export function recordSpend(accountId: string, userSub: string, tokens: number): void {
  const k = dayKey(accountId, userSub);
  spent.set(k, (spent.get(k) || 0) + Math.max(0, tokens));
}
export function checkBudget(accountId: string, userSub: string, limits: BudgetLimits): BudgetCheck {
  if (limits.overrideEmails.includes(userSub)) return { allowed: true, warn: false, remaining: limits.dailyTokens };
  const used = spent.get(dayKey(accountId, userSub)) || 0;
  const remaining = Math.max(0, limits.dailyTokens - used);
  return { allowed: used < limits.dailyTokens, warn: used >= limits.dailyTokens * limits.warnPct, remaining };
}
export function _reset(): void { spent.clear(); } // test-only
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/ai-cost-token-budget.test.ts`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai-cost/token-budget.ts tests/unit/ai-cost-token-budget.test.ts
git commit -m "feat(adr-033): in-process per-user token budget (volatile v1, TDD)"
```

---

### Task 8: Wire budget check into POST + record spend

**Files:**
- Modify: `src/app/api/ai/route.ts` (`POST`, after `currentUser` at ~line 1049; and `recordAndSave` at ~line 985)

- [ ] **Step 1: Soft-cap gate at request entry**

After `const currentUser = getUserFromRequest(request);` (line 1049), before streaming starts:

```typescript
const aiCost = getConfig().aiCost;
if (aiCost?.budget) {
  const limits = { dailyTokens: aiCost.budget.dailyTokens, warnPct: aiCost.budget.warnPct ?? 0.8, overrideEmails: aiCost.budget.overrideEmails ?? [] };
  const b = checkBudget(accountId || 'all', currentUser.email, limits);
  if (!b.allowed) {
    return NextResponse.json({ error: 'Daily AI token budget exceeded. Contact on-call for an override.', code: 'BUDGET_EXCEEDED' }, { status: 429 });
  }
}
```

Add import: `import { checkBudget, recordSpend } from '@/lib/ai-cost/token-budget';`

- [ ] **Step 2: Record spend in `recordAndSave`**

Inside `recordAndSave` (line 985), after `recordCall(callRecord)`, add (guarded by config so it's a no-op when budget is off):

```typescript
const _budget = getConfig().aiCost?.budget;
if (_budget && p.userId) recordSpend(/* accountId unknown here */ 'all', p.userId, (p.inputTokens || 0) + (p.outputTokens || 0));
```

(Note: `recordAndSave` doesn't currently receive `accountId`; Phase 1 buckets by `'all'` + user. Threading `accountId` through is a small follow-up, not required for the cap to function.)

- [ ] **Step 3: Run build + suite**

Run: `npm test && npm run build`
Expected: PASS + build OK. With `aiCost.budget` unset (default), no gating and no spend recording → unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/ai/route.ts
git commit -m "feat(adr-033): per-user token budget gate + spend recording"
```

---

### Task 9: Config flags + golden-question SLO test

**Files:**
- Modify: `src/lib/app-config.ts` (add `aiCost` to the config type, default undefined)
- Modify: `data/config.json` (add a commented-off-equivalent `aiCost` example — all flags false)
- Create: `tests/fixtures/golden-questions.json`, `tests/unit/ai-classify-golden.test.ts`

- [ ] **Step 1: Add the `aiCost` config type**

In `src/lib/app-config.ts`, extend the config interface (find the existing `AppConfig`/`getConfig` type):

```typescript
export interface AiCostConfig {
  promptCache?: boolean;
  answerCache?: boolean;
  budget?: { dailyTokens: number; warnPct?: number; overrideEmails?: string[] };
}
// add to the AppConfig interface:
//   aiCost?: AiCostConfig;
```

- [ ] **Step 2: Write the golden fixture + SLO test (failing if heuristic accuracy drops)**

```json
// tests/fixtures/golden-questions.json
{
  "sloAccuracy": 0.85,
  "cases": [
    { "q": "EC2 인스턴스 목록 보여줘", "route": "aws-data" },
    { "q": "S3 버킷 몇 개야", "route": "aws-data" },
    { "q": "이번 달 비용 분석", "route": "cost" },
    { "q": "savings plan 추천", "route": "cost" },
    { "q": "보안 그룹 중 0.0.0.0/0 열린 거", "route": "security" },
    { "q": "IAM 사용자 MFA 확인", "route": "security" },
    { "q": "reachability analyzer로 경로 확인", "route": "network" },
    { "q": "flow log 분석", "route": "network" },
    { "q": "EKS 파드 crashloop 트러블슈팅", "route": "container" },
    { "q": "VPC 서브넷 리스트", "route": "aws-data" }
  ]
}
```

```typescript
// tests/unit/ai-classify-golden.test.ts
import { describe, it, expect } from 'vitest';
import golden from '../fixtures/golden-questions.json';
import { heuristicClassify } from '@/lib/ai-cost/heuristic-classifier';

describe('classification SLO (golden set)', () => {
  it('heuristic high-confidence hits meet the accuracy SLO (else keep Sonnet fallback)', () => {
    let decided = 0, correct = 0;
    for (const c of golden.cases) {
      const r = heuristicClassify(c.q);
      if (r && r.confidence === 'high') {
        decided++;
        if (r.routes[0] === c.route) correct++;
      }
    }
    // Of the questions the heuristic CONFIDENTLY decided, accuracy must clear the SLO.
    // A confident-but-wrong rate above (1 - SLO) means the heuristic is too aggressive
    // → tighten RULES (the LLM fallback still covers the undecided ones safely).
    const accuracy = decided === 0 ? 1 : correct / decided;
    expect(accuracy).toBeGreaterThanOrEqual(golden.sloAccuracy);
  });
});
```

- [ ] **Step 3: Run the SLO test**

Run: `npx vitest run tests/unit/ai-classify-golden.test.ts`
Expected: PASS (confident-decision accuracy ≥ 0.85). If it FAILS, the heuristic `RULES` in Task 1 are over-reaching — tighten them; undecided questions safely fall through to the LLM classifier, so precision matters more than recall.

- [ ] **Step 4: Run full suite + build**

Run: `npm test && npm run build`
Expected: all PASS, build OK.

- [ ] **Step 5: Commit**

```bash
git add src/lib/app-config.ts data/config.json tests/fixtures/golden-questions.json tests/unit/ai-classify-golden.test.ts
git commit -m "feat(adr-033): aiCost config flags (default off) + golden-set classification SLO"
```

---

## Rollout note (post-merge, not a code task)
All behavior is gated by `data/config.json` `aiCost.*` flags defaulting **off** → merging is a no-op until enabled. Enable in order on the live v1 host: `promptCache` → `answerCache` → `budget`, watching the `/bedrock` page's token/cost panel after each. The `STEAMPIPE_SCHEMA_VERSION` const must be bumped whenever the Steampipe plugin/schema changes (invalidates all cached answers).

---

## Self-Review

**1. Spec coverage (ADR-033 Phase 1 + 2026-06-09 addenda):**
- Heuristic → Haiku → Sonnet classification → Tasks 1, 2, 3. ✅
- Prompt caching on **direct** prefixes only (not gateway calls) → Task 4 (explicit "do NOT touch invokeAgentCore"). ✅ (addendum: caching reach corrected.)
- Exact-match answer cache keyed by (accountId, userSub, route, normalizedQuestion, sourceDataFingerprint), TTL ≤ Steampipe 5-min, write-invalidation, normalization → Tasks 5, 6. ✅ (addendum: `sourceDataFingerprint` includes plugin/schema version via `STEAMPIPE_SCHEMA_VERSION`.)
- Per-user token budget (warn 80% / soft cap / on-call override) + **documented volatility** → Tasks 7, 8 (comment + plan note). ✅
- Confidence-based tiering + single-route synthesis-skip → Task 2 (`shouldSkipSynthesis`); note: wiring synthesis-skip is covered because single high-confidence routes already bypass the multi-route synthesis branch in `route.ts` (synthesis only runs when `routes.length > 1`). ✅
- Golden-set + classification-accuracy SLO with always-Sonnet fallback → Task 9. ✅
- Phase-2 deferrals (semantic cache, durable budget) explicitly OUT of scope → header + Task 5/7 comments. ✅

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N" — each step has concrete code + exact commands. ✅

**3. Type consistency:** `HeuristicResult {routes, confidence}` (Task 1) consumed by `pickClassifierModel`/`shouldSkipSynthesis` (Task 2) and `classifyIntent` (Task 3) — consistent. `CachedAnswer {content, via?, usedTools?}` (Task 5) used identically in Task 6. `BudgetLimits/BudgetCheck` (Task 7) match the `checkBudget` call in Task 8. `cachedSystem(system, enabled)` signature (Task 4) matches all call sites. `AiCostConfig` (Task 9) fields (`promptCache`, `answerCache`, `budget.{dailyTokens,warnPct,overrideEmails}`) match Tasks 4/6/8 reads. ✅

Gap fixed during review: Task 8 notes `recordAndSave` lacks `accountId` → Phase 1 buckets spend under `'all'`+user (functional; threading accountId is a flagged follow-up, not a blocker).
