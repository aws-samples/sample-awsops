"""Offline runtime enforcement, including rejection before credential/DNS/network access."""
import copy
import os
import unittest
from unittest.mock import Mock, patch
from test_agent import agent


def fixture():
    spec = {"id": 7, "kind": "custom_mcp", "direction": "egress", "capability": "read",
            "endpoint": "https://example.com/mcp", "transport": "api_key",
            "credentialsRef": "ops/awsops-v2/integrations/custom/7",
            "registeredTools": ["query"], "exposedTools": ["query"],
            "accountId": "self", "accountSelected": True}
    spec["readOnlyAttestation"] = {
        "actorSub": "immutable-sub", "attestedAt": "2026-10-18T12:00:00.000Z",
        "tools": ["query"], "credentialVersionId": "a" * 32,
        **{k: spec[k] for k in ("endpoint", "transport", "credentialsRef")}}
    return spec


class CustomMcpPolicyTest(unittest.TestCase):
    def setUp(self):
        enabled = patch.dict(os.environ, {"CUSTOM_MCP_ENABLED": "true"})
        enabled.start()
        self.addCleanup(enabled.stop)

    def test_default_off_never_reads_credentials_dns_or_network(self):
        with patch.dict(os.environ, {"CUSTOM_MCP_ENABLED": "false"}), \
                patch.object(agent, "_get_secret") as secret, \
                patch.object(agent, "_assert_host_allowed") as dns, \
                patch.object(agent, "MCPClient") as network:
            with self.assertRaisesRegex(ValueError, "activation"):
                agent._connect_integration(fixture(), Mock(), "self")
            secret.assert_not_called()
            dns.assert_not_called()
            network.assert_not_called()

    def test_valid_scoped_secret_and_attestation(self):
        self.assertEqual(agent.validate_custom_mcp_spec(fixture(), "self"), "a" * 32)

    def test_negative_cases_never_read_secret_resolve_dns_or_open_connection(self):
        cases = [{"direction": "ingress"}, {"capability": "read_write"}, {"transport": "sigv4"},
                 {"transport": "oauth_3lo"}, {"exposedTools": []}, {"registeredTools": []},
                 {"exposedTools": ["mutate"]}, {"registeredTools": ["gateway___mutate"]},
                 {"accountSelected": False}, {"accountId": "other"}, {"id": True},
                 {"credentialsRef": "ops/awsops-v2/integrations/custom/8"},
                 {"readOnlyAttestation": None}, {"kind": "grafana", "transport": "sigv4"}]
        for edit in cases:
            with self.subTest(edit=edit), patch.object(agent, "_get_secret") as secret, \
                    patch.object(agent, "_assert_host_allowed") as dns, patch.object(agent, "MCPClient") as network:
                with self.assertRaises(ValueError):
                    agent._connect_integration({**fixture(), **edit}, Mock(), "self")
                secret.assert_not_called()
                dns.assert_not_called()
                network.assert_not_called()

    def test_changes_in_config_or_tools_require_new_attestation(self):
        for key, value in [("endpoint", "https://changed.example/mcp"), ("transport", "oauth_client_credentials"),
                           ("registeredTools", ["other"]), ("credentialsRef", "other")]:
            with self.subTest(key=key):
                with self.assertRaises(ValueError):
                    agent.validate_custom_mcp_spec({**fixture(), key: value}, "self")

    def test_bad_attestation_fields_are_rejected(self):
        for key, value in [("actorSub", ""), ("attestedAt", "invalid"), ("attestedAt", "2026-10-18"),
                           ("credentialVersionId", "short"), ("tools", ["other"])]:
            spec = fixture()
            spec["readOnlyAttestation"][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                agent.validate_custom_mcp_spec(spec, "self")

    def test_rotated_secret_never_reaches_connection(self):
        with patch.object(agent, "_assert_host_allowed"), patch.object(agent, "_get_secret", side_effect=ValueError("rotated")), \
                patch.object(agent, "MCPClient") as network:
            with self.assertRaises(ValueError):
                agent._connect_integration(fixture(), Mock(), "self")
            network.assert_not_called()

    def test_get_secret_requires_attested_version_still_be_current(self):
        secret = Mock()
        secret.get_secret_value.return_value = {"VersionId": "a" * 32, "SecretString": '{"token":"fixture"}'}
        with patch.object(agent, "_secrets_client", secret):
            self.assertEqual(agent._get_secret("bound", expected_version="a" * 32), '{"token":"fixture"}')
            secret.get_secret_value.assert_called_once_with(SecretId="bound", VersionId="a" * 32, VersionStage="AWSCURRENT")
            secret.get_secret_value.return_value["VersionId"] = "b" * 32
            with self.assertRaises(ValueError):
                agent._get_secret("bound", expected_version="a" * 32)
