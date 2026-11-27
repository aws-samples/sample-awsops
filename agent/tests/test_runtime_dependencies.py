"""Exercise the installed runtime SDKs in clean processes, outside helper stubs."""
import os
from pathlib import Path
import subprocess
import sys
import textwrap
import unittest


class RuntimeDependencyContracts(unittest.TestCase):
    def run_contract(self, script):
        environment = {
            **os.environ,
            "AWS_EC2_METADATA_DISABLED": "true",
            "AWS_ACCESS_KEY_ID": "synthetic-access-key",
            "AWS_SECRET_ACCESS_KEY": "synthetic-secret-key",
            "AWS_DEFAULT_REGION": "us-east-1",
            "DEPLOYMENT_READINESS_ENABLED": "false",
        }
        result = subprocess.run(
            [sys.executable, "-c", textwrap.dedent(script)],
            cwd=Path(__file__).resolve().parents[1], env=environment,
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_mcp_sdk_does_not_follow_same_origin_or_external_redirects(self):
        self.run_contract("""
            import asyncio
            import httpx
            from mcp.shared._httpx_utils import stream_within_origin
            import streamable_http_sigv4 as transport

            async def run():
                for location in ("/other", "https://external.example/mcp"):
                    requests = []
                    def respond(request):
                        requests.append(str(request.url))
                        return httpx.Response(307, headers={"location": location})
                    client = transport._no_redirect_http_client_factory()
                    client._transport = httpx.MockTransport(respond)
                    async with client:
                        async with stream_within_origin(
                            client, "POST", "https://configured.example/mcp", json={}
                        ) as response:
                            assert response.status_code == 307
                    assert requests == ["https://configured.example/mcp"], requests
            asyncio.run(run())
        """)

    def test_sigv4_transport_negotiates_and_lists_tools_with_real_mcp_session(self):
        self.run_contract("""
            import asyncio
            import json
            from unittest.mock import patch
            import httpx
            from botocore.credentials import Credentials
            from mcp import ClientSession
            import streamable_http_sigv4 as transport

            requests = []
            def respond(request):
                requests.append(request)
                assert request.headers["authorization"].startswith("AWS4-HMAC-SHA256 ")
                assert "x-amz-date" in request.headers
                if request.method != "POST":
                    return httpx.Response(405)
                payload = json.loads(request.content)
                if "id" not in payload:
                    return httpx.Response(202)
                if payload["method"] == "initialize":
                    result = {
                        "protocolVersion": "2025-03-26",
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "offline-gateway", "version": "1"},
                    }
                else:
                    assert payload["method"] == "tools/list"
                    result = {"tools": [{
                        "name": "inventory_summary", "description": "Read inventory",
                        "inputSchema": {"type": "object", "properties": {}},
                    }]}
                return httpx.Response(200, json={
                    "jsonrpc": "2.0", "id": payload["id"], "result": result
                })
            def factory(**kwargs):
                return httpx.AsyncClient(transport=httpx.MockTransport(respond), **kwargs)
            async def run():
                with patch.object(transport, "create_mcp_http_client", side_effect=factory):
                    async with transport.streamablehttp_client_with_sigv4(
                        "https://gateway.example/mcp", Credentials("key", "secret", "token"),
                        "bedrock-agentcore", "us-east-1",
                    ) as (read, write, get_session_id):
                        async with ClientSession(read, write) as session:
                            await session.initialize()
                            result = await session.list_tools()
                            assert [tool.name for tool in result.tools] == ["inventory_summary"]
                        assert get_session_id() is None
                assert len(requests) >= 3
            asyncio.run(run())
        """)

    def test_agentcore_invocation_stream_keeps_disabled_readiness_fail_closed(self):
        self.run_contract("""
            import asyncio
            import json
            from types import SimpleNamespace
            from unittest.mock import patch
            import httpx
            with patch("subprocess.run", return_value=SimpleNamespace(stdout='{"items":[]}')):
                import agent
            async def run():
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=agent.app), base_url="http://runtime"
                ) as client:
                    response = await client.post("/invocations", json={
                        "mode": "deployment_readiness", "nonce": "a" * 32,
                        "expectedAccountId": "123456789012", "expectedCloudfrontId": "KNOWN123",
                    })
                    assert response.status_code == 200, response.text
                    assert response.headers["content-type"].startswith("text/event-stream")
                    records = [json.loads(line[6:]) for line in response.text.splitlines()
                               if line.startswith("data: ")]
                    assert len(records) == 1, records
                    evidence = records[0]
                    assert evidence["status"] == "not_ready", evidence
                    assert evidence["reason"] == "disabled", evidence
                    assert evidence["nonce"] == "a" * 32, evidence
                    assert agent.CLICKHOUSE_OFFICIAL_MCP is False
            asyncio.run(run())
        """)

    def test_anthropic_bedrock_sdk_keeps_the_dark_loop_contract(self):
        # Pin the installed SDK surface anthropic_loop.py uses; building the manager sends nothing.
        self.run_contract("""
            import asyncio
            import inspect
            from anthropic import AsyncAnthropicBedrock
            import anthropic_loop

            async def run():
                client = AsyncAnthropicBedrock(aws_region="us-east-1")
                params = inspect.signature(client.messages.stream).parameters
                for name in ("model", "max_tokens", "thinking", "system", "messages", "tools"):
                    assert name in params, name
                system, tools = [{"type": "text", "text": "s"}], [
                    {"name": "t", "description": "d", "input_schema": {"type": "object"}}]
                anthropic_loop.apply_cache_control(system, tools)
                manager = client.messages.stream(
                    model="global.anthropic.claude-sonnet-5-5", max_tokens=16,
                    thinking=anthropic_loop.MODEL_THINKING, system=system,
                    messages=[{"role": "user", "content": "hi"}], tools=tools)
                assert hasattr(manager, "__aenter__") and hasattr(manager, "__aexit__")
                await client.close()
            asyncio.run(run())
        """)

    def test_strands_offers_and_runs_a_tool_registered_mid_answer(self):
        # Section handoff (agent.py _build_handoff) registers a consulted gateway's tools on the
        # running Agent from inside the consult_section tool. That only works if the event loop
        # re-reads tool specs every cycle and resolves tools at call time, so pin it against the
        # real SDK with a scripted model.
        self.run_contract("""
            import asyncio
            from strands import Agent, tool
            from strands.models.model import Model

            seen_specs, calls, holder = [], [], []

            class ScriptedModel(Model):
                def __init__(self):
                    self.turn = 0
                def update_config(self, **kw):
                    pass
                def get_config(self):
                    return {}
                async def structured_output(self, *a, **kw):
                    raise NotImplementedError
                    yield
                async def stream(self, messages, tool_specs=None, system_prompt=None, **kw):
                    seen_specs.append(sorted(s["name"] for s in (tool_specs or [])))
                    self.turn += 1
                    yield {"messageStart": {"role": "assistant"}}
                    if self.turn in (1, 2):
                        name = "consult" if self.turn == 1 else "attached_tool"
                        yield {"contentBlockStart": {"start": {"toolUse": {"toolUseId": f"t{self.turn}", "name": name}}}}
                        yield {"contentBlockDelta": {"delta": {"toolUse": {"input": "{}"}}}}
                        yield {"contentBlockStop": {}}
                        yield {"messageStop": {"stopReason": "tool_use"}}
                    else:
                        yield {"contentBlockDelta": {"delta": {"text": "done"}}}
                        yield {"contentBlockStop": {}}
                        yield {"messageStop": {"stopReason": "end_turn"}}

            @tool
            def attached_tool() -> str:
                \"\"\"Registered mid-answer.\"\"\"
                calls.append("attached_tool")
                return "ok"

            @tool
            def consult() -> str:
                \"\"\"Attach attached_tool to the running agent.\"\"\"
                holder[0].tool_registry.register_tool(attached_tool)
                return "attached"

            agent = Agent(model=ScriptedModel(), tools=[consult], callback_handler=None)
            holder.append(agent)

            async def run():
                async for _ in agent.stream_async("q"):
                    pass

            asyncio.run(run())
            assert seen_specs[0] == ["consult"], seen_specs
            assert "attached_tool" in seen_specs[1], seen_specs
            assert calls == ["attached_tool"], calls
        """)
