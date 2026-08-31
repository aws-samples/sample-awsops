"""Unit tests for agent.py pure helpers. Stdlib unittest only (no strands/bedrock).

Run from this directory:  cd agent && python3 -m unittest test_agent

agent.py loads strands / bedrock_agentcore and instantiates a BedrockModel at import
time, none of which are available locally. We stub those modules in sys.modules BEFORE
importing agent, so the pure helper `_filter_tools` can be imported and tested in
isolation. This keeps the change within Task 2's file scope (agent.py + test_agent.py).
"""
import asyncio
import sys
import types
import unittest


def _install_stubs():
    def stub(name, **attrs):
        m = types.ModuleType(name)
        for k, v in attrs.items():
            setattr(m, k, v)
        sys.modules[name] = m
        return m

    strands = stub('strands', Agent=lambda *a, **k: None)
    models = stub('strands.models', BedrockModel=lambda *a, **k: object(), CacheConfig=lambda *a, **k: object())
    strands.models = models
    stub('strands.tools')
    stub('strands.tools.mcp')
    stub('strands.tools.mcp.mcp_client', MCPClient=lambda *a, **k: None)
    hooks = stub('strands.hooks',
                 AfterToolCallEvent=type('AfterToolCallEvent', (), {}),
                 HookProvider=object,
                 HookRegistry=type('HookRegistry', (), {}))
    strands.hooks = hooks
    stub('botocore')
    stub('botocore.credentials', Credentials=object)
    stub('bedrock_agentcore')
    stub('bedrock_agentcore.runtime',
         BedrockAgentCoreApp=lambda *a, **k: types.SimpleNamespace(entrypoint=lambda f: f))
    stub('streamable_http_sigv4',
         streamablehttp_client_with_sigv4=lambda *a, **k: None,
         streamablehttp_client_with_headers=lambda *a, **k: None)
    stub('boto3', client=lambda *a, **k: None, Session=lambda *a, **k: None)


_install_stubs()
import agent  # noqa: E402  (import after stubs are installed)


class FakeTool:
    def __init__(self, name):
        self.tool_name = name


def names(tools):
    return [t.tool_name for t in tools]


class FilterToolsTest(unittest.TestCase):
    def test_none_allowlist_returns_all_unchanged(self):
        tools = [FakeTool('a'), FakeTool('b')]
        self.assertIs(agent._filter_tools(tools, None), tools)

    def test_empty_allowlist_returns_all_unchanged_not_deny_all(self):
        # [] means "no restriction" (the resolver omits the key when empty), NOT deny-all.
        tools = [FakeTool('a'), FakeTool('b')]
        self.assertIs(agent._filter_tools(tools, []), tools)

    def test_filters_to_allowlist_preserving_tool_order(self):
        tools = [FakeTool('a'), FakeTool('b'), FakeTool('c')]
        # allowlist order must NOT change output order — original tool order is preserved.
        self.assertEqual(names(agent._filter_tools(tools, ['c', 'a'])), ['a', 'c'])

    def test_unknown_names_in_allowlist_are_ignored(self):
        tools = [FakeTool('a')]
        self.assertEqual(names(agent._filter_tools(tools, ['a', 'does-not-exist'])), ['a'])

    def test_duplicate_allowlist_entries_are_safe(self):
        tools = [FakeTool('a'), FakeTool('b')]
        self.assertEqual(names(agent._filter_tools(tools, ['a', 'a'])), ['a'])

    def test_no_match_yields_empty_tool_set(self):
        # A non-empty allowlist matching nothing → tool-less (safe), not "all tools".
        tools = [FakeTool('a'), FakeTool('b')]
        self.assertEqual(agent._filter_tools(tools, ['zzz']), [])


class SsrfGuardTest(unittest.TestCase):
    def test_ip_always_blocked(self):
        # Loopback
        self.assertTrue(agent._ip_always_blocked('127.0.0.1'))
        self.assertTrue(agent._ip_always_blocked('::1'))
        # Link-local (Metadata)
        self.assertTrue(agent._ip_always_blocked('169.254.169.254'))
        self.assertTrue(agent._ip_always_blocked('fe80::1'))
        # Multicast
        self.assertTrue(agent._ip_always_blocked('224.0.0.1'))
        self.assertTrue(agent._ip_always_blocked('ff02::1'))
        # Unspecified / Reserved
        self.assertTrue(agent._ip_always_blocked('0.0.0.0'))
        self.assertTrue(agent._ip_always_blocked('240.0.0.1'))
        # Cloud metadata — ALWAYS blocked even though IPv6 IMDS is ULA (P4 gate fix)
        self.assertTrue(agent._ip_always_blocked('fd00:ec2::254'))      # AWS IPv6 IMDS (fc00::/7 ULA)
        self.assertTrue(agent._ip_always_blocked('fd00:ec2:0:0:0:0:0:254'))  # same, expanded form
        # Public / Private (not always blocked)
        self.assertFalse(agent._ip_always_blocked('8.8.8.8'))
        self.assertFalse(agent._ip_always_blocked('10.0.0.1'))
        self.assertFalse(agent._ip_always_blocked('192.168.1.1'))

    def test_ip_is_private(self):
        # RFC1918
        self.assertTrue(agent._ip_is_private('10.0.0.1'))
        self.assertTrue(agent._ip_is_private('172.16.0.1'))
        self.assertTrue(agent._ip_is_private('192.168.1.1'))
        # ULA
        self.assertTrue(agent._ip_is_private('fc00::1'))
        # Public
        self.assertFalse(agent._ip_is_private('8.8.8.8'))
        # Metadata / Loopback (always blocked, NOT in the _ip_is_private "opt-in" set)
        self.assertFalse(agent._ip_is_private('169.254.169.254'))
        self.assertFalse(agent._ip_is_private('127.0.0.1'))
        self.assertFalse(agent._ip_is_private('fd00:ec2::254'))  # IPv6 IMDS — metadata, not opt-in-able

    def test_assert_host_allowed_basics(self):
        def resolver(host, port, *a, **k):
            # map hosts to IPs for testing
            mapping = {
                'public.com': ['8.8.8.8'],
                'private.local': ['10.0.0.1'],
                'metadata.internal': ['169.254.169.254'],
                'loopback.local': ['127.0.0.1'],
                'mixed.com': ['8.8.8.8', '10.0.0.1'],
                'nxdomain.local': [],
            }
            res = mapping.get(host, [])
            if not res: return []
            # return format: (family, type, proto, canonname, sockaddr)
            return [(2, 1, 6, '', (ip, port)) for ip in res]

        # HTTPS required
        with self.assertRaisesRegex(agent.SsrfBlocked, "HTTPS required"):
            agent._assert_host_allowed("http://public.com", False, resolver=resolver)

        # Public HTTPS allowed
        agent._assert_host_allowed("https://public.com", False, resolver=resolver)

        # Private HTTPS blocked by default
        with self.assertRaisesRegex(agent.SsrfBlocked, "private access disabled"):
            agent._assert_host_allowed("https://private.local", False, resolver=resolver)

        # Private HTTPS allowed with opt-in
        agent._assert_host_allowed("https://private.local", True, resolver=resolver)

        # Metadata ALWAYS blocked
        with self.assertRaisesRegex(agent.SsrfBlocked, "always-blocked"):
            agent._assert_host_allowed("https://metadata.internal", False, resolver=resolver)
        with self.assertRaisesRegex(agent.SsrfBlocked, "always-blocked"):
            agent._assert_host_allowed("https://metadata.internal", True, resolver=resolver)

        # Loopback ALWAYS blocked
        with self.assertRaisesRegex(agent.SsrfBlocked, "always-blocked"):
            agent._assert_host_allowed("https://loopback.local", True, resolver=resolver)

        # Mixed resolution (ANY blocked IP = fail)
        with self.assertRaisesRegex(agent.SsrfBlocked, "private access disabled"):
            agent._assert_host_allowed("https://mixed.com", False, resolver=resolver)
        
        # NXDOMAIN
        with self.assertRaisesRegex(agent.SsrfBlocked, "could not resolve"):
            agent._assert_host_allowed("https://nxdomain.local", True, resolver=resolver)


class IntegrationHelpersTest(unittest.TestCase):
    def test_parse_secret(self):
        self.assertEqual(agent.parse_secret('{"token":"t"}'), {"token": "t"})
        self.assertEqual(agent.parse_secret('raw-val'), {"_raw": "raw-val"})
        self.assertEqual(agent.parse_secret(''), {})
        self.assertEqual(agent.parse_secret(None), {})

    def test_auth_headers(self):
        # api_key
        self.assertEqual(agent.auth_headers('api_key', {"header": "X-API", "value": "k"}), {"X-API": "k"})
        self.assertEqual(agent.auth_headers('api_key', {"api_key": "k"}), {"Authorization": "k"})
        self.assertEqual(agent.auth_headers('api_key', {"_raw": "k"}), {"Authorization": "k"})
        with self.assertRaises(ValueError):
            agent.auth_headers('api_key', {})

        # oauth_client_credentials
        self.assertEqual(agent.auth_headers('oauth_client_credentials', {"token": "t"}), {"Authorization": "Bearer t"})
        self.assertEqual(agent.auth_headers('oauth_client_credentials', {"_raw": "t"}), {"Authorization": "Bearer t"})
        with self.assertRaises(ValueError):
            agent.auth_headers('oauth_client_credentials', {})

        # sigv4
        self.assertEqual(agent.auth_headers('sigv4', {}), {})

        # Unknown
        with self.assertRaises(ValueError):
            agent.auth_headers('unknown', {})

    def test_sigv4_params(self):
        # Explicit service required
        with self.assertRaisesRegex(ValueError, "requires an explicit 'sigv4Service'"):
            agent.sigv4_params('https://abc.com')

        # Derived region (execute-api)
        self.assertEqual(
            agent.sigv4_params('https://abc.execute-api.ap-northeast-2.amazonaws.com/mcp', service='execute-api'),
            ('execute-api', 'ap-northeast-2')
        )

        # Derived region (lambda-url)
        self.assertEqual(
            agent.sigv4_params('https://abc.lambda-url.us-east-1.on.aws/mcp', service='lambda'),
            ('lambda', 'us-east-1')
        )

        # Explicit region override
        self.assertEqual(
            agent.sigv4_params('https://abc.execute-api.us-east-1.amazonaws.com/mcp', service='execute-api', region='ap-northeast-2'),
            ('execute-api', 'ap-northeast-2')
        )

        # Fallback to GATEWAY_REGION
        self.assertEqual(
            agent.sigv4_params('https://abc.com', service='custom'),
            ('custom', agent.GATEWAY_REGION)
        )


class IntegrationToolMergeTest(unittest.TestCase):
    """Task 3 — tool ∩ exposed_tools (admin ceiling) + per-integration failure isolation."""

    def test_select_keeps_only_exposed_preserving_order(self):
        live = [FakeTool('a'), FakeTool('b'), FakeTool('c')]
        # exposed order must not reorder output — live order is preserved.
        self.assertEqual(names(agent.select_integration_tools(live, ['c', 'a'])), ['a', 'c'])

    def test_select_empty_exposed_contributes_nothing(self):
        # Admin ceiling: a READ integration with no exposed_tools contributes NOTHING (not "all").
        live = [FakeTool('a'), FakeTool('b')]
        self.assertEqual(agent.select_integration_tools(live, []), [])

    def test_select_tools_not_in_exposed_are_dropped(self):
        live = [FakeTool('a'), FakeTool('b')]
        self.assertEqual(names(agent.select_integration_tools(live, ['a', 'nope'])), ['a'])

    def test_select_empty_live_yields_empty(self):
        self.assertEqual(agent.select_integration_tools([], ['a']), [])

    def test_gather_unions_healthy_integrations(self):
        specs = [{'name': 'x'}, {'name': 'y'}]
        def connect(spec):
            return [FakeTool(spec['name'] + '_t')]
        self.assertEqual(names(agent.gather_integration_tools(specs, connect)), ['x_t', 'y_t'])

    def test_gather_drops_failed_keeps_others_mixed_result(self):
        # R2 gate: integration A RAISES, B SUCCEEDS → only B's tools appear, gather NEVER raises.
        specs = [{'name': 'A', 'endpoint': 'https://a'}, {'name': 'B', 'endpoint': 'https://b'}]
        def connect(spec):
            if spec['name'] == 'A':
                raise agent.SsrfBlocked('A is blocked')
            return [FakeTool('b_tool')]
        out = agent.gather_integration_tools(specs, connect)
        self.assertEqual(names(out), ['b_tool'])

    def test_gather_never_raises_when_all_fail(self):
        specs = [{'name': 'A'}, {'name': 'B'}]
        def connect(spec):
            raise ValueError('boom')
        self.assertEqual(agent.gather_integration_tools(specs, connect), [])

    def test_gather_empty_and_none_specs(self):
        self.assertEqual(agent.gather_integration_tools([], lambda s: [FakeTool('x')]), [])
        self.assertEqual(agent.gather_integration_tools(None, lambda s: [FakeTool('x')]), [])

    def test_gather_integration_whose_exposed_filters_everything(self):
        # connect returns [] (exposed filtered all out) → that integration contributes [] but others survive.
        specs = [{'name': 'empty'}, {'name': 'full'}]
        def connect(spec):
            return [] if spec['name'] == 'empty' else [FakeTool('f')]
        self.assertEqual(names(agent.gather_integration_tools(specs, connect)), ['f'])

    def test_dedup_keeps_first_on_collision_gateway_precedence(self):
        # P4 gate fix: gateway tools precede integration tools → gateway wins a name collision; order kept.
        gateway = [FakeTool('shared'), FakeTool('gw_only')]
        integ = [FakeTool('shared'), FakeTool('int_only')]
        deduped = agent._dedup_by_tool_name(gateway + integ)
        self.assertEqual(names(deduped), ['shared', 'gw_only', 'int_only'])



class TestDatasourceGuidance(unittest.TestCase):
    def test_monitoring_prompt_names_query_languages(self):
        # Prometheus & ClickHouse moved to the Observability section; monitoring keeps the
        # still-here datasources (Mimir→PromQL, Loki→LogQL, Tempo→TraceQL).
        mon = agent.SKILL_BASE["monitoring"]
        for lang in ("PromQL", "LogQL", "TraceQL"):
            self.assertIn(lang, mon)
        self.assertIn("Datasource schemas", mon)  # tells the agent to use the injected cache

    def test_observability_prompt_covers_prometheus_and_clickhouse(self):
        obs = agent.SKILL_BASE["observability"]
        for token in ("Prometheus", "PromQL", "ClickHouse", "SQL"):
            self.assertIn(token, obs)
        self.assertIn("Datasource schemas", obs)  # uses the injected schema cache

    def test_observability_aliases_to_external_obs_gateway(self):
        self.assertEqual(agent._GATEWAY_ALIAS.get("observability"), "external-obs")

    def test_resolve_gateway_key_handles_discovery_and_env_spellings(self):
        # Discovery path: v2 gateway `awsops-v2-external-obs-gateway` → key `v2-external-obs`.
        disc = {"network": "u", "ops": "u", "v2-external-obs": "u"}
        self.assertEqual(agent._resolve_gateway_key("observability", disc), "v2-external-obs")
        # Env fallback path: GATEWAYS_JSON uses the canonical `external-obs`.
        env = {"network": "u", "ops": "u", "external-obs": "u"}
        self.assertEqual(agent._resolve_gateway_key("observability", env), "external-obs")
        # The 8 sections pass through unchanged (no alias, key present).
        self.assertEqual(agent._resolve_gateway_key("network", disc), "network")
        # Unknown / unprovisioned → DEFAULT_GATEWAY (never a hard crash).
        self.assertEqual(agent._resolve_gateway_key("observability", {"ops": "u"}), agent.DEFAULT_GATEWAY)

    def test_resolve_gateway_key_v2_only_discovery_no_keyerror(self):
        # v2-ONLY discovery (v1 retired, not yet renamed): DEFAULT_GATEWAY 'ops' is absent,
        # the key is 'v2-ops'. The resolver must return a PRESENT key (v2-external-obs / v2-ops),
        # not a bare 'ops' that the call site would KeyError on.
        v2only = {"v2-network": "u", "v2-ops": "u", "v2-external-obs": "u"}
        self.assertEqual(agent._resolve_gateway_key("observability", v2only), "v2-external-obs")
        self.assertEqual(agent._resolve_gateway_key("network", v2only), "v2-network")
        # an unmatched role falls back to the v2-spelled default (never raises, never returns absent 'ops')
        self.assertEqual(agent._resolve_gateway_key("nope", v2only), "v2-ops")

    def test_resolve_gateway_key_empty_map_returns_default_not_crash(self):
        # Degenerate (no gateways discovered): returns DEFAULT_GATEWAY; call site GATEWAYS.get → None
        # → MCP try-block degrades to a tool-less answer (no crash outside the try).
        self.assertEqual(agent._resolve_gateway_key("observability", {}), agent.DEFAULT_GATEWAY)


class TestAntiHallucinationFooter(unittest.TestCase):
    """The data agent once fabricated a non-existent 'Infra 에이전트'. The footer must give the real
    roster + forbid inventing agents, and tell the agent to be honest when it lacks a tool."""

    def test_footer_forbids_inventing_agents(self):
        f = agent.COMMON_FOOTER.lower()
        self.assertTrue("invent" in f or "make up" in f or "지어내" in agent.COMMON_FOOTER,
                        "footer must forbid inventing agent names")

    def test_footer_lists_real_section_roster(self):
        f = agent.COMMON_FOOTER.lower()
        for section in ("network", "data", "security", "cost", "monitoring", "ops"):
            self.assertIn(section, f)
        # the fabricated name must NOT be presented as a real agent
        self.assertNotIn("infra agent", f)

    def test_footer_tells_agent_to_be_honest_when_lacking_a_tool(self):
        f = agent.COMMON_FOOTER.lower()
        self.assertIn("tool", f)


class TestOpsTopologyPrompt(unittest.TestCase):
    """Ops gateway is the inventory_read MCP home — its prompt must route topology/unused asks
    to the new tools instead of refusing or punting."""

    def test_ops_prompt_mentions_inventory_tools(self):
        ops = agent.SKILL_BASE["ops"]
        for tool in ("find_unused_resources", "get_topology", "query_inventory"):
            self.assertIn(tool, ops)


class HandlerRoutingTest(unittest.TestCase):
    """Task 4: handler routes to the flag-gated Anthropic dark path only when enabled AND no
    integrations; rca mode wins; otherwise the Strands path. Stubs anthropic_loop + rca_orchestrator
    in sys.modules (handler imports them lazily at call time)."""

    def setUp(self):
        self._saved = {k: sys.modules.get(k) for k in ("anthropic_loop", "rca_orchestrator")}
        self.calls = {"run": 0, "rca": 0}

        al = types.ModuleType("anthropic_loop")
        al._use = True

        def _should(payload):
            return al._use

        async def _run(payload):
            self.calls["run"] += 1
            yield {"delta": "ANTHROPIC_PATH"}

        al.should_use_anthropic_loop = _should
        al.run_anthropic_loop = _run
        sys.modules["anthropic_loop"] = al
        self._al = al

        rca = types.ModuleType("rca_orchestrator")

        def _handle(payload):
            self.calls["rca"] += 1
            return {"rca": "RESULT"}

        rca.handle_rca = _handle
        sys.modules["rca_orchestrator"] = rca

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v

    def _drain(self, payload):
        async def _c():
            return [x async for x in agent.handler(payload)]
        return asyncio.run(_c())

    def test_delegates_to_anthropic_when_enabled_and_no_integrations(self):
        self._al._use = True
        out = self._drain({"messages": [{"role": "user", "content": "hi"}]})
        self.assertEqual(out, [{"delta": "ANTHROPIC_PATH"}])
        self.assertEqual(self.calls["run"], 1)

    def test_skips_anthropic_when_integrations_present(self):
        self._al._use = True  # enabled, but integrations present ⇒ Strands path (minimal slice)
        out = self._drain({"integrations": [{"name": "x"}]})  # no input ⇒ clean "No input provided."
        self.assertEqual(self.calls["run"], 0)
        self.assertEqual(out, [{"delta": "No input provided."}])

    def test_skips_anthropic_when_disabled(self):
        self._al._use = False
        out = self._drain({})
        self.assertEqual(self.calls["run"], 0)
        self.assertEqual(out, [{"delta": "No input provided."}])

    def test_rca_mode_wins_over_anthropic(self):
        self._al._use = True
        out = self._drain({"mode": "rca", "messages": [{"role": "user", "content": "hi"}]})
        self.assertEqual(self.calls["rca"], 1)
        self.assertEqual(self.calls["run"], 0)
        self.assertEqual(out, [{"rca": "RESULT"}])


class FakeStreamingAgent:
    """Stands in for a Strands Agent: stream_async replays canned event dicts."""
    def __init__(self, events):
        self._events = events

    async def stream_async(self, _user_input):
        for e in self._events:
            yield e


class StreamTextTest(unittest.TestCase):
    """_stream_text: provenance frames (model/tool) interleaved with text deltas."""

    def _collect(self, events):
        async def run():
            return [c async for c in agent._stream_text(FakeStreamingAgent(events), 'q')]
        return asyncio.run(run())

    def test_model_frame_first_then_deltas(self):
        out = self._collect([{"data": "hel"}, {"data": "lo"}])
        self.assertEqual(out, [{"model": agent.MODEL_ID}, {"delta": "hel"}, {"delta": "lo"}])

    def test_tool_use_emitted_once_per_tool_use_id(self):
        # current_tool_use fires repeatedly while the tool input streams in — one {"tool"} per id.
        out = self._collect([
            {"current_tool_use": {"toolUseId": "t1", "name": "list_eks_clusters"}},
            {"current_tool_use": {"toolUseId": "t1", "name": "list_eks_clusters"}},
            {"data": "answer"},
            {"current_tool_use": {"toolUseId": "t2", "name": "describe_cluster"}},
        ])
        self.assertEqual(out[1:], [
            {"tool": "list_eks_clusters"},
            {"delta": "answer"},
            {"tool": "describe_cluster"},
        ])

    def test_tool_input_query_flushed_on_next_delta(self):
        # v1-parity: the completed tool input's query surfaces as a {"toolInput"} frame
        # once text resumes (input is only final at that point).
        out = self._collect([
            {"current_tool_use": {"toolUseId": "t1", "name": "query_inventory", "input": '{"sql": "SELECT'}},
            {"current_tool_use": {"toolUseId": "t1", "name": "query_inventory", "input": '{"sql": "SELECT * FROM ec2"}'}},
            {"data": "결과는"},
        ])
        self.assertEqual(out[1:], [
            {"tool": "query_inventory"},
            {"toolInput": {"tool": "query_inventory", "query": "SELECT * FROM ec2"}},
            {"delta": "결과는"},
        ])

    def test_tool_input_flushed_at_end_of_stream_and_partial_json_suppressed(self):
        out = self._collect([
            {"current_tool_use": {"toolUseId": "t1", "name": "prom", "input": {"query": "up == 0"}}},
        ])
        self.assertEqual(out[1:], [{"tool": "prom"}, {"toolInput": {"tool": "prom", "query": "up == 0"}}])
        # partial JSON fragment never surfaces half a query
        out2 = self._collect([
            {"current_tool_use": {"toolUseId": "t1", "name": "prom", "input": '{"query": "u'}},
        ])
        self.assertEqual(out2[1:], [{"tool": "prom"}])

    def test_usage_frame_from_result_metrics(self):
        class M:  # Strands AgentResult shim
            class metrics:
                accumulated_usage = {"inputTokens": 1200, "outputTokens": 340}
        out = self._collect([{"data": "hi"}, {"result": M()}])
        self.assertEqual(out[-1], {"usage": {"inputTokens": 1200, "outputTokens": 340}})

    def test_nameless_or_idless_tool_events_skipped(self):
        # The first partial event can arrive before the name; lifecycle events carry neither.
        out = self._collect([
            {"current_tool_use": {"toolUseId": "t1"}},
            {"current_tool_use": {"name": "orphan"}},
            {"event": "lifecycle"},
        ])
        self.assertEqual(out, [{"model": agent.MODEL_ID}])


class TestFilterOfficialMcpTools(unittest.TestCase):
    """ADR-017 (amended 2026-08-05): fail-closed allowlist over `*-mcp-server-target___*` tools."""

    TOOLS = [
        FakeTool('datadog-mcp-server-target___search_datadog_logs'),
        FakeTool('datadog-mcp-server-target___create_datadog_monitor'),   # vendor write tool
        FakeTool('dynatrace-mcp-server-target___execute_dql'),            # target with empty allowlist
        FakeTool('clickhouse-mcp-target___clickhouse_query'),             # lambda target — not a preset
        FakeTool('plain_tool'),
    ]

    def test_allowlisted_tool_survives_and_rest_of_preset_tools_drop(self):
        allow = {'datadog-mcp-server-target': {'search_datadog_logs'}, 'dynatrace-mcp-server-target': set()}
        self.assertEqual(
            names(agent.filter_official_mcp_tools(self.TOOLS, allow)),
            ['datadog-mcp-server-target___search_datadog_logs',
             'clickhouse-mcp-target___clickhouse_query', 'plain_tool'])

    def test_missing_map_is_deny_all_for_preset_tools_only(self):
        self.assertEqual(
            names(agent.filter_official_mcp_tools(self.TOOLS, {})),
            ['clickhouse-mcp-target___clickhouse_query', 'plain_tool'])

    def test_env_parse_failure_fails_closed(self):
        import os
        os.environ['OFFICIAL_MCP_TOOL_ALLOWLIST_JSON'] = 'not-json'
        try:
            self.assertEqual(agent._official_mcp_allowlist(), {})
        finally:
            del os.environ['OFFICIAL_MCP_TOOL_ALLOWLIST_JSON']


class TestClickhouseStdioEnv(unittest.TestCase):
    """ADR-017 (amended): datasource kind-mirror blob → mcp-clickhouse env, read-only pinned."""

    def test_https_endpoint_maps_with_url_standard_port_and_readonly_pins(self):
        env = agent._clickhouse_stdio_env({'endpoint': 'https://ch.internal', 'username': 'ro', 'password': 'pw'})
        self.assertEqual(env['CLICKHOUSE_HOST'], 'ch.internal')
        self.assertEqual(env['CLICKHOUSE_PORT'], '443')
        self.assertEqual(env['CLICKHOUSE_SECURE'], 'true')
        self.assertEqual(env['CLICKHOUSE_USER'], 'ro')
        self.assertEqual(env['CLICKHOUSE_ALLOW_WRITE_ACCESS'], 'false')
        self.assertEqual(env['CLICKHOUSE_ALLOW_DROP'], 'false')

    def test_http_endpoint_with_port(self):
        env = agent._clickhouse_stdio_env({'endpoint': 'http://10.0.3.7:8123'})
        self.assertEqual((env['CLICKHOUSE_HOST'], env['CLICKHOUSE_PORT'], env['CLICKHOUSE_SECURE']),
                         ('10.0.3.7', '8123', 'false'))
        self.assertEqual(env['CLICKHOUSE_USER'], 'default')

    def test_non_http_endpoint_rejected(self):
        for ep in ('clickhouse://x', '', 'https://'):
            with self.assertRaises(ValueError):
                agent._clickhouse_stdio_env({'endpoint': ep})

    def test_http_endpoint_without_port_defaults_to_80(self):
        self.assertEqual(agent._clickhouse_stdio_env({'endpoint': 'http://ch.internal'})['CLICKHOUSE_PORT'], '80')

    def test_unmappable_auth_types_fail_closed(self):
        for creds in ({'endpoint': 'https://ch', 'authType': 'bearer', 'token': 't'},
                      {'endpoint': 'https://ch', 'authType': 'custom_header', 'headerName': 'X-K', 'headerValue': 'v'},
                      {'endpoint': 'https://ch', 'token': 't'}):  # legacy inferred-bearer shape
            with self.assertRaises(ValueError):
                agent._clickhouse_stdio_env(creds)

    def test_basic_and_none_auth_types_are_mappable(self):
        for creds in ({'endpoint': 'https://ch', 'authType': 'basic', 'username': 'u', 'password': 'p'},
                      {'endpoint': 'https://ch', 'authType': 'none'},
                      {'endpoint': 'https://ch', 'username': 'u'}):  # absent authType with a username
            env = agent._clickhouse_stdio_env(creds)
            self.assertEqual(env['CLICKHOUSE_HOST'], 'ch')


class TestApplyOfficialMcpGates(unittest.TestCase):
    """ADR-017 gates shared by BOTH chat paths (Strands handler + anthropic_loop dark path)."""

    def setUp(self):
        self._saved_flag = agent.CLICKHOUSE_OFFICIAL_MCP
        self._saved_connect = agent._connect_clickhouse_stdio

    def tearDown(self):
        agent.CLICKHOUSE_OFFICIAL_MCP = self._saved_flag
        agent._connect_clickhouse_stdio = self._saved_connect

    def test_vendor_allowlist_applied_on_raw_gateway_list(self):
        # flag off + OFFICIAL_MCP_TOOL_ALLOWLIST_JSON unset (deny-all): preset tools drop.
        agent.CLICKHOUSE_OFFICIAL_MCP = False
        raw = [FakeTool('datadog-mcp-server-target___create_datadog_monitor'), FakeTool('plain_tool')]
        gw, stdio, client = agent.apply_official_mcp_gates(raw, 'v2-external-obs', None)
        self.assertEqual(names(gw), ['plain_tool'])
        self.assertEqual(stdio, [])
        self.assertIsNone(client)

    def test_non_external_obs_gateway_never_connects_stdio(self):
        agent.CLICKHOUSE_OFFICIAL_MCP = True
        connected = []

        def fake_connect(stack):
            connected.append(stack)
            return object(), [FakeTool('ch')]
        agent._connect_clickhouse_stdio = fake_connect
        raw = [FakeTool('clickhouse-mcp-target___clickhouse_query'), FakeTool('plain_tool')]
        gw, stdio, client = agent.apply_official_mcp_gates(raw, 'v2-data', None)
        self.assertEqual(connected, [])
        self.assertEqual(stdio, [])
        self.assertIsNone(client)
        self.assertEqual(names(gw), ['clickhouse-mcp-target___clickhouse_query', 'plain_tool'])

    def test_external_obs_stdio_replaces_lambda_clickhouse_tools(self):
        agent.CLICKHOUSE_OFFICIAL_MCP = True
        sentinel = object()  # stands in for the MCPClient that OWNS the stdio tools
        agent._connect_clickhouse_stdio = lambda stack: (sentinel, [FakeTool('run_select_query')])
        raw = [FakeTool('clickhouse-mcp-target___clickhouse_query'), FakeTool('plain_tool')]
        gw, stdio, client = agent.apply_official_mcp_gates(raw, 'v2-external-obs', None)
        self.assertNotIn('clickhouse-mcp-target___clickhouse_query', names(gw))
        self.assertIn('plain_tool', names(gw))
        self.assertEqual(names(stdio), ['run_select_query'])
        # the dark path dispatches stdio tools by name, so it MUST get the owning client back
        self.assertIs(client, sentinel)

    def test_stdio_connect_failure_is_isolated(self):
        agent.CLICKHOUSE_OFFICIAL_MCP = True

        def boom(stack):
            raise RuntimeError('boom')
        agent._connect_clickhouse_stdio = boom
        raw = [FakeTool('clickhouse-mcp-target___clickhouse_query'), FakeTool('plain_tool')]
        gw, stdio, client = agent.apply_official_mcp_gates(raw, 'v2-external-obs', None)  # must NOT raise
        self.assertEqual(stdio, [])
        # no stdio tools => no client to route to; a stale client here would make the dark path
        # send gateway tool calls into a dead subprocess.
        self.assertIsNone(client)
        # mutual exclusion must NOT fire when the stdio connect failed — both survive.
        self.assertEqual(names(gw), ['clickhouse-mcp-target___clickhouse_query', 'plain_tool'])


if __name__ == '__main__':
    unittest.main()
