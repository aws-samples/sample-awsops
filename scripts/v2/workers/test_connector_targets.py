"""connector_target_sync: own-gateway, own-Lambda create/update only; parity with provision.py."""
import os
import sys
import unittest
from unittest import mock

HERE = os.path.dirname(__file__)
sys.path.insert(0, HERE)
sys.path.insert(1, os.path.join(HERE, "..", "agentcore"))
import catalog  # noqa: E402
import connector_targets as ct  # noqa: E402
import handlers  # noqa: E402

OWN = "arn:aws:lambda:ap-northeast-2:123456789012:function:awsops-dev-agent-clickhouse-mcp"
ENV = {"CONNECTOR_TARGET_SYNC_ENABLED": "true",
       "CONNECTOR_TARGET_LAMBDAS": '{"clickhouse-mcp": "%s"}' % OWN}


class FakeCtrl:
    def __init__(self, targets=None, current=None, gateways=None):
        self.gateways = gateways if gateways is not None else [{"name": ct.GATEWAY_NAME, "gatewayId": "gw-obs"}]
        self.targets = targets or []
        self.current = current or {}
        self.calls = []

    def list_gateways(self, **_):
        return {"items": self.gateways}

    def list_gateway_targets(self, **kw):
        self.calls.append(("list_targets", kw["gatewayIdentifier"]))
        return {"items": self.targets}

    def get_gateway_target(self, **kw):
        return self.current

    def create_gateway_target(self, **kw):
        self.calls.append(("create", kw))

    def update_gateway_target(self, **kw):
        self.calls.append(("update", kw))

    def delete_gateway_target(self, **kw):  # must never be called
        raise AssertionError("delete is out of scope")


def current_for(arn, tools=None):
    tools = ct.inject_account(catalog.TARGETS["clickhouse-mcp-target"]["tools"]) if tools is None else tools
    return {"targetConfiguration": {"mcp": {"lambda": {"lambdaArn": arn, "toolSchema": {"inlinePayload": tools}}}},
            "credentialProviderConfigurations": [{"credentialProviderType": "GATEWAY_IAM_ROLE"}]}


@mock.patch.dict(os.environ, ENV, clear=False)
class ConnectorTargetSyncTest(unittest.TestCase):
    def test_creates_missing_target_on_own_gateway_with_provision_shape(self):
        ctrl = FakeCtrl()
        self.assertEqual(ct.run({"kind": "clickhouse"}, ctrl=ctrl), {"status": "created", "target": "clickhouse-mcp-target"})
        kind, call = ctrl.calls[-1]
        self.assertEqual(kind, "create")
        self.assertEqual(call["gatewayIdentifier"], "gw-obs")
        self.assertEqual(call["targetConfiguration"]["mcp"]["lambda"]["lambdaArn"], OWN)
        self.assertEqual(call["credentialProviderConfigurations"], [{"credentialProviderType": "GATEWAY_IAM_ROLE"}])

    def test_matching_target_is_left_alone(self):
        ctrl = FakeCtrl(targets=[{"name": "clickhouse-mcp-target", "targetId": "t1"}], current=current_for(OWN))
        self.assertEqual(ct.run({"kind": "clickhouse"}, ctrl=ctrl)["status"], "exists")
        self.assertFalse([c for c in ctrl.calls if c[0] in ("create", "update")])

    def test_own_target_with_schema_drift_is_updated(self):
        ctrl = FakeCtrl(targets=[{"name": "clickhouse-mcp-target", "targetId": "t1"}], current=current_for(OWN, tools=[]))
        self.assertEqual(ct.run({"kind": "clickhouse"}, ctrl=ctrl)["status"], "updated")

    def test_target_of_another_stack_is_never_repointed(self):
        other = OWN.replace("awsops-dev", "awsops-v2-stg")
        ctrl = FakeCtrl(targets=[{"name": "clickhouse-mcp-target", "targetId": "t1"}], current=current_for(other))
        out = ct.run({"kind": "clickhouse"}, ctrl=ctrl)
        self.assertEqual(out["reason"], "target_owned_by_another_stack")
        self.assertFalse([c for c in ctrl.calls if c[0] in ("create", "update")])

    def test_rejects_non_connector_kinds_and_undeployed_lambdas(self):
        ctrl = FakeCtrl()
        self.assertEqual(ct.run({"kind": "network"}, ctrl=ctrl)["reason"], "not_a_connector_kind")
        self.assertEqual(ct.run({"kind": "opensearch"}, ctrl=ctrl)["reason"], "not_a_connector_kind")  # monitoring gateway
        self.assertEqual(ct.run({"kind": "prometheus"}, ctrl=ctrl)["reason"], "connector_lambda_not_deployed")
        self.assertEqual(ct.run({"kind": "../x"}, ctrl=ctrl)["reason"], "invalid_kind")
        self.assertEqual(ctrl.calls, [])

    def test_missing_or_ambiguous_gateway_is_an_error_without_writes(self):
        for gateways in ([], [{"name": ct.GATEWAY_NAME, "gatewayId": "a"}, {"name": ct.GATEWAY_NAME, "gatewayId": "b"}]):
            ctrl = FakeCtrl(gateways=gateways)
            self.assertEqual(ct.run({"kind": "clickhouse"}, ctrl=ctrl)["reason"], "gateway_unavailable")
            self.assertEqual(ctrl.calls, [])

    def test_disabled_flag_skips_everything(self):
        with mock.patch.dict(os.environ, {"CONNECTOR_TARGET_SYNC_ENABLED": "false"}):
            self.assertEqual(ct.run({"kind": "clickhouse"}, ctrl=FakeCtrl())["reason"], "disabled")

    def test_registered_as_lambda_job(self):
        self.assertTrue(handlers.is_allowed("connector_target_sync"))
        self.assertEqual(handlers.runtime_for("connector_target_sync"), "lambda")


class ProvisionParityTest(unittest.TestCase):
    def test_tool_transform_and_fingerprint_match_provision(self):
        try:
            import provision
        except ImportError as error:  # boto3/botocore missing in this interpreter
            self.skipTest(f"provision unavailable: {error}")
        for spec in catalog.TARGETS.values():
            self.assertEqual(ct.inject_account(spec["tools"]), provision._inject_account(spec["tools"]))
            self.assertEqual(ct.tool_fingerprint(spec["tools"]), provision.tool_fingerprint(spec["tools"]))
        self.assertEqual(ct.GATEWAY_NAME, f"awsops-v2-{ct.GATEWAY_KEY}-gateway")


if __name__ == "__main__":
    unittest.main()
