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

    def test_execution_timeout_is_passed_and_clamped(self):
        # the connector bounded response SIZE only; the diag-signal dry run now asks for an execution bound
        # because this path runs model-written PromQL against a user's backend.
        def fake(method, url, headers=None, body=None, timeout=None):
            cap.update(url=url)
            return 200, {"status": "success", "data": {"resultType": "vector", "result": []}}

        for given, expect in (("5s", "5s"), (5, "5s"), ("999", "60s"), ("3600s", "60s"), ("0", "1s"), (0, "1s")):
            cap = {}
            with mock.patch.object(pm, "http_json", side_effect=fake):
                pm.lambda_handler({"tool_name": "prometheus_query",
                                   "arguments": {"query": "up", "timeout": given}}, None)
            self.assertEqual(_qs(cap["url"])["timeout"][0], expect, given)
        cap = {}
        with mock.patch.object(pm, "http_json", side_effect=fake):
            pm.lambda_handler({"tool_name": "prometheus_query", "arguments": {"query": "up"}}, None)
        self.assertNotIn("timeout", _qs(cap["url"]))   # unchanged for callers that ask for no bound

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

    def test_schema_probe_metrics_decides_names_past_the_cap(self):
        # cap+1 names trip the alphabetical cap; probe_metrics names are decided by LOCAL membership
        # in the full in-memory list (no per-name network calls) — present names past the cap merge
        # into `metrics`, and EVERY requested (valid) name lands in `probed` as definitive.
        many = [f"m{i:04d}" for i in range(pm.SCHEMA_METRIC_CAP + 1)] + ["up"]
        seq_len = {"n": 0}

        def fake(method, url, headers=None, body=None, timeout=None):
            seq_len["n"] += 1
            if "buildinfo" in url:
                return 200, {"status": "success", "data": {"version": "2.48.0"}}
            if url.endswith("/labels"):
                return 200, {"status": "success", "data": ["job"]}
            return 200, {"status": "success", "data": many}  # bulk name list (capped client-side)
        with mock.patch.object(pm, "http_json", side_effect=fake):
            out = pm.lambda_handler({"tool_name": "prometheus_schema", "arguments": {
                "probe_metrics": ["up", "node_cpu_seconds_total"]}}, None)
        b = json.loads(out["body"])
        self.assertTrue(b["truncated"])
        self.assertIn("up", b["metrics"])                                  # merged past the cap
        self.assertNotIn("node_cpu_seconds_total", b["metrics"])
        self.assertEqual(b["probed"], ["node_cpu_seconds_total", "up"])    # both decided locally
        self.assertEqual(seq_len["n"], 3)  # buildinfo + labels + names — zero probe traffic

    def test_schema_failed_metric_fetch_degrades_to_truncated(self):
        # A FAILED bulk name fetch is not an empty schema: truncated=true (absence undeterminable,
        # cards degrade to "unknown") and nothing is probed — never a confident "unavailable".
        seq = [(200, {"status": "success", "data": {"version": "2.48.0"}}),
               (200, {"status": "success", "data": ["job"]}),
               (500, {"raw": "names down"})]
        with mock.patch.object(pm, "http_json", side_effect=lambda *a, **k: seq.pop(0)):
            out = pm.lambda_handler({"tool_name": "prometheus_schema",
                                     "arguments": {"probe_metrics": ["up"]}}, None)
        b = json.loads(out["body"])
        self.assertTrue(b["truncated"])
        self.assertEqual(b["metrics"], [])
        self.assertNotIn("probed", b)

    def test_schema_complete_list_still_decides_probe_names(self):
        # A complete name list decides probe names locally too — `probed` is definitive both ways.
        seq = [(200, {"status": "success", "data": {"version": "2.48.0"}}),
               (200, {"status": "success", "data": ["job"]}),
               (200, {"status": "success", "data": ["up"]})]
        with mock.patch.object(pm, "http_json", side_effect=lambda *a, **k: seq.pop(0)):
            out = pm.lambda_handler({"tool_name": "prometheus_schema",
                                     "arguments": {"probe_metrics": ["up", "absent_metric"]}}, None)
        b = json.loads(out["body"])
        self.assertFalse(b["truncated"])
        self.assertEqual(b["probed"], ["absent_metric", "up"])
        self.assertEqual(seq, [])  # exactly 3 calls — nothing left over, no probe traffic

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
        self.assertTrue(b["up"]["exists"])
        self.assertEqual(b["up"]["type"], "gauge")
        self.assertEqual(b["up"]["labels"], ["instance", "job"])

        # failed label fetch surfaces an error entry (not silently dropped); type still resolved
        self.assertIn("http_requests", b)
        self.assertTrue(b["http_requests"]["exists"])
        self.assertEqual(b["http_requests"]["type"], "counter")
        self.assertEqual(b["http_requests"]["labels"], [])
        self.assertIn("error", b["http_requests"])

        self.assertIn("unknown", b)
        self.assertFalse(b["unknown"]["exists"])
        self.assertIsNone(b["unknown"]["type"])
        self.assertEqual(b["unknown"]["labels"], [])

    def test_metric_meta_uses_short_http_deadlines(self):
        timeouts = []

        def fake(method, url, headers=None, body=None, timeout=None):
            timeouts.append(timeout)
            if "metadata" in url:
                return 200, {"status": "success", "data": {"up": [{"type": "gauge"}]}}
            return 200, {"status": "success", "data": ["__name__", "instance"]}

        with mock.patch.object(pm, "http_json", side_effect=fake):
            pm.lambda_handler({"tool_name": "prometheus_metric_meta", "arguments": {"metrics": ["up"]}}, None)
        self.assertEqual(timeouts, [3, 3])

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


def test_metric_meta_transport_timeout_on_one_metric_is_that_metrics_error(monkeypatch):
    import socket
    calls = []

    def fake_get(creds, path, params, http_timeout=None):
        calls.append(path)
        if params.get("metric") == "slow_metric" or params.get("match[]") == '{__name__="slow_metric"}':
            raise socket.timeout("timed out")
        if path.endswith("/metadata"):
            return {params["metric"]: [{"type": "gauge"}]}
        return ["__name__", "instance"]

    monkeypatch.setattr(pm, "_get", fake_get)
    monkeypatch.setattr(pm, "_ds", lambda: {"endpoint": "http://x"})
    out = pm.prometheus_metric_meta({"metrics": ["slow_metric", "up"]})
    body = out["body"] if isinstance(out, dict) and "body" in out else out
    import json as _json
    data = _json.loads(body) if isinstance(body, str) else body
    entries = data.get("result") or data
    slow, up = entries["slow_metric"], entries["up"]
    assert slow["error"].startswith("upstream unreachable")
    assert slow["exists"] is None  # unknown — never a definitive absence
    assert up["exists"] is True and up["type"] == "gauge"  # the other metric still resolved


def test_metric_meta_api_error_yields_exists_unknown_not_false(monkeypatch):
    def fake_get(creds, path, params, http_timeout=None):
        raise pm._ApiError("Prometheus HTTP 503: upstream overloaded")

    monkeypatch.setattr(pm, "_get", fake_get)
    monkeypatch.setattr(pm, "_ds", lambda: {"endpoint": "http://x"})
    out = pm.prometheus_metric_meta({"metrics": ["up"]})
    body = out["body"] if isinstance(out, dict) and "body" in out else out
    import json as _json
    data = _json.loads(body) if isinstance(body, str) else body
    entry = (data.get("result") or data)["up"]
    assert entry["exists"] is None  # backend outage is UNKNOWN, never a definitive absence
    assert "error" in entry


def test_metric_meta_api_error_on_one_metric_is_unknown_not_absent(monkeypatch):
    """HTTP 429/5xx or a non-success API status is the backend's error, not proof the metric is
    absent — `exists` must be None (unknown), never a confident False (review MAJOR)."""
    def fake_get(creds, path, params, http_timeout=None):
        if params.get("metric") == "flaky_metric" or params.get("match[]") == '{__name__="flaky_metric"}':
            raise pm._ApiError("HTTP 503: upstream busy")
        if path.endswith("/metadata"):
            return {params["metric"]: [{"type": "gauge"}]}
        return ["__name__", "instance"]

    monkeypatch.setattr(pm, "_get", fake_get)
    monkeypatch.setattr(pm, "_ds", lambda: {"endpoint": "http://x"})
    out = pm.prometheus_metric_meta({"metrics": ["flaky_metric", "up"]})
    body = out["body"] if isinstance(out, dict) and "body" in out else out
    import json as _json
    data = _json.loads(body) if isinstance(body, str) else body
    entries = data.get("result") or data
    flaky, up = entries["flaky_metric"], entries["up"]
    assert "HTTP 503" in flaky["error"]
    assert flaky["exists"] is None  # unknown — never a definitive absence
    assert up["exists"] is True and up["type"] == "gauge"


def test_metric_meta_operation_budget_keeps_partial_results(monkeypatch):
    """12 metrics x 2 calls x 3s = 72s would exceed the connector Lambda's 60s timeout and lose
    EVERYTHING — the operation-wide budget must stop probing and mark the rest unknown instead."""
    clock = {"t": 0.0}
    monkeypatch.setattr(pm.time, "monotonic", lambda: clock["t"])

    def fake_get(creds, path, params, http_timeout=None):
        clock["t"] += 25.0  # each call burns 25 "seconds" — budget (40s) spends after metric 1
        if path.endswith("/metadata"):
            return {params["metric"]: [{"type": "gauge"}]}
        return ["__name__"]

    monkeypatch.setattr(pm, "_get", fake_get)
    monkeypatch.setattr(pm, "_ds", lambda: {"endpoint": "http://x"})
    out = pm.prometheus_metric_meta({"metrics": ["m1", "m2", "m3"]})
    body = out["body"] if isinstance(out, dict) and "body" in out else out
    import json as _json
    data = _json.loads(body) if isinstance(body, str) else body
    entries = data.get("result") or data
    assert entries["m1"]["exists"] is True          # probed before the budget spent
    assert entries["m2"]["error"].startswith("metadata time budget exhausted")
    assert entries["m2"]["exists"] is None and entries["m3"]["exists"] is None
    assert set(entries) == {"m1", "m2", "m3"}      # nothing dropped
