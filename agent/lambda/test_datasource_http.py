"""Tests for datasource_http — shared SSRF/auth/HTTP helper for the v1 datasource family.
`python3 -m unittest test_datasource_http`. No network: a fake resolver + mocked secret/opener.
"""
import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import datasource_http as dh  # noqa: E402


def _resolver_for(ip):
    return lambda host, port, proto=None: [(2, 1, 6, "", (ip, port))]


class TestSsrf(unittest.TestCase):
    def test_always_blocked_ips(self):
        for ip in ("169.254.169.254", "fd00:ec2::254", "127.0.0.1", "::1", "fe80::1", "224.0.0.1"):
            with self.assertRaises(dh.SsrfBlocked):
                dh.assert_host_allowed(f"http://host:8123", resolver=_resolver_for(ip))

    def test_ipv4_mapped_ipv6_metadata_blocked(self):
        for ip in ("::ffff:169.254.169.254", "::ffff:127.0.0.1"):
            with self.assertRaises(dh.SsrfBlocked):
                dh.assert_host_allowed("http://host:8123", resolver=_resolver_for(ip))

    def test_6to4_ipv6_metadata_blocked(self):
        # 6to4 (2002::/16) embeds an IPv4; must not evade the metadata/loopback checks.
        for ip in ("2002:a9fe:a9fe::", "2002:7f00:0001::"):  # 169.254.169.254 / 127.0.0.1
            with self.assertRaises(dh.SsrfBlocked):
                dh.assert_host_allowed("http://host:8123", resolver=_resolver_for(ip))

    def test_private_and_public_allowed(self):
        for ip in ("10.0.0.5", "192.168.1.9", "172.16.3.4", "fc00::1", "8.8.8.8"):
            dh.assert_host_allowed("http://ch:8123", resolver=_resolver_for(ip))  # no raise

    def test_scheme_restricted(self):
        with self.assertRaises(dh.SsrfBlocked):
            dh.assert_host_allowed("file:///etc/passwd", resolver=_resolver_for("10.0.0.1"))
        with self.assertRaises(dh.SsrfBlocked):
            dh.assert_host_allowed("gopher://10.0.0.1/", resolver=_resolver_for("10.0.0.1"))
        dh.assert_host_allowed("https://ch.example", resolver=_resolver_for("8.8.8.8"))  # ok


class TestAuth(unittest.TestCase):
    def test_basic(self):
        h = dh.auth_headers({"username": "default", "password": "pw"})
        self.assertEqual(h["Authorization"], "Basic ZGVmYXVsdDpwdw==")

    def test_basic_empty_password(self):
        h = dh.auth_headers({"username": "default"})
        self.assertTrue(h["Authorization"].startswith("Basic "))

    def test_bearer(self):
        self.assertEqual(dh.auth_headers({"token": "t"})["Authorization"], "Bearer t")

    def test_none(self):
        self.assertEqual(dh.auth_headers({}), {})


class TestLoad(unittest.TestCase):
    def test_load_datasource(self):
        with mock.patch.object(dh, "_load_secret_map",
                               return_value={"clickhouse": {"endpoint": "http://ch:8123", "username": "u"}}):
            ds = dh.load_datasource("clickhouse")
        self.assertEqual(ds["endpoint"], "http://ch:8123")

    def test_not_connected(self):
        with mock.patch.object(dh, "_load_secret_map", return_value={}):
            with self.assertRaises(dh.NotConnected):
                dh.load_datasource("clickhouse")

    def test_load_datasource_instance_id_pure_arg(self):
        # per-instance id key wins; falls back to the kind-mirror when the id key is absent/blank.
        m = {"5": {"endpoint": "http://prom-a:9090"}, "prometheus": {"endpoint": "http://prom-default:9090"}}
        with mock.patch.object(dh, "_load_secret_map", return_value=m):
            self.assertEqual(dh.load_datasource("prometheus", instance_id=5)["endpoint"], "http://prom-a:9090")
            self.assertEqual(dh.load_datasource("prometheus")["endpoint"], "http://prom-default:9090")  # kind mirror
            self.assertEqual(dh.load_datasource("prometheus", instance_id=999)["endpoint"], "http://prom-default:9090")  # missing id → mirror

    def test_warm_container_no_bleed(self):
        # an inline conn set on one invocation must not bleed into a later instance_id invocation.
        m = {"5": {"endpoint": "http://prom-a:9090"}, "prometheus": {"endpoint": "http://prom-default:9090"}}
        dh.set_request_conn({"endpoint": "http://inline:9090"})
        try:
            self.assertEqual(dh.load_datasource("prometheus")["endpoint"], "http://inline:9090")  # inline wins
        finally:
            dh.set_request_conn(None)  # connector handler does this in a finally
        with mock.patch.object(dh, "_load_secret_map", return_value=m):
            self.assertEqual(dh.load_datasource("prometheus", instance_id=5)["endpoint"], "http://prom-a:9090")  # no bleed


class TestHttp(unittest.TestCase):
    def test_no_redirect_follow(self):
        # a 3xx must NOT be auto-followed (SSRF defense)
        import urllib.request

        class _R:
            def __init__(self, code):
                self._c = code
            def getcode(self):
                return self._c
            def read(self):
                return b'{"ok":1}'
        with mock.patch.object(dh._opener, "open", return_value=_R(200)):
            status, data = dh.http_json("GET", "http://ch:8123/ping")
        self.assertEqual(status, 200)
        self.assertEqual(data["ok"], 1)
        # the opener is built with the no-redirect handler
        self.assertTrue(any(isinstance(h, dh._NoRedirect) for h in dh._opener.handlers))


class TestRedirectSsrf(unittest.TestCase):
    def test_http_json_propagates_ssrf_from_redirect_handler(self):
        # _NoRedirect.redirect_request raises SsrfBlocked from inside _opener.open; http_json must
        # let it propagate (not swallow), so the Lambda handler can map it to a clean 400.
        with mock.patch.object(dh._opener, "open", side_effect=dh.SsrfBlocked("redirect to blocked")):
            with self.assertRaises(dh.SsrfBlocked):
                dh.http_json("GET", "http://ch:8123/x")


if __name__ == "__main__":
    unittest.main()
