"""Unit tests for section_handoff (pure state/policy; no strands/boto)."""
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
