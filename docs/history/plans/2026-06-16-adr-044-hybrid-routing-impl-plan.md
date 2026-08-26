# Plan: ADR-044 v2 Chat Hybrid Routing — cross-domain auto-synthesis + pin/chip + Agent Space filter

> Implements **ADR-044** (supersedes ADR-025 for v2, amends ADR-038). TDD, bite-sized, per-task commit.
> **Scope: `web/` only.** Explicitly **excludes** `scripts/v2/workers/**` (held by a concurrent session; B1 comms-write executor is flag-OFF dark code, out of scope here).
> **Safety: all new behavior is behind `MULTI_ROUTE_SYNTHESIS_ENABLED` (default OFF).** Flag off ⇒ byte-identical to today's single-route + chips path. No live regression until the golden-set gate passes (ADR-044 §6).

## Context (current code, verified)
- `web/lib/classifier.ts` — already returns `{"ranked":[{key,score}]}` (≤3). No change needed.
- `web/lib/route.ts` `classifyRoute()` — pin → regex(1 match) → llm → fallback; returns `{primary, ranked, method}`. **Uses only `ranked[0]`.** No multi-domain signal.
- `web/app/api/chat/route.ts` — invokes **one** gateway (`invokeAgent({gateway: spec.gateway})`). `ranked` is emitted in `meta` for the UI's switch chips. **No fan-out, no synthesis.**
- `web/components/chat/{useChat.ts,MessageList.tsx}` — `send(prompt, overrideSection, switchedFrom)`; a chip click re-sends with `section`=chip target + `switchedFrom`=prev. Chips render from `meta.ranked`.

## Files in scope (allowed set)
- `web/lib/route.ts` + `web/lib/route.test.ts`
- `web/lib/synthesize.ts` (new) + `web/lib/synthesize.test.ts` (new)
- `web/app/api/chat/route.ts` + `web/app/api/chat/route.test.ts`
- `web/components/chat/useChat.ts` + `web/components/chat/MessageList.tsx`
- `web/lib/agentcore.ts` (read-only reuse of `invokeAgent`; edit only if a multi-call signature is needed)

## Plan gate (2026-06-16) — verdict GO-WITH-CHANGES
Panel: agy/Gemini-3.1 (full review) + kiro-cli/Opus (independently confirmed code premises: classifier already returns `ranked`; chat does a single `invokeAgent`). codex down (engine 404). Findings folded in below (chair-verified against code):
- **[CRITICAL, T3] per-gateway resolve.** `invokeAgent` consumes a full `ResolvedAgentSpec` (gateway + toolAllowlist + systemPromptOverride + integrations). Fan-out MUST build a **separate invoke input per selected gateway**, not reuse `route.primary`'s `spec`. Since fan-out is restricted to `tier==='builtin'`, each is a trivial builtin spec (`{gateway, agentName: gateway, skillHashes:[]}`, no override/allowlist) — construct one per gateway.
- **[MAJOR, T1/T3] multiDomain staleness.** `route.multiDomain` is computed in pure `route.ts`; the Agent-Space/active filter runs later in `chat/route.ts`. **Recompute** `effectiveMultiDomain = filteredSelected.length >= 2` AFTER filtering, and branch on that (not the stale flag).
- **[MAJOR→refined, T4] disabled-agent routing.** Chair correction: `enabledAgentIds` is **custom-agent-only** (`catalog-source.ts`); built-ins are gated by the global `active` flag. So T4(b) = filter `selected` to **active** sections only (the `active` field already on `RankedEntry`) + the existing `inactiveSection` block already handles a disabled *primary*. Do NOT invent built-in×enabledAgentIds gating (ill-defined).
- **[MINOR, T3] meta timing.** Emit the `meta` SSE frame **immediately** from `route.selected` (the attempt list) — never wait for `Promise.allSettled` survivors (UX regression). `record()` stores the actual survivors/`via` after synthesis.
- **[MINOR, T2] injection hardening.** Wrap `userPrompt` and each `parts[].text` in explicit tags (`<user_query>`, `<domain_response gateway="...">`) so a malicious domain answer can't jailbreak the synthesis system prompt.

## Tasks

- [ ] **T1 — Multi-domain detection in `route.ts`.**
  Add `multiDomain: boolean` and `selected: RankedEntry[]` to `RouteResult`. In the `llm` branch, after building `ranked`, compute `selected` = active entries with `score >= MULTI_ROUTE_MIN_SCORE` (env, default `0.3`), capped at 3; `multiDomain = selected.length >= 2`. `pin`/`regex`/`fallback` ⇒ `multiDomain=false`, `selected=[primary]`. Pure, never throws.
  *Tests:* ≥2 active routes above threshold ⇒ multiDomain + selected sorted desc; one dominant ⇒ single; pin/regex ⇒ single; inactive routes excluded from `selected`; below-threshold excluded.

- [ ] **T2 — `web/lib/synthesize.ts` (port ADR-025 `synthesizeResponsesStreaming`).**
  `async function* synthesizeStream(userPrompt, parts: {gateway,text}[], opts?: {send?}): AsyncIterable<string>` — one Bedrock Sonnet `ConverseStream` call, system = "Combine these per-domain analyses into one coherent answer; do not repeat; keep per-domain structure." Yields text deltas. `send` injectable; never throws (on error, yield a concatenated fallback). Sonnet model id from env (`SYNTHESIS_MODEL_ID`, default the v2 Sonnet).
  *Tests:* merges 2 parts via injected send; single part ⇒ passthrough (no Bedrock call); injected error ⇒ graceful concatenation fallback; prompt-injection in `parts[].text` is treated as data (system immutable).

- [ ] **T3 — Fan-out + synthesis wiring in `web/app/api/chat/route.ts` (flag-gated).**
  Add `const synthOn = process.env.MULTI_ROUTE_SYNTHESIS_ENABLED === 'true'`. When `synthOn && hybridOn && route?.multiDomain && spec.tier==='builtin'` (custom agents + inactive sections keep single path): fan out `invokeAgent` over `route.selected` gateways with `Promise.allSettled` (cap 3). 0 survivors ⇒ existing fallback; 1 ⇒ stream it directly (skip synth); ≥2 ⇒ stream `synthesizeStream(prompt, survivors)`. `meta.via = 'multi:network+cost'`, `meta.routes = selected keys`. `record()` stores the merged text + meta. Flag off OR not multiDomain ⇒ **unchanged single path**.
  *Tests:* flag off ⇒ single invoke (regression lock); flag on + multiDomain + 2 survivors ⇒ synthesize called, merged stream, `via` in meta; 1 survivor ⇒ no synth; allSettled drops a rejected gateway; custom-agent pin ⇒ single path even if multiDomain.

- [ ] **T4 — Pin/chip precedence + Agent Space active filter.**
  (a) Assert a chip-switch resend (`switchedFrom` + new `section`) overrides a prior pin — add the regression test (current `body.section` flow already does this; lock it so ADR-044's deadlock fix can't regress). (b) Filter `route.ranked`/`selected` by the Agent Space: a built-in section not in `space.enabledAgentIds` (when a space row exists) is dropped from selection (mirrors the existing `isCustomAgentEnabled` fail-closed posture for customs). No space ⇒ unchanged.
  *Tests:* chip resend overrides earlier pin; space with `enabledAgentIds=[network]` drops `cost` from `selected`; no space ⇒ all kept.

- [ ] **T5 — Thread agent-agnostic lock (test-only).**
  Add a `chat-store`/route test asserting the same `threadId` persists across two turns that route to different gateways, and per-turn `gateway` is recorded in `meta` (ADR-018 isolation keyed user+account+thread, not agent). No production change expected — if a change is needed, it is a bug.

- [ ] **T6 — UI: chips demoted to secondary + multi-route "via" badge.**
  `MessageList.tsx`: when `meta.via` starts with `multi:`, render a combined "Network + Cost" badge for the synthesized answer; keep `ranked` chips but relabel as "다른 도메인 더 보기 / explore another domain" (secondary aid, not the primary path). `useChat.ts`: a chip click must clear any sticky pin (verify the resend path does not leave the UI locked to one agent). Component test if a harness exists; otherwise a typed unit assertion on the label/branch.

## Out of scope (deferred)
- B1 comms-write executor semantics (`scripts/v2/workers/**`) — held-session collision + flag-OFF dark code; the ADR-040 §3 doc amendment already landed.
- Golden-set tuning of `MULTI_ROUTE_MIN_SCORE` and activation of `MULTI_ROUTE_SYNTHESIS_ENABLED` (owner-gated, ADR-044 §6).
- Incident federation (ADR-032) and external integration (ADR-039) paths — delineated by ADR-044 §5, not changed here.

## Done
All tasks committed (explicit paths), `web` vitest green, flag default OFF verified (single-route path byte-identical), and the multi-route path exercised only under the flag in tests.

## Result (P5)
- **Status: COMPLETE — merge-ready (flag-OFF).** Commits `953bbf3`(T1) `7ecbbed`(T2) `c0ce534`(T3) `792dfe2`(T4) `b154842`(T5) `b29840c`(T6) `694ab08`(T7 gate-fixes).
- **Tests:** full `web` vitest **858 passed / 1 skipped**; my source files tsc-clean (pre-existing `intent/inventory` test-type errors untouched).
- **Plan gate (round 0):** GO-WITH-CHANGES (agy; kiro confirmed code premises) → 5 findings folded in before implementing.
- **Final gate round 1:** agy NO-GO + kiro GO-WITH-CHANGES → CRITICAL (custom-pin), MAJOR (disabled-fallback) + MINORs fixed in T7.
- **Final gate round 2:** **agy GO + kiro GO** — all findings resolved, no regressions, no remaining blockers. (codex unavailable all rounds — engine 404.)
- **Activation:** behind `MULTI_ROUTE_SYNTHESIS_ENABLED` (default OFF). Owner enables after a multi-domain golden-set passes (ADR-044 §6). Deploy is `make deploy` (web image only); no terraform.
- **Deferred (unchanged):** B1 comms-write executor (`scripts/v2/workers/**`, held-session + flag-OFF); full custom-agent UI picker (ADR-039 gap #6) — server-side pin contract is now honored, UI picker wiring is separate.
