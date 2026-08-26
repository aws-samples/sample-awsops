"""Tests for prometheus_mcp — read-only PromQL connector on datasource_http."""
import json
import os
import sys
import unittest
from unittest import mock
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, os.path.dirname(__file__))
import prometheus_mcp as pm  # noqa: E402

DS = {"endpoint": "http://prometheus:9090", "token": "tok"}


def _qs(url):
    return parse_qs(urlparse(url).query)


class _Base(unittest.TestCase):
    def setUp(self):
        for name in ("load_datasource", "assert_host_allowed"):
            p = mock.patch.object(pm, name, return_value=DS if name == "load_datasource" else None)
            p.start(); self.addCleanup(p.stop)


class TestQuery(_Base):
    def test_instant_query_encodes_promql(self):
        cap = {}

        def fake(method, url, headers=None, body=None, timeout=None):
            cap.update(method=method, url=url, headers=headers)
            return 200, {"status": "success", "data": {"resultType": "vector", "result": [{"metric": {}, "value": [1, "2"]}]}}

        with mock.patch.object(pm, "http_json", side_effect=fake):
            out = pm.lambda_handler({"tool_name": "prometheus_query",
                                     "arguments": {"query": 'rate(http_requests_total{code="500"}[5m])'}}, None)
        self.assertEqual(out["statusCode"], 200)
        u = cap["url"]
        self.assertIn("/api/v1/query", u)
        self.assertNotIn("/api/v1/query_range", u)
        self.assertEqual(_qs(u)["query"][0], 'rate(http_requests_total{code="500"}[5m])')  # decoded round-trips
        self.assertIn("time", _qs(u))
        self.assertEqual(cap["headers"]["Authorization"], "Bearer tok")

    def test_range_defaults(self):
        cap = {}
        with mock.patch.object(pm, "http_json",
                               side_effect=lambda m, url, headers=None, body=None, timeout=None: (cap.update(url=url) or (200, {"status": "success", "data": {"resultType": "matrix", "result": []}}))):
            out = pm.lambda_handler({"tool_name": "prometheus_query_range", "arguments": {"query": "up"}}, None)
        self.assertEqual(out["statusCode"], 200)
        q = _qs(cap["url"])
        self.assertIn("/api/v1/query_range", cap["url"])
        self.assertIn("start", q); self.assertIn("end", q); self.assertEqual(q["step"][0], "60")
        self.assertLess(int(q["start"][0]), int(q["end"][0]))  # 1h window

    def test_status_not_success_errors(self):
        with mock.patch.object(pm, "http_json", return_value=(200, {"status": "error", "errorType": "bad_data", "error": "parse error"})):
            out = pm.lambda_handler({"tool_name": "prometheus_query", "arguments": {"query": "up("}}, None)
        self.assertEqual(out["statusCode"], 400)
        self.assertIn("parse error", json.loads(out["body"])["error"])

    def test_http_error(self):
        with mock.patch.object(pm, "http_json", return_value=(503, {"raw": "unavailable"})):
            out = pm.lambda_handler({"tool_name": "prometheus_query", "arguments": {"query": "up"}}, None)
        self.assertEqual(out["statusCode"], 400)
        self.assertIn("503", json.loads(out["body"])["error"])


class TestLabelsSeries(_Base):
    def test_labels(self):
        cap = {}
        with mock.patch.object(pm, "http_json",
                               side_effect=lambda m, url, headers=None, body=None, timeout=None: (cap.update(url=url) or (200, {"status": "success", "data": ["__name__", "job"]}))):
            out = pm.lambda_handler({"tool_name": "prometheus_labels", "arguments": {}}, None)
        self.assertEqual(out["statusCode"], 200)
        self.assertIn("/api/v1/labels", cap["url"])

    def test_series_requires_match(self):
        out = pm.lambda_handler({"tool_name": "prometheus_series", "arguments": {}}, None)
        self.assertEqual(out["statusCode"], 400)

    def test_series_encodes_match(self):
        cap = {}
        with mock.patch.object(pm, "http_json",
                               side_effect=lambda m, url, headers=None, body=None, timeout=None: (cap.update(url=url) or (200, {"status": "success", "data": []}))):
            pm.lambda_handler({"tool_name": "prometheus_series", "arguments": {"match": 'up{job="x"}'}}, None)
        q = _qs(cap["url"])
        self.assertIn("/api/v1/series", cap["url"])
        self.assertEqual(q["match[]"][0], 'up{job="x"}')


class TestBounding(_Base):
    def test_matrix_samples_bounded(self):
        big = {"status": "success", "data": {"resultType": "matrix",
               "result": [{"metric": {"i": str(i)}, "values": [[t, "1"] for t in range(2000)]} for i in range(200)]}}
        with mock.patch.object(pm, "http_json", return_value=(200, big)):
            out = pm.lambda_handler({"tool_name": "prometheus_query_range", "arguments": {"query": "up"}}, None)
        body = json.loads(out["body"])
        self.assertTrue(body["truncated"])
        self.assertLessEqual(len(body["result"]), pm.MAX_SERIES)
        for s in body["result"]:
            self.assertLessEqual(len(s.get("values", [])), pm.MAX_POINTS_PER_SERIES)
        total = sum(len(s.get("values", [])) for s in body["result"])
        self.assertLessEqual(total, pm.MAX_TOTAL_SAMPLES)


class TestGuards(_Base):
    def test_not_connected(self):
        with mock.patch.object(pm, "load_datasource", side_effect=pm.NotConnected("prometheus not connected")):
            out = pm.lambda_handler({"tool_name": "prometheus_query", "arguments": {"query": "up"}}, None)
        self.assertEqual(out["statusCode"], 400)
        self.assertIn("not connected", json.loads(out["body"])["error"].lower())

    def test_ssrf_block(self):
        with mock.patch.object(pm, "assert_host_allowed", side_effect=pm.SsrfBlocked("endpoint blocked")):
            out = pm.lambda_handler({"tool_name": "prometheus_query", "arguments": {"query": "up"}}, None)
        self.assertEqual(out["statusCode"], 400)
        self.assertIn("blocked", json.loads(out["body"])["error"].lower())

    def test_target_account_id_popped(self):
        with mock.patch.object(pm, "http_json", return_value=(200, {"status": "success", "data": {"resultType": "vector", "result": []}})):
            out = pm.lambda_handler({"tool_name": "prometheus_query", "arguments": {"query": "up", "target_account_id": "222222222222"}}, None)
        self.assertEqual(out["statusCode"], 200)

    def test_redirect_origin_ssrf_returns_400_not_crash(self):
        # a SsrfBlocked raised from inside http_json (no-redirect handler) is caught by lambda_handler
        with mock.patch.object(pm, "http_json", side_effect=pm.SsrfBlocked("endpoint blocked: redirect")):
            out = pm.lambda_handler({"tool_name": "prometheus_query", "arguments": {"query": "up"}}, None)
        self.assertEqual(out["statusCode"], 400)
        self.assertIn("blocked", json.loads(out["body"])["error"].lower())

    def test_unknown_tool(self):
        out = pm.lambda_handler({"tool_name": "prometheus_write", "arguments": {}}, None)
        self.assertEqual(out["statusCode"], 400)



class TestSchema(_Base):
    def test_schema_metrics_labels_and_version(self):
        # schema now probes buildinfo FIRST, then labels, then metrics.
        seq=[(200,{"status":"success","data":{"version":"2.48.0"}}),  # buildinfo
             (200,{"status":"success","data":["job","instance"]}),     # labels
             (200,{"status":"success","data":["up","http_requests_total"]})]  # metrics
        with mock.patch.object(pm,"http_json",side_effect=lambda *a,**k: seq.pop(0)):
            out=pm.lambda_handler({"tool_name":"prometheus_schema","arguments":{}},None)
        b=json.loads(out["body"])
        self.assertEqual(out["statusCode"],200)
        self.assertIn("metrics",b); self.assertIn("labels",b)
        self.assertEqual(b["version"],"2.48.0")  # captured for version-aware DSL

    def test_schema_buildinfo_down_still_returns_names(self):
        # version is best-effort: a buildinfo error → version null, names still returned.
        seq=[(500,{"raw":"nope"}),  # buildinfo fails
             (200,{"status":"success","data":["job"]}),
             (200,{"status":"success","data":["up"]})]
        with mock.patch.object(pm,"http_json",side_effect=lambda *a,**k: seq.pop(0)):
            out=pm.lambda_handler({"tool_name":"prometheus_schema","arguments":{}},None)
        b=json.loads(out["body"])
        self.assertEqual(out["statusCode"],200)
        self.assertIsNone(b["version"])
        self.assertIn("up", b["metrics"])


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
            
        with mock.patch.object(pm, "http_json", side_effect=fake):
            out = pm.lambda_handler({"tool_name": "prometheus_metric_meta", "arguments": {"metrics": ["up", "http_requests", "unknown"]}}, None)
        
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
        out = pm.lambda_handler({"tool_name": "prometheus_metric_meta", "arguments": {"metrics": []}}, None)
        self.assertEqual(json.loads(out["body"]), {})

    def test_metrics_cap(self):
        cap = []
        with mock.patch.object(pm, "http_json", return_value=(200, {"status": "success", "data": {}})) as m:
            out = pm.lambda_handler({"tool_name": "prometheus_metric_meta", "arguments": {"metrics": [f"m{i}" for i in range(20)]}}, None)
        
        b = json.loads(out["body"])
        self.assertEqual(len(b), 12)
        self.assertEqual(m.call_count, 24) # per-metric: 12 × (metadata?metric= + labels)



class TestInstanceId(_Base):
    def test_instance_id_resolves_per_instance_credential_blind(self):
        # worker path: only an instance_id in arguments → connector resolves per-instance creds itself.
        with mock.patch.object(pm, "http_json", return_value=(200, {"status":"success","data":{"resultType":"vector","result":[]}})):
            pm.load_datasource.reset_mock()
            out = pm.lambda_handler({"tool_name":"prometheus_query","arguments":{"query":"up","instance_id":7}}, None)
        self.assertEqual(out["statusCode"], 200)
        pm.load_datasource.assert_any_call(pm.SLUG, instance_id=7)  # credential-blind per-instance resolve


if __name__ == "__main__":
    unittest.main()
