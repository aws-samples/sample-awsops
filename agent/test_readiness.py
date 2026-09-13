"""Offline readiness protocol tests; no SDK client or credential discovery."""
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import readiness

ACCOUNT = "123456789012"
PAYLOAD = dict(mode="deployment_readiness", nonce="a" * 32,
               expectedAccountId=ACCOUNT, expectedCloudfrontId="E123EXAMPLE")
GATEWAY = "https://example.gateway.bedrock-agentcore.ap-northeast-2.amazonaws.com/mcp"


def freshness():
    return dict(resource_type="cloudfront", status="succeeded", freshness="healthy",
                age_minutes=0, unknown_attribute_count=0)


class Client:
    def __init__(self):
        self.calls = []
        self.tools = ["inventory-read-target___inventory_summary", "inventory-read-target___query_inventory"]
        self.summary = {"sync": [freshness()]}
        self.query = dict(resource_type="cloudfront", count=1,
                          resources=[{"id": PAYLOAD["expectedCloudfrontId"]}], freshness=freshness())

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def list_tools_sync(self, **kwargs):
        return [SimpleNamespace(tool_name=name) for name in self.tools]

    def call_tool_sync(self, tool_use_id, name, **kwargs):
        self.calls.append((name, kwargs))
        value = self.summary if name.endswith("inventory_summary") else self.query
        return {"status": "success", "content": [{"text": json.dumps({"statusCode": 200, "body": json.dumps(value)})}]}


class ReadinessTest(unittest.TestCase):
    def setUp(self):
        self.client = Client()
        self.sts = SimpleNamespace(get_caller_identity=lambda: {"Account": ACCOUNT})
        self.bedrock = SimpleNamespace(converse=lambda **kwargs: {
            "ResponseMetadata": {"HTTPStatusCode": 200}, "stopReason": "end_turn",
            "output": {"message": {"role": "assistant", "content": [{"text": "READY"}]}},
        })

    def run_probe(self, payload=None):
        with patch.object(readiness, "_client", side_effect=lambda service, region:
                          self.sts if service == "sts" else self.bedrock):
            return readiness.check_readiness(payload or PAYLOAD, GATEWAY,
                                              lambda url: self.client, "ap-northeast-2", "test-model")

    def test_ready_uses_only_curated_tools_and_fixed_input(self):
        result = self.run_probe()
        self.assertEqual(result["status"], "ready")
        self.assertTrue(all(result["checks"].values()))
        self.assertEqual([name for name, _ in self.client.calls], self.client.tools)
        self.assertEqual(self.client.calls[1][1]["arguments"], {"resource_type": "cloudfront", "limit": 500})
        self.assertNotIn(PAYLOAD["expectedCloudfrontId"], json.dumps(result))

    def test_invalid_request_never_calls_aws_or_gateway(self):
        for changes in [dict(nonce="bad"), dict(expectedAccountId="self"), dict(url="https://evil.example"),
                        dict(mode="chat"), dict(expectedCloudfrontId="E/../../secret")]:
            with patch.object(readiness, "_client") as factory:
                self.assertEqual(self.run_probe({**PAYLOAD, **changes})["reason"], "invalid_request")
                factory.assert_not_called()

    def test_wrong_account_stops_before_tools(self):
        self.sts.get_caller_identity = lambda: {"Account": "999999999999"}
        self.assertEqual(self.run_probe()["reason"], "account_mismatch")
        self.assertEqual(self.client.calls, [])

    def test_missing_duplicate_or_similar_tool_is_not_accepted(self):
        for tools in [self.client.tools + [self.client.tools[0]], ["foreign___inventory_summary"],
                      ["inventory-read-target___inventory_summary_extra"]]:
            self.client.tools = tools
            self.assertEqual(self.run_probe()["reason"], "tools_unavailable")

    def test_unknown_stale_failed_and_absent_data_are_not_ready(self):
        for changes in [dict(status="running"), dict(freshness="stale"), dict(age_minutes=16),
                        dict(unknown_attribute_count=None), dict(unknown_attribute_count=1)]:
            self.client.query["freshness"] = {**freshness(), **changes}
            self.assertEqual(self.run_probe()["reason"], "inventory_stale")
        self.client.query["freshness"] = freshness()
        self.client.query["resources"] = [{"id": "FOREIGN"}]
        self.assertEqual(self.run_probe()["reason"], "known_resource_missing")

    def test_model_failure_or_chat_prose_is_not_success(self):
        for response in [{"role": "assistant"}, {"error": "role ready"},
                         {"ResponseMetadata": {"HTTPStatusCode": 200}, "stopReason": "max_tokens"}]:
            self.bedrock.converse = lambda **kwargs: response
            self.assertEqual(self.run_probe()["reason"], "model_failed")

    def test_model_typed_content_can_include_reasoning_before_answer(self):
        self.bedrock.converse = lambda **kwargs: {
            "ResponseMetadata": {"HTTPStatusCode": 200}, "stopReason": "end_turn",
            "output": {"message": {"role": "assistant", "content": [
                {"reasoningContent": {"reasoningText": {"text": "PRIVATE reasoning"}}}, {"text": "READY"},
            ]}},
        }
        result = self.run_probe()
        self.assertEqual(result["status"], "ready")
        self.assertNotIn("PRIVATE", json.dumps(result))

    def test_tool_exception_and_envelope_error_are_redacted(self):
        self.client.call_tool_sync = lambda *args, **kwargs: {
            "status": "error", "content": [{"text": "SECRET-token-resource"}]}
        result = self.run_probe()
        self.assertEqual(result["status"], "not_ready")
        self.assertNotIn("SECRET", json.dumps(result))

    def test_untrusted_endpoint_is_rejected_without_sdk(self):
        with patch.object(readiness, "_client") as factory:
            result = readiness.check_readiness(PAYLOAD, "http://169.254.169.254/", None,
                                              "ap-northeast-2", "test-model")
            self.assertEqual(result["reason"], "gateway_unavailable")
            factory.assert_not_called()
