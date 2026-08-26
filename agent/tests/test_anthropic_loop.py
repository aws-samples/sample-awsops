"""Unit tests for agent/anthropic_loop.py — pure helpers + the injected agentic loop.

Stdlib unittest only. anthropic_loop's module top-level is stdlib-only (the heavy
imports — agent, anthropic — are lazy inside run_anthropic_loop), so the pure helpers
and the injected loop are testable here with NO anthropic/strands/network.

Run:  cd agent && python3 -m unittest tests.test_anthropic_loop
"""
import asyncio
import os
import types
import unittest

import anthropic_loop as al


# ── Fakes ────────────────────────────────────────────────────────────────────
class FakeTool:
    """Mimics a Strands MCP tool: .tool_name + .tool_spec (inputSchema wrapped in {'json': …})."""
    def __init__(self, name, description="", input_schema=None, nested=True):
        self.tool_name = name
        self.description = description
        schema = input_schema if input_schema is not None else {"type": "object", "properties": {}}
        self.tool_spec = {
            "name": name,
            "description": description,
            "inputSchema": {"json": schema} if nested else schema,
        }


def run(agen):
    """Drain an async generator to a list (sync test helper)."""
    async def _collect():
        return [x async for x in agen]
    return asyncio.run(_collect())


# ── should_use_anthropic_loop (truth table) ──────────────────────────────────
class ShouldUseAnthropicLoopTest(unittest.TestCase):
    def setUp(self):
        self._saved = os.environ.get("ANTHROPIC_AGENT_LOOP_ENABLED")
        os.environ.pop("ANTHROPIC_AGENT_LOOP_ENABLED", None)

    def tearDown(self):
        os.environ.pop("ANTHROPIC_AGENT_LOOP_ENABLED", None)
        if self._saved is not None:
            os.environ["ANTHROPIC_AGENT_LOOP_ENABLED"] = self._saved

    def test_env_unset_no_override_is_false(self):
        self.assertFalse(al.should_use_anthropic_loop({}))

    def test_env_true_no_override_is_true(self):
        os.environ["ANTHROPIC_AGENT_LOOP_ENABLED"] = "true"
        self.assertTrue(al.should_use_anthropic_loop({}))

    def test_env_true_but_payload_strands_overrides_false(self):
        os.environ["ANTHROPIC_AGENT_LOOP_ENABLED"] = "true"
        self.assertFalse(al.should_use_anthropic_loop({"agentLoop": "strands"}))

    def test_env_unset_but_payload_anthropic_overrides_true(self):
        self.assertTrue(al.should_use_anthropic_loop({"agentLoop": "anthropic"}))

    def test_env_garbage_is_false(self):
        os.environ["ANTHROPIC_AGENT_LOOP_ENABLED"] = "yes-please"
        self.assertFalse(al.should_use_anthropic_loop({}))

    def test_none_payload_safe(self):
        self.assertFalse(al.should_use_anthropic_loop(None))


# ── mcp_tools_to_anthropic ────────────────────────────────────────────────────
class McpToolsToAnthropicTest(unittest.TestCase):
    def test_maps_name_description_and_unwraps_nested_schema(self):
        schema = {"type": "object", "properties": {"x": {"type": "string"}}, "required": ["x"]}
        out = al.mcp_tools_to_anthropic([FakeTool("get_x", "Get the X. Detail.", schema)])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["name"], "get_x")
        self.assertEqual(out[0]["description"], "Get the X. Detail.")
        # nested {'json': schema} must be unwrapped to the bare JSON Schema
        self.assertEqual(out[0]["input_schema"], schema)

    def test_flat_schema_passthrough(self):
        schema = {"type": "object", "properties": {"y": {"type": "number"}}}
        out = al.mcp_tools_to_anthropic([FakeTool("f", "d", schema, nested=False)])
        self.assertEqual(out[0]["input_schema"], schema)

    def test_missing_or_empty_schema_defaults_to_object(self):
        out = al.mcp_tools_to_anthropic([FakeTool("g", "d", {})])
        self.assertEqual(out[0]["input_schema"], {"type": "object", "properties": {}})

    def test_preserves_order(self):
        out = al.mcp_tools_to_anthropic([FakeTool("a"), FakeTool("b"), FakeTool("c")])
        self.assertEqual([t["name"] for t in out], ["a", "b", "c"])


# ── build_anthropic_messages ─────────────────────────────────────────────────
class BuildAnthropicMessagesTest(unittest.TestCase):
    def test_history_plus_last_user_input(self):
        history = [
            {"role": "user", "content": [{"text": "hi"}]},
            {"role": "assistant", "content": [{"text": "hello"}]},
        ]
        msgs = al.build_anthropic_messages(history, "what is up?")
        self.assertEqual(msgs[0], {"role": "user", "content": [{"type": "text", "text": "hi"}]})
        self.assertEqual(msgs[1], {"role": "assistant", "content": [{"type": "text", "text": "hello"}]})
        self.assertEqual(msgs[-1], {"role": "user", "content": [{"type": "text", "text": "what is up?"}]})

    def test_empty_history(self):
        msgs = al.build_anthropic_messages([], "only message")
        self.assertEqual(msgs, [{"role": "user", "content": [{"type": "text", "text": "only message"}]}])

    def test_drops_empty_history_turn(self):
        # P4 CI (M1): an empty/whitespace history turn must NOT become an empty text block (→ 400).
        history = [
            {"role": "user", "content": [{"text": "   "}]},      # empty → dropped
            {"role": "assistant", "content": [{"text": "hi"}]},
        ]
        msgs = al.build_anthropic_messages(history, "q")
        self.assertEqual(msgs, [
            {"role": "assistant", "content": [{"type": "text", "text": "hi"}]},
            {"role": "user", "content": [{"type": "text", "text": "q"}]},
        ])


# ── extract_tool_uses (dict AND object blocks) ───────────────────────────────
class ExtractToolUsesTest(unittest.TestCase):
    def test_dict_blocks(self):
        blocks = [
            {"type": "text", "text": "thinking"},
            {"type": "tool_use", "id": "tu_1", "name": "list_vpcs", "input": {"region": "x"}},
        ]
        uses = al.extract_tool_uses(blocks)
        self.assertEqual(uses, [{"id": "tu_1", "name": "list_vpcs", "input": {"region": "x"}}])

    def test_object_blocks_like_real_sdk(self):
        text = types.SimpleNamespace(type="text", text="hi")
        tu = types.SimpleNamespace(type="tool_use", id="tu_2", name="get_topology", input={})
        uses = al.extract_tool_uses([text, tu])
        self.assertEqual(uses, [{"id": "tu_2", "name": "get_topology", "input": {}}])

    def test_no_tool_use_returns_empty(self):
        self.assertEqual(al.extract_tool_uses([{"type": "text", "text": "x"}]), [])


# ── tool_result_block ─────────────────────────────────────────────────────────
class ToolResultBlockTest(unittest.TestCase):
    def test_shape(self):
        b = al.tool_result_block("tu_1", "some result")
        self.assertEqual(b["type"], "tool_result")
        self.assertEqual(b["tool_use_id"], "tu_1")
        self.assertEqual(b["content"], [{"type": "text", "text": "some result"}])
        self.assertNotIn("is_error", b)  # only present when True

    def test_error_flag(self):
        b = al.tool_result_block("tu_2", "boom", is_error=True)
        self.assertTrue(b["is_error"])

    def test_caps_long_result(self):
        # P4 CI (m2): a large tool result must be bounded so it can't blow up per-round context.
        big = "x" * (al.TOOL_RESULT_CHAR_CAP + 500)
        txt = al.tool_result_block("t", big)["content"][0]["text"]
        self.assertLessEqual(len(txt), al.TOOL_RESULT_CHAR_CAP + 60)  # cap + short truncation marker
        self.assertIn("truncated", txt)


# ── apply_cache_control ───────────────────────────────────────────────────────
class ApplyCacheControlTest(unittest.TestCase):
    def test_marks_last_system_and_last_tool(self):
        sys_blocks = [{"type": "text", "text": "a"}, {"type": "text", "text": "b"}]
        tools = [{"name": "t1"}, {"name": "t2"}]
        al.apply_cache_control(sys_blocks, tools)
        self.assertNotIn("cache_control", sys_blocks[0])
        self.assertEqual(sys_blocks[-1]["cache_control"], {"type": "ephemeral"})
        self.assertEqual(tools[-1]["cache_control"], {"type": "ephemeral"})

    def test_empty_lists_no_crash(self):
        al.apply_cache_control([], [])  # must not raise


# ── Fakes for the injected agentic loop (Task 2) ─────────────────────────────
class _FakeStreamCtx:
    def __init__(self, chunks, final):
        self._chunks, self._final = chunks, final

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    @property
    def text_stream(self):
        async def _gen():
            for c in self._chunks:
                yield c
        return _gen()

    async def get_final_message(self):
        return self._final


class _FakeMessages:
    def __init__(self, script, raise_on=None):
        self._script = list(script)
        self.calls = []
        self._raise_on = raise_on

    def stream(self, **kwargs):
        idx = len(self.calls)
        self.calls.append(kwargs)
        if self._raise_on is not None and idx == self._raise_on:
            raise RuntimeError("boom-stream")
        chunks, final = self._script[idx]  # IndexError past the script ⇒ simulated later failure
        return _FakeStreamCtx(chunks, final)


class _FakeClient:
    def __init__(self, script, raise_on=None):
        self.messages = _FakeMessages(script, raise_on)


class _Recorder:
    def __init__(self, result="ok"):
        self.calls = []
        self.result = result

    def __call__(self, tool_use_id, name, inp):
        self.calls.append((tool_use_id, name, inp))
        return self.result


def _final(stop_reason, content):
    return types.SimpleNamespace(stop_reason=stop_reason, content=content)


def _tooluse(id, name, inp):
    return {"type": "tool_use", "id": id, "name": name, "input": inp}


def _text(t):
    return {"type": "text", "text": t}


def _drive(client, mcp_call, *, tools, max_rounds=8, max_tokens=al.MAX_OUTPUT_TOKENS,
           system=None, messages=None, allowed=None):
    return run(al.drive_anthropic_loop(
        aclient=client, mcp_call=mcp_call, model=al.MODEL_ID,
        system_blocks=system if system is not None else [_text("sys")],
        anthropic_tools=tools,
        messages=messages if messages is not None else [{"role": "user", "content": [_text("q")]}],
        max_rounds=max_rounds, max_tokens=max_tokens, allowed_tool_names=allowed))


class DriveAnthropicLoopTest(unittest.TestCase):
    def test_happy_path_streams_runs_tool_and_feeds_result(self):
        client = _FakeClient([
            (["Let me check. "], _final("tool_use", [_tooluse("tu1", "list_vpcs", {"region": "x"})])),
            (["3 VPCs."], _final("end_turn", [_text("3 VPCs.")])),
        ])
        rec = _Recorder("vpc-a,vpc-b,vpc-c")
        deltas = _drive(client, rec, tools=[{"name": "list_vpcs", "input_schema": {}}])
        self.assertEqual(deltas, [{"delta": "Let me check. "}, {"delta": "3 VPCs."}])
        # tool ran exactly once with the model-supplied input
        self.assertEqual(rec.calls, [("tu1", "list_vpcs", {"region": "x"})])
        # max_tokens passed on the first call
        self.assertEqual(client.messages.calls[0]["max_tokens"], al.MAX_OUTPUT_TOKENS)
        self.assertIn("tools", client.messages.calls[0])
        # the tool_result was fed back on the 2nd model turn
        second_msgs = client.messages.calls[1]["messages"]
        results = [blk for m in second_msgs if m["role"] == "user"
                   for blk in m["content"] if isinstance(blk, dict) and blk.get("type") == "tool_result"]
        self.assertTrue(any(r["tool_use_id"] == "tu1" for r in results))

    def test_max_rounds_cap_forces_final_toolless_turn(self):
        # every turn asks for a tool; cap=2 ⇒ 3 stream calls (2 tool rounds + 1 tool-less synthesis)
        always_tool = ([], _final("tool_use", [_tooluse("t", "list_vpcs", {})]))
        client = _FakeClient([always_tool, always_tool, (["final answer"], _final("end_turn", [_text("final answer")]))])
        rec = _Recorder()
        deltas = _drive(client, rec, tools=[{"name": "list_vpcs"}], max_rounds=2)
        self.assertEqual(len(rec.calls), 2)                 # exactly max_rounds tool calls
        self.assertEqual(len(client.messages.calls), 3)     # bounded — no infinite loop
        self.assertNotIn("tools", client.messages.calls[2])  # final synthesis turn offers no tools
        self.assertIn({"delta": "final answer"}, deltas)

    def test_output_contract_is_delta_str(self):
        client = _FakeClient([(["hello ", "world"], _final("end_turn", [_text("hello world")]))])
        deltas = _drive(client, _Recorder(), tools=[])
        for d in deltas:
            self.assertEqual(list(d.keys()), ["delta"])
            self.assertIsInstance(d["delta"], str)

    def test_no_tools_single_turn(self):
        client = _FakeClient([(["just text"], _final("end_turn", [_text("just text")]))])
        deltas = _drive(client, _Recorder(), tools=[])
        self.assertEqual(deltas, [{"delta": "just text"}])
        self.assertEqual(len(client.messages.calls), 1)

    def test_failsoft_before_first_delta(self):
        client = _FakeClient([(["unused"], _final("end_turn", [_text("x")]))], raise_on=0)
        deltas = _drive(client, _Recorder(), tools=[])
        self.assertEqual(deltas, [{"delta": al._FAILED_DELTA}])

    def test_failsoft_after_first_delta(self):
        # one tool round streams "partial ", then the 2nd model turn errors (script exhausted)
        client = _FakeClient([(["partial "], _final("tool_use", [_tooluse("t", "list_vpcs", {})]))])
        deltas = _drive(client, _Recorder(), tools=[{"name": "list_vpcs"}])
        self.assertEqual(deltas, [{"delta": "partial "}, {"delta": al._INTERRUPTED_DELTA}])

    def test_tool_error_becomes_is_error_result_not_fatal(self):
        def boom(tool_use_id, name, inp):
            raise ValueError("tool exploded")
        client = _FakeClient([
            (["trying "], _final("tool_use", [_tooluse("tu1", "list_vpcs", {})])),
            (["recovered"], _final("end_turn", [_text("recovered")])),
        ])
        deltas = _drive(client, boom, tools=[{"name": "list_vpcs"}])
        self.assertEqual(deltas, [{"delta": "trying "}, {"delta": "recovered"}])  # not fatal
        results = [blk for m in client.messages.calls[1]["messages"] if m["role"] == "user"
                   for blk in m["content"] if isinstance(blk, dict) and blk.get("type") == "tool_result"]
        self.assertTrue(any(r.get("is_error") for r in results))

    def test_assistant_content_drops_empty_text_blocks(self):
        # P4 CI gate (kiro-opus): Anthropic rejects empty text blocks in input → a tool_use turn with
        # an empty/whitespace text block would 400 on the next round. _assistant_content must drop them.
        final = _final("tool_use", [_text("  "), _text("real"), _tooluse("t", "x", {})])
        out = al._assistant_content(final)
        self.assertEqual(out, [
            {"type": "text", "text": "real"},
            {"type": "tool_use", "id": "t", "name": "x", "input": {}},
        ])

    def test_temperature_zero_passed_to_stream(self):
        # P4 gate (kiro-opus MAJOR): parity with the Strands BedrockModel temperature=0.0 (ADR-038).
        client = _FakeClient([(["x"], _final("end_turn", [_text("x")]))])
        _drive(client, _Recorder(), tools=[])
        self.assertEqual(client.messages.calls[0]["temperature"], al.MODEL_TEMPERATURE)
        self.assertEqual(al.MODEL_TEMPERATURE, 0.0)

    def test_multiple_tool_uses_in_one_turn_all_run(self):
        client = _FakeClient([
            ([], _final("tool_use", [_tooluse("a", "list_vpcs", {}), _tooluse("b", "get_topology", {})])),
            (["done"], _final("end_turn", [_text("done")])),
        ])
        rec = _Recorder()
        _drive(client, rec, tools=[{"name": "list_vpcs"}, {"name": "get_topology"}])
        self.assertEqual([c[0] for c in rec.calls], ["a", "b"])           # tool_use_ids forwarded
        self.assertEqual([c[1] for c in rec.calls], ["list_vpcs", "get_topology"])  # names
        results = [blk for m in client.messages.calls[1]["messages"] if m["role"] == "user"
                   for blk in m["content"] if isinstance(blk, dict) and blk.get("type") == "tool_result"]
        self.assertEqual({r["tool_use_id"] for r in results}, {"a", "b"})

    def test_execution_time_allowlist_refuses_unlisted_tool(self):
        # P4 gate (codex, defense-in-depth): model output is not a security boundary — a tool the
        # model names that is NOT in the allowed set must be refused at execution, never run.
        client = _FakeClient([
            ([], _final("tool_use", [_tooluse("x", "delete_everything", {})])),
            (["ok"], _final("end_turn", [_text("ok")])),
        ])
        rec = _Recorder()
        _drive(client, rec, tools=[{"name": "list_vpcs"}], allowed={"list_vpcs"})
        self.assertEqual(rec.calls, [])  # never executed
        results = [blk for m in client.messages.calls[1]["messages"] if m["role"] == "user"
                   for blk in m["content"] if isinstance(blk, dict) and blk.get("type") == "tool_result"]
        self.assertTrue(any(r.get("is_error") and "not permitted" in r["content"][0]["text"] for r in results))


# ── run_anthropic_loop wiring (stubbed agent + anthropic) — Task 3 ────────────
import sys


class _FakeMCPClient:
    def __init__(self, transport_factory):
        self._tf = transport_factory
        self.tool_calls = []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def call_tool_sync(self, tool_use_id, name, arguments=None):
        # Real Strands MCPClient signature: (tool_use_id, name, arguments=...). The first positional
        # is tool_use_id, NOT name — matching this to reality is exactly what caught the live bug.
        self.tool_calls.append((tool_use_id, name, arguments))
        return types.SimpleNamespace(content=[types.SimpleNamespace(text=f"out:{name}")])


class _CapturingBedrock:
    instances = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.closed = False
        # one end_turn turn so the loop completes with a single delta
        self.messages = _FakeMessages([(["hi"], _final("end_turn", [_text("hi")]))])
        _CapturingBedrock.instances.append(self)

    async def aclose(self):
        self.closed = True


def _install_agent_stub(gateway_tools, *, footer="FOOTER", skill_prompt="SKILLPROMPT"):
    m = types.ModuleType("agent")
    m.DEFAULT_GATEWAY = "ops"
    m.GATEWAYS = {"ops": "https://gw/ops/mcp"}
    m.COMMON_FOOTER = footer
    m.MCPClient = _FakeMCPClient
    m._resolve_gateway_key = lambda role, gws: role if role in gws else "ops"
    m.create_gateway_transport = lambda url: ("transport", url)
    m.get_all_tools = lambda client: list(gateway_tools)
    m._dedup_by_tool_name = lambda tools: tools

    def _filter(tools, allow):
        if not allow:
            return tools
        s = set(allow)
        return [t for t in tools if getattr(t, "tool_name", None) in s]
    m._filter_tools = _filter
    m.build_skill_prompt = lambda role, tools: skill_prompt  # real impl already includes the footer
    m.build_account_directive = lambda aid, alias: (f"\nACCT:{aid}" if aid and aid != "__all__" else "")
    m.effective_account_id = lambda aid: "" if (not aid or aid == "__all__") else aid

    def _bc(payload):
        msgs = payload.get("messages") or []
        if msgs:
            hist = [{"role": x.get("role", "user"), "content": [{"text": x.get("content", "")}]}
                    for x in msgs[:-1]]
            return msgs[-1].get("content", ""), hist
        return payload.get("prompt", ""), []
    m.build_conversation = _bc
    sys.modules["agent"] = m
    return m


class RunAnthropicLoopTest(unittest.TestCase):
    def setUp(self):
        self._saved = {k: sys.modules.get(k) for k in ("agent", "anthropic")}
        _CapturingBedrock.instances = []
        anth = types.ModuleType("anthropic")
        anth.AsyncAnthropicBedrock = _CapturingBedrock
        sys.modules["anthropic"] = anth

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v

    def test_no_input_yields_single_delta(self):
        _install_agent_stub([])
        out = run(al.run_anthropic_loop({"messages": [{"role": "user", "content": ""}]}))
        self.assertEqual(out, [{"delta": "No input provided."}])

    def test_constructs_bedrock_client_in_home_region_with_model(self):
        _install_agent_stub([FakeTool("list_vpcs", "List VPCs")])
        out = run(al.run_anthropic_loop({"messages": [{"role": "user", "content": "hello"}]}))
        self.assertEqual(out, [{"delta": "hi"}])
        self.assertEqual(_CapturingBedrock.instances[-1].kwargs, {"aws_region": "ap-northeast-2"})
        call0 = _CapturingBedrock.instances[-1].messages.calls[0]
        self.assertEqual(call0["model"], al.MODEL_ID)
        self.assertEqual(call0["max_tokens"], al.MAX_OUTPUT_TOKENS)

    def test_allowlist_applied_before_conversion(self):
        _install_agent_stub([FakeTool("keep", "k"), FakeTool("drop", "d")])
        run(al.run_anthropic_loop({"messages": [{"role": "user", "content": "x"}],
                                   "toolAllowlist": ["keep"]}))
        tools = _CapturingBedrock.instances[-1].messages.calls[0]["tools"]
        self.assertEqual([t["name"] for t in tools], ["keep"])

    def test_builtin_prompt_does_not_double_footer(self):
        _install_agent_stub([FakeTool("t")], footer="FOOTER", skill_prompt="SKILLPROMPT")
        run(al.run_anthropic_loop({"messages": [{"role": "user", "content": "x"}]}))
        sys_text = _CapturingBedrock.instances[-1].messages.calls[0]["system"][0]["text"]
        self.assertIn("SKILLPROMPT", sys_text)
        self.assertNotIn("FOOTER", sys_text)  # build_skill_prompt already owns the footer

    def test_override_prompt_appends_footer_once(self):
        _install_agent_stub([FakeTool("t")], footer="FOOTER")
        run(al.run_anthropic_loop({"messages": [{"role": "user", "content": "x"}],
                                   "systemPromptOverride": "CUSTOM"}))
        sys_text = _CapturingBedrock.instances[-1].messages.calls[0]["system"][0]["text"]
        self.assertIn("CUSTOM", sys_text)
        self.assertEqual(sys_text.count("FOOTER"), 1)

    def test_client_closed_after_run(self):
        # P4 CI gate (codex): the AsyncAnthropicBedrock HTTP pool must be closed (no FD/socket leak).
        _install_agent_stub([FakeTool("t")])
        run(al.run_anthropic_loop({"messages": [{"role": "user", "content": "x"}]}))
        self.assertTrue(_CapturingBedrock.instances[-1].closed)

    def test_account_directive_prefixes_user_input(self):
        _install_agent_stub([FakeTool("t")])
        run(al.run_anthropic_loop({"messages": [{"role": "user", "content": "list"}],
                                   "accountId": "999999999999", "accountAlias": "prod"}))
        msgs = _CapturingBedrock.instances[-1].messages.calls[0]["messages"]
        last_text = msgs[-1]["content"][-1]["text"]
        self.assertIn("Target Account: prod (999999999999)", last_text)
        sys_text = _CapturingBedrock.instances[-1].messages.calls[0]["system"][0]["text"]
        self.assertIn("ACCT:999999999999", sys_text)


if __name__ == "__main__":
    unittest.main()
