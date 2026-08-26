"""Task 12 — per-kind *_health tools resolve the inline conn-config and probe the right path.

NOTE: prometheus_mcp/clickhouse_mcp import assert_host_allowed/http_json BY NAME, so each module's
binding must be patched (patching datasource_http.* alone does not affect the already-bound names).
health() itself lives in datasource_http, so its http_json/assert_host_allowed are patched there too."""
import os
import sys
import json
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lambda"))

import datasource_http as dh  # noqa: E402
import prometheus_mcp  # noqa: E402
import clickhouse_mcp  # noqa: E402
import loki_mcp  # noqa: E402


class TestHealthTools(unittest.TestCase):
    def tearDown(self):
        dh.set_request_conn(None)

    def test_prometheus_health_uses_inline_conn_and_probes_healthy(self):
        with mock.patch.object(prometheus_mcp, "assert_host_allowed"), \
             mock.patch.object(dh, "assert_host_allowed"), \
             mock.patch.object(dh, "http_json", return_value=(200, {})) as hj:
            resp = prometheus_mcp.lambda_handler(
                {"tool_name": "prometheus_health", "arguments": {}, "conn_config": {"endpoint": "http://p:9090", "authType": "none"}},
                None,
            )
        self.assertEqual(resp["statusCode"], 200)
        self.assertTrue(json.loads(resp["body"])["ok"])
        self.assertTrue(hj.call_args[0][1].endswith("/-/healthy"))  # GET <endpoint>/-/healthy

    def test_clickhouse_health_probes_ping(self):
        with mock.patch.object(dh, "assert_host_allowed"), \
             mock.patch.object(dh, "http_json", return_value=(200, {})) as hj:
            resp = clickhouse_mcp.lambda_handler(
                {"tool_name": "clickhouse_health", "arguments": {}, "conn_config": {"endpoint": "http://ch:8123", "authType": "basic", "username": "u", "password": "p"}},
                None,
            )
        self.assertEqual(resp["statusCode"], 200)
        self.assertTrue(json.loads(resp["body"])["ok"])
        self.assertTrue(hj.call_args[0][1].endswith("/ping"))

    def test_loki_health_probes_ready(self):
        with mock.patch.object(dh, "assert_host_allowed"), \
             mock.patch.object(dh, "http_json", return_value=(200, {})) as hj:
            resp = loki_mcp.lambda_handler(
                {"tool_name": "loki_health", "arguments": {}, "conn_config": {"endpoint": "http://loki:3100", "authType": "none", "org_id": "t1"}},
                None,
            )
        self.assertEqual(resp["statusCode"], 200)
        self.assertTrue(json.loads(resp["body"])["ok"])
        self.assertTrue(hj.call_args[0][1].endswith("/ready"))

    def test_health_reports_failure_on_http_error(self):
        with mock.patch.object(prometheus_mcp, "assert_host_allowed"), \
             mock.patch.object(dh, "assert_host_allowed"), \
             mock.patch.object(dh, "http_json", return_value=(502, {})):
            resp = prometheus_mcp.lambda_handler(
                {"tool_name": "prometheus_health", "conn_config": {"endpoint": "http://p:9090"}}, None,
            )
        self.assertFalse(json.loads(resp["body"])["ok"])


if __name__ == "__main__":
    unittest.main()
