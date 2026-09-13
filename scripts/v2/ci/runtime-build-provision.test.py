"""Offline immutable-image and smoke protocol regression; no real AWS clients."""
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agentcore"))
import provision

ACCOUNT = "123456789012"
DIGEST = "sha256:" + "b" * 64
AC = {
    "region": "ap-northeast-2", "project": "awsops-dev",
    "role_arn": f"arn:aws:iam::{ACCOUNT}:role/RuntimeRole",
    "ecr_uri": f"{ACCOUNT}.dkr.ecr.ap-northeast-2.amazonaws.com/awsops-dev-agentcore",
    "readiness_cloudfront_id": "E123EXAMPLE",
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
            with self.assertRaises(ValueError):
                provision.main()
            gateways.assert_not_called()
            self.assertEqual([call.args[0] for call in sdk.client.call_args_list], ["sts"])

    def test_smoke_rejects_prose_wrong_nonce_false_checks_extra_fields_stale_and_duplicate_frames(self):
        self.assertTrue(provision.valid_readiness_response(frame(ready()), REQUEST))
        bad = []
        for change in (
                {"nonce": "b" * 32}, {"accountId": "999999999999"}, {"status": "not_ready"},
                {"debug": "SECRET"}, {"inventory": {"count": 0, "ageMinutes": 1}},
                {"inventory": {"count": 2, "ageMinutes": 16}}):
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
        with mock.patch.object(provision, "boto3") as sdk, \
                mock.patch.object(provision, "log") as log:
            sdk.client.return_value.invoke_agent_runtime.return_value = {
                "response": stream, "contentType": "text/event-stream"}
            provision.smoke(AC, ARN)
            self.assertTrue(stream.closed)
            self.assertEqual(log.call_args.args, ("smoke", "ERR", "readiness_unconfirmed"))
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


if __name__ == "__main__":
    unittest.main()
