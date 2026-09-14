"""Known gateway identity must survive readiness failures without enabling writes."""
import json
import os
import sys
from contextlib import ExitStack
from types import SimpleNamespace
from unittest import TestCase, mock

sys.path.insert(0, os.path.dirname(__file__))
import provision


AC = {"region": "ap-northeast-2", "role_arn": "arn:aws:iam::123456789012:role/fixture",
      "ecr_uri": "fixture.example.test/agent", "lambda_arns": {}}
PRESET_NAME = "datadog-mcp-server-target"
PRESET = {PRESET_NAME: provision.catalog.MCP_SERVER_TARGETS[PRESET_NAME]}
ENDPOINT = "https://mcp.datadoghq.com/v1/mcp"


def gateway(key):
    return {"name": f"awsops-v2-{key}-gateway", "gatewayId": f"gw-{key}",
            "status": "READY", "roleArn": AC["role_arn"], "protocolType": "MCP",
            "authorizerType": "AWS_IAM",
            "description": provision.catalog.GATEWAY_DESCRIPTIONS[key]}


class TestGatewayIdentityAndTeardown(TestCase):
    def setUp(self):
        provision.report.clear()
        provision.diagnostics.reset()

    def test_known_unready_gateway_still_runs_every_preset_teardown_reason(self):
        cases = [
            ({}, {}, {}, True),
            ({"datadog": ENDPOINT}, {}, {}, False),
            ({"datadog": "http://invalid.example"}, {"datadog": "http://invalid.example"}, {}, True),
            ({"datadog": ENDPOINT}, {"datadog": ENDPOINT}, {}, True),
        ]
        for endpoints, acknowledgments, secrets, readable in cases:
            with self.subTest(endpoints=endpoints, acknowledgments=acknowledgments):
                ctrl = mock.Mock()
                ctrl.list_gateways.return_value = {"items": [gateway("external-obs")]}
                ctrl.get_gateway.side_effect = provision.ClientError(
                    {"Error": {"Code": "ThrottlingException", "Message": "not printed"}}, "GetGateway")
                ctrl.list_gateway_targets.return_value = {"items": [{"name": PRESET_NAME, "targetId": "t-1"}]}
                ready = set()
                with mock.patch.object(provision.catalog, "GATEWAYS", ["external-obs"]), \
                     mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", PRESET), \
                     mock.patch.object(provision.catalog, "RETIRED_MCP_SERVER_TARGETS", ()):
                    ids = provision.ensure_gateways(ctrl, AC, ready_gateways=ready)
                    self.assertEqual(ids, {"external-obs": "gw-external-obs"})
                    self.assertEqual(ready, set())
                    provision.ensure_mcp_server_targets(
                        ctrl, {**AC, "official_mcp_endpoints": endpoints,
                               "official_mcp_read_only_ack": acknowledgments},
                        ids, secrets=secrets, secrets_read_ok=readable, ready_gateways=ready)
                ctrl.delete_gateway_target.assert_called_once_with(
                    gatewayIdentifier="gw-external-obs", targetId="t-1")
                ctrl.delete_api_key_credential_provider.assert_called_once()
                ctrl.create_gateway_target.assert_not_called()

    def test_unready_gateway_blocks_preset_provisioning_but_not_tombstones(self):
        ctrl = mock.Mock()
        ctrl.list_gateway_targets.return_value = {"items": [{"name": "removed-target", "targetId": "old"}]}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", PRESET), \
             mock.patch.object(provision.catalog, "RETIRED_MCP_SERVER_TARGETS", (("removed-target", "removed"),)):
            provision.ensure_mcp_server_targets(
                ctrl, {**AC, "official_mcp_endpoints": {"datadog": ENDPOINT},
                       "official_mcp_read_only_ack": {"datadog": ENDPOINT}},
                {"external-obs": "gw-external-obs"}, secrets={"mcp:datadog": {"token": "fixture"}},
                secrets_read_ok=True, ready_gateways=set())
        ctrl.delete_gateway_target.assert_called_once_with(gatewayIdentifier="gw-external-obs", targetId="old")
        ctrl.create_api_key_credential_provider.assert_not_called()
        ctrl.update_api_key_credential_provider.assert_not_called()
        ctrl.create_gateway_target.assert_not_called()
        ctrl.update_gateway_target.assert_not_called()
        ctrl.synchronize_gateway_targets.assert_not_called()

    def _main(self, missing_ops=False):
        ctrl = mock.Mock()
        ctrl.list_gateways.return_value = {"items": [
            gateway("external-obs"), *([] if missing_ops else [gateway("ops")])]}
        ctrl.create_gateway.side_effect = provision.ClientError(
            {"Error": {"Code": "AccessDeniedException", "Message": "not printed"}}, "CreateGateway")

        def get_gateway(gatewayIdentifier):
            if gatewayIdentifier == "gw-external-obs":
                raise provision.ClientError(
                    {"Error": {"Code": "ThrottlingException", "Message": "not printed"}}, "GetGateway")
            return gateway("ops")

        ctrl.get_gateway.side_effect = get_gateway
        ctrl.list_gateway_targets.return_value = {"items": [{"name": PRESET_NAME, "targetId": "t-1"}]}
        ctrl.list_agent_runtimes.return_value = {"agentRuntimes": [
            {"agentRuntimeName": provision.RUNTIME_NAME, "agentRuntimeId": "rt-1"}]}
        ctrl.update_agent_runtime.return_value = {"agentRuntimeArn": "fixture", "agentRuntimeId": "rt-1"}
        with ExitStack() as stack:
            for name, value in (
                ("GATEWAYS", ["ops", "external-obs"]), ("MCP_SERVER_TARGETS", PRESET),
                ("RETIRED_MCP_SERVER_TARGETS", ()),
            ):
                stack.enter_context(mock.patch.object(provision.catalog, name, value))
            stack.enter_context(mock.patch.object(provision, "tf_outputs", return_value={
                **AC, "official_mcp_endpoints": {"datadog": ENDPOINT}, "official_mcp_read_only_ack": {}}))
            stack.enter_context(mock.patch.object(provision, "validate_dev_deployment"))
            stack.enter_context(mock.patch.object(provision, "development_run", return_value=False))
            stack.enter_context(mock.patch.object(provision.boto3, "client", return_value=ctrl))
            stack.enter_context(mock.patch.object(provision, "_load_official_mcp_secret", return_value=({}, True)))
            stack.enter_context(mock.patch.object(provision, "_cutover_preset_keys", return_value=set()))
            targets = stack.enter_context(mock.patch.object(provision, "ensure_targets"))
            stack.enter_context(mock.patch.object(provision, "_wait_runtime_ready", return_value=True))
            stack.enter_context(mock.patch.object(provision, "prune_moved_targets"))
            stack.enter_context(mock.patch.object(provision, "ensure_memory", return_value="memory"))
            stack.enter_context(mock.patch.object(provision, "ensure_interpreter", return_value="interpreter"))
            ssm = stack.enter_context(mock.patch.object(provision, "write_ssm"))
            result = provision._provision(SimpleNamespace(smoke=False))
        return ctrl, targets, ssm, result

    def test_transient_gateway_failure_cannot_truncate_runtime_routes_or_teardown(self):
        ctrl, targets, _, result = self._main()
        self.assertEqual(result, 1)
        urls = json.loads(ctrl.update_agent_runtime.call_args.kwargs["environmentVariables"]["GATEWAYS_JSON"])
        self.assertEqual(set(urls), {"ops", "external-obs"})
        self.assertIn("gw-external-obs", urls["external-obs"])
        self.assertEqual(targets.call_args.kwargs["ready_gateways"], {"ops"})
        ctrl.delete_gateway_target.assert_called_once_with(gatewayIdentifier="gw-external-obs", targetId="t-1")

    def test_missing_gateway_id_blocks_runtime_mutation_but_keeps_known_teardown(self):
        ctrl, _, ssm, result = self._main(missing_ops=True)
        self.assertEqual(result, 1)
        ctrl.list_agent_runtimes.assert_not_called()
        ctrl.create_agent_runtime.assert_not_called()
        ctrl.update_agent_runtime.assert_not_called()
        self.assertEqual(ssm.call_args.args[1], "")
        ctrl.delete_gateway_target.assert_called_once_with(gatewayIdentifier="gw-external-obs", targetId="t-1")
