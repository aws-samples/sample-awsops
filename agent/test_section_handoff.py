"""Unit tests for section_handoff (pure state/policy; no strands/boto)."""
import importlib.util
from pathlib import Path
import unittest

from section_handoff import SECTION_CAPABILITIES, HandoffState, handoff_prompt


class FakeTool:
    def __init__(self, name: str) -> None:
        self.tool_name = name


def make_state(tools_by_section=None, existing=None, register_error_names=(), connect_error=None,
               primary="network", max_sections=2):
    tools_by_section = tools_by_section or {
        "security": ["iam_list_users", "iam_get_role"],
        "cost": ["ce_get_cost"],
        "data": ["rds_list"],
    }
    calls = {"connect": [], "register": []}
    existing_set = set(existing or [])

    def connect(section):
        calls["connect"].append(section)
        if connect_error is not None:
            raise connect_error
        return [FakeTool(n) for n in tools_by_section.get(section, [])]

    def register(tool):
        if tool.tool_name in register_error_names:
            raise ValueError("duplicate")
        calls["register"].append(tool.tool_name)
        existing_set.add(tool.tool_name)

    available = {k: f"https://gw/{k}" for k in ("security", "cost", "data")}
    state = HandoffState(primary, available, connect, register, lambda: set(existing_set), max_sections)
    return state, calls


_CATALOG = Path(__file__).resolve().parents[1] / "scripts" / "v2" / "agentcore" / "catalog.py"

# Word in SECTION_CAPABILITIES[gateway] that names each catalog target; a target without an entry
# fails the parity test, so a new gateway target cannot silently stay invisible to consult_section.
_TARGET_WORDS = {
    "iam-mcp-target": "IAM",
    "flow-monitor-target": "flow logs",
    "reachability-read-target": "reachability",
    "network-mcp-target": "VPC",
    "core-helpers-target": "CLI",
    "inventory-read-target": "inventory",
    "aws-knowledge-target": "AWS docs",
    "istio-read-target": "Istio",
    "eks-mcp-target": "EKS",
    "ecs-mcp-target": "ECS",
    "rds-mcp-target": "RDS",
    "dynamodb-mcp-target": "DynamoDB",
    "msk-mcp-target": "MSK",
    "valkey-mcp-target": "Valkey",
    "cost-mcp-target": "Cost Explorer",
    "finops-mcp-target": "FinOps",
    "cloudwatch-mcp-target": "CloudWatch",
    "cloudtrail-mcp-target": "CloudTrail",
    "opensearch-mcp-target": "OpenSearch",
    "loki-mcp-target": "Loki",
    "tempo-mcp-target": "Tempo",
    "mimir-mcp-target": "Mimir",
    "iac-mcp-target": "CloudFormation",
    "terraform-mcp-target": "Terraform",
    "notion-mcp-target": "Notion",
    "clickhouse-mcp-target": "ClickHouse",
    "prometheus-mcp-target": "Prometheus",
    "datadog-mcp-server-target": "Datadog",
    "dynatrace-mcp-server-target": "Dynatrace",
    "newrelic-mcp-server-target": "New Relic",
}


class CapabilityCatalogParityTests(unittest.TestCase):
    """SECTION_CAPABILITIES is the only signal the model has when choosing what to consult."""

    def test_every_catalog_target_is_named_in_its_gateway_capabilities(self):
        spec = importlib.util.spec_from_file_location("agentcore_catalog", _CATALOG)
        catalog = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(catalog)
        self.assertEqual(set(catalog.GATEWAYS), set(SECTION_CAPABILITIES))
        targets = {**catalog.TARGETS, **catalog.MCP_SERVER_TARGETS}
        for name, target in targets.items():
            with self.subTest(target=name):
                self.assertIn(name, _TARGET_WORDS, "add a capability word for this new target")
                self.assertIn(_TARGET_WORDS[name].lower(), SECTION_CAPABILITIES[target["gateway"]].lower())


class SectionHandoffTests(unittest.TestCase):
    def test_capability_keys(self):
        self.assertEqual(
            set(SECTION_CAPABILITIES),
            {"network", "container", "data", "security", "cost", "monitoring", "iac", "ops", "external-obs"},
        )

    def test_consult_registers_tools(self):
        state, calls = make_state()
        out = state.consult("security")
        self.assertEqual(calls["connect"], ["security"])
        self.assertEqual(calls["register"], ["iam_list_users", "iam_get_role"])
        self.assertIn("iam_list_users", out)
        self.assertIn("iam_get_role", out)
        self.assertEqual(state.used, ["network", "security"])

    def test_existing_name_skipped(self):
        state, calls = make_state(existing=["iam_get_role"])
        out = state.consult("security")
        self.assertEqual(calls["register"], ["iam_list_users"])
        self.assertIn("skipped", out)
        self.assertIn("iam_get_role", out)

    def test_register_valueerror_skipped(self):
        state, calls = make_state(register_error_names=("iam_get_role",))
        out = state.consult("security")
        self.assertEqual(calls["register"], ["iam_list_users"])
        self.assertIn("skipped", out)
        self.assertEqual(state.used, ["network", "security"])

    def test_all_skipped_still_counts(self):
        state, _ = make_state(existing=["iam_list_users", "iam_get_role"])
        out = state.consult("security")
        self.assertEqual(state.used, ["network", "security"])
        self.assertIn("no new tools", out)

    def test_refusals_not_consultable(self):
        for sec in ("network", "aws-data", "nope"):
            state, calls = make_state()
            out = state.consult(sec)
            self.assertIn("not consultable", out)
            self.assertEqual(calls["connect"], [])
            self.assertEqual(state.used, ["network"])

    def test_limit(self):
        state, calls = make_state()
        state.consult("security")
        state.consult("cost")
        calls["connect"].clear()
        out = state.consult("data")
        self.assertIn("limit", out)
        self.assertEqual(calls["connect"], [])
        self.assertEqual(state.used, ["network", "security", "cost"])

    def test_reconsult(self):
        state, calls = make_state()
        state.consult("security")
        calls["connect"].clear()
        out = state.consult("security")
        self.assertIn("already attached", out)
        self.assertEqual(calls["connect"], [])

    def test_connect_failure(self):
        state, _ = make_state(connect_error=RuntimeError("https://secret.example/x"))
        out = state.consult("security")
        self.assertIn("unavailable", out)
        self.assertNotIn("secret.example", out)
        self.assertIn("RuntimeError", out)
        self.assertEqual(state.used, ["network"])

    def test_failed_connect_not_retried(self):
        state, calls = make_state(connect_error=RuntimeError("boom"))
        state.consult("security")
        out = state.consult("security")
        self.assertIn("unavailable", out)
        self.assertEqual(calls["connect"], ["security"])
        self.assertEqual(state.used, ["network"])

    def test_consult_section_never_registered(self):
        state, calls = make_state(tools_by_section={"security": ["consult_section", "iam_list_users"]})
        state.consult("security")
        self.assertEqual(calls["register"], ["iam_list_users"])

    def test_alias_and_normalization(self):
        registered = []

        def connect(section):
            return [FakeTool(n) for n in {"external-obs": ["prom_query"]}.get(section, [])]

        def register(tool):
            registered.append(tool.tool_name)

        available = {k: f"https://gw/{k}" for k in ("security", "external-obs")}
        state = HandoffState("network", available, connect, register, lambda: set(registered))
        out = state.consult(" Observability ")
        self.assertEqual(registered, ["prom_query"])
        self.assertIn("prom_query", out)
        self.assertEqual(state.used[-1], "external-obs")

        out = state.consult(None)
        self.assertIn("not consultable", out)
        self.assertEqual(state.used, ["network", "external-obs"])

    def test_prompt(self):
        state, _ = make_state()
        p = handoff_prompt(state)
        for k in ("security", "cost", "data"):
            self.assertIn(k, p)
            self.assertIn(SECTION_CAPABILITIES[k], p)
        self.assertNotIn(SECTION_CAPABILITIES["network"], p)
        self.assertIn("consult_section", p)
        self.assertIn("Do not ask the user before consulting.", p)


if __name__ == "__main__":
    unittest.main()
