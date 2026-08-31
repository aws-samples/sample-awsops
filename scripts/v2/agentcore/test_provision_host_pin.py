"""Per-preset host pin (ADR-017 deviation ② closed).

Without this pin `official_mcp_endpoints` only had to be https:// and the ack was a self-echo of the
operator's own string, so a preset key could be bound to any host and _ensure_api_key_provider would
hand that host the preset's real vendor credential — effectively the BYO-MCP connection BASELINE §2
pins as do-not-revive. These tests fix the two bypass shapes that a naive raw-URL `endswith` lets
through, and assert a catalog entry declaring neither state fails closed rather than defaulting open.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import socket
from unittest import mock

import catalog  # noqa: E402
import provision  # noqa: E402


def _spec(preset_key):
    for v in catalog.MCP_SERVER_TARGETS.values():
        if v["preset_key"] == preset_key:
            return v
    raise AssertionError(f"no preset {preset_key!r} in catalog")


class TestEveryPresetIsClassified(unittest.TestCase):
    def test_no_preset_is_left_unclassified(self):
        # A preset with neither key would fail closed at runtime, i.e. be silently unusable — catch
        # that here instead, at the point someone adds a preset.
        for name, spec in catalog.MCP_SERVER_TARGETS.items():
            pinned = bool(spec.get("allowed_host_suffixes"))
            asserted = bool(spec.get("host_is_operator_asserted"))
            self.assertTrue(
                pinned ^ asserted,
                f"{name}: exactly one of allowed_host_suffixes / host_is_operator_asserted required "
                f"(pinned={pinned}, operator_asserted={asserted})",
            )


class TestHostPin(unittest.TestCase):
    def test_vendor_host_and_regional_sibling_allowed(self):
        dd = _spec("datadog")
        self.assertIsNone(provision._host_pin_violation("https://mcp.datadoghq.com/mcp", dd))
        self.assertIsNone(provision._host_pin_violation("https://mcp.datadoghq.eu/mcp", dd))

    def test_trailing_dot_is_normalised(self):
        self.assertIsNone(
            provision._host_pin_violation("https://mcp.datadoghq.com./mcp", _spec("datadog"))
        )

    def test_missing_dot_boundary_is_rejected(self):
        # `endswith("datadoghq.com")` on the raw URL would ALLOW this.
        self.assertIsNotNone(
            provision._host_pin_violation("https://evil-datadoghq.com/mcp", _spec("datadog"))
        )

    def test_allowed_suffix_in_the_middle_is_rejected(self):
        self.assertIsNotNone(
            provision._host_pin_violation(
                "https://datadoghq.com.attacker.example/mcp", _spec("datadog")
            )
        )

    def test_unrelated_host_is_rejected(self):
        self.assertIsNotNone(
            provision._host_pin_violation("https://attacker.example/mcp", _spec("datadog"))
        )

# SYNTHETIC operator-asserted spec: the ADR-017 amendment (2026-08-05) removed every self-hosted
# preset from the live catalog, but the private-literal enforcement path in _host_pin_violation
# stays (fail-closed classifier for any future operator-asserted preset) — keep it covered.
_SELF_HOSTED_SPEC = {"preset_key": "synthetic-self-hosted", "host_is_operator_asserted": True}


class TestSelfHostedRequiresAPrivateLiteral(unittest.TestCase):
    """Marking a preset host_is_operator_asserted, or confining it to a declared internal suffix, both
    still left it exfiltratable: a NAME resolves privately at provision time and can be repointed at a
    public address afterwards, and AgentCore makes the connection so we get no second look. Requiring
    the private IP LITERAL removes the DNS indirection entirely — the value verified is the value
    connected to — which closes the class instead of narrowing it."""

    def test_private_literal_is_accepted(self):
        for url in ("https://10.0.3.7:8123/mcp", "https://192.168.4.4/mcp", "https://[fd00::1]/mcp"):
            self.assertIsNone(provision._host_pin_violation(url, _SELF_HOSTED_SPEC), url)

    def test_a_name_is_rejected_even_if_it_looks_internal(self):
        for url in ("https://ch.internal:8123/mcp", "https://ch.svc.cluster.local/mcp"):
            v = provision._host_pin_violation(url, _SELF_HOSTED_SPEC)
            self.assertIsNotNone(v, url)
            self.assertIn("NAME", v)

    def test_public_literal_is_rejected(self):
        self.assertIsNotNone(
            provision._host_pin_violation("https://93.184.216.34/mcp", _SELF_HOSTED_SPEC)
        )

    def test_publicly_routed_ipv6_transition_forms_are_rejected(self):
        """`ipaddress.is_private` answers from the IPv4 EMBEDDED in a 6to4/Teredo address, so these
        report is_private=True while routing to the public internet — the exact exfiltration this gate
        exists to stop. Gating on is_private accepted all of them; the in-VPC allowlist rejects them."""
        for url in (
            "https://[2002:5db8:d822::1]/mcp",      # 6to4 wrapping public 93.184.216.34
            "https://[2001:0:5db8:d822::1]/mcp",    # Teredo wrapping the same
            "https://[2002:0a00:0001::1]/mcp",      # 6to4 wrapping private 10.0.0.1 — still public routing
            "https://[::ffff:10.0.0.1]/mcp",        # IPv4-mapped private
            "https://[64:ff9b::5db8:d822]/mcp",     # NAT64
            "https://[2600:1f00::1]/mcp",           # AWS-style GUA (routable)
        ):
            self.assertIsNotNone(provision._host_pin_violation(url, _SELF_HOSTED_SPEC), url)

    def test_vendor_hosted_preset_still_uses_its_name_pin(self):
        # Vendor-hosted presets are unaffected — they pin on the vendor domain, by name.
        self.assertIsNone(
            provision._host_pin_violation("https://mcp.datadoghq.com/mcp", _spec("datadog"))
        )
