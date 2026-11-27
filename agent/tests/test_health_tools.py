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

    def test_prometheus_health_uses_inline_conn_and_verifies_query(self):
        with mock.patch.object(prometheus_mcp, "assert_host_allowed"), \
             mock.patch.object(prometheus_mcp, "http_json", return_value=(200, {
                 "status": "success", "data": {"resultType": "vector", "result": [{"metric": {}, "value": [1, "1"]}]},
             })) as hj:
            resp = prometheus_mcp.lambda_handler(
                {"tool_name": "prometheus_health", "arguments": {}, "conn_config": {"endpoint": "http://p:9090", "authType": "none"}},
                None,
            )
        self.assertEqual(resp["statusCode"], 200)
        self.assertTrue(json.loads(resp["body"])["ok"])
        self.assertIn("/api/v1/query?", hj.call_args[0][1])
        self.assertIn("timeout=1s", hj.call_args[0][1])

    def test_clickhouse_health_verifies_readonly_sql(self):
        with mock.patch.object(clickhouse_mcp, "assert_host_allowed"), \
             mock.patch.object(clickhouse_mcp, "http_json", return_value=(200, {
                 "meta": [{"name": "probe", "type": "UInt8"}], "data": [{"probe": 1}], "rows": 1,
             })) as hj:
            resp = clickhouse_mcp.lambda_handler(
                {"tool_name": "clickhouse_health", "arguments": {}, "conn_config": {"endpoint": "http://ch:8123", "authType": "basic", "username": "u", "password": "p"}},
                None,
            )
        self.assertEqual(resp["statusCode"], 200)
        self.assertTrue(json.loads(resp["body"])["ok"])
        self.assertIn("readonly=1", hj.call_args[0][1])
        self.assertIn("max_execution_time=1", hj.call_args[0][1])

    def test_loki_health_verifies_tenant_query(self):
        with mock.patch.object(loki_mcp, "assert_host_allowed"), \
             mock.patch.object(loki_mcp, "http_json", return_value=(200, {
                 "status": "success", "data": {"resultType": "streams", "result": []},
             })) as hj:
            resp = loki_mcp.lambda_handler(
                {"tool_name": "loki_health", "arguments": {}, "conn_config": {"endpoint": "http://loki:3100", "authType": "none", "org_id": "t1"}},
                None,
            )
        self.assertEqual(resp["statusCode"], 200)
        self.assertTrue(json.loads(resp["body"])["ok"])
        self.assertIn("/loki/api/v1/query_range?", hj.call_args[0][1])
        self.assertEqual(hj.call_args.kwargs["headers"]["X-Scope-OrgID"], "t1")

    def test_health_reports_failure_on_http_error(self):
        with mock.patch.object(prometheus_mcp, "assert_host_allowed"), \
             mock.patch.object(prometheus_mcp, "http_json", return_value=(502, {})):
            resp = prometheus_mcp.lambda_handler(
                {"tool_name": "prometheus_health", "conn_config": {"endpoint": "http://p:9090"}}, None,
            )
        self.assertFalse(json.loads(resp["body"])["ok"])


if __name__ == "__main__":
    unittest.main()
