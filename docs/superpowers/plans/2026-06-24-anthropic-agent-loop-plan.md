# Implementation Plan — Anthropic-SDK-on-Bedrock Agent Loop (flag-gated dark path)

Spec: `docs/superpowers/specs/2026-06-24-anthropic-agent-loop-design.md`
Branch: `feat/v2-anthropic-agent-loop` · Base/trunk: `origin/feat/v2-architecture-design` (`f337a5c`)

## Approach
TDD + Tidy First. Each task: write the failing test → minimal code → refactor → commit.
The new module `agent/anthropic_loop.py` is designed so its **pure helpers** and its
**orchestration loop** are unit-testable with NO `anthropic`/`strands`/`boto3`/network — heavy
imports (`agent`, `anthropic`) are lazy, inside `run_anthropic_loop`. Bedrock + MCP are injected
into `drive_anthropic_loop` so tests drive it with fakes.

## Test gate baseline (pre-existing, NOT introduced here)
`bash tests/run-all.sh` is red at base on origin with exactly **2** failures, both outside
`agent/`: `docs/architecture.md missing` (structure check drift) and the web vitest
`alert-knowledge.test.ts`. **Green criterion for this change = the failing set must not grow
AND all agent Python unittests pass.** We do not touch web/docs (out of scope; concurrent
sessions own them).

---

### Task 1: Pure helpers + tests
**Files:**
- Create: `agent/anthropic_loop.py`
- Test: `agent/tests/test_anthropic_loop.py`

- [ ] Write failing tests in `agent/tests/test_anthropic_loop.py` (stdlib `unittest`, import `anthropic_loop` directly — top-level must stay stdlib-only):
  - [ ] `should_use_anthropic_loop` truth table: env `ANTHROPIC_AGENT_LOOP_ENABLED` ∈ {unset,"true","false"} × `payload.agentLoop` ∈ {absent,"anthropic","strands"} (override wins).
  - [ ] `mcp_tools_to_anthropic`: a fake tool whose `.tool_spec={"name","description","inputSchema":{...}}` → `{name, description, input_schema}`; missing/empty schema → `{"type":"object","properties":{}}`.
  - [ ] `build_anthropic_messages`: history `[{role,content:[{text}]}]` + `user_input` → `[{role,content:[{type:"text",text}]}]`; empty history; empty input.
  - [ ] `extract_tool_uses`: assistant content blocks → list of `{id,name,input}` (only `tool_use` blocks); fakes cover BOTH dict-shaped AND object-shaped (getattr) blocks like the real SDK returns.
  - [ ] `tool_result_block`: `(id, result, is_error)` → `{type:"tool_result",tool_use_id,content,is_error}`.
  - [ ] `apply_cache_control`: marks last system block + last tool with `cache_control={"type":"ephemeral"}`; no-op on empty lists.
- [ ] Implement `agent/anthropic_loop.py` with stdlib-only top-level imports, `MAX_TOOL_ROUNDS=8`, and the six pure helpers above. Make tests pass.
- [ ] Run `cd agent && python3 -m unittest tests.test_anthropic_loop` → green.
- [ ] Commit: `feat(agent): anthropic_loop pure helpers (schema/messages/cache) + tests`.

### Task 2: Orchestration loop `drive_anthropic_loop` (injected deps) + tests
**Files:**
- Modify: `agent/anthropic_loop.py`
- Test: `agent/tests/test_anthropic_loop.py`

- [ ] Write failing tests using a **scripted fake async client** (a `messages.stream(...)` async context manager that yields text-delta events then a turn with a `tool_use` block, then a final text turn) and a **fake `mcp_call(name,input)`**:
  - [ ] Happy path: yields `{"delta": str}` in order; the tool runs exactly once; a `tool_result` is appended before the next model turn; final answer streamed.
  - [ ] `MAX_TOOL_ROUNDS` cap: a fake client that always asks for a tool → loop stops at the cap with one final tool-less synthesis turn; never infinite; emits a bounded number of rounds.
  - [ ] Output contract: every yielded item is a dict with a single `"delta"` str key.
  - [ ] Fail-soft (pre-first-delta): an exception before the first delta yields exactly one fail-soft `{"delta": …}` and stops (no exception escapes, no re-run).
  - [ ] Fail-soft (post-first-delta, `started=True`): an error after the first delta yields a bounded interruption delta and stops — does NOT raise, does NOT re-run the model.
  - [ ] `max_tokens` is passed to the stream call — the fake client asserts it received a positive int (Anthropic Messages API requires it; omitting it fails the first call).
- [ ] Implement `async def drive_anthropic_loop(*, aclient, mcp_call, model, system_blocks, anthropic_tools, messages, max_rounds, max_tokens)`:
  - [ ] Stream a model turn (passing `max_tokens=MAX_OUTPUT_TOKENS`); forward text deltas as `{"delta": text}`.
  - [ ] On `stop_reason=="tool_use"`: extract tool_uses; run each via `await asyncio.to_thread(mcp_call, name, input)`; append assistant turn + a user turn of `tool_result` blocks; loop.
  - [ ] Stop when `stop_reason!="tool_use"` or rounds hit `max_rounds` (final tool-less synthesis turn at the cap).
  - [ ] Wrap the whole generator body so a pre-first-delta error yields the fail-soft delta (track a `started` flag mirroring `agent.handler`).
- [ ] Run unittest → green. Commit: `feat(agent): drive_anthropic_loop agentic loop (injected Bedrock+MCP) + tests`.

### Task 3: `run_anthropic_loop` wiring + stubbed test
**Files:**
- Modify: `agent/anthropic_loop.py`
- Test: `agent/tests/test_anthropic_loop.py`

- [ ] Write a failing test that installs `sys.modules` stubs (mirroring `agent/test_agent.py`) for `anthropic` (an `AsyncAnthropicBedrock` capturing ctor kwargs) and reuses agent stubs, then asserts `run_anthropic_loop`:
  - [ ] Constructs `AsyncAnthropicBedrock(aws_region="ap-northeast-2")` and uses model `global.anthropic.claude-sonnet-4-6`, `temperature=0.0`.
  - [ ] Applies `_dedup_by_tool_name` + `_filter_tools(toolAllowlist)` to gateway tools **before** schema conversion (same ceiling/order as Strands).
  - [ ] Builds the system prompt mirroring `agent.handler` EXACTLY: override path = `systemPromptOverride + tool_section + COMMON_FOOTER + account_directive`; built-in path = `build_skill_prompt(skill_role, tools) + account_directive` (build_skill_prompt ALREADY appends COMMON_FOOTER — assert it is NOT doubled); then bounded `extraContext` (≤8000 chars).
  - [ ] No-input payload → single `{"delta": "No input provided."}`.
- [ ] Implement `async def run_anthropic_loop(payload)`: lazy `import agent` + `from anthropic import AsyncAnthropicBedrock`; `build_conversation`; resolve gateway via `agent._resolve_gateway_key`/`GATEWAYS.get`; open `MCPClient` in an `ExitStack`; `get_all_tools` → dedup → filter; build system prompt (mirror handler; no doubled footer); `mcp_tools_to_anthropic`; define `mcp_call(name, input)` calling `mcp_client.call_tool_sync(name, arguments=input or {})` (the repo's call shape, `agent/rca/tools.py`); delegate to `drive_anthropic_loop` with `max_tokens=MAX_OUTPUT_TOKENS`. Fail-soft on pre-stream error.
- [ ] Confirm against installed `strands-agents==1.41.0` that `call_tool_sync(name, arguments=…)` is correct (matches `agent/rca/tools.py`); the Anthropic `tool_use.id` goes ONLY into the `tool_result` block, never as a positional arg. Normalize the MCP result content to text.
- [ ] Run unittest → green. Commit: `feat(agent): run_anthropic_loop wiring (gateway MCP + AsyncAnthropicBedrock) + test`.

### Task 4: Route the handler to the dark path
**Files:**
- Modify: `agent/agent.py`
- Test: `agent/test_agent.py`

- [ ] Write a failing test (extends `agent/test_agent.py` stub harness) that patches `anthropic_loop.run_anthropic_loop` with a fake async-gen and asserts `handler`:
  - [ ] delegates to it when `should_use_anthropic_loop(payload)` is true AND `payload` has no `integrations`.
  - [ ] does NOT delegate (uses Strands path) when `integrations` is present, even with the flag on.
  - [ ] does NOT delegate for `mode=="rca"` (RCA branch still wins).
- [ ] Implement: insert, immediately after the `mode=="rca"` branch and before `build_conversation`, the gate:
  `from anthropic_loop import should_use_anthropic_loop` → `if should_use_anthropic_loop(payload) and not payload.get("integrations"): from anthropic_loop import run_anthropic_loop; async for chunk in run_anthropic_loop(payload): yield chunk; return`.
- [ ] Run `cd agent && python3 -m unittest test_agent` → green (existing 32 + new). Commit: `feat(agent): flag-gated route from handler to anthropic_loop (minimal slice)`.

### Task 5: Dependency + container wiring
**Files:**
- Modify: `agent/requirements.txt`
- Modify: `agent/Dockerfile`

- [ ] Add `anthropic[bedrock]` (pinned to a known-good version — record the exact pin) to `agent/requirements.txt`.
- [ ] Add the same pin to the `agent/Dockerfile` inline `pip install` list and add `COPY anthropic_loop.py .`.
- [ ] Sanity: `python3 -c "import ast; ast.parse(open('agent/anthropic_loop.py').read())"` (syntax) and confirm Dockerfile COPY/pip lines are consistent with `requirements.txt`.
- [ ] Commit: `build(agent): add anthropic[bedrock] dep + COPY anthropic_loop.py (no API key; Bedrock client)`.

### Task 6: Wire agent Python tests into the project test gate
**Files:**
- Modify: `tests/run-all.sh`

- [ ] Add an "Agent Python tests" section that runs the agent unittests (e.g. `(cd agent && python3 -m unittest discover -s . -p 'test_*.py' && python3 -m unittest discover -s tests -p 'test_*.py')`) and records a single `pass`/`fail` line, so the golden tests actually gate (today `run-all.sh` runs only structure checks + web vitest).
- [ ] Run `bash tests/run-all.sh`: confirm the failing set ⊆ the frozen baseline (`docs/architecture.md`, vitest `alert-knowledge`) — i.e. no NEW failures — and the new "Agent Python tests" line is `ok`.
- [ ] Commit: `test(agent): run agent Python unittests in tests/run-all.sh gate`.

---

## Done criteria
- Flag OFF (default) → no new code path taken; behavior byte-identical.
- Flag ON / `payload.agentLoop="anthropic"` + no integrations → streams `{"delta": …}` via the
  Anthropic Bedrock loop, gateway MCP tools called read-only, capped at `MAX_TOOL_ROUNDS`.
- `integrations` present or `mode=="rca"` → Strands path unchanged.
- All agent Python unittests green and running inside `tests/run-all.sh`; no new run-all failures.
- No `ANTHROPIC_API_KEY`; same model + home region → Bedrock invocation-log cost attribution intact.

## Out of scope
integrations egress MCP in the dark path · RCA via Anthropic loop · live dual-run harness ·
per-request model selection · BFF/UI toggle. (Spec §8.)
