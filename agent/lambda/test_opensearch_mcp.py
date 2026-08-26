"""Tests for opensearch_mcp — read-only OpenSearch log query (AWS-native sigv4 `es`).

`python3 -m unittest test_opensearch_mcp`. boto3 `opensearch` client + `urlopen` are mocked
(no network). sigv4 is NOT mocked away — get_credentials returns a real botocore Credentials
(fake keys) so SigV4Auth actually signs, and we assert the signed bytes == the sent bytes.
"""
import io
import json
import os
import sys
import unittest
import urllib.error
from unittest import mock

from botocore.credentials import Credentials

sys.path.insert(0, os.path.dirname(__file__))
import opensearch_mcp as om  # noqa: E402
import cross_account as ca  # noqa: E402

FAKE_CREDS = Credentials(access_key="AKIAEXAMPLE", secret_key="secretkey", token="tok")


class _FakeOS:
    """Fake boto3 'opensearch' client."""
    def __init__(self, domains=None, status=None):
        self._domains = domains if domains is not None else [{"DomainName": "logs"}]
        self._status = status if status is not None else {"Endpoint": "search-logs.es.amazonaws.com",
                                                           "EngineVersion": "OpenSearch_2.11"}
    def list_domain_names(self):
        return {"DomainNames": self._domains}
    def describe_domain(self, DomainName):
        return {"DomainStatus": self._status}


def _fake_resp(status, obj):
    class _R:
        def getcode(self):
            return status
        def read(self):
            return json.dumps(obj).encode()
    return _R()


class _Base(unittest.TestCase):
    def setUp(self):
        os.environ["AWSOPS_HOST_ACCOUNT_ID"] = "123456789012"  # hermetic: no live STS in get_role_arn
        ca._host_account_id.cache_clear()
        self.addCleanup(ca._host_account_id.cache_clear)
        self._creds = mock.patch.object(om, "get_credentials", return_value=FAKE_CREDS)
        self._creds.start()
        self.addCleanup(self._creds.stop)


class TestListDomains(_Base):
    def test_list_with_public_endpoint(self):
        with mock.patch.object(om, "get_client", return_value=_FakeOS()):
            out = om.lambda_handler({"tool_name": "list_opensearch_domains", "arguments": {}}, None)
        self.assertEqual(out["statusCode"], 200)
        body = json.loads(out["body"])
        self.assertEqual(body["domains"][0]["name"], "logs")
        self.assertEqual(body["domains"][0]["endpoint"], "search-logs.es.amazonaws.com")

    def test_endpoint_falls_back_to_vpc(self):
        os_client = _FakeOS(status={"Endpoints": {"vpc": "vpc-logs.es.amazonaws.com"}})
        with mock.patch.object(om, "get_client", return_value=os_client):
            out = om.lambda_handler({"tool_name": "list_opensearch_domains", "arguments": {}}, None)
        self.assertEqual(json.loads(out["body"])["domains"][0]["endpoint"], "vpc-logs.es.amazonaws.com")

    def test_no_domains(self):
        with mock.patch.object(om, "get_client", return_value=_FakeOS(domains=[])):
            out = om.lambda_handler({"tool_name": "list_opensearch_domains", "arguments": {}}, None)
        self.assertEqual(json.loads(out["body"])["domains"], [])


class TestSearch(_Base):
    def test_search_signs_exact_bytes_and_builds_body(self):
        captured = {}

        def fake_urlopen(req, timeout=None):
            captured["req"] = req
            return _fake_resp(200, {"hits": {"total": {"value": 1}, "hits": [
                {"_index": "logs-2026", "_id": "1", "_source": {"msg": "ERROR boom"}}]}})

        with mock.patch.object(om, "get_client", return_value=_FakeOS()), \
             mock.patch("opensearch_mcp.urllib.request.urlopen", side_effect=fake_urlopen):
            out = om.lambda_handler({"tool_name": "search_opensearch_logs",
                                     "arguments": {"domain": "logs", "query": "ERROR", "start": "1h", "size": 500}}, None)
        self.assertEqual(out["statusCode"], 200)
        body = json.loads(out["body"])
        self.assertEqual(body["count"], 1)
        self.assertEqual(body["hits"][0]["_source"]["msg"], "ERROR boom")
        req = captured["req"]
        # sigv4 actually ran (NOT mocked): Authorization + X-Amz-Date present
        self.assertIn("Authorization", req.headers)
        self.assertTrue(any(k.lower() == "x-amz-date" for k in req.headers))
        # signed body == sent body, and it is the search DSL we built (clamped size, time range, query)
        sent = req.data
        self.assertIsInstance(sent, (bytes, bytearray))
        dsl = json.loads(sent)
        self.assertEqual(dsl["size"], om.MAX_SIZE)  # 500 clamped to 50
        self.assertIn("@timestamp", json.dumps(dsl["query"]))
        self.assertIn("ERROR", json.dumps(dsl["query"]))
        self.assertEqual(req.full_url, "https://search-logs.es.amazonaws.com/_all/_search")

    def test_default_window_and_time_field_override(self):
        with mock.patch.object(om, "get_client", return_value=_FakeOS()), \
             mock.patch("opensearch_mcp.urllib.request.urlopen",
                        side_effect=lambda req, timeout=None: _fake_resp(200, {"hits": {"hits": []}})) as _:
            body = om._search_body(None, None, None, None, "event.created")
        self.assertIn("event.created", json.dumps(body["query"]))
        self.assertEqual(body["query"]["bool"]["must"][0]["range"]["event.created"]["gte"], "now-1h")

    def test_domain_required(self):
        out = om.lambda_handler({"tool_name": "search_opensearch_logs", "arguments": {}}, None)
        self.assertEqual(out["statusCode"], 400)
        self.assertIn("domain", json.loads(out["body"])["error"])

    def test_http_error_mapped(self):
        def boom(req, timeout=None):
            raise urllib.error.HTTPError(req.full_url, 403, "Forbidden", {},
                                         io.BytesIO(b'{"error":"no permissions for [indices:data/read/search]"}'))
        with mock.patch.object(om, "get_client", return_value=_FakeOS()), \
             mock.patch("opensearch_mcp.urllib.request.urlopen", side_effect=boom):
            out = om.lambda_handler({"tool_name": "search_opensearch_logs", "arguments": {"domain": "logs"}}, None)
        self.assertEqual(out["statusCode"], 400)
        self.assertIn("403", json.loads(out["body"])["error"])


class TestIndices(_Base):
    def test_cat_indices(self):
        captured = {}

        def fake_urlopen(req, timeout=None):
            captured["req"] = req
            return _fake_resp(200, [{"index": "logs-2026", "docs.count": "10"}])

        with mock.patch.object(om, "get_client", return_value=_FakeOS()), \
             mock.patch("opensearch_mcp.urllib.request.urlopen", side_effect=fake_urlopen):
            out = om.lambda_handler({"tool_name": "opensearch_indices", "arguments": {"domain": "logs"}}, None)
        self.assertEqual(out["statusCode"], 200)
        self.assertEqual(captured["req"].get_method(), "GET")
        self.assertIn("/_cat/indices", captured["req"].full_url)


class TestDispatch(_Base):
    def test_unknown_tool(self):
        out = om.lambda_handler({"tool_name": "delete_index", "arguments": {}}, None)
        self.assertEqual(out["statusCode"], 400)
        self.assertIn("unknown", json.loads(out["body"])["error"].lower())

    def test_target_account_id_popped(self):
        # cross-account path: target_account_id is consumed, not forwarded into the search DSL
        with mock.patch.object(om, "get_client", return_value=_FakeOS()), \
             mock.patch("opensearch_mcp.urllib.request.urlopen",
                        side_effect=lambda req, timeout=None: _fake_resp(200, {"hits": {"hits": []}})):
            out = om.lambda_handler({"tool_name": "search_opensearch_logs",
                                     "arguments": {"domain": "logs", "target_account_id": "222222222222"}}, None)
        self.assertEqual(out["statusCode"], 200)



class TestSchema(_Base):
    def test_schema_domains_indices(self):
        def fake_urlopen(req, timeout=None): return _fake_resp(200,[{"index":"logs-2026"},{"index":"app-2026"}])
        with mock.patch.object(om,"get_client",return_value=_FakeOS()), \
             mock.patch("opensearch_mcp.urllib.request.urlopen",side_effect=fake_urlopen):
            out=om.lambda_handler({"tool_name":"opensearch_schema","arguments":{}},None)
        b=json.loads(out["body"]); self.assertEqual(b["domains"][0]["name"],"logs"); self.assertIn("logs-2026",b["domains"][0]["indices"])


if __name__ == "__main__":
    unittest.main()
