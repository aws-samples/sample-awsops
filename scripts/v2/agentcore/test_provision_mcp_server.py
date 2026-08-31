"""ADR-017: regression for provision.ensure_mcp_server_targets.

Same discipline as test_provision_skip.py — a SKIP-worthy state (no endpoints configured, no
stored credential) must never surface as ERR, or a perfectly valid flag-off/not-yet-onboarded
config would make `make agentcore` fail.

Also covers the fixes from the 2026-07-31 kiro review of PR #194:
  - CRITICAL: disabling a preset (flag off / endpoint removed) must RETIRE (delete) any target +
    credential provider a prior run left live, not just stop touching them.
  - CRITICAL: a live legacy lambda target for the same kind must be deleted before the mcpServer
    target is created — checking `lambda_arns` (tf config) alone can't see a leftover target
    object from a prior run.
  - WARNING: a malformed stored credential (not a dict) must SKIP, not crash the whole run.
  - WARNING: a credential-provider wiring change (location/param/prefix) with an unchanged
    endpoint must still be detected as drift and trigger an update.

Runs with `python3 -m unittest test_provision_mcp_server` (no network/boto3 control-plane
calls in the SKIP paths).
"""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import provision  # noqa: E402

_DATADOG_PRESET = {
    "datadog-mcp-server-target": {
        "gateway": "external-obs",
        "preset_key": "datadog",
        "description": "Datadog official MCP",
        # Mirrors the real catalog entry: vendor-hosted, so the host is pinned. Without one of the
        # two host-pin keys _host_pin_violation fails closed (a catalog entry that declares neither
        # is a bug), which is exactly what we want in production but would break every test here.
        "allowed_host_suffixes": (".datadoghq.com", ".datadoghq.eu", ".ddog-gov.com"),
        "auth": {"mode": "api_key", "credential_location": "HEADER", "credential_parameter_name": "Authorization", "credential_prefix": "Bearer "},
    }
}

_CLICKHOUSE_PRESET = {
    "clickhouse-mcp-server-target": {
        "gateway": "external-obs",
        "preset_key": "clickhouse",
        "description": "ClickHouse official MCP",
        # Mirrors the real catalog entry: self-hosted, so the host is operator-asserted.
        "host_is_operator_asserted": True,
        "auth": {"mode": "api_key", "credential_location": "HEADER", "credential_parameter_name": "Authorization", "credential_prefix": "Bearer "},
    }
}

_CLICKHOUSE_LAMBDA_TARGETS = {
    "clickhouse-mcp-target": {"gateway": "external-obs", "lambda_key": "clickhouse-mcp", "description": "", "tools": []},
}


def _ctrl_with_targets(targets_by_gw=None):
    """A Mock() ctrl whose list_gateway_targets returns the given {gw_id: [target,...]} map in the
    shape provision._list_all expects (an 'items' key). get_gateway_target returns a pre-existing
    target's full body (including credentialProviderConfigurations) by targetId, defaulting
    status to READY unless the test set one — including for a NEWLY CREATED targetId (not in the
    initial map), so _wait_target_ready's poll succeeds immediately by default in every test that
    doesn't specifically exercise the not-ready/failed path."""
    targets_by_gw = targets_by_gw or {}
    ctrl = mock.Mock()
    ctrl.list_gateway_targets.side_effect = lambda gatewayIdentifier, **_kw: {"items": targets_by_gw.get(gatewayIdentifier, [])}
    by_id = {t["targetId"]: t for ts in targets_by_gw.values() for t in ts}

    def _get_gateway_target(gatewayIdentifier, targetId):
        t = by_id.get(targetId, {})
        return {**t, "status": t.get("status", "READY")}
    ctrl.get_gateway_target.side_effect = _get_gateway_target
    return ctrl


class _IsolatedProvisionTest(unittest.TestCase):
    """Base for tests that patch MCP_SERVER_TARGETS to a single synthetic preset. The REAL
    RETIRED_MCP_SERVER_TARGETS tombstones fire on every ensure_mcp_server_targets() call, so without
    neutralizing them here their 5 provider deletes leak into every `assert_called_once_with` in this
    file. Tombstone behaviour itself is covered by TestRetiredCatalogEntries, which patches the list
    to the entry it is actually testing."""

    def setUp(self):
        provision.report.clear()
        patcher = mock.patch.object(provision.catalog, "RETIRED_MCP_SERVER_TARGETS", ())
        patcher.start()
        self.addCleanup(patcher.stop)


class TestEnsureMcpServerTargets(_IsolatedProvisionTest):
    def test_no_endpoints_configured_is_skip_not_err(self):
        ctrl = _ctrl_with_targets()
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _DATADOG_PRESET):
            provision.ensure_mcp_server_targets(ctrl, {"official_mcp_endpoints": {}, "lambda_arns": {}, "region": "ap-northeast-2"}, {"external-obs": "gw-1"})
        self.assertIn("SKIP", {r[1] for r in provision.report})
        self.assertEqual([r for r in provision.report if r[1] == "ERR"], [])
        ctrl.create_gateway_target.assert_not_called()

    def test_endpoint_configured_but_no_credential_is_skip(self):
        ctrl = _ctrl_with_targets()
        ac = {"official_mcp_endpoints": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "lambda_arns": {}, "region": "ap-northeast-2", "integrations_secret_name": None}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _DATADOG_PRESET):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"})
        self.assertIn("SKIP", {r[1] for r in provision.report})
        self.assertEqual([r for r in provision.report if r[1] == "ERR"], [])
        ctrl.create_gateway_target.assert_not_called()

    def test_conflicting_lambda_in_tf_config_is_warn_not_err(self):
        # datadog was never a lambda TARGETS entry (legacy_target_name -> None), so the tf-config
        # check is purely informational here: it must WARN, never ERR/block, and must not crash.
        # The WARN check only runs once the preset is ACTIVE (endpoint + credential present) — an
        # inactive preset never reaches it (it's retired/skipped first) — so a credential must be
        # stored for this scenario to exercise the check at all.
        ctrl = _ctrl_with_targets()
        ctrl.get_api_key_credential_provider.return_value = {"credentialProviderArn": "arn:provider"}
        ctrl.create_gateway_target.return_value = {"targetId": "t-1"}
        ac = {"official_mcp_endpoints": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "official_mcp_read_only_ack": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "lambda_arns": {"datadog-mcp": "arn:aws:lambda:...:function:x-agent-datadog-mcp"},
              "region": "ap-northeast-2", "integrations_secret_name": "sec"}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _DATADOG_PRESET), \
             mock.patch.object(provision, "_load_official_mcp_secret", return_value=({"mcp:datadog": {"token": "tok"}}, True)):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"})
        self.assertIn("WARN", {r[1] for r in provision.report})
        self.assertEqual([r for r in provision.report if r[1] == "ERR"], [])

    def test_disabling_preset_retires_existing_target_and_credential_provider(self):
        # CRITICAL #1 regression: a target from a prior run exists; the endpoint is now gone
        # (flag off or removed from official_mcp_endpoints) — it must be DELETED, not left live.
        ctrl = _ctrl_with_targets({"gw-1": [{"name": "datadog-mcp-server-target", "targetId": "t-1"}]})
        ac = {"official_mcp_endpoints": {}, "lambda_arns": {}, "region": "ap-northeast-2", "integrations_secret_name": None}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _DATADOG_PRESET):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"})
        ctrl.delete_gateway_target.assert_called_once_with(gatewayIdentifier="gw-1", targetId="t-1")
        ctrl.delete_api_key_credential_provider.assert_called_once_with(name="awsops-v2-datadog-mcp")
        self.assertIn("RETIRED", {r[1] for r in provision.report})

    def test_live_legacy_lambda_target_is_deleted_before_cutover(self):
        # CRITICAL #2 regression: clickhouse-mcp-target (the OLD lambda target) is still LIVE on
        # external-obs even though lambda_arns no longer has clickhouse-mcp (tf already applied the
        # removal) — the live object, not the tf config, is what must gate/trigger cleanup. It must
        # be deleted before the new mcpServer target is created, so the two can never coexist.
        ctrl = _ctrl_with_targets({"gw-1": [{"name": "clickhouse-mcp-target", "targetId": "t-legacy"}]})
        ctrl.get_api_key_credential_provider.side_effect = _raise_not_found
        ctrl.create_api_key_credential_provider.return_value = {"credentialProviderArn": "arn:provider"}
        ctrl.create_gateway_target.return_value = {"targetId": "t-new"}
        ac = {"official_mcp_endpoints": {"clickhouse": "https://10.0.3.7:8123/mcp"},
              # self-hosted presets must be provably in-VPC (ADR-017): a private IP literal needs no
              # suffix declaration and no DNS, so it is the simplest valid form for a test.
                            "official_mcp_read_only_ack": {"clickhouse": "https://10.0.3.7:8123/mcp"},
              "lambda_arns": {}, "region": "ap-northeast-2", "integrations_secret_name": "sec"}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _CLICKHOUSE_PRESET), \
             mock.patch.object(provision.catalog, "TARGETS", _CLICKHOUSE_LAMBDA_TARGETS), \
             mock.patch.object(provision.catalog, "_LAMBDA_KEY_BY_PRESET", {"clickhouse": "clickhouse-mcp"}), \
             mock.patch.object(provision, "_load_official_mcp_secret", return_value=({"mcp:clickhouse": {"token": "tok"}}, True)):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"})
        ctrl.delete_gateway_target.assert_called_once_with(gatewayIdentifier="gw-1", targetId="t-legacy")
        ctrl.create_gateway_target.assert_called_once()
        self.assertIn(("target:clickhouse-mcp-target", "RETIRED"), [(r[0], r[1]) for r in provision.report])
        self.assertIn(("target:clickhouse-mcp-server-target", "CREATED"), [(r[0], r[1]) for r in provision.report])

    def test_malformed_secret_value_does_not_crash(self):
        # WARNING #1 regression: a stored credential that is a string (not a dict) must SKIP the
        # preset, not raise AttributeError and abort the whole provisioner run.
        ctrl = _ctrl_with_targets()
        ac = {"official_mcp_endpoints": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "official_mcp_read_only_ack": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "lambda_arns": {}, "region": "ap-northeast-2", "integrations_secret_name": "sec"}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _DATADOG_PRESET), \
             mock.patch.object(provision, "_load_official_mcp_secret", return_value=({"mcp:datadog": "not-a-dict"}, True)):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"})  # must not raise
        self.assertIn("SKIP", {r[1] for r in provision.report})
        self.assertEqual([r for r in provision.report if r[1] == "ERR"], [])
        ctrl.create_gateway_target.assert_not_called()

    def test_credential_provider_drift_triggers_update_even_with_unchanged_endpoint(self):
        # WARNING #2 regression: endpoint is unchanged but the credential-provider wiring (e.g.
        # catalog.py's credential_parameter_name) differs from what's live — must still UPDATE.
        live_target = {
            "name": "datadog-mcp-server-target", "targetId": "t-1",
            "targetConfiguration": {"mcp": {"mcpServer": {"endpoint": "https://mcp.datadoghq.com/v1/mcp"}}},
            "credentialProviderConfigurations": [{
                "credentialProviderType": "API_KEY",
                "credentialProvider": {"apiKeyCredentialProvider": {
                    "providerArn": "arn:provider", "credentialLocation": "HEADER",
                    "credentialParameterName": "X-Api-Key", "credentialPrefix": "",  # stale wiring
                }},
            }],
            "description": "Datadog official MCP",
        }
        ctrl = _ctrl_with_targets({"gw-1": [live_target]})
        ctrl.get_api_key_credential_provider.side_effect = None
        ctrl.get_api_key_credential_provider.return_value = {"credentialProviderArn": "arn:provider"}
        ac = {"official_mcp_endpoints": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "official_mcp_read_only_ack": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "lambda_arns": {}, "region": "ap-northeast-2", "integrations_secret_name": "sec"}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _DATADOG_PRESET), \
             mock.patch.object(provision, "_load_official_mcp_secret", return_value=({"mcp:datadog": {"token": "tok"}}, True)):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"})
        ctrl.update_gateway_target.assert_called_once()
        self.assertIn(("target:datadog-mcp-server-target", "UPDATED"), [(r[0], r[1]) for r in provision.report])

    def test_recreated_provider_with_unchanged_wiring_is_still_drift(self):
        # WARNING (2026-07-31 follow-up) regression: the live target's credentialProviderConfigurations
        # references an OLD providerArn (e.g. the provider was deleted+recreated by a prior retire/
        # re-enable cycle) even though location/param/prefix are unchanged. Comparing only the header
        # wiring (not providerArn) would call this "no drift" and leave the target bound to a
        # nonexistent provider — must still UPDATE.
        live_target = {
            "name": "datadog-mcp-server-target", "targetId": "t-1",
            "targetConfiguration": {"mcp": {"mcpServer": {"endpoint": "https://mcp.datadoghq.com/v1/mcp"}}},
            "credentialProviderConfigurations": [{
                "credentialProviderType": "API_KEY",
                "credentialProvider": {"apiKeyCredentialProvider": {
                    "providerArn": "arn:provider-OLD-STALE", "credentialLocation": "HEADER",
                    "credentialParameterName": "Authorization", "credentialPrefix": "Bearer ",
                }},
            }],
            "description": "Datadog official MCP",
        }
        ctrl = _ctrl_with_targets({"gw-1": [live_target]})
        ctrl.get_api_key_credential_provider.return_value = {"credentialProviderArn": "arn:provider-NEW"}
        ac = {"official_mcp_endpoints": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "official_mcp_read_only_ack": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "lambda_arns": {}, "region": "ap-northeast-2", "integrations_secret_name": "sec"}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _DATADOG_PRESET), \
             mock.patch.object(provision, "_load_official_mcp_secret", return_value=({"mcp:datadog": {"token": "tok"}}, True)):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"})
        ctrl.update_gateway_target.assert_called_once()
        updated_creds = ctrl.update_gateway_target.call_args.kwargs["credentialProviderConfigurations"]
        self.assertEqual(updated_creds[0]["credentialProvider"]["apiKeyCredentialProvider"]["providerArn"], "arn:provider-NEW")

    def test_missing_credential_retires_a_previously_live_target_not_just_skips(self):
        # CRITICAL #2 (2026-07-31 follow-up) regression: endpoint stays configured but the stored
        # credential disappeared (rotated out / cleared) — a PRIOR run's target + provider are still
        # live. Must be retired, not left running with a stale/unverifiable credential.
        ctrl = _ctrl_with_targets({"gw-1": [{"name": "datadog-mcp-server-target", "targetId": "t-1"}]})
        ac = {"official_mcp_endpoints": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "official_mcp_read_only_ack": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "lambda_arns": {}, "region": "ap-northeast-2", "integrations_secret_name": "sec"}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _DATADOG_PRESET), \
             mock.patch.object(provision, "_load_official_mcp_secret", return_value=({}, True)):  # credential gone
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"})
        ctrl.delete_gateway_target.assert_called_once_with(gatewayIdentifier="gw-1", targetId="t-1")
        ctrl.delete_api_key_credential_provider.assert_called_once_with(name="awsops-v2-datadog-mcp")
        ctrl.create_gateway_target.assert_not_called()

    def test_legacy_target_is_retired_only_after_new_target_confirmed_created_not_before(self):
        # CRITICAL #1 (2026-07-31 follow-up) regression: the ORIGINAL fix deleted the legacy lambda
        # target BEFORE creating the new one — a create failure then left NEITHER target live
        # (outage). The new target must be confirmed CREATED/UPDATED/EXISTS first; only then may the
        # legacy target be retired.
        ctrl = _ctrl_with_targets({"gw-1": [{"name": "clickhouse-mcp-target", "targetId": "t-legacy"}]})
        ctrl.get_api_key_credential_provider.side_effect = _raise_not_found
        ctrl.create_api_key_credential_provider.return_value = {"credentialProviderArn": "arn:provider"}
        from botocore.exceptions import ClientError
        ctrl.create_gateway_target.side_effect = ClientError(
            {"Error": {"Code": "ValidationException", "Message": "boom"}}, "CreateGatewayTarget")
        ac = {"official_mcp_endpoints": {"clickhouse": "https://10.0.3.7:8123/mcp"},
              # self-hosted presets must be provably in-VPC (ADR-017): a private IP literal needs no
              # suffix declaration and no DNS, so it is the simplest valid form for a test.
                            "official_mcp_read_only_ack": {"clickhouse": "https://10.0.3.7:8123/mcp"},
              "lambda_arns": {}, "region": "ap-northeast-2", "integrations_secret_name": "sec"}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _CLICKHOUSE_PRESET), \
             mock.patch.object(provision.catalog, "TARGETS", _CLICKHOUSE_LAMBDA_TARGETS), \
             mock.patch.object(provision.catalog, "_LAMBDA_KEY_BY_PRESET", {"clickhouse": "clickhouse-mcp"}), \
             mock.patch.object(provision, "_load_official_mcp_secret", return_value=({"mcp:clickhouse": {"token": "tok"}}, True)):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"})
        # The new target creation failed — the legacy target must NOT have been deleted, or the
        # kind would be unavailable through EITHER path.
        ctrl.delete_gateway_target.assert_not_called()
        self.assertIn(("target:clickhouse-mcp-server-target", "ERR"), [(r[0], r[1]) for r in provision.report])
        self.assertNotIn("RETIRED", {r[1] for r in provision.report})

    def test_secret_read_failure_does_not_retire_a_live_target(self):
        # CRITICAL (2026-07-31 second follow-up) regression: the credentials secret READ itself
        # failed (transient Secrets Manager error / malformed JSON) — must NOT be treated the same
        # as "credential intentionally removed" (which retires a live target). A transient blip on
        # a routine `make agentcore` run must never mass-deprovision every configured preset.
        ctrl = _ctrl_with_targets({"gw-1": [{"name": "datadog-mcp-server-target", "targetId": "t-1"}]})
        ac = {"official_mcp_endpoints": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "official_mcp_read_only_ack": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "lambda_arns": {}, "region": "ap-northeast-2", "integrations_secret_name": "sec"}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _DATADOG_PRESET), \
             mock.patch.object(provision, "_load_official_mcp_secret", return_value=({}, False)):  # read FAILED
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"})
        ctrl.delete_gateway_target.assert_not_called()
        ctrl.delete_api_key_credential_provider.assert_not_called()
        self.assertIn("SKIP", {r[1] for r in provision.report})
        self.assertNotIn("RETIRED", {r[1] for r in provision.report})

    def test_new_target_not_yet_ready_does_not_retire_legacy_target(self):
        # CRITICAL (2026-07-31 second follow-up) regression: create_gateway_target returning 200
        # means the request was ACCEPTED, not that the target is usable yet. If it never reaches
        # READY (stuck CREATING, or a terminal FAILED status), the legacy lambda target must stay
        # live — cutover is not confirmed, so retiring the old tool would cause an outage.
        ctrl = _ctrl_with_targets({"gw-1": [{"name": "clickhouse-mcp-target", "targetId": "t-legacy"}]})
        ctrl.get_api_key_credential_provider.side_effect = _raise_not_found
        ctrl.create_api_key_credential_provider.return_value = {"credentialProviderArn": "arn:provider"}
        ctrl.create_gateway_target.return_value = {"targetId": "t-new"}
        # Override the default READY-immediately behavior: the new target reports FAILED.
        ctrl.get_gateway_target.side_effect = lambda gatewayIdentifier, targetId: (
            {"status": "FAILED"} if targetId == "t-new" else {"status": "READY"})
        ac = {"official_mcp_endpoints": {"clickhouse": "https://10.0.3.7:8123/mcp"},
              # self-hosted presets must be provably in-VPC (ADR-017): a private IP literal needs no
              # suffix declaration and no DNS, so it is the simplest valid form for a test.
                            "official_mcp_read_only_ack": {"clickhouse": "https://10.0.3.7:8123/mcp"},
              "lambda_arns": {}, "region": "ap-northeast-2", "integrations_secret_name": "sec"}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _CLICKHOUSE_PRESET), \
             mock.patch.object(provision.catalog, "TARGETS", _CLICKHOUSE_LAMBDA_TARGETS), \
             mock.patch.object(provision.catalog, "_LAMBDA_KEY_BY_PRESET", {"clickhouse": "clickhouse-mcp"}), \
             mock.patch.object(provision, "_load_official_mcp_secret", return_value=({"mcp:clickhouse": {"token": "tok"}}, True)):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"})
        ctrl.delete_gateway_target.assert_not_called()  # legacy target untouched
        self.assertNotIn("RETIRED", {r[1] for r in provision.report})
        self.assertIn(("target:clickhouse-mcp-server-target:ready", "ERR"), [(r[0], r[1]) for r in provision.report])

    def test_missing_read_only_ack_skips_and_retires_even_with_a_valid_credential(self):
        # CRITICAL (kiro review, 2026-07-31): mcpServer targets have no server-side tool
        # allowlist (unlike the Lambda targets' toolSchema.inlinePayload) — provisioning must
        # refuse to go live on read_only_note alone. Endpoint + credential are both present and
        # valid here; only the explicit official_mcp_read_only_ack is missing, and that alone must
        # be enough to refuse provisioning (and retire anything a prior, now-un-acked run left live).
        ctrl = _ctrl_with_targets({"gw-1": [{"name": "datadog-mcp-server-target", "targetId": "t-1"}]})
        ac = {"official_mcp_endpoints": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "lambda_arns": {}, "region": "ap-northeast-2", "integrations_secret_name": "sec"}
        # official_mcp_read_only_ack deliberately absent from ac.
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _DATADOG_PRESET), \
             mock.patch.object(provision, "_load_official_mcp_secret", return_value=({"mcp:datadog": {"token": "tok"}}, True)):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"})
        ctrl.create_gateway_target.assert_not_called()
        ctrl.delete_gateway_target.assert_called_once_with(gatewayIdentifier="gw-1", targetId="t-1")
        ctrl.delete_api_key_credential_provider.assert_called_once_with(name="awsops-v2-datadog-mcp")
        self.assertIn("SKIP", {r[1] for r in provision.report})
        self.assertEqual([r for r in provision.report if r[1] == "ERR"], [])

    def test_ack_bound_to_old_endpoint_is_treated_as_unacked_after_endpoint_changes(self):
        # MAJOR (round-3 review, 2026-07-31): official_mcp_read_only_ack is now map(string), the
        # acked value must equal the CURRENT endpoint. An operator acking preset X against endpoint
        # A, then repointing official_mcp_endpoints[X] at endpoint B without re-acking, must be
        # treated exactly like never having acked B — fail-closed, retire, no credential handoff to
        # the unreviewed endpoint.
        ctrl = _ctrl_with_targets({"gw-1": [{"name": "datadog-mcp-server-target", "targetId": "t-1"}]})
        # The new endpoint is a VALID vendor host (regional sibling) on purpose — an off-domain host
        # is now rejected by the host pin before the ack is consulted at all (ERR, not SKIP; see
        # test_provision_host_pin), which would stop this test isolating the ack binding it exists for.
        ac = {"official_mcp_endpoints": {"datadog": "https://mcp.datadoghq.eu/mcp"},
              "official_mcp_read_only_ack": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},  # stale ack, old endpoint
              "lambda_arns": {}, "region": "ap-northeast-2", "integrations_secret_name": "sec"}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _DATADOG_PRESET), \
             mock.patch.object(provision, "_load_official_mcp_secret", return_value=({"mcp:datadog": {"token": "tok"}}, True)):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"})
        ctrl.create_gateway_target.assert_not_called()
        ctrl.delete_gateway_target.assert_called_once_with(gatewayIdentifier="gw-1", targetId="t-1")
        ctrl.delete_api_key_credential_provider.assert_called_once_with(name="awsops-v2-datadog-mcp")
        self.assertIn("SKIP", {r[1] for r in provision.report})
        self.assertEqual([r for r in provision.report if r[1] == "ERR"], [])

    def test_matching_ack_still_provisions(self):
        # Sanity counterpart: an ack whose value equals the CURRENT endpoint is a valid ack.
        ctrl = _ctrl_with_targets()
        ctrl.get_api_key_credential_provider.side_effect = _raise_not_found
        ctrl.create_api_key_credential_provider.return_value = {"credentialProviderArn": "arn:provider"}
        ctrl.create_gateway_target.return_value = {"targetId": "t-1"}
        ac = {"official_mcp_endpoints": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "official_mcp_read_only_ack": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "lambda_arns": {}, "region": "ap-northeast-2", "integrations_secret_name": "sec"}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _DATADOG_PRESET), \
             mock.patch.object(provision, "_load_official_mcp_secret", return_value=({"mcp:datadog": {"token": "tok"}}, True)):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"})
        ctrl.create_gateway_target.assert_called_once()
        self.assertIn(("target:datadog-mcp-server-target", "CREATED"), [(r[0], r[1]) for r in provision.report])

    def test_unchanged_existing_target_still_gets_a_tools_sync_request(self):
        # MAJOR (round-3 review, 2026-07-31): synchronize_gateway_targets was only requested on the
        # CREATE/UPDATE branches — an EXISTS (no drift) target never got a sync, so a vendor adding/
        # renaming tools after the initial provision never reached the Gateway on subsequent
        # `make agentcore` runs. It must be requested on EXISTS too.
        live_target = {
            "name": "datadog-mcp-server-target", "targetId": "t-1",
            "targetConfiguration": {"mcp": {"mcpServer": {"endpoint": "https://mcp.datadoghq.com/v1/mcp"}}},
            "credentialProviderConfigurations": [{
                "credentialProviderType": "API_KEY",
                "credentialProvider": {"apiKeyCredentialProvider": {
                    "providerArn": "arn:provider", "credentialLocation": "HEADER",
                    "credentialParameterName": "Authorization", "credentialPrefix": "Bearer ",
                }},
            }],
            "description": "Datadog official MCP",
        }
        ctrl = _ctrl_with_targets({"gw-1": [live_target]})
        ctrl.get_api_key_credential_provider.return_value = {"credentialProviderArn": "arn:provider"}
        ac = {"official_mcp_endpoints": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "official_mcp_read_only_ack": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "lambda_arns": {}, "region": "ap-northeast-2", "integrations_secret_name": "sec"}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _DATADOG_PRESET), \
             mock.patch.object(provision, "_load_official_mcp_secret", return_value=({"mcp:datadog": {"token": "tok"}}, True)):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"})
        ctrl.update_gateway_target.assert_not_called()  # no drift -> EXISTS, not UPDATED
        ctrl.synchronize_gateway_targets.assert_called_once_with(gatewayIdentifier="gw-1", targetIdList=["t-1"])
        self.assertIn(("target:datadog-mcp-server-target", "EXISTS"), [(r[0], r[1]) for r in provision.report])
        self.assertIn(("target:datadog-mcp-server-target:sync", "OK"), [(r[0], r[1]) for r in provision.report])


class TestEnsureTargetsSkipsCutoverLegacy(_IsolatedProvisionTest):
    """MAJOR (kiro review, 2026-07-31): ensure_targets must not recreate a legacy lambda target
    that ensure_mcp_server_targets owns this run, or the two functions flap it into existence and
    back out on every single provisioner run."""

    def test_skip_names_prevents_recreating_an_active_presets_legacy_target(self):
        ctrl = mock.Mock()
        with mock.patch.object(provision.catalog, "TARGETS", _CLICKHOUSE_LAMBDA_TARGETS):
            provision.ensure_targets(ctrl, {"lambda_arns": {"clickhouse-mcp": "arn:lambda"}},
                                      {"external-obs": "gw-1"}, skip_names={"clickhouse-mcp-target"})
        ctrl.create_gateway_target.assert_not_called()
        ctrl.list_gateway_targets.assert_not_called()  # returns before any control-plane call
        self.assertIn("SKIP", {r[1] for r in provision.report})
        self.assertEqual([r for r in provision.report if r[1] == "ERR"], [])

    def test_main_computes_skip_names_from_an_active_acked_preset(self):
        # End-to-end of the helper main() uses: an active, acked, credentialed preset's legacy
        # target name must be in the computed skip set.
        ac = {"official_mcp_endpoints": {"clickhouse": "https://10.0.3.7:8123/mcp"},
              # self-hosted presets must be provably in-VPC (ADR-017): a private IP literal needs no
              # suffix declaration and no DNS, so it is the simplest valid form for a test.
                            "official_mcp_read_only_ack": {"clickhouse": "https://10.0.3.7:8123/mcp"}}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _CLICKHOUSE_PRESET), \
             mock.patch.object(provision.catalog, "TARGETS", _CLICKHOUSE_LAMBDA_TARGETS):
            active = provision._cutover_preset_keys(ac, {"mcp:clickhouse": {"token": "tok"}}, True)
        self.assertEqual(active, {"clickhouse"})

    def test_inactive_preset_is_not_in_skip_names(self):
        # No endpoint configured -> ensure_mcp_server_targets will SKIP it (not own its legacy
        # target this run) -> ensure_targets must be free to keep managing the legacy target as
        # normal (not in the skip set).
        ac = {"official_mcp_endpoints": {}, "official_mcp_read_only_ack": {"clickhouse": "https://10.0.3.7:8123/mcp"}}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _CLICKHOUSE_PRESET):
            active = provision._cutover_preset_keys(ac, {}, True)
        self.assertEqual(active, set())


class TestLegacyRetireCrossesGateways(_IsolatedProvisionTest):
    """MAJOR (kiro review, 2026-07-31): a legacy lambda target can live on a DIFFERENT gateway than
    the new mcpServer target for the same preset (e.g. tempo-mcp-target on 'monitoring' vs
    tempo-mcp-server-target on 'external-obs') — retire must search the legacy target's OWN
    gateway, not just the new target's gateway."""

    def test_legacy_target_on_a_different_gateway_is_still_retired(self):
        _TEMPO_PRESET = {
            "tempo-mcp-server-target": {
                "gateway": "external-obs",
                "preset_key": "tempo",
                "description": "Tempo official MCP",
                # Mirrors the real catalog entry: self-hosted, so the host is operator-asserted.
                "host_is_operator_asserted": True,
                "auth": {"mode": "api_key", "credential_location": "HEADER", "credential_parameter_name": "Authorization", "credential_prefix": "Bearer "},
            }
        }
        _TEMPO_LAMBDA_TARGETS = {
            # legacy target lives on 'monitoring', NOT 'external-obs' (the new preset's gateway) —
            # this cross-gateway mismatch is exactly what broke before this fix.
            "tempo-mcp-target": {"gateway": "monitoring", "lambda_key": "tempo-mcp", "description": "", "tools": []},
        }
        ctrl = _ctrl_with_targets({
            "gw-mon": [{"name": "tempo-mcp-target", "targetId": "t-legacy"}],
            "gw-obs": [],
        })
        ctrl.get_api_key_credential_provider.side_effect = _raise_not_found
        ctrl.create_api_key_credential_provider.return_value = {"credentialProviderArn": "arn:provider"}
        ctrl.create_gateway_target.return_value = {"targetId": "t-new"}
        ac = {"official_mcp_endpoints": {"tempo": "https://10.0.3.8:3200/api/mcp"},
              # self-hosted presets must be provably in-VPC (ADR-017): a private IP literal needs no
              # suffix declaration and no DNS, so it is the simplest valid form for a test.
                            "official_mcp_read_only_ack": {"tempo": "https://10.0.3.8:3200/api/mcp"},
              "lambda_arns": {}, "region": "ap-northeast-2", "integrations_secret_name": "sec"}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _TEMPO_PRESET), \
             mock.patch.object(provision.catalog, "TARGETS", _TEMPO_LAMBDA_TARGETS), \
             mock.patch.object(provision.catalog, "_LAMBDA_KEY_BY_PRESET", {"tempo": "tempo-mcp"}), \
             mock.patch.object(provision, "_load_official_mcp_secret", return_value=({"mcp:tempo": {"token": "tok"}}, True)):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-obs", "monitoring": "gw-mon"})
        ctrl.delete_gateway_target.assert_called_once_with(gatewayIdentifier="gw-mon", targetId="t-legacy")
        self.assertIn(("target:tempo-mcp-target", "RETIRED"), [(r[0], r[1]) for r in provision.report])


class TestRetiredCatalogEntries(unittest.TestCase):
    """MAJOR-2 (PR #207 review): a preset REMOVED from the catalog leaves its remote target and
    vendor-token credential provider live forever — the per-preset loop only reaches names still in
    MCP_SERVER_TARGETS, and prune_moved_targets() KEEPs unknown names on purpose. The tombstone list
    is what closes that, so assert the deletion, not just the absence from the catalog."""

    def setUp(self):
        provision.report.clear()

    def test_retired_catalog_entry_is_deleted_with_its_credential_provider(self):
        ctrl = _ctrl_with_targets({"gw-1": [{"name": "clickhouse-mcp-server-target", "targetId": "t-old"}]})
        ac = {"official_mcp_endpoints": {}, "lambda_arns": {}, "region": "ap-northeast-2",
              "integrations_secret_name": None}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _DATADOG_PRESET), \
             mock.patch.object(provision.catalog, "RETIRED_MCP_SERVER_TARGETS",
                               (("clickhouse-mcp-server-target", "clickhouse"),)):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"})
        ctrl.delete_gateway_target.assert_called_once_with(gatewayIdentifier="gw-1", targetId="t-old")
        ctrl.delete_api_key_credential_provider.assert_any_call(name="awsops-v2-clickhouse-mcp")
        self.assertIn(("target:clickhouse-mcp-server-target", "RETIRED"),
                      [(r[0], r[1]) for r in provision.report])

    def _run_tombstone(self, ctrl):
        ac = {"official_mcp_endpoints": {}, "lambda_arns": {}, "region": "ap-northeast-2",
              "integrations_secret_name": None}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _DATADOG_PRESET), \
             mock.patch.object(provision.catalog, "RETIRED_MCP_SERVER_TARGETS",
                               (("clickhouse-mcp-server-target", "clickhouse"),)):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"})

    def test_provider_only_state_is_still_cleaned_up(self):
        # The two objects fail INDEPENDENTLY, and provision creates the provider BEFORE the target —
        # so "provider exists, target doesn't" is reachable (failed target create, or a half-done
        # retirement). Gating the pass on the target being present would skip this forever and orphan
        # the vendor token, so the provider delete must run even with no target in sight.
        ctrl = _ctrl_with_targets({"gw-1": []})
        self._run_tombstone(ctrl)
        ctrl.delete_gateway_target.assert_not_called()
        ctrl.delete_api_key_credential_provider.assert_any_call(name="awsops-v2-clickhouse-mcp")

    def test_failed_target_delete_does_not_stop_the_provider_cleanup(self):
        # Neither delete may be conditioned on the other: a transient failure on one must not strand
        # the other. Both are idempotent, so every run re-attempts until the pair converges.
        ctrl = _ctrl_with_targets({"gw-1": [{"name": "clickhouse-mcp-server-target", "targetId": "t-old"}]})
        ctrl.delete_gateway_target.side_effect = _client_error("ThrottlingException")
        self._run_tombstone(ctrl)
        ctrl.delete_api_key_credential_provider.assert_any_call(name="awsops-v2-clickhouse-mcp")
        self.assertIn(("target:clickhouse-mcp-server-target", "ERR"),
                      [(r[0], r[1]) for r in provision.report])

    def test_fully_converged_state_is_not_an_error(self):
        # The steady state, forever after every deployment converged: both objects already gone.
        # Must be silent (no ERR) — the deletes tolerate "already gone".
        ctrl = _ctrl_with_targets({"gw-1": []})
        ctrl.delete_api_key_credential_provider.side_effect = _raise_not_found
        self._run_tombstone(ctrl)
        ctrl.delete_gateway_target.assert_not_called()
        self.assertEqual([r for r in provision.report if r[1] == "ERR"], [])

    def test_every_real_tombstone_names_a_preset_no_longer_in_the_catalog(self):
        # Guards the tombstone list itself: an entry that is STILL declared would make the
        # provisioner delete the target it is about to create, every run.
        live = {s["preset_key"] for s in provision.catalog.MCP_SERVER_TARGETS.values()}
        for tname, preset_key in provision.catalog.RETIRED_MCP_SERVER_TARGETS:
            self.assertNotIn(preset_key, live, f"{tname} is tombstoned but still declared")


class TestRound4Findings(_IsolatedProvisionTest):
    """Round-4 PR #194 review (2026-07-31)."""

    def test_blocked_endpoint_is_not_a_cutover_so_legacy_target_survives(self):
        # MAJOR L2-1: _cutover_preset_keys used to check only "endpoint present + ack matches", so a
        # blocked-but-https endpoint (terraform's ^https:// validation passes it) put the legacy
        # target in skip_names (never created) while ensure_mcp_server_targets rejected the remote
        # target — every tool for the kind vanished. Both paths now share _endpoint_blocked.
        for endpoint in ("https://127.0.0.1/mcp", "https://169.254.169.254/mcp", "https://localhost/mcp"):
            ac = {"official_mcp_endpoints": {"clickhouse": endpoint},
              # self-hosted presets must be provably in-VPC (ADR-017): a private IP literal needs no
              # suffix declaration and no DNS, so it is the simplest valid form for a test.
                                "official_mcp_read_only_ack": {"clickhouse": endpoint}}
            with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _CLICKHOUSE_PRESET), \
                 mock.patch.object(provision.catalog, "TARGETS", _CLICKHOUSE_LAMBDA_TARGETS):
                active = provision._cutover_preset_keys(ac, {"mcp:clickhouse": {"token": "tok"}}, True)
            self.assertEqual(active, set(), endpoint)

    def test_blocked_endpoint_does_not_get_a_remote_target(self):
        # The other half of L2-1: the remote target is still refused (and any leftover retired),
        # which is only safe BECAUSE the legacy target is no longer skipped (test above).
        ctrl = _ctrl_with_targets()
        ac = {"official_mcp_endpoints": {"clickhouse": "https://127.0.0.1/mcp"},
              # self-hosted presets must be provably in-VPC (ADR-017): a private IP literal needs no
              # suffix declaration and no DNS, so it is the simplest valid form for a test.
                            "official_mcp_read_only_ack": {"clickhouse": "https://127.0.0.1/mcp"},
              "lambda_arns": {}, "region": "ap-northeast-2", "integrations_secret_name": "sec"}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _CLICKHOUSE_PRESET), \
             mock.patch.object(provision.catalog, "TARGETS", _CLICKHOUSE_LAMBDA_TARGETS), \
             mock.patch.object(provision.catalog, "_LAMBDA_KEY_BY_PRESET", {"clickhouse": "clickhouse-mcp"}), \
             mock.patch.object(provision, "_load_official_mcp_secret", return_value=({"mcp:clickhouse": {"token": "tok"}}, True)):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"})
        ctrl.create_gateway_target.assert_not_called()

    def test_flag_off_still_retires_when_the_secret_read_failed(self):
        # MAJOR L2-2: the secrets-read SKIP used to sit ABOVE the teardown branches, so a Secrets
        # Manager blip left a live target + provider running after the flag was turned off — the
        # kill-switch stopped working (and ensure_targets would recreate the legacy lambda target
        # too => duplicate tool names).
        ctrl = _ctrl_with_targets({"gw-1": [{"name": "datadog-mcp-server-target", "targetId": "t-1"}]})
        ac = {"official_mcp_endpoints": {}, "lambda_arns": {},
              "region": "ap-northeast-2", "integrations_secret_name": "sec"}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _DATADOG_PRESET):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"}, secrets={}, secrets_read_ok=False)
        ctrl.delete_gateway_target.assert_called_once_with(gatewayIdentifier="gw-1", targetId="t-1")
        ctrl.delete_api_key_credential_provider.assert_called_once_with(name="awsops-v2-datadog-mcp")

    def test_revoked_ack_still_retires_when_the_secret_read_failed(self):
        # MAJOR L2-2, other explicit teardown trigger: ack revoked while Secrets Manager is unhappy.
        ctrl = _ctrl_with_targets({"gw-1": [{"name": "datadog-mcp-server-target", "targetId": "t-1"}]})
        ac = {"official_mcp_endpoints": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "official_mcp_read_only_ack": {},  # ack revoked
              "lambda_arns": {}, "region": "ap-northeast-2", "integrations_secret_name": "sec"}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _DATADOG_PRESET):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"}, secrets={}, secrets_read_ok=False)
        ctrl.delete_gateway_target.assert_called_once_with(gatewayIdentifier="gw-1", targetId="t-1")
        ctrl.delete_api_key_credential_provider.assert_called_once_with(name="awsops-v2-datadog-mcp")

    def test_healthy_live_target_untouched_when_the_secret_read_failed(self):
        # MAJOR L2-2 counterpart: reordering must NOT lose the round-1 property — a transient
        # secrets-read failure with the flag on and the ack valid touches nothing.
        ctrl = _ctrl_with_targets({"gw-1": [{"name": "datadog-mcp-server-target", "targetId": "t-1"}]})
        ac = {"official_mcp_endpoints": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "official_mcp_read_only_ack": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "lambda_arns": {}, "region": "ap-northeast-2", "integrations_secret_name": "sec"}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _DATADOG_PRESET):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"}, secrets={}, secrets_read_ok=False)
        ctrl.delete_gateway_target.assert_not_called()
        ctrl.delete_api_key_credential_provider.assert_not_called()
        ctrl.update_gateway_target.assert_not_called()
        ctrl.create_gateway_target.assert_not_called()
        self.assertIn("SKIP", {r[1] for r in provision.report})

    def test_non_object_secret_json_is_a_read_failure_not_an_empty_credential(self):
        # MINOR L2-5: a valid-JSON array/string secret returned ({}, True) = "read fine, credential
        # absent", which RETIRES a live target. An unreadable shape must fail closed instead.
        class _SM:
            def get_secret_value(self, SecretId):
                return {"SecretString": '["not", "an", "object"]'}
        with mock.patch.object(provision.boto3, "client", return_value=_SM()):
            # An endpoint must be configured for the read to happen at all: with none, the loader
            # short-circuits to ({}, True) on purpose so a deployment not using ADR-017 never fails
            # a provisioner run on a store it has no reason to touch (PR #194 review MAJOR, L2).
            secrets, ok = provision._load_official_mcp_secret({
                "integrations_secret_name": "sec", "region": "ap-northeast-2",
                "official_mcp_endpoints": {"datadog": "https://mcp.datadoghq.com/mcp"},
            })
        self.assertEqual(secrets, {})
        self.assertFalse(ok)

    def test_no_configured_endpoint_reads_nothing_and_is_not_an_error(self):
        # PR #194 review MAJOR (L2): the store has no version until the BFF first writes to it, so
        # reading it unconditionally raised ResourceNotFoundException -> ERR -> exit 1, breaking a
        # provisioner run that had nothing to do with ADR-017. No endpoints => no read at all.
        called = []

        class _SM:
            def get_secret_value(self, SecretId):
                called.append(SecretId)
                raise AssertionError("must not read the store when no preset endpoint is configured")

        with mock.patch.object(provision.boto3, "client", return_value=_SM()):
            secrets, ok = provision._load_official_mcp_secret({
                "integrations_secret_name": "sec", "region": "ap-northeast-2",
                "official_mcp_endpoints": {},
            })
        self.assertEqual(secrets, {})
        self.assertTrue(ok)
        self.assertEqual(called, [])

    def test_non_string_token_skips_the_preset_instead_of_crashing_the_run(self):
        # MINOR L2-6: a dict/number token reaches boto3 as ParamValidationError — NOT a ClientError,
        # so it escapes the handlers and aborts the entire provisioner run. Treated as absent.
        self.assertIsNone(provision._preset_token({"mcp:datadog": {"token": {"nested": "dict"}}}, "datadog"))
        self.assertIsNone(provision._preset_token({"mcp:datadog": {"token": 12345}}, "datadog"))
        self.assertIsNone(provision._preset_token({"mcp:datadog": {"token": ""}}, "datadog"))
        self.assertEqual(provision._preset_token({"mcp:datadog": {"token": "tok"}}, "datadog"), "tok")
        ctrl = _ctrl_with_targets()
        ac = {"official_mcp_endpoints": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "official_mcp_read_only_ack": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "lambda_arns": {}, "region": "ap-northeast-2", "integrations_secret_name": "sec"}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _DATADOG_PRESET), \
             mock.patch.object(provision, "_load_official_mcp_secret", return_value=({"mcp:datadog": {"token": {"a": 1}}}, True)):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"})  # must not raise
        ctrl.create_api_key_credential_provider.assert_not_called()
        ctrl.create_gateway_target.assert_not_called()
        self.assertIn("SKIP", {r[1] for r in provision.report})


class TestEndpointBlocked(unittest.TestCase):
    """MAJOR (kiro review, 2026-07-31): runtime defense-in-depth for official_mcp_endpoints,
    mirroring web/lib/ssrf-guard.ts isAlwaysBlockedHost's always-blocked subset."""

    def test_https_public_hostname_allowed(self):
        self.assertIsNone(provision._endpoint_blocked("https://mcp.datadoghq.com/v1/mcp"))

    def test_https_private_rfc1918_ip_allowed(self):
        # Self-hosted presets (ClickHouse/Grafana/Splunk) are explicitly in-VPC per catalog.py.
        self.assertIsNone(provision._endpoint_blocked("https://10.0.5.9/mcp"))

    def test_http_scheme_rejected(self):
        self.assertIsNotNone(provision._endpoint_blocked("http://mcp.datadoghq.com/v1/mcp"))

    def test_loopback_ip_rejected(self):
        self.assertIsNotNone(provision._endpoint_blocked("https://127.0.0.1/mcp"))

    def test_metadata_ip_rejected(self):
        self.assertIsNotNone(provision._endpoint_blocked("https://169.254.169.254/latest/meta-data"))

    def test_localhost_hostname_rejected(self):
        self.assertIsNotNone(provision._endpoint_blocked("https://localhost/mcp"))


class TestMainGatesProvisioningNotTeardownWhenRuntimeFails(unittest.TestCase):
    """review MAJOR (follow-up to the ensure_runtime-before-ensure_mcp_server_targets reorder):
    ensure_runtime can still fail (or, before the readiness-poll fix, return an ARN before the new
    revision was actually live). main() must always CALL ensure_mcp_server_targets — skipping the
    whole call also skips its teardown/retire paths, which an operator may need specifically to shut
    a live vendor target off — but pass allow_provision=False so create/update/sync (the only paths
    that expose something NEW to a possibly-stale runtime) are withheld."""

    def _run_main_with(self, runtime_arn):
        with mock.patch.object(provision, "tf_outputs", return_value={
                "region": "us-east-1", "role_arn": "arn:aws:iam::123456789012:role/x",
                "project": "awsops-v2"}), \
             mock.patch.object(provision, "boto3") as m_boto3, \
             mock.patch.object(provision, "ensure_gateways", return_value={"external-obs": "gw-1"}), \
             mock.patch.object(provision, "_load_official_mcp_secret", return_value=({}, True)), \
             mock.patch.object(provision, "_cutover_preset_keys", return_value=set()), \
             mock.patch.object(provision, "ensure_targets") as m_ensure_targets, \
             mock.patch.object(provision, "ensure_runtime", return_value=runtime_arn) as m_ensure_runtime, \
             mock.patch.object(provision, "ensure_mcp_server_targets") as m_ensure_mcp, \
             mock.patch.object(provision, "prune_moved_targets"), \
             mock.patch.object(provision, "ensure_memory", return_value="mem-1"), \
             mock.patch.object(provision, "ensure_interpreter", return_value="interp-1"), \
             mock.patch.object(provision, "write_ssm"), \
             mock.patch.object(provision.sys, "argv", ["provision.py"]), \
             mock.patch.object(provision, "report", []):
            m_boto3.client.return_value = mock.MagicMock()
            with self.assertRaises(SystemExit):
                provision.main()
        return m_ensure_targets, m_ensure_runtime, m_ensure_mcp

    def test_runtime_failure_still_calls_ensure_mcp_server_targets_but_gates_provisioning(self):
        _, m_ensure_runtime, m_ensure_mcp = self._run_main_with("")
        m_ensure_runtime.assert_called_once()
        m_ensure_mcp.assert_called_once()  # teardown paths must still run
        self.assertFalse(m_ensure_mcp.call_args.kwargs["allow_provision"])

    def test_runtime_success_allows_provisioning(self):
        _, m_ensure_runtime, m_ensure_mcp = self._run_main_with(
            "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/x")
        m_ensure_runtime.assert_called_once()
        m_ensure_mcp.assert_called_once()
        self.assertTrue(m_ensure_mcp.call_args.kwargs["allow_provision"])


class TestEnsureMcpServerTargetsAllowProvisionGate(_IsolatedProvisionTest):
    """allow_provision=False must skip ONLY create/update/sync for an otherwise-eligible preset —
    every teardown branch (blocked endpoint, no endpoint, stale ack, missing credential, tombstone)
    must still run regardless, since those only reduce exposure."""

    def test_eligible_preset_is_skipped_not_created_when_provisioning_disallowed(self):
        ctrl = _ctrl_with_targets()
        ac = {"official_mcp_endpoints": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "official_mcp_read_only_ack": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "lambda_arns": {}, "region": "ap-northeast-2", "integrations_secret_name": "sec"}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _DATADOG_PRESET), \
             mock.patch.object(provision, "_load_official_mcp_secret",
                                return_value=({"mcp:datadog": {"token": "tok"}}, True)):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"}, allow_provision=False)
        ctrl.create_gateway_target.assert_not_called()
        self.assertIn("SKIP", {r[1] for r in provision.report})
        self.assertEqual([r for r in provision.report if r[1] == "ERR"], [])

    def test_teardown_still_runs_when_provisioning_disallowed(self):
        # ack revoked (endpoint set, ack absent) — this preset must still be torn down even though
        # provisioning is globally disallowed this run; teardown never depends on allow_provision.
        ctrl = _ctrl_with_targets({"gw-1": [{"name": "datadog-mcp-server-target", "targetId": "t-1"}]})
        ac = {"official_mcp_endpoints": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "lambda_arns": {}, "region": "ap-northeast-2", "integrations_secret_name": "sec"}
        # official_mcp_read_only_ack deliberately absent.
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _DATADOG_PRESET), \
             mock.patch.object(provision, "_load_official_mcp_secret",
                                return_value=({"mcp:datadog": {"token": "tok"}}, True)):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"}, allow_provision=False)
        ctrl.delete_gateway_target.assert_called_once_with(gatewayIdentifier="gw-1", targetId="t-1")
        ctrl.delete_api_key_credential_provider.assert_called_once_with(name="awsops-v2-datadog-mcp")

    def test_eligible_live_target_is_retired_when_provisioning_disallowed(self):
        # PR #207 review MAJOR (3 cells independent): a fully-eligible preset (endpoint + matching
        # ack + credential) with an ALREADY-LIVE target must be RETIRED when the runtime allowlist
        # is unconfirmed — leaving it "untouched" kept a possibly pre-allowlist runtime serving
        # 100% of the vendor's tools, write tools included.
        ctrl = _ctrl_with_targets({"gw-1": [{"name": "datadog-mcp-server-target", "targetId": "t-1"}]})
        ac = {"official_mcp_endpoints": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "official_mcp_read_only_ack": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "lambda_arns": {}, "region": "ap-northeast-2", "integrations_secret_name": "sec"}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _DATADOG_PRESET), \
             mock.patch.object(provision, "_load_official_mcp_secret",
                                return_value=({"mcp:datadog": {"token": "tok"}}, True)):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"}, allow_provision=False)
        ctrl.delete_gateway_target.assert_called_once_with(gatewayIdentifier="gw-1", targetId="t-1")
        ctrl.create_gateway_target.assert_not_called()
        self.assertIn(("target:datadog-mcp-server-target", "ERR"), [(r[0], r[1]) for r in provision.report])

    def test_eligible_absent_target_still_skips_when_provisioning_disallowed(self):
        # No live target → nothing to retire; the create/update/sync deferral stays a quiet SKIP.
        # The PROVIDER delete still runs (codex stop-gate P2): if a prior run's target deletion
        # blocked the provider delete (async ordering), the next run — which sees no target — must
        # retry it, or the orphaned provider is never retired. Idempotent (missing = no-op).
        ctrl = _ctrl_with_targets({"gw-1": []})
        ctrl.delete_api_key_credential_provider.side_effect = _raise_not_found
        ac = {"official_mcp_endpoints": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "official_mcp_read_only_ack": {"datadog": "https://mcp.datadoghq.com/v1/mcp"},
              "lambda_arns": {}, "region": "ap-northeast-2", "integrations_secret_name": "sec"}
        with mock.patch.object(provision.catalog, "MCP_SERVER_TARGETS", _DATADOG_PRESET), \
             mock.patch.object(provision, "_load_official_mcp_secret",
                                return_value=({"mcp:datadog": {"token": "tok"}}, True)):
            provision.ensure_mcp_server_targets(ctrl, ac, {"external-obs": "gw-1"}, allow_provision=False)
        ctrl.delete_gateway_target.assert_not_called()
        ctrl.create_gateway_target.assert_not_called()
        ctrl.delete_api_key_credential_provider.assert_called_once_with(name="awsops-v2-datadog-mcp")
        self.assertEqual([r for r in provision.report if r[1] == "ERR"], [])


class TestEnsureRuntimeFailClosed(unittest.TestCase):
    def setUp(self):
        provision.report.clear()

    def test_wait_crash_returns_empty_not_raise(self):
        # codex stop-gate P1 on 569105be: an exception escaping the readiness poll (e.g. a
        # malformed AGENTCORE_RUNTIME_READY_TIMEOUT) propagated out of ensure_runtime and crashed
        # main() BEFORE ensure_mcp_server_targets ran — so the unconfirmed-runtime retirement
        # branch was unreachable. Any wait failure must mean "" (fail-closed), never a raise.
        ctrl = mock.MagicMock()
        ctrl.list_agent_runtimes.return_value = {"agentRuntimes": [{"agentRuntimeName": provision.RUNTIME_NAME, "agentRuntimeId": "rid-1"}]}
        ctrl.update_agent_runtime.return_value = {"agentRuntimeArn": "arn:rt"}
        ac = {"region": "ap-northeast-2", "role_arn": "arn:aws:iam::1:role/r", "ecr_uri": "e"}
        with mock.patch.object(provision, "_wait_runtime_ready", side_effect=ValueError("boom")):
            self.assertEqual(provision.ensure_runtime(ctrl, ac, {}), "")
        self.assertIn(("runtime:ready", "ERR"), [(r[0], r[1]) for r in provision.report])


class TestWaitRuntimeReady(unittest.TestCase):
    def test_ready_returns_true(self):
        ctrl = mock.MagicMock()
        ctrl.get_agent_runtime.return_value = {"status": "READY"}
        self.assertTrue(provision._wait_runtime_ready(ctrl, "rid-1", timeout_s=5, interval_s=0))

    def test_terminal_failure_returns_false(self):
        ctrl = mock.MagicMock()
        ctrl.get_agent_runtime.return_value = {"status": "UPDATE_FAILED", "failureReason": "nope"}
        self.assertFalse(provision._wait_runtime_ready(ctrl, "rid-1", timeout_s=5, interval_s=0))

    def test_timeout_returns_false(self):
        ctrl = mock.MagicMock()
        ctrl.get_agent_runtime.return_value = {"status": "UPDATING"}
        self.assertFalse(provision._wait_runtime_ready(ctrl, "rid-1", timeout_s=0, interval_s=0))


def _client_error(code):
    """side_effect factory for an arbitrary (non-NotFound) control-plane failure."""
    def _raise(*_a, **_kw):
        from botocore.exceptions import ClientError
        raise ClientError({"Error": {"Code": code, "Message": "nope"}}, "DeleteGatewayTarget")
    return _raise


def _raise_not_found(*_a, **_kw):
    from botocore.exceptions import ClientError
    raise ClientError({"Error": {"Code": "ResourceNotFoundException", "Message": "no"}}, "GetApiKeyCredentialProvider")


if __name__ == "__main__":
    unittest.main()
