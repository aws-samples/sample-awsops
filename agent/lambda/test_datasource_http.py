"""Tests for datasource_http — shared SSRF/auth/HTTP helper for the v2 external-observability
datasource family. `python3 -m unittest test_datasource_http`. No network beyond loopback: a fake
resolver + mocked secret/opener, plus (for the IP-pinning tests) a real local HTTP(S) server on
127.0.0.1.
"""
import http.server
import json
import os
import ssl
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import datasource_http as dh  # noqa: E402


def _resolver_for(ip):
    return lambda host, port, proto=None: [(2, 1, 6, "", (ip, port))]


class TestSsrf(unittest.TestCase):
    def setUp(self):
        # assert_host_allowed pins the validated IP for the host (P1-3 IP-pinning) — reset between
        # tests so one test's cache entry for a reused host (e.g. "ch") can't leak into another's.
        dh._PINNED_IP_CACHE = {}

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
    def setUp(self):
        dh._PINNED_IP_CACHE = {}  # see TestSsrf.setUp

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
    def setUp(self):
        dh._PINNED_IP_CACHE = {}  # see TestSsrf.setUp

    def test_http_json_propagates_ssrf_from_redirect_handler(self):
        # _NoRedirect.redirect_request raises SsrfBlocked from inside _opener.open; http_json must
        # let it propagate (not swallow), so the Lambda handler can map it to a clean 400.
        with mock.patch.object(dh._opener, "open", side_effect=dh.SsrfBlocked("redirect to blocked")):
            with self.assertRaises(dh.SsrfBlocked):
                dh.http_json("GET", "http://ch:8123/x")


class TestIpPinning(unittest.TestCase):
    """pentest-remediation P1-3 (Finding 2/7): assert_host_allowed used to resolve-and-discard — the
    validated IP was never actually connected to; http_json's urllib re-resolved the hostname
    independently, which is exactly the DNS-rebinding window the finding exploited. These prove the
    fix with a REAL local socket (not mocked): the hostname in the URL never resolves anywhere (it
    isn't a real DNS name), yet the request reaches a local server — proving the connection used the
    pinned IP, not a fresh DNS lookup — while the server observes the ORIGINAL hostname in the Host
    header (proving SNI/Host preservation, not a raw IP-only fetch)."""

    def setUp(self):
        dh._PINNED_IP_CACHE = {}
        self.received = {}
        handler_self = self

        class _Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802 — stdlib method name
                handler_self.received["host_header"] = self.headers.get("Host")
                handler_self.received["path"] = self.path
                body = b'{"ok":true}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):  # silence test output
                pass

        self.server = http.server.HTTPServer(("127.0.0.1", 0), _Handler)
        self.port = self.server.server_port
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.thread.join(timeout=2)
        dh._PINNED_IP_CACHE = {}

    def test_pinned_ip_is_actually_connected_to_with_original_host_header_preserved(self):
        fake_hostname = "totally-fake-host-that-does-not-resolve.invalid"
        # Seed the cache exactly as assert_host_allowed would after validating a resolution to our
        # local server's IP — this is the state http_json relies on.
        dh._PINNED_IP_CACHE[fake_hostname] = ["127.0.0.1"]
        status, data = dh.http_json("GET", f"http://{fake_hostname}:{self.port}/probe")
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"])
        # The local server DID receive the request (impossible without pinning, since fake_hostname
        # cannot resolve via real DNS) — and it saw the ORIGINAL hostname in Host, not the pinned IP.
        self.assertEqual(self.received["path"], "/probe")
        self.assertEqual(self.received["host_header"], f"{fake_hostname}:{self.port}")

    def test_without_a_cache_entry_falls_back_to_the_shared_unpinned_opener(self):
        # No assert_host_allowed call happened for this host → _opener_for must return the shared
        # module-level _opener unchanged (same object identity the other tests mock against).
        self.assertIs(dh._opener_for("some-other-host"), dh._opener)

    def test_assert_host_allowed_populates_the_cache_that_http_json_consumes(self):
        # 10.0.0.5 (private, allowed) — 127.0.0.1 is itself always-blocked and would raise here.
        resolver = lambda host, port, proto=None: [(2, 1, 6, "", ("10.0.0.5", port))]  # noqa: E731
        dh.assert_host_allowed("http://pin-me:1234", resolver=resolver)
        self.assertEqual(dh._PINNED_IP_CACHE["pin-me"], ["10.0.0.5"])

    def test_assert_host_allowed_caches_all_resolved_ips_deduped(self):
        # dual-stack / multi-A-record: every validated IP is cached (in order, deduped), not just
        # the first — this is what preserves socket.create_connection's fallback-through-addresses.
        resolver = lambda host, port, proto=None: [  # noqa: E731
            (10, 1, 6, "", ("2001:db8::1", port, 0, 0)),
            (2, 1, 6, "", ("10.0.0.5", port)),
            (2, 1, 6, "", ("10.0.0.5", port)),  # duplicate resolved address
        ]
        dh.assert_host_allowed("http://multi:1234", resolver=resolver)
        self.assertEqual(dh._PINNED_IP_CACHE["multi"], ["2001:db8::1", "10.0.0.5"])

    def test_set_request_conn_resets_the_cache(self):
        dh._PINNED_IP_CACHE["stale-host"] = ["10.0.0.5"]
        dh.set_request_conn(None)
        self.assertEqual(dh._PINNED_IP_CACHE, {})

    def test_first_pinned_ip_failing_falls_back_to_second(self):
        # The core MAJOR fix: _pin_create_connection must try each pinned IP in order and fall back
        # on connect failure — same as stdlib socket.create_connection's multi-address behavior.
        # Drive it directly (no real Lambda networking needed): a fake base_create that raises for
        # the first IP and succeeds for the second.
        attempts = []

        def fake_base_create(address, *a, **kw):
            attempts.append(address)
            if address[0] == "10.0.0.1":
                raise OSError("simulated: network is unreachable")
            return ("connected", address)

        wrapped = dh._pin_create_connection(fake_base_create, ["10.0.0.1", "10.0.0.2"])
        result = wrapped(("original-hostname", 443))
        self.assertEqual(attempts, [("10.0.0.1", 443), ("10.0.0.2", 443)])
        self.assertEqual(result, ("connected", ("10.0.0.2", 443)))

    def test_all_pinned_ips_failing_raises_the_last_error(self):
        def fake_base_create(address, *a, **kw):
            raise OSError(f"unreachable: {address[0]}")

        wrapped = dh._pin_create_connection(fake_base_create, ["10.0.0.1", "10.0.0.2"])
        with self.assertRaises(OSError) as ctx:
            wrapped(("original-hostname", 443))
        self.assertIn("10.0.0.2", str(ctx.exception))  # the last attempt's error surfaces


class TestHttpsPinning(unittest.TestCase):
    """MAJOR #1 (review round 2): _PinnedHTTPSHandler.https_open used to pass a check_hostname=
    kwarg that stdlib removed from HTTPSConnection/ssl on py3.12+ — silently breaking every pinned
    HTTPS request the moment the Lambda runtime is bumped past 3.11. HTTPS pinning previously had
    zero test coverage (only the plaintext HTTP server in TestIpPinning was exercised). This spins
    up a REAL local TLS server with a self-signed cert (openssl — PROTOCOL_TLS_SERVER needs a cert
    file, and stdlib ssl has no CA-generation of its own) and proves a pinned HTTPS request
    completes end-to-end: same non-resolving fake-hostname trick as TestIpPinning, but over TLS
    with a matching cert SAN and a trusted CA — proving the connection both used the pinned IP AND
    passed real certificate/hostname verification (not a check_hostname=None bypass)."""

    FAKE_HOST = "totally-fake-https-host-that-does-not-resolve.invalid"

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        cls.certfile = os.path.join(cls._tmp.name, "cert.pem")
        cls.keyfile = os.path.join(cls._tmp.name, "key.pem")
        try:
            subprocess.run(
                ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                 "-keyout", cls.keyfile, "-out", cls.certfile, "-days", "1",
                 "-subj", f"/CN={cls.FAKE_HOST}", "-addext", f"subjectAltName=DNS:{cls.FAKE_HOST}"],
                check=True, capture_output=True, timeout=30,
            )
        except (FileNotFoundError, subprocess.CalledProcessError) as e:
            cls._tmp.cleanup()
            raise unittest.SkipTest(f"openssl unavailable/failed, cannot generate test cert: {e}")

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def setUp(self):
        dh._PINNED_IP_CACHE = {}
        self.received = {}
        handler_self = self

        class _Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802 — stdlib method name
                handler_self.received["host_header"] = self.headers.get("Host")
                handler_self.received["path"] = self.path
                body = b'{"ok":true}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):  # silence test output
                pass

        self.server = http.server.HTTPServer(("127.0.0.1", 0), _Handler)
        server_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        server_ctx.load_cert_chain(certfile=self.certfile, keyfile=self.keyfile)
        self.server.socket = server_ctx.wrap_socket(self.server.socket, server_side=True)
        self.port = self.server.server_port
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

        # Trust our self-signed cert like a real CA, but leave check_hostname ON (the default) —
        # this proves the fix relies on the default context's built-in hostname/cert verification
        # (server_hostname = self.host = the ORIGINAL hostname, unchanged by pinning), not on the
        # now-removed check_hostname= kwarg this MAJOR deletes.
        client_ctx = ssl.create_default_context(cafile=self.certfile)
        self._ctx_patch = mock.patch("ssl._create_default_https_context", return_value=client_ctx)
        self._ctx_patch.start()

    def tearDown(self):
        self._ctx_patch.stop()
        self.server.shutdown()
        self.thread.join(timeout=2)
        dh._PINNED_IP_CACHE = {}

    def test_pinned_https_request_completes_with_real_tls_verification(self):
        dh._PINNED_IP_CACHE[self.FAKE_HOST] = ["127.0.0.1"]
        status, data = dh.http_json("GET", f"https://{self.FAKE_HOST}:{self.port}/probe")
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"])
        # Reached only via the pinned IP (FAKE_HOST cannot resolve via real DNS) and TLS/hostname
        # verification passed (cert CN/SAN matches the original hostname used as server_hostname).
        self.assertEqual(self.received["path"], "/probe")
        self.assertEqual(self.received["host_header"], f"{self.FAKE_HOST}:{self.port}")


if __name__ == "__main__":
    unittest.main()
