"""Tests for tempo_mcp — read-only TraceQL connector on datasource_http (seconds time, hex trace_id)."""
import json, os, sys, unittest
from unittest import mock
from urllib.parse import urlparse, parse_qs
sys.path.insert(0, os.path.dirname(__file__))
import tempo_mcp as tm  # noqa: E402
DS={"endpoint":"http://tempo:3200","token":"tok"}
def _qs(u): return parse_qs(urlparse(u).query)

class _Base(unittest.TestCase):
    def setUp(self):
        for name in ("load_datasource","assert_host_allowed"):
            p=mock.patch.object(tm,name,return_value=DS if name=="load_datasource" else None); p.start(); self.addCleanup(p.stop)

class TestSearch(_Base):
    def test_search_seconds_window_encoding(self):
        cap={}
        with mock.patch.object(tm,"http_json",side_effect=lambda m,u,headers=None,body=None,timeout=None:(cap.update(url=u,h=headers) or (200,{"traces":[]}))):
            out=tm.lambda_handler({"tool_name":"tempo_search","arguments":{"query":'{ .service.name="x" }'}},None)
        self.assertEqual(out["statusCode"],200)
        q=_qs(cap["url"]); self.assertIn("/api/search",cap["url"])
        self.assertEqual(q["q"][0], '{ .service.name="x" }')
        start,end=int(q["start"][0]),int(q["end"][0])
        self.assertLess(start, 10**11)  # SECONDS magnitude (not ns)
        self.assertAlmostEqual(end-start, 3600, delta=5)
    def test_no_envelope_status_still_success(self):
        # Tempo has no {status:success}; HTTP 200 with {traces:[...]} must succeed (not error)
        with mock.patch.object(tm,"http_json",return_value=(200,{"traces":[{"traceID":"a1"}]})):
            out=tm.lambda_handler({"tool_name":"tempo_search","arguments":{"query":"{}"}},None)
        self.assertEqual(out["statusCode"],200)
        self.assertEqual(len(json.loads(out["body"])["traces"]),1)
    def test_http_error(self):
        with mock.patch.object(tm,"http_json",return_value=(500,{"raw":"boom"})):
            self.assertEqual(tm.lambda_handler({"tool_name":"tempo_search","arguments":{"query":"{}"}},None)["statusCode"],400)

class TestTrace(_Base):
    def test_get_trace_hex_path(self):
        cap={}
        with mock.patch.object(tm,"http_json",side_effect=lambda m,u,headers=None,body=None,timeout=None:(cap.update(url=u) or (200,{"batches":[]}))):
            tm.lambda_handler({"tool_name":"tempo_get_trace","arguments":{"trace_id":"a1B2c3"}},None)
        self.assertTrue(cap["url"].endswith("/api/traces/a1B2c3"))
    def test_non_hex_trace_id_rejected_before_request(self):
        with mock.patch.object(tm,"http_json") as hj:
            out=tm.lambda_handler({"tool_name":"tempo_get_trace","arguments":{"trace_id":"x; rm -rf"}},None)
        self.assertEqual(out["statusCode"],400); hj.assert_not_called()

class TestTags(_Base):
    def test_tags_and_values(self):
        cap={}
        def fake(m,u,headers=None,body=None,timeout=None): cap["url"]=u; return 200,{"tagNames":["service.name"]}
        with mock.patch.object(tm,"http_json",side_effect=fake):
            tm.lambda_handler({"tool_name":"tempo_search_tags","arguments":{}},None); self.assertIn("/api/search/tags",cap["url"])
            tm.lambda_handler({"tool_name":"tempo_tag_values","arguments":{"tag":"service.name"}},None); self.assertIn("/api/search/tag/service.name/values",cap["url"])
    def test_tag_values_requires_tag(self):
        self.assertEqual(tm.lambda_handler({"tool_name":"tempo_tag_values","arguments":{}},None)["statusCode"],400)

class TestOrgId(_Base):
    def test_org_id(self):
        cap={}
        with mock.patch.object(tm,"load_datasource",return_value={**DS,"org_id":"t9"}), \
             mock.patch.object(tm,"http_json",side_effect=lambda m,u,headers=None,body=None,timeout=None:(cap.update(h=headers) or (200,{"traces":[]}))):
            tm.lambda_handler({"tool_name":"tempo_search","arguments":{"query":"{}"}},None)
        self.assertEqual(cap["h"]["X-Scope-OrgID"],"t9")

class TestBounding(_Base):
    def test_traces_bounded(self):
        big={"traces":[{"traceID":str(i),"spanSet":{"spans":[{"x":1}]*10}} for i in range(300)]}
        with mock.patch.object(tm,"http_json",return_value=(200,big)):
            out=tm.lambda_handler({"tool_name":"tempo_search","arguments":{"query":"{}"}},None)
        body=json.loads(out["body"]); self.assertTrue(body["truncated"]); self.assertLessEqual(len(body["traces"]),tm.MAX_TRACES)
    def test_trace_bytes_bounded_multibyte(self):
        big={"batches":[{"log":"오류"*250000}]}  # ~1.5MB UTF-8 (exceeds MAX_TOTAL_BYTES)
        with mock.patch.object(tm,"http_json",return_value=(200,big)):
            out=tm.lambda_handler({"tool_name":"tempo_get_trace","arguments":{"trace_id":"ab"}},None)
        self.assertLessEqual(len(out["body"].encode("utf-8")), tm.MAX_TOTAL_BYTES*2)
        self.assertTrue(json.loads(out["body"]).get("truncated"))

class TestGuards(_Base):
    def test_not_connected(self):
        with mock.patch.object(tm,"load_datasource",side_effect=tm.NotConnected("tempo not connected")):
            self.assertEqual(tm.lambda_handler({"tool_name":"tempo_search","arguments":{"query":"{}"}},None)["statusCode"],400)
    def test_ssrf(self):
        with mock.patch.object(tm,"assert_host_allowed",side_effect=tm.SsrfBlocked("endpoint blocked")):
            self.assertEqual(tm.lambda_handler({"tool_name":"tempo_search","arguments":{"query":"{}"}},None)["statusCode"],400)
    def test_target_account_id_popped(self):
        with mock.patch.object(tm,"http_json",return_value=(200,{"traces":[]})):
            self.assertEqual(tm.lambda_handler({"tool_name":"tempo_search","arguments":{"query":"{}","target_account_id":"222222222222"}},None)["statusCode"],200)
    def test_unknown_tool(self):
        self.assertEqual(tm.lambda_handler({"tool_name":"tempo_write","arguments":{}},None)["statusCode"],400)


class TestSchema(_Base):
    def test_schema_tags(self):
        with mock.patch.object(tm,"http_json",return_value=(200,{"tagNames":["service.name","http.status"]})):
            out=tm.lambda_handler({"tool_name":"tempo_schema","arguments":{}},None)
        import json as _j; self.assertEqual(_j.loads(out["body"])["tags"],["service.name","http.status"])


class TestSchemaVersion(_Base):
    def test_schema_version_and_instance_id(self):
        seq=[(200,{"version":"2.4.0"}),(200,{"tagNames":["service.name"]})]
        with mock.patch.object(tm,"http_json",side_effect=lambda *a,**k: seq.pop(0)):
            out=tm.lambda_handler({"tool_name":"tempo_schema","arguments":{}},None)
        b=json.loads(out["body"]); self.assertEqual(b["version"],"2.4.0"); self.assertIn("service.name",b["tags"])

    def test_instance_id_credential_blind(self):
        tm.load_datasource.reset_mock()
        with mock.patch.object(tm,"http_json",return_value=(200,{"traces":[]})):
            out=tm.lambda_handler({"tool_name":"tempo_search","arguments":{"query":'{ .service.name="x" }',"instance_id":7}},None)
        self.assertEqual(out["statusCode"],200); tm.load_datasource.assert_any_call(tm.SLUG, instance_id=7)


if __name__=="__main__": unittest.main()
