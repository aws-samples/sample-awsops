"""Tests for notion_mcp Lambda — read-only Notion MCP tools (M1 gateway target).

Runs with `python3 -m unittest test_notion_mcp` (no pytest dependency). All HTTP and
Secrets Manager access is mocked at module seams (`_urlopen`, `_get_secret_string`) —
no network, no boto3 calls.
"""
import io
import json
import os
import sys
import unittest
import urllib.error
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import notion_mcp as nm  # noqa: E402


def _resp(status, obj):
    """Build a fake (_urlopen) return: (status, body_bytes)."""
    return status, json.dumps(obj).encode()


def _body_of(req):
    return json.loads(req.data.decode()) if req.data else None


class _Base(unittest.TestCase):
    def setUp(self):
        nm._TOKEN = None  # reset warm-container token cache between tests
        # default: single-secret map with this connector's slug ("notion") configured
        self._sec = mock.patch.object(nm, "_get_secret_string",
                                      return_value='{"notion":{"token":"secret_tok"},"datadog":{"api_key":"d"}}')
        self._sec.start()
        self.addCleanup(self._sec.stop)


class TestSearch(_Base):
    def test_search_builds_request(self):
        captured = {}

        def fake_urlopen(req, timeout=None):
            captured["req"] = req
            return _resp(200, {"results": [{"id": "p1", "object": "page"}]})

        with mock.patch.object(nm, "_urlopen", side_effect=fake_urlopen):
            out = nm.lambda_handler({"tool_name": "notion_search",
                                     "arguments": {"query": "runbook", "page_size": 500}}, None)
        self.assertEqual(out["statusCode"], 200)
        req = captured["req"]
        self.assertEqual(req.full_url, "https://api.notion.com/v1/search")
        self.assertEqual(req.get_method(), "POST")
        # auth + version headers (urllib lowercases header keys)
        # urllib stores header keys via str.capitalize() ("Notion-Version" -> "Notion-version");
        # HTTP headers are case-insensitive so the wire request is correct.
        self.assertEqual(req.get_header("Authorization"), "Bearer secret_tok")
        self.assertEqual(req.get_header("Notion-version"), "2022-06-28")
        b = _body_of(req)
        self.assertEqual(b["query"], "runbook")
        self.assertEqual(b["page_size"], 25)  # clamped from 500 to ceiling


class TestFetchPage(_Base):
    def test_fetch_page_merges_and_bounds_children(self):
        # one page, then children with >ceiling blocks + has_more
        big = {"results": [{"id": f"b{i}", "type": "paragraph"} for i in range(40)], "has_more": True}
        seq = [_resp(200, {"id": "pg", "object": "page"}), _resp(200, big)]
        calls = []

        def fake_urlopen(req, timeout=None):
            calls.append((req.get_method(), req.full_url))
            return seq.pop(0)

        with mock.patch.object(nm, "_urlopen", side_effect=fake_urlopen):
            out = nm.lambda_handler({"tool_name": "notion_fetch_page",
                                     "arguments": {"page_id": "pg", "page_size": 100}}, None)
        self.assertEqual(out["statusCode"], 200)
        body = json.loads(out["body"])
        self.assertEqual(body["page"]["id"], "pg")
        self.assertLessEqual(len(body["blocks"]), nm.MAX_PAGE_SIZE)  # bounded
        self.assertTrue(body["truncated"])
        # GET pages/{id} then GET blocks/{id}/children (bounded, no auto-follow)
        self.assertEqual(calls[0], ("GET", "https://api.notion.com/v1/pages/pg"))
        self.assertEqual(calls[1][0], "GET")
        self.assertIn("/blocks/pg/children", calls[1][1])
        self.assertEqual(len(calls), 2)  # did NOT follow has_more

    def test_fetch_page_requires_page_id(self):
        out = nm.lambda_handler({"tool_name": "notion_fetch_page", "arguments": {}}, None)
        self.assertEqual(out["statusCode"], 400)
        self.assertIn("page_id", json.loads(out["body"])["error"])


class TestQueryDatabase(_Base):
    def test_query_database_builds_request(self):
        captured = {}

        def fake_urlopen(req, timeout=None):
            captured["req"] = req
            return _resp(200, {"results": []})

        with mock.patch.object(nm, "_urlopen", side_effect=fake_urlopen):
            out = nm.lambda_handler({"tool_name": "notion_query_database",
                                     "arguments": {"database_id": "db1"}}, None)
        self.assertEqual(out["statusCode"], 200)
        req = captured["req"]
        self.assertEqual(req.full_url, "https://api.notion.com/v1/databases/db1/query")
        self.assertEqual(req.get_method(), "POST")
        self.assertEqual(_body_of(req)["page_size"], nm.DEFAULT_PAGE_SIZE)  # default


class TestClamp(_Base):
    def test_clamp(self):
        self.assertEqual(nm._clamp_page_size(500), nm.MAX_PAGE_SIZE)
        self.assertEqual(nm._clamp_page_size("7"), 7)      # accepts str
        self.assertEqual(nm._clamp_page_size(None), nm.DEFAULT_PAGE_SIZE)
        self.assertEqual(nm._clamp_page_size("garbage"), nm.DEFAULT_PAGE_SIZE)
        self.assertEqual(nm._clamp_page_size(0), 1)        # floor


class TestErrors(_Base):
    def test_missing_secret_not_configured(self):
        with mock.patch.object(nm, "_get_secret_string", return_value="  "):
            out = nm.lambda_handler({"tool_name": "notion_search", "arguments": {"query": "x"}}, None)
        self.assertEqual(out["statusCode"], 400)
        self.assertIn("not configured", json.loads(out["body"])["error"].lower())

    def test_slug_missing_from_map(self):
        # secret exists but this connector's slug ("notion") is absent → not configured
        with mock.patch.object(nm, "_get_secret_string", return_value='{"datadog":{"api_key":"d"}}'):
            out = nm.lambda_handler({"tool_name": "notion_search", "arguments": {"query": "x"}}, None)
        self.assertEqual(out["statusCode"], 400)
        self.assertIn("not configured", json.loads(out["body"])["error"].lower())

    def test_notion_api_error_mapped(self):
        def boom(req, timeout=None):
            raise urllib.error.HTTPError(req.full_url, 401, "Unauthorized", {},
                                         io.BytesIO(b'{"message":"API token is invalid."}'))

        with mock.patch.object(nm, "_urlopen", side_effect=boom):
            out = nm.lambda_handler({"tool_name": "notion_search", "arguments": {"query": "x"}}, None)
        self.assertEqual(out["statusCode"], 400)
        msg = json.loads(out["body"])["error"]
        self.assertIn("401", msg)

    def test_unknown_tool(self):
        out = nm.lambda_handler({"tool_name": "notion_delete_everything", "arguments": {}}, None)
        self.assertEqual(out["statusCode"], 400)
        self.assertIn("unknown", json.loads(out["body"])["error"].lower())


class TestGatewayContract(_Base):
    def test_target_account_id_is_ignored(self):
        def fake_urlopen(req, timeout=None):
            return _resp(200, {"results": []})

        with mock.patch.object(nm, "_urlopen", side_effect=fake_urlopen):
            # gateway injects target_account_id into arguments — must be popped, no cross-account call
            out = nm.lambda_handler({"tool_name": "notion_search",
                                     "arguments": {"query": "x", "target_account_id": "123456789012"}}, None)
        self.assertEqual(out["statusCode"], 200)

    def test_token_cached_across_calls(self):
        sec = mock.Mock(return_value='{"notion":{"token":"secret_tok"}}')
        with mock.patch.object(nm, "_get_secret_string", sec), \
             mock.patch.object(nm, "_urlopen", side_effect=lambda req, timeout=None: _resp(200, {"results": []})):
            nm.lambda_handler({"tool_name": "notion_search", "arguments": {"query": "a"}}, None)
            nm.lambda_handler({"tool_name": "notion_search", "arguments": {"query": "b"}}, None)
        self.assertEqual(sec.call_count, 1)  # warm-container cache → fetched once


if __name__ == "__main__":
    unittest.main()
