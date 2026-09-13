"""Offline readiness protocol tests; no SDK client or credential discovery."""
import json
import os
import asyncio
import copy
import threading
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
                age_minutes=0, stale_after_minutes=30, unknown_attribute_count=0)


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
        enabled = patch.dict(os.environ, {"DEPLOYMENT_READINESS_ENABLED": "true"})
        enabled.start()
        self.addCleanup(enabled.stop)
        self.client = Client()
        self.sts = SimpleNamespace(get_caller_identity=lambda: {"Account": ACCOUNT})
        self.bedrock = SimpleNamespace(converse=lambda **kwargs: {
            "ResponseMetadata": {"HTTPStatusCode": 200}, "stopReason": "end_turn",
            "output": {"message": {"role": "assistant", "content": [{"text": "READY"}]}},
        })

    def run_probe(self, payload=None):
        with patch.object(readiness, "_client", side_effect=lambda service, region, *budget:
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
        for changes in [dict(status="running"), dict(freshness="stale"), dict(age_minutes=31)]:
            self.client.query["freshness"] = {**freshness(), **changes}
            self.assertEqual(self.run_probe()["reason"], "inventory_stale")
        self.client.query["freshness"] = freshness()
        self.client.query["resources"] = [{"id": "FOREIGN"}]
        self.assertEqual(self.run_probe()["reason"], "known_resource_missing")

    def test_unknown_or_nonzero_attribute_coverage_is_incomplete_not_stale(self):
        for source in ("summary", "query"):
            for value in (None, 1):
                self.client = Client()
                row = self.client.summary["sync"][0] if source == "summary" else self.client.query["freshness"]
                row["unknown_attribute_count"] = value
                result = self.run_probe()
                self.assertEqual(result["reason"], "inventory_incomplete")
                self.assertFalse(result["checks"]["freshInventory"])
                self.assertFalse(result["checks"]["model"])

    def test_default_off_valid_requests_return_disabled_without_sdk_or_gateway(self):
        for value in (None, "false", "TRUE"):
            with patch.dict(os.environ, {}, clear=True), patch.object(readiness, "_client") as sdk:
                if value is not None:
                    os.environ["DEPLOYMENT_READINESS_ENABLED"] = value
                factory = unittest.mock.Mock()
                result = readiness.check_readiness(PAYLOAD, GATEWAY, factory, "ap-northeast-2", "model")
                self.assertEqual(result["reason"], "disabled")
                self.assertEqual(result["nonce"], PAYLOAD["nonce"])
                self.assertFalse(any(result["checks"].values()))
                self.assertIsNone(result["inventory"]["count"])
                result = asyncio.run(readiness.handle_readiness(PAYLOAD, GATEWAY, factory, "ap-northeast-2", "model"))
                self.assertEqual(result["reason"], "disabled")
                sdk.assert_not_called()
                factory.assert_not_called()

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

    def test_freshness_uses_each_producers_threshold_instead_of_a_15_minute_window(self):
        for age, threshold, expected in [(16, 30, "ready"), (90, 120, "ready"), (1440, 1440, "ready"),
                                         (31, 30, "not_ready"), (1, 0, "not_ready"),
                                         (1, 1441, "not_ready"), (1, None, "not_ready")]:
            self.client.summary["sync"] = [{**freshness(), "age_minutes": age, "stale_after_minutes": threshold}]
            self.client.query["freshness"] = {**freshness(), "age_minutes": age, "stale_after_minutes": threshold}
            self.assertEqual(self.run_probe()["status"], expected, (age, threshold))

    def test_successful_converse_does_not_depend_on_exact_model_wording(self):
        for text in ["READY.", "Ready", "The service responded."]:
            self.bedrock.converse = lambda **kwargs: {
                "ResponseMetadata": {"HTTPStatusCode": 200}, "stopReason": "end_turn",
                "output": {"message": {"role": "assistant", "content": [{"text": text}]}},
            }
            self.assertEqual(self.run_probe()["status"], "ready")
        for text in ["", "   ", "x" * 4097]:
            self.bedrock.converse = lambda **kwargs: {
                "ResponseMetadata": {"HTTPStatusCode": 200}, "stopReason": "end_turn",
                "output": {"message": {"role": "assistant", "content": [{"text": text}]}},
            }
            self.assertEqual(self.run_probe()["reason"], "model_failed")

    def test_late_model_call_receives_only_the_remaining_sdk_budget(self):
        now = [0.0]
        original_call = self.client.call_tool_sync
        def call(*args, **kwargs):
            result = original_call(*args, **kwargs)
            if args[1].endswith("query_inventory"):
                now[0] = 38.0
            return result
        self.client.call_tool_sync = call
        budgets = []
        def client(service, region, *budget):
            if service == "bedrock-runtime":
                budgets.extend(budget)
            return self.sts if service == "sts" else self.bedrock
        with patch.object(readiness.time, "monotonic", side_effect=lambda: now[0]), \
                patch.object(readiness, "_client", side_effect=client):
            result = readiness.check_readiness(PAYLOAD, GATEWAY, lambda url: self.client, "ap-northeast-2", "model")
        self.assertEqual(result["status"], "ready")
        self.assertEqual(len(budgets), 1)
        self.assertGreater(budgets[0], 0)
        self.assertLessEqual(budgets[0], 2)

    def test_outer_timeout_preserves_progress_and_stops_later_calls(self):
        self._timeout_case("query")

    def test_outer_model_timeout_retains_inventory_and_does_not_mutate_returned_evidence(self):
        self._timeout_case("model")

    def test_cancelled_request_cannot_start_the_model_after_mcp_returns(self):
        self._timeout_case("query", cancelled=True)

    def test_timed_out_queued_worker_never_starts_sdk_calls(self):
        self._timeout_case("queued")

    def test_timeout_during_model_client_initialization_prevents_converse(self):
        self._timeout_case("model_client")

    def _timeout_case(self, stage, cancelled=False):
        release, finished, entered = threading.Event(), threading.Event(), threading.Event()
        model_calls = []
        original_call, original_model = self.client.call_tool_sync, self.bedrock.converse
        def call(*args, **kwargs):
            if stage == "query" and args[1].endswith("query_inventory"):
                entered.set()
                release.wait(2)
            return original_call(*args, **kwargs)
        def model(**kwargs):
            model_calls.append(kwargs)
            if stage == "model":
                entered.set()
                release.wait(2)
            return original_model(**kwargs)
        self.client.call_tool_sync, self.bedrock.converse = call, model
        original_check, original_wait = readiness.check_readiness, asyncio.wait_for
        def check(*args, **kwargs):
            try:
                if stage == "queued":
                    entered.set()
                    release.wait(2)
                return original_check(*args, **kwargs)
            finally:
                finished.set()
        async def bounded_wait(future, timeout):
            task = asyncio.ensure_future(future)
            self.assertTrue(await asyncio.to_thread(entered.wait, 1))
            if cancelled:
                task.cancel()
                return await task
            return await original_wait(task, 0.03)
        def client(service, region, *budget):
            if stage == "model_client" and service == "bedrock-runtime":
                entered.set()
                release.wait(2)
            return self.sts if service == "sts" else self.bedrock
        async def scenario():
            try:
                result = await readiness.handle_readiness(
                    PAYLOAD, GATEWAY, lambda url: self.client, "ap-northeast-2", "model")
                saved = copy.deepcopy(result)
                return result, saved
            except asyncio.CancelledError:
                if not cancelled:
                    raise
                return None, None
            finally:
                release.set()
                await asyncio.to_thread(finished.wait, 2)
        with patch.object(readiness, "check_readiness", side_effect=check), \
                patch.object(readiness, "_client", side_effect=client) as sdk, \
                patch.object(readiness.asyncio, "wait_for", new=bounded_wait):
            result, saved = asyncio.run(scenario())
        self.assertEqual(result, saved)
        self.assertEqual(len(model_calls), 1 if stage == "model" else 0)
        if cancelled:
            self.assertIsNone(result)
            return
        self.assertEqual(result["reason"], "timeout")
        if stage == "queued":
            sdk.assert_not_called()
            self.assertFalse(any(result["checks"].values()))
            return
        self.assertTrue(result["checks"]["identity"])
        self.assertTrue(result["checks"]["inventorySummary"])
        self.assertFalse(result["checks"]["model"])
        if stage in ("model", "model_client"):
            self.assertTrue(result["checks"]["knownResource"])
            self.assertEqual(result["inventory"]["count"], 1)
