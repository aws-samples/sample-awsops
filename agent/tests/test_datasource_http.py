"""Task 11 — inline conn-config precedence + explicit-authType auth headers + custom-header safety."""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lambda"))

import datasource_http as dh  # noqa: E402


class TestAuthHeaders(unittest.TestCase):
    def tearDown(self):
        dh.set_request_conn(None)

    def test_none_yields_no_authorization(self):
        self.assertEqual(dh.auth_headers({"authType": "none"}), {})

    def test_basic_explicit_and_empty_password(self):
        h = dh.auth_headers({"authType": "basic", "username": "u", "password": "p"})
        self.assertTrue(h["Authorization"].startswith("Basic "))
        h2 = dh.auth_headers({"authType": "basic", "username": "u"})  # empty password allowed
        self.assertTrue(h2["Authorization"].startswith("Basic "))

    def test_bearer_explicit(self):
        self.assertEqual(dh.auth_headers({"authType": "bearer", "token": "t"}), {"Authorization": "Bearer t"})

    def test_custom_header(self):
        self.assertEqual(
            dh.auth_headers({"authType": "custom_header", "headerName": "X-API-Key", "headerValue": "k"}),
            {"X-API-Key": "k"},
        )

    def test_custom_header_injection_rejected(self):
        with self.assertRaises(dh.SsrfBlocked):
            dh.auth_headers({"authType": "custom_header", "headerName": "X-Bad", "headerValue": "v\r\nHost: evil"})
        with self.assertRaises(dh.SsrfBlocked):
            dh.auth_headers({"authType": "custom_header", "headerName": "Host", "headerValue": "v"})

    def test_legacy_inference_without_authtype(self):
        self.assertTrue(dh.auth_headers({"username": "u", "password": "p"})["Authorization"].startswith("Basic "))
        self.assertEqual(dh.auth_headers({"token": "t"}), {"Authorization": "Bearer t"})
        self.assertEqual(dh.auth_headers({}), {})

    def test_org_id_added_for_any_authtype(self):
        self.assertEqual(dh.auth_headers({"authType": "none", "org_id": "t1"}), {"X-Scope-OrgID": "t1"})


class TestInlineConnPrecedence(unittest.TestCase):
    def tearDown(self):
        dh.set_request_conn(None)

    def test_inline_conn_takes_precedence_over_slug_map(self):
        dh.set_request_conn({"endpoint": "http://inline:9090", "authType": "none"})
        with mock.patch.object(dh, "_load_secret_map", return_value={"prometheus": {"endpoint": "http://slug:9090"}}):
            self.assertEqual(dh.load_datasource("prometheus")["endpoint"], "http://inline:9090")

    def test_falls_back_to_slug_map_when_no_inline(self):
        dh.set_request_conn(None)
        with mock.patch.object(dh, "_load_secret_map", return_value={"prometheus": {"endpoint": "http://slug:9090"}}):
            self.assertEqual(dh.load_datasource("prometheus")["endpoint"], "http://slug:9090")

    def test_inline_without_endpoint_is_ignored(self):
        dh.set_request_conn({"authType": "none"})  # no endpoint → not used
        with mock.patch.object(dh, "_load_secret_map", return_value={"prometheus": {"endpoint": "http://slug:9090"}}):
            self.assertEqual(dh.load_datasource("prometheus")["endpoint"], "http://slug:9090")


class TestHealth(unittest.TestCase):
    def test_health_ok(self):
        with mock.patch.object(dh, "assert_host_allowed"), mock.patch.object(dh, "http_json", return_value=(200, {})):
            r = dh.health({"endpoint": "http://p:9090", "authType": "none"}, "/-/healthy")
            self.assertTrue(r["ok"])
            self.assertIn("latency_ms", r)

    def test_health_http_error(self):
        with mock.patch.object(dh, "assert_host_allowed"), mock.patch.object(dh, "http_json", return_value=(503, {})):
            self.assertFalse(dh.health({"endpoint": "http://p:9090"}, "/-/healthy")["ok"])

    def test_health_ssrf_blocked(self):
        with mock.patch.object(dh, "assert_host_allowed", side_effect=dh.SsrfBlocked("blocked")):
            r = dh.health({"endpoint": "http://169.254.169.254"}, "/-/healthy")
            self.assertFalse(r["ok"])
            self.assertIn("blocked", r["error"])

    def test_health_no_endpoint(self):
        self.assertFalse(dh.health({}, "/-/healthy")["ok"])


if __name__ == "__main__":
    unittest.main()
