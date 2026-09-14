"""Regression (PR #197 round 9 MAJOR): ensure_targets must detect an IN-PLACE tool schema edit.

Drift detection used to compare tool-NAME sets only, so round 8's removal of `secret_arn` from
execute_sql's inputSchema (same tool name) was invisible and the deployed gateway kept advertising
the stale contract. Also asserts the comparison is STABLE — an unchanged catalog must not report
drift (key ordering, tool ordering, and API-echoed extra top-level fields must not thrash the
gateway).

Runs with `python3 -m unittest test_provision_drift` (no network — the control plane is a Mock).
"""
import os
import sys
import unittest
import copy
import io
import json
from contextlib import redirect_stdout
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import provision  # noqa: E402

_SCHEMA_NEW = {"type": "object", "properties": {"sql": {"type": "string"}}, "required": ["sql"]}
_SCHEMA_OLD = {"type": "object",
               "properties": {"sql": {"type": "string"}, "secret_arn": {"type": "string"}},
               "required": ["sql"]}

_TARGETS = {
    "rds-mcp-target": {
        "gateway": "data",
        "lambda_key": "rds-mcp",
        "description": "RDS",
        "tools": [{"name": "execute_sql", "description": "SQL", "inputSchema": _SCHEMA_NEW}],
    }
}


def _target(deployed_tools, **changes):
    return {
        "targetId": "t-1", "status": "READY", "description": "RDS",
        "credentialProviderConfigurations": [{"credentialProviderType": "GATEWAY_IAM_ROLE"}],
        "targetConfiguration": {"mcp": {"lambda": {
            "lambdaArn": "arn:aws:lambda:x:1:function:f",
            "toolSchema": {"inlinePayload": deployed_tools}}}},
        **changes,
    }


def _run(deployed_tools, snapshot=None):
    ctrl = mock.Mock()
    ctrl.list_gateway_targets.return_value = {
        "items": [{"name": "rds-mcp-target", "targetId": "t-1"}]}
    ctrl.get_gateway_target.return_value = snapshot or _target(deployed_tools)
    def updated_target(**request):
        ctrl.get_gateway_target.return_value = {**ctrl.get_gateway_target.return_value,
                                                **request, "status": "READY"}
        return {"targetId": "t-1"}
    ctrl.update_gateway_target.side_effect = updated_target
    provision.report.clear()
    with mock.patch.object(provision.catalog, "TARGETS", _TARGETS):
        provision.ensure_targets(
            ctrl, {"lambda_arns": {"rds-mcp": "arn:aws:lambda:x:1:function:f"}}, {"data": "gw-1"})
    return ctrl, {r[1] for r in provision.report}


def _deployed(schema, **extra):
    """What the API echoes back: the injected target_account_id property plus any extra
    top-level fields this provisioner never sends."""
    schema = {**schema, "properties": {**schema["properties"],
                                       "target_account_id": {
                                           "type": "string",
                                           "description": "Target AWS account ID for cross-account "
                                                          "access (12 digits). Only provide when "
                                                          "instructed."}}}
    return [{"name": "execute_sql", "description": "SQL", "inputSchema": schema, **extra}]


class TestProvisionDrift(unittest.TestCase):
    def test_in_place_schema_edit_is_drift(self):
        ctrl, statuses = _run(_deployed(_SCHEMA_OLD))
        self.assertIn("UPDATED", statuses, "stale inputSchema (same tool name) must re-sync")
        ctrl.update_gateway_target.assert_called_once()

    def test_description_edit_is_drift(self):
        ctrl, statuses = _run([{**_deployed(_SCHEMA_NEW)[0], "description": "old text"}])
        self.assertIn("UPDATED", statuses)
        ctrl.update_gateway_target.assert_called_once()

    def test_unchanged_is_not_drift(self):
        ctrl, statuses = _run(_deployed(_SCHEMA_NEW))
        self.assertEqual({"EXISTS"}, statuses)
        ctrl.update_gateway_target.assert_not_called()

    def test_api_echoed_extra_top_level_fields_are_not_drift(self):
        ctrl, statuses = _run(_deployed(_SCHEMA_NEW, outputSchema=None, annotations={}))
        self.assertEqual({"EXISTS"}, statuses)
        ctrl.update_gateway_target.assert_not_called()

    def test_fingerprint_is_order_stable(self):
        a = [{"name": "b", "description": "B", "inputSchema": {"type": "object", "x": 1}},
             {"name": "a", "description": "A", "inputSchema": {"x": 1, "type": "object"}}]
        b = [{"description": "A", "inputSchema": {"type": "object", "x": 1}, "name": "a"},
             {"inputSchema": {"x": 1, "type": "object"}, "name": "b", "description": "B"}]
        self.assertEqual(provision.tool_fingerprint(a), provision.tool_fingerprint(b))

    def test_lambda_arn_drift_with_unchanged_schema_is_updated(self):
        current = _target(_deployed(_SCHEMA_NEW))
        current["targetConfiguration"]["mcp"]["lambda"]["lambdaArn"] = "arn:aws:lambda:x:1:function:old"
        ctrl, statuses = _run(_deployed(_SCHEMA_NEW), current)
        self.assertIn("UPDATED", statuses)
        self.assertEqual(ctrl.update_gateway_target.call_args.kwargs["targetConfiguration"]["mcp"]["lambda"]["lambdaArn"],
                         "arn:aws:lambda:x:1:function:f")

    def test_credential_and_target_description_drift_are_updated(self):
        for changes in (
            {"credentialProviderConfigurations": [{"credentialProviderType": "API_KEY"}]},
            {"credentialProviderConfigurations": None},
            {"description": "old target description"},
        ):
            with self.subTest(changes=changes):
                ctrl, statuses = _run(_deployed(_SCHEMA_NEW), _target(_deployed(_SCHEMA_NEW), **changes))
                self.assertIn("UPDATED", statuses)
                self.assertEqual(ctrl.update_gateway_target.call_args.kwargs["credentialProviderConfigurations"],
                                 [{"credentialProviderType": "GATEWAY_IAM_ROLE"}])

    def test_update_preserves_target_metadata_and_waits_until_ready(self):
        current = _target(_deployed(_SCHEMA_OLD),
                          metadataConfiguration={"allowedRequestHeaders": ["x-correlation-id"]})
        ctrl, statuses = _run(_deployed(_SCHEMA_NEW), current)
        self.assertIn("UPDATED", statuses)
        self.assertEqual(ctrl.update_gateway_target.call_args.kwargs["metadataConfiguration"],
                         current["metadataConfiguration"])
        self.assertGreaterEqual(ctrl.get_gateway_target.call_count, 2)

    def test_update_readiness_failure_is_not_reported_as_updated(self):
        ctrl = mock.Mock()
        ctrl.list_gateway_targets.return_value = {"items": [{"name": "rds-mcp-target", "targetId": "t-1"}]}
        ctrl.get_gateway_target.side_effect = [_target(_deployed(_SCHEMA_OLD)), {"status": "FAILED"}]
        provision.report.clear()
        with mock.patch.object(provision.catalog, "TARGETS", _TARGETS):
            provision.ensure_targets(ctrl, {"lambda_arns": {"rds-mcp": "arn:aws:lambda:x:1:function:f"}},
                                     {"data": "gw-1"})
        self.assertNotIn("UPDATED", {row[1] for row in provision.report})
        self.assertIn("ERR", {row[1] for row in provision.report})

    def test_target_waits_for_updated_values_not_an_old_ready_snapshot(self):
        old = _target(_deployed(_SCHEMA_NEW))
        old["targetConfiguration"]["mcp"]["lambda"]["lambdaArn"] = "arn:old"
        ctrl = mock.Mock()
        ctrl.list_gateway_targets.return_value = {"items": [{"name": "rds-mcp-target", "targetId": "t-1"}]}
        ctrl.get_gateway_target.side_effect = [old, old, _target(_deployed(_SCHEMA_NEW))]
        provision.report.clear()
        with mock.patch.object(provision.catalog, "TARGETS", _TARGETS), \
             mock.patch.object(provision.time, "sleep") as sleep:
            provision.ensure_targets(ctrl, {"lambda_arns": {"rds-mcp": "arn:aws:lambda:x:1:function:f"}},
                                     {"data": "gw-1"})
        self.assertEqual(ctrl.get_gateway_target.call_count, 3)
        sleep.assert_called_once()
        self.assertIn("UPDATED", {row[1] for row in provision.report})

    def test_unsuccessful_target_updates_can_retry_without_metadata_drift(self):
        for status in ("UPDATE_UNSUCCESSFUL", "SYNCHRONIZE_UNSUCCESSFUL"):
            with self.subTest(status=status):
                ctrl, statuses = _run(_deployed(_SCHEMA_NEW),
                                      _target(_deployed(_SCHEMA_NEW), status=status))
                ctrl.update_gateway_target.assert_called_once()
                self.assertIn("UPDATED", statuses)


def _gateway(description="new text", **changes):
    return {"name": "awsops-v2-ops-gateway", "gatewayId": "gw-ops", "status": "READY",
            "description": description, "roleArn": "arn:aws:iam::1:role/r",
            "protocolType": "MCP", "authorizerType": "NONE", **changes}


def _run_gateways(deployed_description, **changes):
    """ensure_gateways with one existing gateway whose live description is as given."""
    ctrl = mock.Mock()
    ctrl.list_gateways.return_value = {"items": [{
        "name": "awsops-v2-ops-gateway", "gatewayId": "gw-ops",
        "description": deployed_description}]}
    ctrl.get_gateway.return_value = _gateway(deployed_description, **changes)
    def updated_gateway(**request):
        ctrl.get_gateway.return_value = {**ctrl.get_gateway.return_value, **request, "status": "READY"}
        return {"gatewayId": "gw-ops"}
    ctrl.update_gateway.side_effect = updated_gateway
    provision.report.clear()
    with mock.patch.object(provision.catalog, "GATEWAYS", ["ops"]), \
         mock.patch.object(provision.catalog, "GATEWAY_DESCRIPTIONS", {"ops": "new text"}):
        ids = provision.ensure_gateways(ctrl, {"role_arn": "arn:aws:iam::1:role/r"})
    return ctrl, ids, {r[1] for r in provision.report}


class TestGatewayDescriptionDrift(unittest.TestCase):
    """PR #246 review: a catalog GATEWAY_DESCRIPTIONS edit must converge onto an already-live
    gateway — previously the description was only applied at create_gateway, so the live ops
    gateway kept advertising "Steampipe SQL ..." after the catalog was fixed."""

    def test_stale_description_is_drift(self):
        ctrl, ids, statuses = _run_gateways("Steampipe SQL listing/status/docs/inventory")
        self.assertIn("UPDATED", statuses)
        ctrl.update_gateway.assert_called_once()
        kw = ctrl.update_gateway.call_args.kwargs
        self.assertEqual("new text", kw["description"])
        # Must send exactly the same required identity/config fields create_gateway uses —
        # never invent different values that could clobber the live gateway.
        self.assertEqual("awsops-v2-ops-gateway", kw["name"])
        self.assertEqual("MCP", kw["protocolType"])
        self.assertEqual("NONE", kw["authorizerType"])
        self.assertEqual({"ops": "gw-ops"}, ids)

    def test_matching_description_is_not_drift(self):
        ctrl, ids, statuses = _run_gateways("new text")
        self.assertEqual({"EXISTS"}, statuses)
        ctrl.update_gateway.assert_not_called()
        self.assertEqual({"ops": "gw-ops"}, ids)

    def test_rejected_cosmetic_update_does_not_fail_ready_gateway(self):
        ctrl = mock.Mock()
        ctrl.list_gateways.return_value = {"items": [{
            "name": "awsops-v2-ops-gateway", "gatewayId": "gw-ops", "description": "stale"}]}
        ctrl.get_gateway.return_value = _gateway("stale")
        ctrl.update_gateway.side_effect = provision.ClientError(
            {"Error": {"Code": "AccessDenied", "Message": "no"}}, "UpdateGateway")
        provision.report.clear()
        with mock.patch.object(provision.catalog, "GATEWAYS", ["ops"]), \
             mock.patch.object(provision.catalog, "GATEWAY_DESCRIPTIONS", {"ops": "new text"}):
            ids = provision.ensure_gateways(ctrl, {"role_arn": "arn:aws:iam::1:role/r"})
        # Cosmetic convergence: the gateway id is still returned so provisioning continues.
        self.assertEqual({"ops": "gw-ops"}, ids)
        # And it must be WARN, not ERR — main() exits 1 on any ERR in the report, which would
        # fail `make agentcore` over a label (the exact regression the stop-hook caught).
        statuses = {r[1] for r in provision.report}
        self.assertIn("WARN", statuses)
        self.assertNotIn("ERR", statuses)

    def test_role_drift_reconciles_even_when_description_matches(self):
        ctrl, ids, statuses = _run_gateways("new text", roleArn="arn:aws:iam::1:role/old")
        self.assertIn("UPDATED", statuses)
        self.assertEqual(ctrl.update_gateway.call_args.kwargs["roleArn"], "arn:aws:iam::1:role/r")
        self.assertEqual(ids, {"ops": "gw-ops"})
        self.assertGreaterEqual(ctrl.get_gateway.call_count, 2)

    def test_existing_auth_protocol_and_security_settings_are_preserved(self):
        settings = {
            "authorizerType": "CUSTOM_JWT",
            "authorizerConfiguration": {"customJWTAuthorizer": {
                "discoveryUrl": "https://issuer.example.test/.well-known/openid-configuration",
                "allowedAudience": ["fixture-audience"]}},
            "protocolConfiguration": {"mcp": {"supportedVersions": ["2025-03-26"]}},
            "kmsKeyArn": "arn:aws:kms:x:1:key/fixture",
            "exceptionLevel": "DEBUG",
            "policyEngineConfiguration": {"arn": "arn:fixture:policy", "mode": "ENFORCE"},
            "interceptorConfigurations": [{"interceptionPoints": ["REQUEST"],
                                          "interceptor": {"lambda": {"arn": "arn:fixture:interceptor"}}}],
        }
        original = copy.deepcopy(settings)
        ctrl, _, statuses = _run_gateways("stale", **settings)
        self.assertIn("UPDATED", statuses)
        for key, value in original.items():
            self.assertEqual(ctrl.update_gateway.call_args.kwargs[key], value, key)
        self.assertEqual(settings, original)
        ctrl, _, _ = _run_gateways("stale", authorizerType="AWS_IAM")
        self.assertEqual(ctrl.update_gateway.call_args.kwargs["authorizerType"], "AWS_IAM")

    def test_missing_existing_auth_never_defaults_to_none(self):
        ctrl, ids, statuses = _run_gateways("stale", authorizerType=None)
        ctrl.update_gateway.assert_not_called()
        self.assertIn("ERR", statuses)
        self.assertEqual(ids, {})

    def test_role_update_failure_blocks_dependent_gateway_id(self):
        ctrl = mock.Mock()
        ctrl.list_gateways.return_value = {"items": [_gateway(roleArn="arn:aws:iam::1:role/old")]}
        ctrl.get_gateway.return_value = _gateway(roleArn="arn:aws:iam::1:role/old")
        ctrl.update_gateway.side_effect = provision.ClientError(
            {"Error": {"Code": "ConflictException", "Message": "SECRET_SENTINEL"}}, "UpdateGateway")
        provision.report.clear()
        with mock.patch.object(provision.catalog, "GATEWAYS", ["ops"]):
            ids = provision.ensure_gateways(ctrl, {"role_arn": "arn:aws:iam::1:role/r"})
        self.assertEqual(ids, {})
        self.assertIn("ERR", {row[1] for row in provision.report})

    def test_failed_gateway_does_not_receive_target_work(self):
        ctrl, ids, statuses = _run_gateways("new text", status="FAILED")
        ctrl.update_gateway.assert_not_called()
        self.assertEqual(ids, {})
        self.assertIn("ERR", statuses)

    def test_gateway_waits_for_updated_role_not_an_old_ready_snapshot(self):
        old = _gateway(roleArn="arn:old")
        ctrl = mock.Mock()
        ctrl.list_gateways.return_value = {"items": [old]}
        ctrl.get_gateway.side_effect = [old, old, _gateway()]
        provision.report.clear()
        with mock.patch.object(provision.catalog, "GATEWAYS", ["ops"]), \
             mock.patch.object(provision.catalog, "GATEWAY_DESCRIPTIONS", {"ops": "new text"}), \
             mock.patch.object(provision.time, "sleep") as sleep:
            ids = provision.ensure_gateways(ctrl, {"role_arn": "arn:aws:iam::1:role/r"})
        self.assertEqual(ids, {"ops": "gw-ops"})
        self.assertEqual(ctrl.get_gateway.call_count, 3)
        sleep.assert_called_once()

    def test_unsuccessful_gateway_update_can_retry_without_metadata_drift(self):
        ctrl, ids, statuses = _run_gateways("new text", status="UPDATE_UNSUCCESSFUL",
                                          authorizerType="AWS_IAM")
        ctrl.update_gateway.assert_called_once()
        self.assertEqual(ctrl.update_gateway.call_args.kwargs["authorizerType"], "AWS_IAM")
        self.assertEqual(ids, {"ops": "gw-ops"})
        self.assertIn("UPDATED", statuses)

    def test_rejected_recovery_is_an_error_even_when_role_matches(self):
        ctrl = mock.Mock()
        ctrl.list_gateways.return_value = {"items": [_gateway(status="UPDATE_UNSUCCESSFUL")]}
        ctrl.get_gateway.return_value = _gateway(status="UPDATE_UNSUCCESSFUL")
        ctrl.update_gateway.side_effect = provision.ClientError(
            {"Error": {"Code": "ValidationException", "Message": "SECRET_SENTINEL"}}, "UpdateGateway")
        provision.report.clear()
        with mock.patch.object(provision.catalog, "GATEWAYS", ["ops"]), \
             mock.patch.object(provision.catalog, "GATEWAY_DESCRIPTIONS", {"ops": "new text"}):
            ids = provision.ensure_gateways(ctrl, {"role_arn": "arn:aws:iam::1:role/r"})
        ctrl.update_gateway.assert_called_once()
        self.assertEqual(ids, {})
        self.assertIn("ERR", {row[1] for row in provision.report})


class TestTypedProvisionErrors(unittest.TestCase):
    def test_target_errors_preserve_safe_codes_without_messages(self):
        for error_code, expected in (
            ("ValidationException", "aws_validation_failed"),
            ("ConflictException", "aws_conflict"),
            ("ResourceNotFoundException", "aws_resource_not_found"),
        ):
            with self.subTest(error_code=error_code):
                ctrl = mock.Mock()
                ctrl.list_gateway_targets.return_value = {"items": []}
                ctrl.create_gateway_target.side_effect = provision.ClientError(
                    {"Error": {"Code": error_code, "Message": "SECRET_SENTINEL"}}, "CreateGatewayTarget")
                output = io.StringIO()
                with mock.patch.object(provision.catalog, "TARGETS", _TARGETS), redirect_stdout(output):
                    provision.diagnostics.reset()
                    provision.ensure_targets(ctrl, {"lambda_arns": {"rds-mcp": "arn:fixture:lambda"}},
                                             {"data": "gw-1"})
                records = [json.loads(line) for line in output.getvalue().splitlines()]
                self.assertEqual(records[-1]["code"], expected)
                self.assertNotIn("SECRET_SENTINEL", output.getvalue())

    def test_sdk_validation_error_does_not_print_request_parameters(self):
        from botocore.exceptions import ParamValidationError
        ctrl = mock.Mock()
        ctrl.list_gateway_targets.return_value = {"items": []}
        ctrl.create_gateway_target.side_effect = ParamValidationError(report="SECRET_SENTINEL")
        output = io.StringIO()
        with mock.patch.object(provision.catalog, "TARGETS", _TARGETS), redirect_stdout(output):
            provision.diagnostics.reset()
            provision.ensure_targets(ctrl, {"lambda_arns": {"rds-mcp": "arn:fixture:lambda"}},
                                     {"data": "gw-1"})
        self.assertEqual(json.loads(output.getvalue().splitlines()[-1])["code"], "sdk_validation_failed")
        self.assertNotIn("SECRET_SENTINEL", output.getvalue())


class TestReadinessFlag(unittest.TestCase):
    def test_runtime_flag_comes_only_from_applied_boolean(self):
        ac = {"region": "ap-northeast-2", "role_arn": "arn:aws:iam::123456789012:role/fixture",
              "ecr_uri": "fixture.example.test/agent"}
        for value in (None, False, "true", 1, True):
            ctrl = mock.Mock()
            ctrl.list_agent_runtimes.return_value = {"agentRuntimes": []}
            ctrl.create_agent_runtime.return_value = {"agentRuntimeId": "fixture", "agentRuntimeArn": "fixture"}
            with mock.patch.dict(os.environ, {"DEPLOYMENT_READINESS_ENABLED": "true"}), \
                 mock.patch.object(provision, "_wait_runtime_ready", return_value=True):
                provision.ensure_runtime(ctrl, {**ac, "deployment_readiness_enabled": value}, {})
            env = ctrl.create_agent_runtime.call_args.kwargs["environmentVariables"]
            self.assertEqual(env["DEPLOYMENT_READINESS_ENABLED"], "true" if value is True else "false")


if __name__ == "__main__":
    unittest.main()
