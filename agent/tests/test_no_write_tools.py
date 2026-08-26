"""Task 22 — connector Lambdas stay READ-ONLY and never leak the credential in an error.

Freeze guard: Notion + the 5 datasource connectors must expose ONLY read/query/health tools — no
mutating verb is reachable. And a connector error envelope must not echo the credential material."""
import os
import sys
import json
import re
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lambda"))

import datasource_http as dh  # noqa: E402
import notion_mcp  # noqa: E402
import prometheus_mcp  # noqa: E402
import clickhouse_mcp  # noqa: E402
import loki_mcp  # noqa: E402
import tempo_mcp  # noqa: E402
import mimir_mcp  # noqa: E402

MUTATING = re.compile(r"(create|update|delete|insert|drop|alter|write|put|post|remove|exec|mutat|set_)", re.I)
READ_OK = re.compile(r"(query|search|labels?|series|values?|tables?|describe|schema|fetch|get|health|ready|range|tags?|trace|meta)", re.I)


class TestReadOnlyTools(unittest.TestCase):
    def test_no_mutating_tool_names(self):
        for mod in (notion_mcp, prometheus_mcp, clickhouse_mcp, loki_mcp, tempo_mcp, mimir_mcp):
            for name in mod._TOOLS.keys():
                self.assertFalse(MUTATING.search(name), f"{mod.__name__}: mutating tool {name!r}")
                self.assertTrue(READ_OK.search(name), f"{mod.__name__}: {name!r} lacks a read-only verb")

    def test_notion_is_search_fetch_query_only(self):
        self.assertEqual(
            set(notion_mcp._TOOLS.keys()),
            {"notion_search", "notion_fetch_page", "notion_query_database"},
        )


class TestNoCredentialLeak(unittest.TestCase):
    def tearDown(self):
        dh.set_request_conn(None)

    def test_connector_error_does_not_echo_the_token(self):
        secret = "secret_TOKEN_should_never_appear"
        with mock.patch.object(prometheus_mcp, "assert_host_allowed"), \
             mock.patch.object(prometheus_mcp, "http_json", return_value=(500, {"error": "boom"})):
            resp = prometheus_mcp.lambda_handler(
                {"tool_name": "prometheus_query", "arguments": {"query": "up"},
                 "conn_config": {"endpoint": "http://p:9090", "authType": "bearer", "token": secret}},
                None,
            )
        self.assertNotIn(secret, json.dumps(resp))


if __name__ == "__main__":
    unittest.main()
