"""Tests for core_helpers_mcp — static prompt_understanding + suggest_aws_commands (NO call_aws)."""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import core_helpers_mcp as ch  # noqa: E402


class TestPromptUnderstanding(unittest.TestCase):
    def test_returns_static_guide(self):
        out = ch.lambda_handler({"tool_name": "prompt_understanding"}, None)
        self.assertEqual(out["statusCode"], 200)
        self.assertIn("AWS Solution Design Guide", out["body"])

    def test_guide_does_not_advertise_call_aws_or_steampipe(self):
        # read-only variant: must not advertise the mutating/steampipe escape hatches
        out = ch.lambda_handler({"tool_name": "prompt_understanding"}, None)
        self.assertNotIn("call_aws", out["body"])
        self.assertNotIn("run_steampipe_query", out["body"])


class TestSuggest(unittest.TestCase):
    def test_suggests_for_query(self):
        out = ch.lambda_handler({"tool_name": "suggest_aws_commands", "arguments": {"query": "list ec2 instances"}}, None)
        self.assertEqual(out["statusCode"], 200)
        body = json.loads(out["body"])
        self.assertIn("aws ec2 describe-instances", body["suggestions"])

    def test_target_account_id_popped(self):
        out = ch.lambda_handler(
            {"tool_name": "suggest_aws_commands", "arguments": {"query": "ec2", "target_account_id": "123456789012"}},
            None,
        )
        self.assertEqual(out["statusCode"], 200)

    def test_no_mutating_verbs_suggested(self):
        # read-only invariant: suggestions must never include a mutating CLI verb, for any query
        mutating = ("start-instances", "stop-instances", "terminate", "run-instances", "lambda invoke",
                    "delete", "create-", "put-", "modify-", "reboot")
        for q in ["ec2 instance", "start ec2 instance", "stop the instances", "invoke lambda", "delete s3 bucket"]:
            out = ch.lambda_handler({"tool_name": "suggest_aws_commands", "arguments": {"query": q}}, None)
            for s in json.loads(out["body"])["suggestions"]:
                for verb in mutating:
                    self.assertNotIn(verb, s, f"mutating verb '{verb}' suggested for query '{q}': {s}")

    def test_keyword_narrows_match(self):
        # "ec2 instance" returns describe-instances, not a flood of unrelated ec2 commands
        out = ch.lambda_handler({"tool_name": "suggest_aws_commands", "arguments": {"query": "ec2 instance"}}, None)
        sugg = json.loads(out["body"])["suggestions"]
        self.assertIn("aws ec2 describe-instances", sugg)
        self.assertNotIn("aws ec2 describe-route-tables", sugg)  # 'route table' kw absent → not matched


class TestNoCallAws(unittest.TestCase):
    def test_call_aws_is_not_a_tool(self):
        # the escape hatch is ABSENT — call_aws must be rejected as unknown
        out = ch.lambda_handler({"tool_name": "call_aws", "arguments": {"cli_command": "aws ec2 describe-instances"}}, None)
        self.assertEqual(out["statusCode"], 400)

    def test_no_call_aws_symbol_in_module(self):
        self.assertFalse(hasattr(ch, "call_aws"), "core-helpers must not define call_aws")

    def test_unknown_tool(self):
        out = ch.lambda_handler({"tool_name": "frobnicate"}, None)
        self.assertEqual(out["statusCode"], 400)


class TestCatalogWiring(unittest.TestCase):
    def test_core_helpers_target_registered(self):
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "v2", "agentcore"))
        import catalog
        t = catalog.TARGETS.get("core-helpers-target")
        self.assertIsNotNone(t, "core-helpers-target missing from catalog.TARGETS")
        self.assertEqual(t["gateway"], "ops")
        self.assertEqual(t["lambda_key"], "core-helpers")
        names = [tool["name"] for tool in t["tools"]]
        self.assertIn("prompt_understanding", names)
        self.assertIn("suggest_aws_commands", names)
        self.assertNotIn("call_aws", names)


if __name__ == "__main__":
    unittest.main()
