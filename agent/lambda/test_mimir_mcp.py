"""Tests for mimir_mcp — read-only PromQL @ /prometheus + X-Scope-OrgID on datasource_http."""
import json, os, sys, unittest
from unittest import mock
from urllib.parse import urlparse, parse_qs
sys.path.insert(0, os.path.dirname(__file__))
import mimir_mcp as mm  # noqa: E402
DS={"endpoint":"http://mimir:8080","org_id":"t1"}
def _qs(u): return parse_qs(urlparse(u).query)

class _Base(unittest.TestCase):
    def setUp(self):
        for name in ("load_datasource","assert_host_allowed"):
            p=mock.patch.object(mm,name,return_value=DS if name=="load_datasource" else None); p.start(); self.addCleanup(p.stop)

class TestQuery(_Base):
    def test_query_prefix_and_orgid(self):
        cap={}
        with mock.patch.object(mm,"http_json",side_effect=lambda m,u,headers=None,body=None,timeout=None:(cap.update(url=u,h=headers) or (200,{"status":"success","data":{"resultType":"vector","result":[]}}))):
            out=mm.lambda_handler({"tool_name":"mimir_query","arguments":{"query":"up"}},None)
        self.assertEqual(out["statusCode"],200)
        self.assertIn("/prometheus/api/v1/query", cap["url"]); self.assertNotIn("query_range", cap["url"])
        self.assertEqual(_qs(cap["url"])["query"][0],"up")
        self.assertEqual(cap["h"]["X-Scope-OrgID"],"t1")
    def test_range_seconds_window(self):
        cap={}
        with mock.patch.object(mm,"http_json",side_effect=lambda m,u,headers=None,body=None,timeout=None:(cap.update(url=u) or (200,{"status":"success","data":{"resultType":"matrix","result":[]}}))):
            mm.lambda_handler({"tool_name":"mimir_query_range","arguments":{"query":"up"}},None)
        q=_qs(cap["url"]); self.assertIn("/prometheus/api/v1/query_range",cap["url"])
        self.assertLess(int(q["start"][0]),10**11); self.assertEqual(q["step"][0],"60")
    def test_no_orgid_header_absent(self):
        cap={}
        with mock.patch.object(mm,"load_datasource",return_value={"endpoint":"http://mimir:8080"}), \
             mock.patch.object(mm,"http_json",side_effect=lambda m,u,headers=None,body=None,timeout=None:(cap.update(h=headers) or (200,{"status":"success","data":{"result":[]}}))):
            mm.lambda_handler({"tool_name":"mimir_labels","arguments":{}},None)
        self.assertNotIn("X-Scope-OrgID", cap["h"])
    def test_status_not_success(self):
        with mock.patch.object(mm,"http_json",return_value=(200,{"status":"error","error":"bad"})):
            self.assertEqual(mm.lambda_handler({"tool_name":"mimir_query","arguments":{"query":"up("}},None)["statusCode"],400)

class TestLabelsSeries(_Base):
    def test_labels_series(self):
        cap={}
        def fake(m,u,headers=None,body=None,timeout=None): cap["url"]=u; return 200,{"status":"success","data":[]}
        with mock.patch.object(mm,"http_json",side_effect=fake):
            mm.lambda_handler({"tool_name":"mimir_labels","arguments":{}},None); self.assertIn("/prometheus/api/v1/labels",cap["url"])
            mm.lambda_handler({"tool_name":"mimir_series","arguments":{"match":"up"}},None); self.assertIn("/prometheus/api/v1/series",cap["url"]); self.assertIn("match[]",_qs(cap["url"]))
    def test_series_requires_match(self):
        self.assertEqual(mm.lambda_handler({"tool_name":"mimir_series","arguments":{}},None)["statusCode"],400)

class TestBounding(_Base):
    def test_matrix_bounded(self):
        big={"status":"success","data":{"resultType":"matrix","result":[{"metric":{"i":str(i)},"values":[[t,"1"] for t in range(2000)]} for i in range(200)]}}
        with mock.patch.object(mm,"http_json",return_value=(200,big)):
            out=mm.lambda_handler({"tool_name":"mimir_query_range","arguments":{"query":"up"}},None)
        b=json.loads(out["body"]); self.assertTrue(b["truncated"]); self.assertLessEqual(len(b["result"]),mm.MAX_SERIES)

class TestGuards(_Base):
    def test_not_connected(self):
        with mock.patch.object(mm,"load_datasource",side_effect=mm.NotConnected("mimir not connected")):
            self.assertEqual(mm.lambda_handler({"tool_name":"mimir_query","arguments":{"query":"up"}},None)["statusCode"],400)
    def test_ssrf(self):
        with mock.patch.object(mm,"assert_host_allowed",side_effect=mm.SsrfBlocked("endpoint blocked")):
            self.assertEqual(mm.lambda_handler({"tool_name":"mimir_query","arguments":{"query":"up"}},None)["statusCode"],400)
    def test_target_account_id_popped(self):
        with mock.patch.object(mm,"http_json",return_value=(200,{"status":"success","data":{"result":[]}})):
            self.assertEqual(mm.lambda_handler({"tool_name":"mimir_query","arguments":{"query":"up","target_account_id":"222222222222"}},None)["statusCode"],200)
    def test_unknown_tool(self):
        self.assertEqual(mm.lambda_handler({"tool_name":"mimir_push","arguments":{}},None)["statusCode"],400)


class TestSchema(_Base):
    def test_schema_metrics_labels_and_version(self):
        # schema now probes buildinfo FIRST, then labels, then metrics.
        seq=[(200,{"status":"success","data":{"version":"2.11.0"}}),    # buildinfo
             (200,{"status":"success","data":["job","instance"]}),       # labels
             (200,{"status":"success","data":["up","http_requests_total"]})]  # metrics
        with mock.patch.object(mm,"http_json",side_effect=lambda *a,**k: seq.pop(0)):
            out=mm.lambda_handler({"tool_name":"mimir_schema","arguments":{}},None)
        import json as _j; b=_j.loads(out["body"])
        self.assertEqual(out["statusCode"],200)
        self.assertIn("metrics",b); self.assertIn("labels",b)
        self.assertEqual(b["version"],"2.11.0")  # captured for version-aware PromQL

    def test_instance_id_resolves_per_instance_credential_blind(self):
        mm.load_datasource.reset_mock()
        with mock.patch.object(mm,"http_json",return_value=(200,{"status":"success","data":{"resultType":"vector","result":[]}})):
            out=mm.lambda_handler({"tool_name":"mimir_query","arguments":{"query":"up","instance_id":7}},None)
        self.assertEqual(out["statusCode"],200)
        mm.load_datasource.assert_any_call(mm.SLUG, instance_id=7)


class TestMetricMeta(_Base):
    def test_metric_meta(self):
        cap = []
        def fake(method, url, headers=None, body=None, timeout=None):
            cap.append(url)
            import urllib.parse
            url_decoded = urllib.parse.unquote(url)
            if "metadata" in url_decoded:
                return 200, {"status": "success", "data": {"up": [{"type": "gauge"}], "http_requests": [{"type": "counter"}]}}
            elif 'up"' in url_decoded:
                return 200, {"status": "success", "data": ["instance", "job"]}
            elif 'http_requests"' in url_decoded:
                return 500, {"raw": "fail"} # skipped
            elif 'unknown"' in url_decoded:
                return 200, {"status": "success", "data": []}
            return 200, {"status": "success", "data": []}
            
        with mock.patch.object(mm, "http_json", side_effect=fake):
            out = mm.lambda_handler({"tool_name": "mimir_metric_meta", "arguments": {"metrics": ["up", "http_requests", "unknown"]}}, None)
        
        self.assertEqual(out["statusCode"], 200)
        b = json.loads(out["body"])
        
        self.assertIn("metadata", cap[0])
        self.assertEqual(len(cap), 6) # per-metric: 3 metrics × (metadata?metric= + labels)

        self.assertIn("up", b)
        self.assertEqual(b["up"]["type"], "gauge")
        self.assertEqual(b["up"]["labels"], ["instance", "job"])

        # failed label fetch surfaces an error entry (not silently dropped); type still resolved
        self.assertIn("http_requests", b)
        self.assertEqual(b["http_requests"]["type"], "counter")
        self.assertEqual(b["http_requests"]["labels"], [])
        self.assertIn("error", b["http_requests"])

        self.assertIn("unknown", b)
        self.assertIsNone(b["unknown"]["type"])
        self.assertEqual(b["unknown"]["labels"], [])

    def test_empty_metrics(self):
        out = mm.lambda_handler({"tool_name": "mimir_metric_meta", "arguments": {"metrics": []}}, None)
        self.assertEqual(json.loads(out["body"]), {})

    def test_metrics_cap(self):
        cap = []
        with mock.patch.object(mm, "http_json", return_value=(200, {"status": "success", "data": {}})) as m:
            out = mm.lambda_handler({"tool_name": "mimir_metric_meta", "arguments": {"metrics": [f"m{i}" for i in range(20)]}}, None)
        
        b = json.loads(out["body"])
        self.assertEqual(len(b), 12)
        self.assertEqual(m.call_count, 24) # per-metric: 12 × (metadata?metric= + labels)


if __name__=="__main__": unittest.main()
