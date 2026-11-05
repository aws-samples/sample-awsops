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
TEMPO = OWN.replace("clickhouse", "tempo")
ROLE = "arn:aws:iam::123456789012:role/awsops-dev-agentcore"
ENV = {"CONNECTOR_TARGET_SYNC_ENABLED": "true",
       "CONNECTOR_TARGET_LAMBDAS": '{"clickhouse-mcp": "%s", "tempo-mcp": "%s"}' % (OWN, TEMPO),
       "CONNECTOR_TARGET_GATEWAY_ROLE_ARN": ROLE}


class ClientError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


class FakeCtrl:
    def __init__(self, targets=None, current=None, gateways=None, gateway_detail=None, create_error=None,
                 conflict_creates=False):
        self.gateways = gateways if gateways is not None else [
            {"name": ct.gateway_name("external-obs"), "gatewayId": "gw-obs"},
            {"name": ct.gateway_name("monitoring"), "gatewayId": "gw-mon"}]
        self.targets = targets or []
        self.current = current or {}
        self.gateway_detail = gateway_detail if gateway_detail is not None else {
            "roleArn": ROLE, "authorizerType": "AWS_IAM"}
        self.create_error = create_error
        self.conflict_creates = conflict_creates  # the racing create landed: target listed after the error
        self.calls = []

    def list_gateways(self, **_):
        return {"items": self.gateways}

    def get_gateway(self, **_):
        return self.gateway_detail

    def list_gateway_targets(self, **kw):
        self.calls.append(("list_targets", kw["gatewayIdentifier"]))
        return {"items": self.targets}

    def get_gateway_target(self, **kw):
        return self.current

    def create_gateway_target(self, **kw):
        if self.create_error is not None:
            if self.conflict_creates:
                self.targets.append({"name": kw["name"], "targetId": "t9"})
            raise self.create_error
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

    def test_tempo_goes_to_the_monitoring_gateway(self):
        ctrl = FakeCtrl()
        self.assertEqual(ct.run({"kind": "tempo"}, ctrl=ctrl)["status"], "created")
        self.assertEqual(ctrl.calls[-1][1]["gatewayIdentifier"], "gw-mon")
        self.assertEqual(ctrl.calls[-1][1]["targetConfiguration"]["mcp"]["lambda"]["lambdaArn"], TEMPO)

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
        self.assertEqual(ct.run({"kind": "opensearch"}, ctrl=ctrl)["reason"], "not_a_connector_kind")  # pinned allowlist
        self.assertEqual(ct.run({"kind": "prometheus"}, ctrl=ctrl)["reason"], "connector_lambda_not_deployed")
        self.assertEqual(ct.run({"kind": "../x"}, ctrl=ctrl)["reason"], "invalid_kind")
        self.assertEqual(ctrl.calls, [])

    def test_missing_or_ambiguous_gateway_is_an_error_without_writes(self):
        name = ct.gateway_name("external-obs")
        for gateways in ([], [{"name": name, "gatewayId": "a"}, {"name": name, "gatewayId": "b"}]):
            ctrl = FakeCtrl(gateways=gateways)
            with self.assertRaises(RuntimeError):
                ct.run({"kind": "clickhouse"}, ctrl=ctrl)
            self.assertEqual(ctrl.calls, [])

    def test_runtime_error_is_reraised_and_failed_outcome_is_logged(self):
        ctrl = FakeCtrl(gateways=[])
        with mock.patch("builtins.print") as printed:
            with self.assertRaises(RuntimeError):
                ct.run({"kind": "clickhouse"}, ctrl=ctrl)
        lines = [str(call.args[0]) for call in printed.call_args_list if call.args]
        self.assertEqual(len(lines), 1)
        self.assertIn('"status": "failed"', lines[0])
        self.assertIn('"reason": "gateway_unavailable"', lines[0])
        self.assertIn('"kind": "clickhouse"', lines[0])

    def test_target_without_id_fails_with_logged_outcome(self):
        ctrl = FakeCtrl(targets=[{"name": "clickhouse-mcp-target"}])
        with mock.patch("builtins.print") as printed:
            with self.assertRaises(RuntimeError):
                ct.run({"kind": "clickhouse"}, ctrl=ctrl)
        lines = [str(call.args[0]) for call in printed.call_args_list if call.args]
        self.assertTrue(any('"status": "failed"' in line and "target_id_missing" in line for line in lines))
        self.assertFalse([c for c in ctrl.calls if c[0] in ("create", "update")])

    def test_gateway_of_another_stack_is_never_written(self):
        ctrl = FakeCtrl(gateway_detail={"roleArn": ROLE.replace("awsops-dev", "awsops-v2-stg"),
                                        "authorizerType": "AWS_IAM"})
        self.assertEqual(ct.run({"kind": "clickhouse"}, ctrl=ctrl)["reason"], "gateway_owned_by_another_stack")
        self.assertFalse([c for c in ctrl.calls if c[0] in ("create", "update")])

    def test_gateway_without_iam_auth_is_never_written(self):
        ctrl = FakeCtrl(gateway_detail={"roleArn": ROLE, "authorizerType": "NONE"})
        self.assertEqual(ct.run({"kind": "clickhouse"}, ctrl=ctrl)["reason"], "gateway_auth_not_iam")
        self.assertEqual(ctrl.calls, [])

    def test_missing_gateway_role_env_skips_without_writes(self):
        env = {k: v for k, v in ENV.items() if k != "CONNECTOR_TARGET_GATEWAY_ROLE_ARN"}
        with mock.patch.dict(os.environ, env, clear=True):
            ctrl = FakeCtrl()
            self.assertEqual(ct.run({"kind": "clickhouse"}, ctrl=ctrl)["reason"], "gateway_role_unknown")
            self.assertEqual(ctrl.calls, [])

    def test_concurrent_create_conflict_reports_exists(self):
        ctrl = FakeCtrl(create_error=ClientError("ConflictException"), conflict_creates=True)
        self.assertEqual(ct.run({"kind": "clickhouse"}, ctrl=ctrl),
                         {"status": "exists", "reason": "concurrent_create", "target": "clickhouse-mcp-target"})

    def test_conflict_without_a_listed_target_is_reraised(self):
        ctrl = FakeCtrl(create_error=ClientError("ConflictException"))
        with self.assertRaises(ClientError):
            ct.run({"kind": "clickhouse"}, ctrl=ctrl)

    def test_target_pointing_at_another_own_connector_is_not_repointed(self):
        ctrl = FakeCtrl(targets=[{"name": "clickhouse-mcp-target", "targetId": "t1"}], current=current_for(TEMPO))
        out = ct.run({"kind": "clickhouse"}, ctrl=ctrl)
        self.assertEqual(out["reason"], "target_points_at_another_connector")
        self.assertFalse([c for c in ctrl.calls if c[0] in ("create", "update")])

    def test_other_create_errors_are_reraised(self):
        ctrl = FakeCtrl(create_error=ClientError("AccessDeniedException"))
        with self.assertRaises(ClientError):
            ct.run({"kind": "clickhouse"}, ctrl=ctrl)

    def test_disabled_flag_skips_everything(self):
        with mock.patch.dict(os.environ, {"CONNECTOR_TARGET_SYNC_ENABLED": "false"}):
            self.assertEqual(ct.run({"kind": "clickhouse"}, ctrl=FakeCtrl())["reason"], "disabled")

    def test_registered_as_lambda_job(self):
        self.assertTrue(handlers.is_allowed("connector_target_sync"))
        self.assertEqual(handlers.runtime_for("connector_target_sync"), "lambda")

    def test_handler_skips_before_importing_when_flag_off(self):
        with mock.patch.dict(os.environ, {"CONNECTOR_TARGET_SYNC_ENABLED": "false"}):
            self.assertEqual(handlers.REGISTRY["connector_target_sync"][0]({"kind": "clickhouse"}, False),
                             ({"status": "skipped", "reason": "disabled"}, None))


class ProvisionParityTest(unittest.TestCase):
    def test_tool_transform_and_fingerprint_match_provision(self):
        try:
            import provision
        except ImportError as error:  # boto3/botocore missing in this interpreter
            self.skipTest(f"provision unavailable: {error}")
        for spec in catalog.TARGETS.values():
            self.assertEqual(ct.inject_account(spec["tools"]), provision._inject_account(spec["tools"]))
            self.assertEqual(ct.tool_fingerprint(spec["tools"]), provision.tool_fingerprint(spec["tools"]))
        self.assertEqual(ct.gateway_name("monitoring"), "awsops-v2-monitoring-gateway")
        for kind in ("clickhouse", "prometheus", "loki", "tempo", "mimir"):
            self.assertIn(catalog.TARGETS[f"{kind}-mcp-target"]["gateway"], ct.GATEWAY_KEYS)


if __name__ == "__main__":
    unittest.main()
