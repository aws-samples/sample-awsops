"""Tests for istio_read_mcp — read-only Istio CRDs via the EKS k8s API (no Steampipe/pg8000)."""
import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import istio_read_mcp as im  # noqa: E402


# canned k8s API responses keyed by request path
_K8S = {
    "/apis/networking.istio.io/v1beta1/virtualservices": {"items": [
        {"metadata": {"name": "reviews", "namespace": "bookinfo"}},
        {"metadata": {"name": "ratings", "namespace": "bookinfo"}},
    ]},
    "/apis/networking.istio.io/v1beta1/destinationrules": {"items": [
        {"metadata": {"name": "reviews-dr", "namespace": "bookinfo"}},
    ]},
    "/apis/networking.istio.io/v1beta1/gateways": {"items": []},
    "/apis/networking.istio.io/v1beta1/serviceentries": {"items": []},
    "/apis/security.istio.io/v1/authorizationpolicies": {"items": [{"metadata": {"name": "deny-all", "namespace": "istio-system"}}]},
    "/apis/security.istio.io/v1/peerauthentications": {"items": []},
    "/api/v1/namespaces": {"items": [
        {"metadata": {"name": "bookinfo", "labels": {"istio-injection": "enabled"}}},
        {"metadata": {"name": "kube-system", "labels": {}}},
        {"metadata": {"name": "legacy", "labels": {"istio-injection": "disabled"}}},  # explicit opt-out
    ]},
}


class _Base(unittest.TestCase):
    def setUp(self):
        s = mock.patch.object(im, "_eks_session", return_value=("https://eks.example", "tok", None))
        s.start(); self.addCleanup(s.stop)
        g = mock.patch.object(im, "_k8s_get", side_effect=lambda endpoint, path, token, ctx: _K8S.get(path, {"items": []}))
        g.start(); self.addCleanup(g.stop)
        r = mock.patch.object(im, "get_role_arn", return_value=None)
        r.start(); self.addCleanup(r.stop)

    def _call(self, tool, **args):
        out = im.lambda_handler({"tool_name": tool, "arguments": {"cluster_name": "c1", **args}}, None)
        return out, json.loads(out["body"])


class TestList(_Base):
    def test_list_virtual_services(self):
        out, body = self._call("list_virtual_services")
        self.assertEqual(out["statusCode"], 200)
        names = [v["name"] for v in body["virtualservices"]]
        self.assertIn("reviews", names)
        self.assertIn("ratings", names)
        self.assertEqual(body["virtualservices"][0]["namespace"], "bookinfo")

    def test_list_authorization_policies(self):
        out, body = self._call("list_authorization_policies")
        self.assertEqual(out["statusCode"], 200)
        self.assertEqual(body["authorizationpolicies"][0]["name"], "deny-all")


class TestOverview(_Base):
    def test_mesh_overview_counts_and_injected_namespaces(self):
        out, body = self._call("mesh_overview")
        self.assertEqual(out["statusCode"], 200)
        self.assertEqual(body["counts"]["virtualservices"], 2)
        self.assertEqual(body["counts"]["destinationrules"], 1)
        self.assertIn("bookinfo", body["injected_namespaces"])
        self.assertNotIn("kube-system", body["injected_namespaces"])
        self.assertNotIn("legacy", body["injected_namespaces"])  # istio-injection: disabled → not injected


class TestGuards(_Base):
    def test_unknown_tool(self):
        out = im.lambda_handler({"tool_name": "delete_virtual_service", "arguments": {"cluster_name": "c1"}}, None)
        self.assertEqual(out["statusCode"], 400)

    def test_cluster_name_required(self):
        out = im.lambda_handler({"tool_name": "mesh_overview", "arguments": {}}, None)
        self.assertEqual(out["statusCode"], 400)

    def test_target_account_id_popped(self):
        out, body = self._call("list_istio_gateways", target_account_id="123456789012")
        self.assertEqual(out["statusCode"], 200)

    def test_invalid_namespace_400(self):
        out = im.lambda_handler({"tool_name": "list_virtual_services", "arguments": {"cluster_name": "c1", "namespace": "Bad/NS"}}, None)
        self.assertEqual(out["statusCode"], 400)


class TestNoSteampipe(unittest.TestCase):
    def test_source_has_no_steampipe_or_pg8000(self):
        # the v1 dependency may be NAMED in the docstring (explaining what was dropped) but must never
        # be IMPORTED/connected — assert the usage forms are absent (ADR-037: no live Steampipe).
        src = open(os.path.join(os.path.dirname(__file__), "istio_read_mcp.py")).read()
        for banned in ("import pg8000", "pg8000.connect", "STEAMPIPE_HOST", ":9193/"):
            self.assertNotIn(banned, src, f"istio-read must not use {banned} (ADR-037: no live Steampipe)")


class TestCatalogWiring(unittest.TestCase):
    def test_istio_target_registered(self):
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "v2", "agentcore"))
        import catalog
        t = catalog.TARGETS.get("istio-read-target")
        self.assertIsNotNone(t, "istio-read-target missing from catalog.TARGETS")
        self.assertEqual(t["gateway"], "container")
        self.assertEqual(t["lambda_key"], "istio-read")
        names = [x["name"] for x in t["tools"]]
        self.assertIn("mesh_overview", names)
        self.assertIn("list_virtual_services", names)
        self.assertEqual(len(t["tools"]), 7)


if __name__ == "__main__":
    unittest.main()
