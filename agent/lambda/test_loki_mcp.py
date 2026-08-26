"""Tests for loki_mcp — read-only LogQL connector on datasource_http (ns time, X-Scope-OrgID)."""
import json, os, sys, unittest
from unittest import mock
from urllib.parse import urlparse, parse_qs
sys.path.insert(0, os.path.dirname(__file__))
import loki_mcp as lm  # noqa: E402

DS = {"endpoint": "http://loki:3100", "token": "tok"}
def _qs(url): return parse_qs(urlparse(url).query)

class _Base(unittest.TestCase):
    def setUp(self):
        for name in ("load_datasource", "assert_host_allowed"):
            p = mock.patch.object(lm, name, return_value=DS if name == "load_datasource" else None)
            p.start(); self.addCleanup(p.stop)

class TestQuery(_Base):
    def test_range_ns_window_and_encoding(self):
        cap = {}
        with mock.patch.object(lm, "http_json", side_effect=lambda m,u,headers=None,body=None,timeout=None:(cap.update(url=u,headers=headers) or (200,{"status":"success","data":{"resultType":"streams","result":[]}}))):
            out = lm.lambda_handler({"tool_name":"loki_query_range","arguments":{"query":'{app="x"} |= "err"'}}, None)
        self.assertEqual(out["statusCode"],200)
        q=_qs(cap["url"]); self.assertIn("/loki/api/v1/query_range",cap["url"])
        self.assertEqual(q["query"][0], '{app="x"} |= "err"')
        self.assertEqual(q["limit"][0],"100"); self.assertEqual(q["direction"][0],"backward")
        start,end=int(q["start"][0]),int(q["end"][0])
        self.assertGreater(start, 10**18)  # nanoseconds magnitude
        self.assertAlmostEqual((end-start)/1e9, 3600, delta=5)  # ~1h window in ns

    def test_instant(self):
        cap={}
        with mock.patch.object(lm,"http_json",side_effect=lambda m,u,headers=None,body=None,timeout=None:(cap.update(url=u) or (200,{"status":"success","data":{"resultType":"streams","result":[]}}))):
            lm.lambda_handler({"tool_name":"loki_query","arguments":{"query":"{app=\"x\"}"}}, None)
        self.assertIn("/loki/api/v1/query", cap["url"]); self.assertNotIn("query_range", cap["url"])

    def test_status_not_success(self):
        with mock.patch.object(lm,"http_json",return_value=(200,{"status":"error","error":"parse error"})):
            out=lm.lambda_handler({"tool_name":"loki_query","arguments":{"query":"{"}}, None)
        self.assertEqual(out["statusCode"],400); self.assertIn("parse error",json.loads(out["body"])["error"])

class TestLabels(_Base):
    def test_labels_and_values(self):
        cap={}
        def fake(m,u,headers=None,body=None,timeout=None): cap["url"]=u; return 200,{"status":"success","data":["app","job"]}
        with mock.patch.object(lm,"http_json",side_effect=fake):
            lm.lambda_handler({"tool_name":"loki_labels","arguments":{}}, None); self.assertIn("/loki/api/v1/labels",cap["url"])
            lm.lambda_handler({"tool_name":"loki_label_values","arguments":{"label":"app"}}, None); self.assertIn("/loki/api/v1/label/app/values",cap["url"])
    def test_label_values_requires_label(self):
        self.assertEqual(lm.lambda_handler({"tool_name":"loki_label_values","arguments":{}},None)["statusCode"],400)

class TestOrgId(_Base):
    def test_org_id_header(self):
        cap={}
        with mock.patch.object(lm,"load_datasource",return_value={**DS,"org_id":"tenant-7"}), \
             mock.patch.object(lm,"http_json",side_effect=lambda m,u,headers=None,body=None,timeout=None:(cap.update(h=headers) or (200,{"status":"success","data":{"result":[]}}))):
            lm.lambda_handler({"tool_name":"loki_labels","arguments":{}}, None)
        self.assertEqual(cap["h"]["X-Scope-OrgID"],"tenant-7"); self.assertEqual(cap["h"]["Authorization"],"Bearer tok")
    def test_no_org_id_header_absent(self):
        cap={}
        with mock.patch.object(lm,"http_json",side_effect=lambda m,u,headers=None,body=None,timeout=None:(cap.update(h=headers) or (200,{"status":"success","data":{"result":[]}}))):
            lm.lambda_handler({"tool_name":"loki_labels","arguments":{}}, None)
        self.assertNotIn("X-Scope-OrgID", cap["h"])

class TestBounding(_Base):
    def test_streams_lines_and_bytes_bounded(self):
        big={"status":"success","data":{"resultType":"streams","result":[{"stream":{"i":str(i)},"values":[[str(t),"x"*100] for t in range(400)]} for i in range(100)]}}
        with mock.patch.object(lm,"http_json",return_value=(200,big)):
            out=lm.lambda_handler({"tool_name":"loki_query_range","arguments":{"query":"{a=\"b\"}"}}, None)
        body=json.loads(out["body"]); self.assertTrue(body["truncated"])
        self.assertLessEqual(len(body["result"]), lm.MAX_STREAMS)
        total_bytes=sum(len(v[1]) for s in body["result"] for v in s.get("values",[]))
        self.assertLessEqual(total_bytes, lm.MAX_TOTAL_BYTES + 4096)  # within budget (+1 oversized-line slack)
    def test_multibyte_line_bounded_by_bytes(self):
        # Korean/UTF-8 lines must be budgeted by encoded bytes, not code points
        big={"status":"success","data":{"resultType":"streams","result":[{"stream":{},"values":[[str(t),"오류"*5000] for t in range(50)]}]}}
        with mock.patch.object(lm,"http_json",return_value=(200,big)):
            out=lm.lambda_handler({"tool_name":"loki_query_range","arguments":{"query":"{a=\"b\"}"}}, None)
        body=json.loads(out["body"]); self.assertTrue(body["truncated"])
        total=sum(len(v[1].encode("utf-8")) for s in body["result"] for v in s.get("values",[]))
        self.assertLessEqual(total, lm.MAX_TOTAL_BYTES + lm.MAX_LINE_BYTES)

    def test_oversized_single_line_capped(self):
        big={"status":"success","data":{"resultType":"streams","result":[{"stream":{},"values":[["1","Z"*50000]]}]}}
        with mock.patch.object(lm,"http_json",return_value=(200,big)):
            out=lm.lambda_handler({"tool_name":"loki_query_range","arguments":{"query":"{a=\"b\"}"}}, None)
        body=json.loads(out["body"])
        self.assertLessEqual(len(body["result"][0]["values"][0][1]), lm.MAX_LINE_BYTES + 32)

class TestGuards(_Base):
    def test_not_connected(self):
        with mock.patch.object(lm,"load_datasource",side_effect=lm.NotConnected("loki not connected")):
            self.assertEqual(lm.lambda_handler({"tool_name":"loki_query","arguments":{"query":"{}"}},None)["statusCode"],400)
    def test_ssrf(self):
        with mock.patch.object(lm,"assert_host_allowed",side_effect=lm.SsrfBlocked("endpoint blocked")):
            self.assertEqual(lm.lambda_handler({"tool_name":"loki_query","arguments":{"query":"{}"}},None)["statusCode"],400)
    def test_target_account_id_popped(self):
        with mock.patch.object(lm,"http_json",return_value=(200,{"status":"success","data":{"result":[]}})):
            self.assertEqual(lm.lambda_handler({"tool_name":"loki_query","arguments":{"query":"{}","target_account_id":"222222222222"}},None)["statusCode"],200)
    def test_unknown_tool(self):
        self.assertEqual(lm.lambda_handler({"tool_name":"loki_push","arguments":{}},None)["statusCode"],400)


class TestSchema(_Base):
    def test_schema_labels(self):
        with mock.patch.object(lm,"http_json",return_value=(200,{"status":"success","data":["app","job"]})):
            out=lm.lambda_handler({"tool_name":"loki_schema","arguments":{}},None)
        import json as _j; self.assertEqual(_j.loads(out["body"])["labels"],["app","job"])


class TestSchemaVersion(_Base):
    def test_schema_version_and_instance_id(self):
        seq=[(200,{"status":"success","data":{"version":"3.0.0"}}),(200,{"status":"success","data":["app","level"]})]
        with mock.patch.object(lm,"http_json",side_effect=lambda *a,**k: seq.pop(0)):
            out=lm.lambda_handler({"tool_name":"loki_schema","arguments":{}},None)
        b=json.loads(out["body"]); self.assertEqual(b["version"],"3.0.0"); self.assertIn("app",b["labels"])

    def test_instance_id_credential_blind(self):
        lm.load_datasource.reset_mock()
        with mock.patch.object(lm,"http_json",return_value=(200,{"status":"success","data":["app"]})):
            out=lm.lambda_handler({"tool_name":"loki_labels","arguments":{"instance_id":7}},None)
        self.assertEqual(out["statusCode"],200); lm.load_datasource.assert_any_call(lm.SLUG, instance_id=7)


if __name__=="__main__": unittest.main()
