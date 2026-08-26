"""Flag-gated dark-path chat agent loop on the Anthropic SDK's Bedrock client.

Alongside the Strands `Agent` loop in `agent.py`, this module runs the SAME gateway
MCP tools through a custom agentic loop built on `anthropic.AsyncAnthropicBedrock`.
The lever is **tool-loop debuggability** (removing the opacity of the Strands loop),
NOT latency. Default OFF via `ANTHROPIC_AGENT_LOOP_ENABLED`; per-request override via
`payload.agentLoop`. Going through the Bedrock client preserves IAM/VPC/residency and
Bedrock invocation-log cost attribution (no API key). See ADR-008 (amended 2026-06-24)
and BASELINE §2.

Design note (testability): the module top-level imports are stdlib-only so the pure
helpers AND the injected orchestration loop (`drive_anthropic_loop`) are unit-testable
without `anthropic`/`strands`/network. The heavy imports (`agent`, `anthropic`) are
lazy, inside `run_anthropic_loop`.
"""
import asyncio
import inspect
import logging
import os
import sys

# Same model + home region as the Strands path → invocation-log cost attribution intact.
MODEL_ID = "global.anthropic.claude-sonnet-4-6"
BEDROCK_REGION = "ap-northeast-2"
MAX_TOOL_ROUNDS = 8          # hard cap on tool-call rounds (runaway-loop backstop)
MAX_OUTPUT_TOKENS = 4096     # Anthropic Messages API REQUIRES max_tokens on every call
MODEL_TEMPERATURE = 0.0      # parity with the Strands BedrockModel — deterministic tool selection (ADR-038)
EXTRA_CONTEXT_CAP = 8000     # bound BFF-supplied context (parity with agent.handler)
TOOL_RESULT_CHAR_CAP = 24000 # bound a single tool result fed back (avoid per-round context/token blowup)

logger = logging.getLogger(__name__)


def should_use_anthropic_loop(payload):
    """Route decision: env `ANTHROPIC_AGENT_LOOP_ENABLED` is the default; `payload.agentLoop`
    ('anthropic' | 'strands') overrides per-request. Returns True iff the dark path handles it."""
    override = (payload or {}).get("agentLoop")
    if override == "anthropic":
        return True
    if override == "strands":
        return False
    return os.environ.get("ANTHROPIC_AGENT_LOOP_ENABLED", "").strip().lower() == "true"


def _input_schema(tool):
    """Extract a JSON Schema for an MCP tool. Strands wraps it as ``{'inputSchema': {'json': {...}}}``;
    accept that, a flat ``inputSchema``, or attribute forms. Empty/missing → permissive object."""
    spec = getattr(tool, "tool_spec", None)
    schema = None
    if isinstance(spec, dict):
        schema = spec.get("inputSchema") or spec.get("input_schema")
    if schema is None:
        schema = getattr(tool, "inputSchema", None) or getattr(tool, "input_schema", None)
    if isinstance(schema, dict) and isinstance(schema.get("json"), dict):
        schema = schema["json"]  # unwrap Strands' {'json': <schema>}
    if not isinstance(schema, dict) or not schema:
        return {"type": "object", "properties": {}}
    return schema


def mcp_tools_to_anthropic(tools):
    """MCP tool objects → Anthropic ``tools=[{name, description, input_schema}]``, order preserved."""
    out = []
    for t in tools:
        name = getattr(t, "tool_name", None) or (t.get("name") if isinstance(t, dict) else None)
        if not name:  # Bedrock rejects a tool with name=None; gateway tools always have a name
            logger.warning("skipping tool with no name in mcp_tools_to_anthropic")
            continue
        spec = getattr(t, "tool_spec", None)
        desc = getattr(t, "description", "") or (spec.get("description") if isinstance(spec, dict) else "") or ""
        out.append({"name": name, "description": desc, "input_schema": _input_schema(t)})
    return out


def build_anthropic_messages(history, user_input):
    """Strands history (``[{role, content:[{text}]}]``, last message excluded) + the final
    user_input → Anthropic messages (``[{role, content:[{type:'text', text}]}]``)."""
    msgs = []
    for m in history or []:
        role = m.get("role", "user")
        text = "".join(part.get("text", "") for part in (m.get("content") or []) if isinstance(part, dict))
        if not text.strip():  # skip empty turns — Anthropic rejects empty text blocks in input (→ 400)
            continue
        msgs.append({"role": role, "content": [{"type": "text", "text": text}]})
    msgs.append({"role": "user", "content": [{"type": "text", "text": user_input}]})
    return msgs


def _block_attr(block, key, default=None):
    """Read ``key`` from a content block that may be a dict (test fakes) OR a typed SDK object."""
    if isinstance(block, dict):
        return block.get(key, default)
    return getattr(block, key, default)


def extract_tool_uses(content_blocks):
    """Pull ``{id, name, input}`` for each ``tool_use`` block in a completed assistant turn.
    Handles BOTH dict-shaped blocks and the SDK's typed content-block objects."""
    uses = []
    for b in content_blocks or []:
        if _block_attr(b, "type") == "tool_use":
            uses.append({
                "id": _block_attr(b, "id"),
                "name": _block_attr(b, "name"),
                "input": _block_attr(b, "input") or {},
            })
    return uses


def tool_result_block(tool_use_id, result, is_error=False):
    """A ``tool_result`` content block carrying the (text-normalized) MCP result, bounded to
    ``TOOL_RESULT_CHAR_CAP`` so a large gateway response can't blow up per-round context/token/cost."""
    text = result if isinstance(result, str) else str(result)
    if len(text) > TOOL_RESULT_CHAR_CAP:
        text = text[:TOOL_RESULT_CHAR_CAP] + f"\n…[truncated {len(text) - TOOL_RESULT_CHAR_CAP} chars]"
    block = {
        "type": "tool_result",
        "tool_use_id": tool_use_id,
        "content": [{"type": "text", "text": text}],
    }
    if is_error:
        block["is_error"] = True
    return block


def apply_cache_control(system_blocks, anthropic_tools):
    """Prompt-cache parity with the Strands path (cache_config='auto' + cache_tools): mark the
    LAST system block and the LAST tool with ``cache_control={'type':'ephemeral'}``. No-op on empties."""
    if system_blocks:
        system_blocks[-1]["cache_control"] = {"type": "ephemeral"}
    if anthropic_tools:
        anthropic_tools[-1]["cache_control"] = {"type": "ephemeral"}


def _assistant_content(final):
    """Rebuild a serializable assistant turn (text + tool_use blocks) from a final message,
    so it can be appended to ``messages`` before the tool_result turn. Handles dict/object blocks."""
    out = []
    for b in getattr(final, "content", None) or []:
        t = _block_attr(b, "type")
        if t == "text":
            txt = _block_attr(b, "text", "") or ""
            if txt.strip():  # Anthropic rejects empty text blocks in INPUT → drop them (P4 CI: API 400)
                out.append({"type": "text", "text": txt})
        elif t == "tool_use":
            out.append({"type": "tool_use", "id": _block_attr(b, "id"),
                        "name": _block_attr(b, "name"), "input": _block_attr(b, "input") or {}})
    return out


# Fail-soft deltas (mirrors agent.handler's wording for the post-stream case).
_INTERRUPTED_DELTA = "\n\n_[연결이 중단되어 응답이 일부만 전달되었습니다.]_"
_FAILED_DELTA = "_[에이전트 루프 오류로 응답을 생성하지 못했습니다.]_"


async def drive_anthropic_loop(*, aclient, mcp_call, model, system_blocks,
                               anthropic_tools, messages, max_rounds, max_tokens,
                               allowed_tool_names=None):
    """The agentic loop, with all external effects injected so it is unit-testable with fakes:

      - ``aclient``: AsyncAnthropicBedrock-like; ``aclient.messages.stream(**kwargs)`` returns an
        async context manager exposing ``.text_stream`` (async iterator of str) and
        ``await .get_final_message()`` (→ object with ``.stop_reason`` and ``.content``).
      - ``mcp_call(name, input)``: a SYNC callable that runs ONE tool and returns its result.
        Called off the event loop via ``asyncio.to_thread`` so a blocking MCP call never stalls
        streaming. A per-tool exception becomes an ``is_error`` tool_result (one bad tool does not
        abort the turn).

    Yields ``{"delta": str}``. On ``stop_reason == 'tool_use'`` it runs the tools, appends the
    assistant turn + a ``tool_result`` user turn, and loops. The model is offered tools only while
    ``rounds < max_rounds``; at the cap it makes one final TOOL-LESS synthesis turn and stops —
    never an unbounded loop. Errors are fail-soft (D5): no re-run, no exception escapes.
    """
    started = False
    try:
        msgs = list(messages)
        rounds = 0
        while True:
            offer_tools = bool(anthropic_tools) and rounds < max_rounds
            kwargs = {"model": model, "max_tokens": max_tokens,
                      "temperature": MODEL_TEMPERATURE,
                      "system": system_blocks, "messages": msgs}
            if offer_tools:
                kwargs["tools"] = anthropic_tools
            async with aclient.messages.stream(**kwargs) as stream:
                async for text in stream.text_stream:
                    if text:
                        started = True
                        yield {"delta": text}
                final = await stream.get_final_message()

            if not offer_tools or _block_attr(final, "stop_reason") != "tool_use":
                return  # normal completion (or the capped final synthesis turn)

            tool_uses = extract_tool_uses(getattr(final, "content", None) or [])
            if not tool_uses:
                return
            msgs.append({"role": "assistant", "content": _assistant_content(final)})
            results = []
            for tu in tool_uses:
                # Defense-in-depth (ADR-031/039): the allowlist is enforced OUTSIDE the model. The model
                # output is NOT a security boundary — refuse to EXECUTE any tool the model names that is
                # not in the allowed set, even if it hallucinated a gateway tool we did not expose.
                if allowed_tool_names is not None and tu["name"] not in allowed_tool_names:
                    logger.warning("tool %s not in allowlist — refused at execution time", tu.get("name"))
                    results.append(tool_result_block(tu["id"], f"tool not permitted: {tu['name']}", is_error=True))
                    continue
                try:
                    res = await asyncio.to_thread(mcp_call, tu["id"], tu["name"], tu["input"])
                    results.append(tool_result_block(tu["id"], res))
                except Exception as e:  # one tool failing must not abort the turn
                    logger.warning("tool %s failed: %s", tu.get("name"), e)
                    results.append(tool_result_block(tu["id"], f"tool error: {e}", is_error=True))
            msgs.append({"role": "user", "content": results})
            rounds += 1
    except Exception as e:
        logger.error("anthropic loop error (started=%s): %s", started, e, exc_info=True)
        yield {"delta": _INTERRUPTED_DELTA if started else _FAILED_DELTA}
        return


def _normalize_tool_result(res):
    """Normalize a Strands ``call_tool_sync`` result to text for a ``tool_result`` block.
    The result typically carries ``.content`` = a list of blocks with ``.text`` (or dict ``{'text':…}``).
    Defensive across shapes; exact shape is environment-verified at runtime."""
    if isinstance(res, str):
        return res
    content = getattr(res, "content", None)
    if content is None and isinstance(res, dict):
        content = res.get("content")
    if content is None:
        return str(res)
    parts = []
    for b in content:
        txt = _block_attr(b, "text", None)
        parts.append(txt if txt is not None else str(b))
    joined = "\n".join(p for p in parts if p)
    return joined or str(res)


async def _aclose(client):
    """Best-effort close of the Anthropic client's HTTP connection pool (avoids socket/FD leak across
    requests). Handles both async (``aclose``/awaitable ``close``) and sync ``close`` across SDK versions."""
    for name in ("aclose", "close"):
        fn = getattr(client, name, None)
        if fn is None:
            continue
        try:
            res = fn()
            if inspect.isawaitable(res):
                await res
        except Exception as e:  # closing must never break the response
            logger.warning("anthropic client close failed: %s", e)
        return


async def run_anthropic_loop(payload):
    """Thin wiring for the dark path (minimal slice): reuse agent.py's MCP/prompt plumbing, connect
    the gateway MCP, and drive ``drive_anthropic_loop`` on an ``AsyncAnthropicBedrock`` client.

    Mirrors ``agent.handler`` for input parsing, gateway resolution, the tool allowlist/dedup ceiling,
    and the system-prompt construction (override vs built-in — no doubled COMMON_FOOTER). Heavy imports
    (``agent``, ``anthropic``) are lazy here so the rest of this module stays import-light for tests.
    ``integrations`` and ``mode=='rca'`` are intentionally NOT handled here — the handler routes those
    to the Strands path (minimal-slice boundary)."""
    # agent.py runs as __main__ (Dockerfile CMD ["python","agent.py"]); reuse that already-initialized
    # module rather than `import agent`, which would load a SECOND instance and re-run gateway discovery
    # (AWS CLI subprocess) + BedrockModel construction. Falls back to a real import when run as a module
    # (e.g. tests, where __main__ is the test runner — picks up a stubbed `agent` from sys.modules).
    agent = sys.modules.get("__main__")
    if not hasattr(agent, "create_gateway_transport"):
        import agent  # noqa: F811 — module-import fallback
    from anthropic import AsyncAnthropicBedrock  # lazy: only the dark path needs the SDK

    user_input, history = agent.build_conversation(payload)
    if not user_input:
        yield {"delta": "No input provided."}
        return

    gateway_role = payload.get("gateway", agent.DEFAULT_GATEWAY)
    skill_role = payload.get("skill", gateway_role)
    system_prompt_override = payload.get("systemPromptOverride")
    extra_context = payload.get("extraContext")
    tool_allowlist = payload.get("toolAllowlist")
    gateway_key = agent._resolve_gateway_key(gateway_role, agent.GATEWAYS)
    gateway_url = agent.GATEWAYS.get(gateway_key)

    # Cross-account directive (effective_account_id blanks the host / __all__ → same-account, no prefix).
    account_id = agent.effective_account_id(payload.get("accountId", ""))
    account_alias = payload.get("accountAlias", "")
    account_directive = agent.build_account_directive(account_id, account_alias)
    if account_id and account_id != "__all__":
        user_input = f"[Target Account: {account_alias or account_id} ({account_id})] {user_input}"

    logger.info("anthropic_loop gateway=%s key=%s account=%s history=%d",
                gateway_role, gateway_key, account_id or "default", len(history))

    started = False
    try:
        from contextlib import ExitStack
        mcp_client = agent.MCPClient(lambda: agent.create_gateway_transport(gateway_url))
        with ExitStack() as stack:
            stack.enter_context(mcp_client)
            gateway_tools = agent.get_all_tools(mcp_client)
            # Same ceiling/order as the Strands path: dedup (gateway precedence) THEN allowlist,
            # applied to the MCP tool objects BEFORE schema conversion.
            tools = agent._filter_tools(agent._dedup_by_tool_name(gateway_tools), tool_allowlist)

            if system_prompt_override:
                tool_lines = []
                for t in tools:
                    desc = getattr(t, "description", "") or ""
                    short = desc.split(".")[0].strip() if desc else t.tool_name
                    tool_lines.append(f"- **{t.tool_name}**: {short}")
                tool_section = f"\n\n## Available Tools ({len(tools)}):\n" + "\n".join(tool_lines)
                system_text = system_prompt_override + tool_section + agent.COMMON_FOOTER + account_directive
            else:
                # build_skill_prompt ALREADY appends COMMON_FOOTER — do NOT add it again.
                system_text = agent.build_skill_prompt(skill_role, tools) + account_directive
            if extra_context:
                system_text = system_text + "\n\n" + str(extra_context)[:EXTRA_CONTEXT_CAP]

            anthropic_tools = mcp_tools_to_anthropic(tools)
            system_blocks = [{"type": "text", "text": system_text}]
            apply_cache_control(system_blocks, anthropic_tools)

            # Bedrock client (no API key — uses the runtime role); same home region as the Strands path.
            aclient = AsyncAnthropicBedrock(aws_region=BEDROCK_REGION)
            try:
                def mcp_call(tool_use_id, name, inp):
                    # Strands MCPClient.call_tool_sync(tool_use_id, name, arguments=...): the FIRST
                    # positional is tool_use_id, NOT name (verified live — agent/rca/tools.py wraps a
                    # DIFFERENT client whose signature is (name, arguments=), which misled an earlier fix).
                    return _normalize_tool_result(
                        mcp_client.call_tool_sync(tool_use_id, name, arguments=inp or {}))

                messages = build_anthropic_messages(history, user_input)
                allowed_tool_names = {t["name"] for t in anthropic_tools}  # execution-time ceiling
                async for chunk in drive_anthropic_loop(
                        aclient=aclient, mcp_call=mcp_call, model=MODEL_ID,
                        system_blocks=system_blocks, anthropic_tools=anthropic_tools,
                        messages=messages, max_rounds=MAX_TOOL_ROUNDS, max_tokens=MAX_OUTPUT_TOKENS,
                        allowed_tool_names=allowed_tool_names):
                    started = True
                    yield chunk
            finally:
                await _aclose(aclient)  # release the HTTP connection pool (no socket/FD leak)
        return
    except Exception as e:
        # drive_anthropic_loop fail-softs internally, so this only catches PRE-stream setup errors
        # (MCP connect, tool discovery, client construction). No Strands re-run (D5).
        logger.error("run_anthropic_loop setup error (started=%s): %s", started, e, exc_info=True)
        if not started:
            yield {"delta": _FAILED_DELTA}
        return
