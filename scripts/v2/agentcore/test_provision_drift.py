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


def _target(deployed_tools):
    return {
        "targetConfiguration": {"mcp": {"lambda": {
            "lambdaArn": "arn:aws:lambda:x:1:function:f",
            "toolSchema": {"inlinePayload": deployed_tools}}}},
        "credentialProviderConfigurations": [{"credentialProviderType": "GATEWAY_IAM_ROLE"}],
    }


def _run(deployed_tools, current=None):
    ctrl = mock.Mock()
    ctrl.list_gateway_targets.return_value = {
        "items": [{"name": "rds-mcp-target", "targetId": "t-1"}]}
    ctrl.get_gateway_target.return_value = current or _target(deployed_tools)
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

    def test_lambda_arn_drift_updates_with_unchanged_schema(self):
        current = _target(_deployed(_SCHEMA_NEW))
        current["targetConfiguration"]["mcp"]["lambda"]["lambdaArn"] = "arn:old"
        ctrl, statuses = _run(_deployed(_SCHEMA_NEW), current)
        self.assertIn("UPDATED", statuses)
        self.assertEqual(ctrl.update_gateway_target.call_args.kwargs["targetConfiguration"]["mcp"]["lambda"]["lambdaArn"],
                         "arn:aws:lambda:x:1:function:f")

    def test_credential_type_drift_updates_but_echoed_defaults_do_not(self):
        for kind in ("API_KEY", "GATEWAY_IAM_ROLE"):
            current = _target(_deployed(_SCHEMA_NEW))
            current["credentialProviderConfigurations"] = [
                {"credentialProviderType": kind, "credentialProvider": {}, "serviceEcho": None}]
            ctrl, statuses = _run(_deployed(_SCHEMA_NEW), current)
            self.assertEqual(statuses, {"UPDATED" if kind == "API_KEY" else "EXISTS"})

    def test_optional_target_metadata_is_preserved_on_update(self):
        current = _target(_deployed(_SCHEMA_OLD))
        current["metadataConfiguration"] = {"allowedRequestHeaders": ["x-correlation-id"]}
        ctrl, _ = _run(_deployed(_SCHEMA_NEW), current)
        self.assertEqual(ctrl.update_gateway_target.call_args.kwargs["metadataConfiguration"],
                         current["metadataConfiguration"])

    def test_failed_target_with_drift_keeps_baseline_update_path_without_recreation(self):
        current = _target(_deployed(_SCHEMA_OLD))
        current["status"] = "FAILED"
        ctrl, statuses = _run(_deployed(_SCHEMA_NEW), current)
        self.assertEqual(statuses, {"UPDATED"})  # request accepted, not a READY assertion
        ctrl.update_gateway_target.assert_called_once()
        ctrl.delete_gateway_target.assert_not_called()
        ctrl.create_gateway_target.assert_not_called()


def _gateway(description, **fields):
    return {"name": "awsops-v2-ops-gateway", "gatewayId": "gw-ops", "description": description,
            "roleArn": "arn:aws:iam::1:role/r", "authorizerType": "NONE", "protocolType": "MCP", **fields}


def _run_gateways(deployed_description, **fields):
    """ensure_gateways with one existing gateway whose live description is as given."""
    ctrl = mock.Mock()
    ctrl.list_gateways.return_value = {"items": [{
        "name": "awsops-v2-ops-gateway", "gatewayId": "gw-ops",
        "description": deployed_description}]}
    ctrl.get_gateway.return_value = _gateway(deployed_description, **fields)
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

    def test_update_failure_never_fails_the_run(self):
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

    def test_matching_description_does_not_hide_role_drift(self):
        ctrl, ids, statuses = _run_gateways("new text", roleArn="arn:old")
        self.assertEqual(ids, {"ops": "gw-ops"})
        self.assertIn("UPDATED", statuses)
        self.assertEqual(ctrl.update_gateway.call_args.kwargs["roleArn"], "arn:aws:iam::1:role/r")

    def test_existing_auth_protocol_and_security_settings_are_preserved(self):
        fields = {
            "authorizerType": "CUSTOM_JWT",
            "authorizerConfiguration": {"customJWTAuthorizer": {
                "discoveryUrl": "https://issuer.example.test/.well-known/openid-configuration",
                "allowedAudience": ["fixture"]}},
            "protocolConfiguration": {"mcp": {"supportedVersions": ["2025-03-26"]}},
            "kmsKeyArn": "arn:fixture:key", "exceptionLevel": "DEBUG",
            "policyEngineConfiguration": {"arn": "arn:fixture:policy", "mode": "ENFORCE"},
            "interceptorConfigurations": [{"interceptionPoints": ["REQUEST"],
                                          "interceptor": {"lambda": {"arn": "arn:fixture:lambda"}}}],
        }
        original = copy.deepcopy(fields)
        ctrl, _, _ = _run_gateways("stale", **fields)
        for key, value in original.items():
            self.assertEqual(ctrl.update_gateway.call_args.kwargs[key], value)
        self.assertEqual(fields, original)
        ctrl, _, _ = _run_gateways("stale", authorizerType="AWS_IAM", protocolType=None)
        self.assertEqual(ctrl.update_gateway.call_args.kwargs["authorizerType"], "AWS_IAM")
        self.assertNotIn("protocolType", ctrl.update_gateway.call_args.kwargs)

    def test_unreadable_authorizer_never_defaults_to_none_or_loses_known_id(self):
        ctrl, ids, statuses = _run_gateways("stale", roleArn="arn:old", authorizerType=None)
        ctrl.update_gateway.assert_not_called()
        self.assertEqual(ids, {"ops": "gw-ops"})
        self.assertIn("ERR", statuses)


class TestTypedErrors(unittest.TestCase):
    def test_target_errors_expose_only_fixed_typed_codes(self):
        from botocore.exceptions import ParamValidationError
        cases = [(provision.ClientError({"Error": {"Code": code, "Message": "SECRET_SENTINEL"}},
                                       "CreateGatewayTarget"), expected)
                 for code, expected in (("ValidationException", "aws_validation_failed"),
                                        ("ConflictException", "aws_conflict"),
                                        ("ResourceNotFoundException", "aws_resource_not_found"))]
        cases.append((ParamValidationError(report="SECRET_SENTINEL"), "sdk_validation_failed"))
        for error, expected in cases:
            ctrl = mock.Mock()
            ctrl.list_gateway_targets.return_value = {"items": []}
            ctrl.create_gateway_target.side_effect = error
            output = io.StringIO()
            with mock.patch.object(provision.catalog, "TARGETS", _TARGETS), redirect_stdout(output):
                provision.diagnostics.reset()
                provision.ensure_targets(ctrl, {"lambda_arns": {"rds-mcp": "arn:fixture:lambda"}},
                                         {"data": "gw-1"})
            self.assertEqual(json.loads(output.getvalue().splitlines()[-1])["code"], expected)
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
