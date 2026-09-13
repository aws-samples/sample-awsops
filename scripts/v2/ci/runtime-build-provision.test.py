"""Offline immutable-image and smoke protocol regression; no real AWS clients."""
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import unittest
from unittest import mock
from botocore.exceptions import ClientError, ReadTimeoutError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agentcore"))
import provision

ACCOUNT = "123456789012"
DIGEST = "sha256:" + "b" * 64
AC = {
    "region": "ap-northeast-2", "project": "awsops-dev",
    "role_arn": f"arn:aws:iam::{ACCOUNT}:role/RuntimeRole",
    "ecr_uri": f"{ACCOUNT}.dkr.ecr.ap-northeast-2.amazonaws.com/awsops-dev-agentcore",
    "readiness_cloudfront_id": "E123EXAMPLE",
    "readiness_protocol_available": True, "readiness_inventory_enabled": True,
}
RID = "awsops_v2_agent-AbCd123456"
ARN = f"arn:aws:bedrock-agentcore:ap-northeast-2:{ACCOUNT}:runtime/{RID}"
ENV = {
    "TARGET": "dev", "GITHUB_REF": "refs/heads/dev",
    "GITHUB_REPOSITORY": "aws-samples/sample-awsops", "GITHUB_EVENT_NAME": "workflow_dispatch",
    "GITHUB_SHA": "a" * 40, "AWS_REGION": "ap-northeast-2",
    "AWS_ACCOUNT_ID_DEV": ACCOUNT, "RUNTIME_ROLE_ARN": f"arn:aws:iam::{ACCOUNT}:role/platform/DeployRole",
    "AGENT_IMAGE_DIGEST": DIGEST, "AGENT_IMAGE_TAG": "agent-" + "a" * 40,
}
REQUEST = dict(mode="deployment_readiness", nonce="a" * 32,
               expectedAccountId=ACCOUNT, expectedCloudfrontId="E123EXAMPLE")


def ready():
    return dict(schemaVersion=1, mode="deployment_readiness", nonce=REQUEST["nonce"],
                accountId=ACCOUNT, status="ready", reason="ok",
                checks={key: True for key in ("identity", "inventorySummary", "inventoryQuery",
                                             "knownResource", "freshInventory", "model")},
                inventory=dict(count=2, ageMinutes=1))


def frame(value):
    return ("data: " + json.dumps(value) + "\n\n").encode()


class RuntimeImageTest(unittest.TestCase):
    def setUp(self):
        provision.report.clear()
        self.stack = contextlib.ExitStack()
        self.stack.enter_context(mock.patch.dict(os.environ, {}, clear=True))
        self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        self.addCleanup(self.stack.close)

    def test_digest_binds_create_and_update(self):
        for existing in (False, True):
            ctrl = mock.MagicMock()
            ctrl.list_agent_runtimes.return_value = {"agentRuntimes": [{
                "agentRuntimeName": provision.RUNTIME_NAME, "agentRuntimeId": RID,
                "agentRuntimeArn": ARN,
            }] if existing else []}
            ctrl.create_agent_runtime.return_value = {"agentRuntimeArn": ARN, "agentRuntimeId": RID}
            ctrl.update_agent_runtime.return_value = {"agentRuntimeArn": ARN, "agentRuntimeId": RID}
            with mock.patch.dict(os.environ, {"AGENT_IMAGE_DIGEST": DIGEST}), \
                    mock.patch.object(provision, "_wait_runtime_ready", return_value=True):
                self.assertEqual(provision.ensure_runtime(ctrl, AC, {}), ARN)
            call = ctrl.update_agent_runtime if existing else ctrl.create_agent_runtime
            self.assertEqual(call.call_args.kwargs["agentRuntimeArtifact"]["containerConfiguration"]["containerUri"],
                             AC["ecr_uri"] + "@" + DIGEST)

    def test_invalid_or_missing_dev_digest_never_calls_control_plane(self):
        for value in ("", "latest", "sha256:" + "F" * 64, DIGEST + "\n"):
            ctrl = mock.MagicMock()
            ctrl.list_agent_runtimes.return_value = {"agentRuntimes": []}
            with mock.patch.dict(os.environ, {**ENV, "AGENT_IMAGE_DIGEST": value}), \
                    mock.patch.object(provision, "_wait_runtime_ready", return_value=False):
                self.assertEqual(provision.ensure_runtime(ctrl, AC, {}), "")
            self.assertEqual(ctrl.mock_calls, [])

    def test_legacy_tag_remains_when_no_digest_was_requested(self):
        self.assertEqual(provision.runtime_image(AC), AC["ecr_uri"] + ":" + provision.IMAGE_TAG)

    def test_readiness_runtime_flag_requires_applied_boolean_true(self):
        for value in (True, False, None, "true", 1):
            ctrl = mock.MagicMock()
            ctrl.list_agent_runtimes.return_value = {"agentRuntimes": []}
            ctrl.create_agent_runtime.return_value = {"agentRuntimeArn": ARN, "agentRuntimeId": RID}
            with mock.patch.dict(os.environ, {"DEPLOYMENT_READINESS_ENABLED": "true"}), \
                    mock.patch.object(provision, "_wait_runtime_ready", return_value=True):
                provision.ensure_runtime(ctrl, {**AC, "deployment_readiness_enabled": value}, {})
            self.assertEqual(ctrl.create_agent_runtime.call_args.kwargs["environmentVariables"]["DEPLOYMENT_READINESS_ENABLED"],
                             "true" if value is True else "false")
        ctrl.reset_mock()
        with mock.patch.object(provision, "_wait_runtime_ready", return_value=True):
            provision.ensure_runtime(ctrl, AC, {})
        self.assertEqual(ctrl.create_agent_runtime.call_args.kwargs["environmentVariables"]["DEPLOYMENT_READINESS_ENABLED"], "false")

    def test_pending_or_foreign_runtime_is_not_reported_ready(self):
        for value in ("PENDING", "", ARN.replace(ACCOUNT, "999999999999")):
            ctrl = mock.MagicMock()
            ctrl.list_agent_runtimes.return_value = {"agentRuntimes": []}
            ctrl.create_agent_runtime.return_value = {"agentRuntimeArn": value, "agentRuntimeId": RID}
            with mock.patch.dict(os.environ, ENV), \
                    mock.patch.object(provision, "_wait_runtime_ready", return_value=True):
                self.assertEqual(provision.ensure_runtime(ctrl, AC, {}), "")

    def test_dev_static_mismatch_fails_before_client_creation(self):
        for change in ({"AWS_ACCOUNT_ID_DEV": ""}, {"AWS_ACCOUNT_ID_DEV": "999999999999"},
                       {"GITHUB_EVENT_NAME": "push"}, {"AGENT_IMAGE_DIGEST": ""}):
            with mock.patch.dict(os.environ, {**ENV, **change}), \
                    mock.patch.object(provision, "boto3") as sdk:
                with self.assertRaises(ValueError):
                    provision.validate_dev_deployment(AC)
                sdk.client.assert_not_called()

    def test_actual_dev_caller_must_match_independent_account_and_role(self):
        for name, account in (("DeployRole", ACCOUNT), ("OtherRole", ACCOUNT),
                              ("DeployRole", "999999999999")):
            with mock.patch.dict(os.environ, ENV), mock.patch.object(provision, "boto3") as sdk:
                sdk.client.return_value.get_caller_identity.return_value = {
                    "Account": account, "Arn": f"arn:aws:sts::{account}:assumed-role/{name}/GitHubActions"}
                if name == "DeployRole" and account == ACCOUNT:
                    provision.validate_dev_deployment(AC)
                else:
                    with self.assertRaises(ValueError):
                        provision.validate_dev_deployment(AC)
                self.assertEqual(sdk.client.call_args.args[0], "sts")

    def test_main_stops_before_any_provisioning_on_wrong_caller(self):
        with mock.patch.dict(os.environ, ENV), mock.patch.object(provision, "boto3") as sdk, \
                mock.patch.object(provision, "tf_outputs", return_value=AC), \
                mock.patch.object(sys, "argv", ["provision.py"]), \
                mock.patch.object(provision, "ensure_gateways") as gateways:
            sdk.client.return_value.get_caller_identity.return_value = {
                "Account": "999999999999", "Arn": "wrong"}
            with self.assertRaises(SystemExit) as result:
                provision.main()
            self.assertEqual(result.exception.code, 1)
            gateways.assert_not_called()
            self.assertEqual([call.args[0] for call in sdk.client.call_args_list], ["sts"])

    def test_smoke_rejects_prose_wrong_nonce_false_checks_extra_fields_bounds_and_duplicate_frames(self):
        self.assertTrue(provision.valid_readiness_response(frame(ready()), REQUEST))
        bad = []
        for change in (
                {"nonce": "b" * 32}, {"accountId": "999999999999"}, {"status": "not_ready"},
                {"debug": "SECRET"}, {"inventory": {"count": 0, "ageMinutes": 1}},
                {"inventory": {"count": 2, "ageMinutes": 1441}}):
            bad.append(frame({**ready(), **change}))
        value = ready()
        value["checks"]["model"] = False
        bad.extend([frame(value), b"there are IAM roles", frame(ready()) * 2,
                    b"data: " + b"x" * 16385, b"data: NaN\n\n",
                    frame(ready()).replace(b'"schemaVersion": 1', b'"schemaVersion": 1, "schemaVersion": 1')])
        for value in bad:
            self.assertFalse(provision.valid_readiness_response(value, REQUEST))

    def test_smoke_reads_bounded_body_closes_it_and_never_prints_raw_response(self):
        stream = io.BytesIO(b"the role tool failed SECRET")
        with mock.patch.dict(os.environ, {"TARGET": "dev"}), mock.patch.object(provision, "boto3") as sdk, \
                mock.patch.object(provision, "log") as log:
            sdk.client.return_value.invoke_agent_runtime.return_value = {
                "response": stream, "contentType": "text/event-stream"}
            provision.smoke(AC, ARN)
            self.assertTrue(stream.closed)
            self.assertEqual(log.call_args.args, ("smoke", "ERR", "protocol_invalid"))
            payload = json.loads(sdk.client.return_value.invoke_agent_runtime.call_args.kwargs["payload"])
            self.assertEqual(set(payload), set(REQUEST))
            self.assertEqual(payload["expectedAccountId"], ACCOUNT)

    def test_smoke_accepts_only_current_nonce_success_and_closes_stream(self):
        with mock.patch.object(provision, "boto3") as sdk, \
                mock.patch.object(provision, "log") as log:
            streams = []

            def invoke(**kwargs):
                payload = json.loads(kwargs["payload"])
                streams.append(io.BytesIO(frame({**ready(), "nonce": payload["nonce"]})))
                return {"response": streams[-1], "contentType": "text/event-stream"}

            sdk.client.return_value.invoke_agent_runtime.side_effect = invoke
            provision.smoke(AC, ARN)
            self.assertTrue(streams[0].closed)
            self.assertEqual(log.call_args.args, ("smoke", "OK", "readiness_confirmed"))

    def test_legacy_smoke_without_development_metadata_is_advisory_and_still_invokes(self):
        legacy = {**AC, "readiness_cloudfront_id": None, "readiness_protocol_available": False}
        with mock.patch.object(provision, "boto3") as sdk, mock.patch.object(provision, "log") as log:
            stream = io.BytesIO(b"PRIVATE old chat response")
            sdk.client.return_value.invoke_agent_runtime.return_value = {"response": stream}
            provision.smoke(legacy, ARN)
            sdk.client.return_value.invoke_agent_runtime.assert_called_once()
            self.assertEqual(log.call_args.args, ("smoke", "WARN", "legacy_invocation_only"))
            self.assertTrue(stream.closed)

    def test_main_provisions_before_optional_smoke_when_development_output_is_missing(self):
        legacy = {**AC, "readiness_cloudfront_id": None, "readiness_protocol_available": False}
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(sys, "argv", ["provision.py", "--smoke"]))
            stack.enter_context(mock.patch.object(provision, "tf_outputs", return_value=legacy))
            stack.enter_context(mock.patch.object(provision, "boto3"))
            stack.enter_context(mock.patch.object(provision.time, "sleep"))
            gateways = stack.enter_context(mock.patch.object(provision, "ensure_gateways", return_value={}))
            stack.enter_context(mock.patch.object(provision, "_load_official_mcp_secret", return_value=({}, True)))
            stack.enter_context(mock.patch.object(provision, "_cutover_preset_keys", return_value=set()))
            for name in ["ensure_targets", "ensure_mcp_server_targets", "prune_moved_targets", "write_ssm"]:
                stack.enter_context(mock.patch.object(provision, name))
            stack.enter_context(mock.patch.object(provision, "ensure_runtime", return_value=ARN))
            stack.enter_context(mock.patch.object(provision, "ensure_memory", return_value="memory"))
            stack.enter_context(mock.patch.object(provision, "ensure_interpreter", return_value="interpreter"))
            smoke = stack.enter_context(mock.patch.object(provision, "smoke"))
            with self.assertRaises(SystemExit) as result:
                provision.main()
            self.assertEqual(result.exception.code, 0)
            gateways.assert_called_once()
            smoke.assert_called_once_with(legacy, ARN)

    def test_fixed_readiness_failure_categories(self):
        cases = [(b"not JSON", "protocol_invalid")]
        cases.append((frame({**ready(), "nonce": "b" * 32}), "response_identity_mismatch"))
        value = ready()
        value["checks"]["model"] = False
        cases.append((frame(value), "checks_failed"))
        cases.append((frame({**ready(), "status": "not_ready", "reason": "inventory_stale",
                             "inventory": {"count": 2, "ageMinutes": 16}}), "inventory_stale"))
        for value, expected in cases:
            self.assertEqual(provision.readiness_code(value, REQUEST), expected)

    def test_sse_metadata_done_and_classifier_freshness_are_supported(self):
        value = {**ready(), "inventory": {"count": 2, "ageMinutes": 120}}
        payload = json.dumps(value).encode()
        event = b": heartbeat\n\nevent: readiness\nid: fixture\ndata:" + payload + b"\n\ndata: [DONE]\n\n"
        self.assertTrue(provision.valid_readiness_response(event, REQUEST))
        self.assertFalse(provision.valid_readiness_response(event + frame(value), REQUEST))

    def test_disabled_and_incomplete_reasons_are_preserved_without_raw_text(self):
        for reason in ("disabled", "inventory_incomplete"):
            value = {**ready(), "status": "not_ready", "reason": reason,
                     "inventory": {"count": None, "ageMinutes": None}}
            self.assertEqual(provision.readiness_code(frame(value), REQUEST), reason)
            self.assertFalse(provision.valid_readiness_response(frame(value), REQUEST))

    def test_access_denied_is_safe_and_distinct_from_protocol_failure(self):
        errors = [
            (ClientError({"Error": {"Code": code, "Message": "PRIVATE"}}, "InvokeAgentRuntime"), expected)
            for code, expected in [("AccessDeniedException", "invoke_access_denied"),
                                   ("ThrottlingException", "invoke_throttled"),
                                   ("ExpiredTokenException", "invoke_credentials_expired")]
        ] + [(ReadTimeoutError(endpoint_url="https://private.example"), "invoke_timeout")]
        for error, expected in errors:
            with mock.patch.dict(os.environ, {"TARGET": "dev"}), mock.patch.object(provision, "boto3") as sdk, \
                    mock.patch.object(provision, "log") as log:
                sdk.client.return_value.invoke_agent_runtime.side_effect = error
                provision.smoke(AC, ARN)
                self.assertEqual(log.call_args.args, ("smoke", "ERR", expected))

    def test_content_type_and_missing_producer_have_distinct_codes(self):
        with mock.patch.dict(os.environ, {"TARGET": "dev"}), mock.patch.object(provision, "boto3") as sdk, \
                mock.patch.object(provision, "log") as log:
            provision.smoke({**AC, "readiness_protocol_available": False}, ARN)
            sdk.client.assert_not_called()
            self.assertEqual(log.call_args.args, ("smoke", "ERR", "readiness_protocol_unavailable"))
            sdk.client.return_value.invoke_agent_runtime.return_value = {
                "contentType": "application/json", "response": io.BytesIO(b"PRIVATE")}
            provision.smoke(AC, ARN)
            self.assertEqual(log.call_args.args, ("smoke", "ERR", "not_event_stream"))

    def test_safe_catalog_skip_output_and_bounded_counts(self):
        output = io.StringIO()
        provision.diagnostics.reset()
        with contextlib.redirect_stdout(output):
            provision.diagnostics.stage("mcp_targets")
            provision.log("target:datadog-mcp-server-target", "SKIP",
                          "runtime allowlist not confirmed live this run PRIVATE arn:aws:secret")
            provision.log("target:PRIVATE-unknown", "ERR", "PRIVATE arbitrary error")
            provision.diagnostics.summary()
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(events[1]["key"], "datadog-mcp-server-target")
        self.assertEqual(events[1]["code"], "runtime_allowlist_unconfirmed")
        self.assertEqual(events[-1]["counts"]["SKIP"], 1)
        self.assertEqual(events[-1]["counts"]["ERR"], 1)
        self.assertNotIn("PRIVATE", output.getvalue())
        self.assertNotIn("arn:", output.getvalue())

    def test_resource_event_cap_discloses_drops_and_preserves_status_counts(self):
        provision.diagnostics.reset()
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            for _ in range(provision.diagnostics.LIMIT + 5):
                provision.log("target:datadog-mcp-server-target", "SKIP", "PRIVATE")
            provision.diagnostics.summary()
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(len(events), provision.diagnostics.LIMIT + 1)
        self.assertEqual(events[-1]["dropped"], 5)
        self.assertEqual(events[-1]["counts"]["SKIP"], provision.diagnostics.LIMIT + 5)


if __name__ == "__main__":
    unittest.main()
