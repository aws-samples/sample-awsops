# Anthropic-SDK-on-Bedrock Agent Loop — Design Spec

- **Date**: 2026-06-24
- **Branch**: `feat/v2-anthropic-agent-loop` (off `origin/feat/v2-architecture-design` @ `f337a5c`)
- **Status**: Approved (brainstorming) → consensus pipeline
- **Owner**: ojs / Claude
- **Scope tier**: experimental, flag-gated dark path (default OFF)

## 1. Problem & Goal

The AWSops v2 chat agent runs inside an **AgentCore Runtime** container as a **Strands `Agent`**
driving a `BedrockModel` (`agent/agent.py`). Strands owns the agentic tool loop (model call →
tool selection → tool dispatch → synthesis). That loop is opaque to us when we need to debug *why*
the model picked a tool, dropped a result, or stalled.

**Goal**: add a second, **flag-gated** agent loop that keeps the AgentCore Runtime + Bedrock +
Gateway MCP boundaries exactly as-is, but replaces only the "brain" — the Strands `Agent` loop —
with a **custom loop built on the Anthropic SDK's Bedrock client** (`anthropic.AsyncAnthropicBedrock`).

```
web /api/chat            (BFF — unchanged; may add optional payload.agentLoop)
  → Bedrock AgentCore Runtime          (unchanged)
    → agent.py handler(payload)        (routing branch added)
       → anthropic_loop.run_anthropic_loop(payload)     ★ NEW dark path
           → (reused) gateway MCP via Strands MCPClient + existing SigV4 transport
           → MCP tool_spec → Anthropic tool schema
           → AsyncAnthropicBedrock.messages.stream(tools=…)
               ↺ tool_use → mcp_client.call_tool_sync → tool_result   (≤ max rounds)
           → yield {"delta": str}
```

### Why Bedrock (not the Anthropic public API)
- Keeps the AWS IAM / Bedrock / AgentCore deployment boundary intact.
- **No `ANTHROPIC_API_KEY`** — the Bedrock client uses the runtime role's credentials.
- **Bedrock invocation logs + awsops-only cost attribution preserved** (same `global.*` inference
  profile invoked from the home region `ap-northeast-2`, per ADR-038).
- Far lower security/ops friction than a direct-API migration.

### Non-goals
This is a **debuggability experiment**, not a Strands replacement. We are NOT removing Strands,
changing the BFF contract, or changing any infrastructure/Terraform.

## 2. Key Decisions (locked in brainstorming)

| # | Decision | Choice |
|---|---|---|
| D1 | First-increment scope | **Minimal slice**: gateway tools + history + `systemPromptOverride` + `extraContext` + account directive. **`integrations` (egress MCP) and `mode=="rca"` are NOT handled** — those payloads route to the existing Strands path. |
| D2 | Toggle mechanism | **env flag + payload override**: default = env `ANTHROPIC_AGENT_LOOP_ENABLED`; `payload.agentLoop ∈ {"anthropic","strands"}` overrides per-request. |
| D3 | MCP reuse | **Reuse Strands `MCPClient`** for transport + discovery + tool invocation; replace only the agent loop (Approach A). All existing SigV4 / pagination / allowlist / dedup code is shared. |
| D4 | Golden tests | **Contract/behavior unit tests** with Bedrock mocked (CI-safe, deterministic). No live dual-run in this increment. |
| D5 | Error semantics | A runtime error in the dark path does **NOT** silently re-run via Strands (that would mask the bugs we want to surface). Fail-soft with a delta + log; Strands↔Anthropic is a **routing-time** choice only. |

### Governance — reconciled with ADR-008 (amended 2026-06-24)
ADR-008 rejected the `AnthropicBedrock` wrapper, but **scoped to the diagnosis worker's single-shot
per-section calls** (latency rationale). The chat agent loop is a **distinct surface**: this
experiment is permitted behind `ANTHROPIC_AGENT_LOOP_ENABLED` (default OFF, dark) with a
**debuggability** lever (not latency), and going through the Bedrock client **preserves
IAM/VPC/residency/cost-attribution** (the very guarantees ADR-008 cared about). It is **not BYO-MCP
and not ADR-005**: no AWS-resource mutation, no autonomy, no new external endpoint — it reuses the
existing `awsops-v2-*` gateway MCP over the same SigV4 transport. ADR-008 §6 + BASELINE §2/§3 were
updated in the same change set.

## 3. Base-state facts (verified against `f337a5c`)

The handler drifted from older snapshots; the design targets the **current** `agent/agent.py`:

- Gateway resolution is `gateway_key = _resolve_gateway_key(role, GATEWAYS)` then
  `gateway_url = GATEWAYS.get(gateway_key)` — **no eager `GATEWAYS[DEFAULT_GATEWAY]` index**
  (KeyErrors under v2-only discovery). A `None` URL is tolerated by the MCP try-block (tool-less
  fallback). The new loop MUST use the same resolution.
- `SKILL_BASE` has **10 role keys** (network, container, ops, data, security, monitoring,
  **observability**, cost, diagnostics, iac); `build_skill_prompt(role, tools)` falls back to
  `DEFAULT_GATEWAY` ("ops").
- `handler` is an **async generator**; the `mode=="rca"` branch does `yield handle_rca(payload); return`.
- Shared helpers to reuse verbatim: `_resolve_gateway_key`, `create_gateway_transport`,
  `get_all_tools`, `_filter_tools`, `_dedup_by_tool_name`, `build_skill_prompt`,
  `build_conversation`, `build_account_directive`, `COMMON_FOOTER`, `SKILL_BASE`,
  `DEFAULT_GATEWAY`, `MCPClient`; plus `effective_account_id` from `account_utils`.
- Tests stub `sys.modules` (strands/bedrock/boto3) **before** `import agent`
  (see `agent/test_agent.py`). The agent Python unittests (`test_agent`, `test_account_logic`,
  `agent/tests/*`) pass at baseline (32 tests) but are **NOT wired into `tests/run-all.sh`** —
  which today runs only structure checks + web vitest.
- `agent/Dockerfile` installs deps via an **inline pip list** (not `requirements.txt`) and
  `COPY`s each source file explicitly.

## 4. New module — `agent/anthropic_loop.py`

### 4.1 Module shape (testability-first)
- **Top-level imports: stdlib only** (`json`, `os`, `logging`, `asyncio`). No `agent`, no
  `anthropic`, no `strands` at module load → the pure helpers import cleanly in CI without
  runtime deps.
- Heavy imports (`import agent`, `from anthropic import AsyncAnthropicBedrock`) happen **lazily
  inside `run_anthropic_loop`**. `agent.py` imports `anthropic_loop` lazily (inside `handler`),
  so there is no circular import at load time.

### 4.2 Pure helpers (unit-testable, no Bedrock)
```python
MAX_TOOL_ROUNDS = 8            # hard cap; prevents runaway tool loops

def should_use_anthropic_loop(payload) -> bool:
    """env ANTHROPIC_AGENT_LOOP_ENABLED default, overridden by payload.agentLoop."""

def mcp_tools_to_anthropic(tools) -> list[dict]:
    """MCP tool .tool_spec['inputSchema'] (JSON Schema) → Anthropic tool
    {name, description, input_schema}. Empty/missing schema → {"type":"object","properties":{}}."""

def build_anthropic_messages(history, user_input) -> list[dict]:
    """Strands history ([{role, content:[{text}]}]) + last user_input →
    Anthropic messages ([{role, content:[{type:'text', text}]}])."""

def extract_tool_uses(content_blocks) -> list[dict]:
    """Pull tool_use blocks {id, name, input} from a completed assistant turn.
    Handles BOTH dict-shaped blocks (test fakes) AND the Anthropic SDK's typed
    content-block objects (getattr fallback) — a dict-only extractor would pass
    tests yet fail the real tool loop."""

def tool_result_block(tool_use_id, mcp_result, is_error=False) -> dict:
    """{type:'tool_result', tool_use_id, content:[...], is_error}."""

def apply_cache_control(system_blocks, anthropic_tools) -> None:
    """Mark the last system block and the last tool with cache_control={'type':'ephemeral'}
    to match Strands cache_config='auto' + cache_tools (ADR-038 prompt-cache parity)."""
```

### 4.3 Orchestration (injectable for tests)
```python
async def drive_anthropic_loop(*, aclient, mcp_call, model, system_blocks,
                               anthropic_tools, messages, max_rounds) -> AsyncIterator[dict]:
    """The agentic loop, with ALL external effects injected:
      - aclient: AsyncAnthropicBedrock-like (has .messages.stream(...))
      - mcp_call(name, input) -> str|list: executes one tool (wraps mcp_client.call_tool_sync)
    Yields {"delta": str}. On stop_reason=='tool_use': run each tool via mcp_call (off-thread),
    append a tool_result user message, loop. At max_rounds: do one final tool-less synthesis turn,
    then stop. Tests inject a scripted fake aclient + fake mcp_call — no real SDK/AWS needed."""

async def run_anthropic_loop(payload) -> AsyncIterator[dict]:
    """Thin wiring: lazy-import agent + anthropic; build_conversation; resolve gateway;
    connect gateway MCPClient (ExitStack); get_all_tools → _dedup_by_tool_name → _filter_tools
    (toolAllowlist); build the system prompt mirroring `agent.handler` EXACTLY — override path:
    `systemPromptOverride + tool_section + COMMON_FOOTER + account_directive`; built-in path:
    `build_skill_prompt(skill_role, tools) + account_directive` (build_skill_prompt ALREADY appends
    COMMON_FOOTER — do NOT add it a second time); then bounded extra_context (≤8000). Convert tools;
    construct AsyncAnthropicBedrock(aws_region='ap-northeast-2'); delegate to drive_anthropic_loop.
    Fail-soft per D5."""
```

### 4.4 Tool dispatch detail
- Allowlist/dedup applied to MCP tool objects **before** schema conversion → identical ceiling &
  order to the Strands path (`_filter_tools(_dedup_by_tool_name(gateway_tools), toolAllowlist)`).
- Tool execution uses `mcp_client.call_tool_sync(name, arguments=input or {})` — the repo's
  established call shape (`agent/rca/tools.py`). The Anthropic `tool_use.id` is **NOT** a positional
  argument to `call_tool_sync`; it is carried only into the matching `tool_result` block. Strands'
  `MCPClient` runs its own background event-loop thread, so the call is blocking-but-thread-safe;
  the loop wraps it in `asyncio.to_thread(...)` so the async handler's event loop is not blocked.
  The MCP result content is normalized to text for the `tool_result` block.
- The account directive is appended to the system prompt and, when `account_id` is a real
  non-host/`__all__` value, the `[Target Account …]` prefix is added to `user_input` — both reuse
  the existing `agent.build_account_directive` + the handler's prefix rule.

### 4.5 Streaming / model / caching
- `AsyncAnthropicBedrock(aws_region="ap-northeast-2")`, `model="global.anthropic.claude-sonnet-4-6"`
  — same model + home region as the Strands path, preserving invocation-log cost attribution.
  **Assumption to verify once at impl time**: the Anthropic Bedrock SDK passes a `global.*`
  inference-profile id straight through as the Bedrock `modelId`. If it does not, fall back to the
  region-appropriate profile id and record the deviation in the spec/PR.
- Text deltas come from the stream's text events → `yield {"delta": text}`.
- `temperature=0.0` (parity with the Strands `BedrockModel`).
- **`max_tokens` is REQUIRED** by the Anthropic Messages API — define a `MAX_OUTPUT_TOKENS`
  constant (e.g. 4096) and pass it to every `messages.stream(...)` call. Omitting it fails the
  first model call before any delta (the dark path would only ever fail-soft).
- Prompt caching via `cache_control:{"type":"ephemeral"}` on the last system block + last tool
  (see `apply_cache_control`).

## 5. `agent/agent.py` integration (minimal touch)

Insert immediately after the `mode=="rca"` branch, before `build_conversation`:
```python
# Flag-gated dark path (ADR-038/experiment): custom Anthropic-SDK-on-Bedrock loop.
# Minimal slice — integrations (egress MCP) still route to the Strands path below.
from anthropic_loop import should_use_anthropic_loop  # cheap (stdlib-only module top-level)
if should_use_anthropic_loop(payload) and not payload.get("integrations"):
    from anthropic_loop import run_anthropic_loop
    async for chunk in run_anthropic_loop(payload):
        yield chunk
    return
```
- Default OFF (env unset ∧ no override) → byte-for-byte the current behavior; `plan`/runtime
  unaffected; `$0`.
- `integrations` present → skip the dark path (minimal-slice boundary).

## 6. Dependencies & container

- Add `anthropic[bedrock]` to **both** `agent/requirements.txt` **and** the `agent/Dockerfile`
  inline pip list (the file header mandates keeping them in sync). No `ANTHROPIC_API_KEY`.
- Add `COPY anthropic_loop.py .` to `agent/Dockerfile`.
- arm64 build unchanged (`make agentcore`).
- Pin policy: pin `anthropic` to a known-good minor at impl time (record the exact version).

## 7. Tests (contract/behavior, Bedrock mocked)

New `agent/tests/test_anthropic_loop.py` (stdlib `unittest`, no network):
1. `should_use_anthropic_loop` truth table — env × payload override (`anthropic`/`strands`/absent).
2. `mcp_tools_to_anthropic` — `inputSchema` → `input_schema`; empty/missing schema default.
3. `build_anthropic_messages` — history + last → Anthropic format; empty/edge input.
4. allowlist + dedup applied **before** conversion (same ceiling/order as Strands).
5. `extract_tool_uses` / `tool_result_block` round-trip shapes — fakes cover BOTH dict-shaped
   blocks AND object-shaped (getattr) blocks like the real SDK returns.
6. `drive_anthropic_loop` with a **scripted fake aclient** (emits text deltas, then a `tool_use`,
   then a final answer) + **fake `mcp_call`**: asserts the `{"delta": …}` sequence, that the tool
   ran once, and that a `tool_result` was fed back.
7. **max-rounds cap**: fake aclient that keeps requesting tools → loop stops at `MAX_TOOL_ROUNDS`
   with a final synthesis, never infinite.
8. Output-contract: every yielded item is `{"delta": str}`.
9. Fail-soft (pre-first-delta): an exception before the first delta yields exactly one fail-soft
   delta (no crash, no Strands re-run).
10. Fail-soft (post-first-delta, `started=True`): an error after the first delta (e.g. during tool
   execution or a later stream turn) yields a bounded interruption delta and stops — it does not
   raise and does not re-run the model (mirrors `agent.handler`'s `started` guard).
11. `max_tokens` is passed to the stream call (the fake client asserts it received a positive int).

**Wire Python agent tests into the gate**: add an "Agent Python tests" section to
`tests/run-all.sh` that runs the agent unittests (`python3 -m unittest` discovery over `agent/`),
so these golden tests actually gate in consensus/CI (today they don't run there).

## 8. Out of scope (YAGNI — possible follow-ups)
- `integrations` egress-MCP support in the dark path.
- `mode=="rca"` via the Anthropic loop.
- Live dual-run comparison script / harness.
- Per-request model selection via payload.
- A BFF/UI toggle surface for `agentLoop`.

## 9. Risks & mitigations
| Risk | Mitigation |
|---|---|
| `global.*` profile id not accepted by the Anthropic Bedrock SDK | Verify once at impl; fall back to region profile id; record deviation. |
| `call_tool_sync` signature/result shape differs in 1.41.0 | Re-verify at impl; normalize result to text; covered by the round-trip test with a fake. |
| Blocking MCP call stalls the async loop | `asyncio.to_thread` around `call_tool_sync`. |
| Cost attribution regression | Same model + home region + invocation logs as Strands path; no API-key path. |
| Gate doesn't actually run Python tests | Wire agent unittests into `tests/run-all.sh` (§7). |
| Hidden behavior divergence from Strands | Contract tests on the seams (schema conv, allowlist order, account directive, delta contract). |

## 10. Acceptance criteria
- Flag OFF → identical current behavior (no new code path taken).
- Flag ON (or `payload.agentLoop="anthropic"`), no integrations → chat answers stream as
  `{"delta": …}`, gateway MCP tools are called read-only, capped at `MAX_TOOL_ROUNDS`.
- `integrations` present or `mode=="rca"` → Strands path (unchanged).
- New unit tests pass and run inside `bash tests/run-all.sh`; existing suite stays green.
- No `ANTHROPIC_API_KEY`; Bedrock invocation logs still capture the calls.
