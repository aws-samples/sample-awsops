"""Connection identity, bounded I/O, query proof and result-completion regressions."""
import importlib
import io
import json
import sys
import urllib.error
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import datasource_http as dh

CREDS = {"endpoint": "https://provider.example.test", "authType": "none", "org_id": "synthetic-tenant"}


@pytest.fixture(autouse=True)
def reset_request():
    dh.set_request_conn(None)
    yield
    dh.set_request_conn(None)


class Response(io.BytesIO):
    def getcode(self):
        return 200


@pytest.mark.parametrize("size", [63, 64, 65, 1024])
def test_byte_bound_precedes_parse_and_closes_success_stream(size):
    response = Response(b"x" * size)
    with patch.object(dh._opener, "open", return_value=response):
        if size > 64:
            with pytest.raises(dh.ResponseTooLarge):
                dh.http_json("GET", CREDS["endpoint"], max_bytes=64)
        else:
            assert dh.http_json("GET", CREDS["endpoint"], max_bytes=64)[0] == 200
    assert response.closed


def test_error_body_is_bounded_and_closed_without_echoing_content():
    stream = io.BytesIO(b"synthetic-private" * 10000)
    error = urllib.error.HTTPError(CREDS["endpoint"], 403, "denied", {}, stream)
    with patch.object(dh._opener, "open", side_effect=error):
        status, payload = dh.http_json("GET", CREDS["endpoint"])
    # The real HTTP status survives; the oversized body is reported as such, never echoed.
    assert status == 403 and payload == {"error": f"error body exceeded {dh.MAX_ERROR_BYTES} bytes"}
    assert stream.closed
    assert "synthetic-private" not in json.dumps(payload)


@pytest.mark.parametrize("entry", [None, {}, {"token": "synthetic"}, []])
def test_explicit_missing_instance_cannot_borrow_a_sibling_default_mirror(entry):
    mirror = {**CREDS, "instanceId": "3"}  # the default is instance 3, not the requested 7
    with patch.object(dh, "_load_secret_map", return_value={"7": entry, "prometheus": mirror}):
        with pytest.raises(dh.NotConnected):
            dh.load_datasource("prometheus", instance_id=7)
        assert dh.load_datasource("prometheus") == mirror


def test_explicit_default_instance_resolves_its_own_stamped_mirror():
    mirror = {**CREDS, "instanceId": "3"}
    with patch.object(dh, "_load_secret_map", return_value={"prometheus": mirror}):
        assert dh.load_datasource("prometheus", instance_id=3) == mirror
        assert dh.load_datasource("prometheus", instance_id="3") == mirror


def test_unstamped_legacy_mirror_keeps_a_migrated_default_working_with_a_warning(capsys):
    # A mirror written before the instanceId stamp (migrated default whose id key was never
    # written) is the compat window; it closes on that default's next save.
    with patch.object(dh, "_load_secret_map", return_value={"prometheus": CREDS}):
        assert dh.load_datasource("prometheus", instance_id=7) == CREDS
    assert "unstamped kind mirror" in capsys.readouterr().out


@pytest.mark.parametrize("kind", ["prometheus", "mimir"])
@pytest.mark.parametrize("configured,requested,expected", [(1, None, 1), (35, None, 35), (35, "5s", 5), (1, "60s", 1), (60, None, 55), (None, None, 10)])
def test_provider_ceiling_applies_on_default_and_explicit_paths(kind, configured, requested, expected):
    module = importlib.import_module(kind + "_mcp")
    credentials = {**CREDS, "timeoutS": configured}
    response = {"status": "success", "data": {"resultType": "vector", "result": []}}
    with patch.object(module, "load_datasource", return_value=credentials), \
            patch.object(module, "assert_host_allowed"), patch.object(module, "http_json", return_value=(200, response)) as http:
        arguments = {"query": "up", **({"timeout": requested} if requested is not None else {})}
        getattr(module, kind + "_query")(arguments)
    assert parse_qs(urlparse(http.call_args.args[1]).query)["timeout"] == [f"{expected}s"]
    assert http.call_args.kwargs["timeout"] == expected + 3


@pytest.mark.parametrize("endpoint,prefix,path", [
    ("https://provider.example.test", None, "/prometheus/api/v1/query"),
    ("https://provider.example.test/prometheus", None, "/prometheus/api/v1/query"),
    ("https://provider.example.test/mount", "/metrics", "/mount/metrics/api/v1/query"),
    ("https://provider.example.test", "", "/api/v1/query"),
])
def test_mimir_mount_is_applied_once(endpoint, prefix, path):
    module = importlib.import_module("mimir_mcp")
    credentials = {**CREDS, "endpoint": endpoint, **({"apiPrefix": prefix} if prefix is not None else {})}
    with patch.object(module, "load_datasource", return_value=credentials), \
            patch.object(module, "assert_host_allowed"), patch.object(module, "http_json", return_value=(
                200, {"status": "success", "data": {"resultType": "vector", "result": []}}
            )) as http:
        module.mimir_query({"query": "up"})
    assert urlparse(http.call_args.args[1]).path == path


@pytest.mark.parametrize("kind", ["prometheus", "mimir", "loki", "tempo", "jaeger", "dynatrace"])
def test_connection_probe_cannot_pass_with_public_ready_and_denied_query(kind):
    module = importlib.import_module(kind + "_mcp")
    def upstream(method, url, **kwargs):
        return (200, {}) if "/ready" in url or "/healthy" in url else (403, {"error": "synthetic denied"})
    with patch.object(module, "load_datasource", return_value=CREDS), \
            patch.object(module, "assert_host_allowed"), patch.object(module, "http_json", side_effect=upstream):
        result = json.loads(getattr(module, kind + "_health")({})["body"])
    assert result["ok"] is False
    assert "synthetic denied" not in json.dumps(result)


@pytest.mark.parametrize("kind,response", [
    ("prometheus", {"status": "success", "data": {"resultType": "vector", "result": [{"metric": {}, "value": [1, "1"]}]}}),
    ("mimir", {"status": "success", "data": {"resultType": "vector", "result": [{"metric": {}, "value": [1, "1"]}]}}),
    ("loki", {"status": "success", "data": {"resultType": "streams", "result": []}}),
    ("tempo", {"traces": [], "metrics": {}}),
    ("jaeger", {"data": []}),
    ("dynatrace", {"result": []}),
])
def test_query_probe_accepts_recognizable_success_and_uses_bounded_query(kind, response):
    module = importlib.import_module(kind + "_mcp")
    with patch.object(module, "load_datasource", return_value=CREDS), \
            patch.object(module, "assert_host_allowed"), patch.object(module, "http_json", return_value=(200, response)) as http:
        result = json.loads(getattr(module, kind + "_health")({})["body"])
    assert result["ok"] is True
    assert result["verified"] == ["query"]
    url = http.call_args.args[1]
    assert "/ready" not in url and "/healthy" not in url
    assert http.call_args.kwargs["headers"]["X-Scope-OrgID"] == CREDS["org_id"]


@pytest.mark.parametrize("kind", ["jaeger", "dynatrace", "datadog"])
def test_login_html_is_unknown_not_empty(kind):
    module = importlib.import_module(kind + "_mcp")
    with patch.object(module, "_ds", return_value=CREDS), patch.object(module, "http_json", return_value=(200, {"raw": "<html>login</html>"})):
        query = getattr(module, kind + ("_search" if kind == "jaeger" else "_query"))
        result = json.loads(query({"query": "synthetic"})["body"])
    assert result["collectionStatus"] == "unknown"
    assert "login" not in json.dumps(result)


@pytest.mark.parametrize("kind,response", [
    ("dynatrace", {"result": [{"metricId": "valid", "data": [{"dimensions": [], "timestamps": [1000, 2000], "values": [1]}]}]}),
    ("datadog", {"status": "ok", "series": [{"metric": "valid", "pointlist": [[1000, 1], ["invalid", 2]]}]}),
])
def test_malformed_samples_cannot_certify_complete_metrics(kind, response):
    module = importlib.import_module(kind + "_mcp")
    with patch.object(module, "_ds", return_value=CREDS), patch.object(module, "_get", return_value=response):
        result = json.loads(getattr(module, kind + "_query")({"query": "synthetic"})["body"])
    assert result["collectionStatus"] == "unknown"


def trace(index):
    return {"traceID": f"{index + 1:032x}", "spans": [{
        "startTime": 1000000, "duration": 100, "operationName": "query", "processID": "p",
    }], "processes": {"p": {"serviceName": "synthetic"}}}


@pytest.mark.parametrize("count,limit,state", [(0, 20, "empty"), (19, 20, "ok"), (20, 20, "partial"), (1, 1, "partial")])
def test_jaeger_limit_saturation_is_partial(count, limit, state):
    module = importlib.import_module("jaeger_mcp")
    with patch.object(module, "_ds", return_value=CREDS), patch.object(module, "_get", return_value={"data": [trace(i) for i in range(count)]}):
        result = json.loads(module.jaeger_search({"query": f"service=synthetic&limit={limit}"})["body"])
    assert result["collectionStatus"] == state
    assert result["requestedLimit"] == limit and result["returnedCount"] == count


@pytest.mark.parametrize("limit", ["-1", "nan", "1.5", "100000000000000000000"])
def test_jaeger_bad_limit_does_not_reach_provider(limit):
    module = importlib.import_module("jaeger_mcp")
    with patch.object(module, "_ds") as ds:
        assert module.jaeger_search({"query": f"service=synthetic&limit={limit}"})["statusCode"] == 400
    ds.assert_not_called()


@pytest.mark.parametrize("value", [float("inf"), float("nan"), True, 10**400])
@pytest.mark.parametrize("kind", ["dynatrace", "datadog"])
def test_unrepresentable_chart_numbers_are_unknown_without_serializing_them(kind, value):
    module = importlib.import_module(kind + "_mcp")
    response = {"result": [{"metricId": "synthetic", "data": [{
        "dimensions": [], "timestamps": [1000], "values": [value],
    }]}]} if kind == "dynatrace" else {
        "status": "ok", "series": [{"metric": "synthetic", "pointlist": [[1000, value]]}],
    }
    with patch.object(module, "_ds", return_value=CREDS), patch.object(module, "_get", return_value=response):
        result = json.loads(getattr(module, kind + "_query")({"query": "synthetic"})["body"])
    assert result["collectionStatus"] == "unknown"


@pytest.mark.parametrize("status,response,verified", [
    (403, {"error": "synthetic password should not be echoed"}, False),
    (200, {"raw": "<html>login</html>"}, False),
    (200, {"meta": [{"name": "probe", "type": "UInt8"}], "data": [{"probe": 1}], "rows": 1}, True),
])
def test_clickhouse_probe_verifies_sql_not_ping(status, response, verified):
    module = importlib.import_module("clickhouse_mcp")
    with patch.object(module, "load_datasource", return_value=CREDS), \
            patch.object(module, "assert_host_allowed"), patch.object(module, "http_json", return_value=(status, response)) as http:
        result = json.loads(module.clickhouse_health({})["body"])
    assert result["ok"] is verified
    assert "/ping" not in http.call_args.args[1]
    assert "max_execution_time=1" in http.call_args.args[1]
    assert "synthetic password" not in json.dumps(result)


@pytest.mark.parametrize("auth,expected", [
    ("none", {}), (None, {"DD-API-KEY": "synthetic-api", "DD-APPLICATION-KEY": "synthetic-app"}),
])
def test_explicit_no_auth_cannot_transmit_legacy_datadog_keys(auth, expected):
    module = importlib.import_module("datadog_mcp")
    credentials = {"apiKey": "synthetic-api", "appKey": "synthetic-app",
                   **({"authType": auth} if auth is not None else {})}
    assert module._headers(credentials) == expected


@pytest.mark.parametrize("kind,response", [
    ("datadog", {"status": "ok", "series": [], "http_status": 200}),
    ("dynatrace", {"result": [], "http_status": 200}),
    ("jaeger", {"data": [], "http_status": 200}),
    ("loki", {"status": "success", "data": {"resultType": "streams", "result": []}}),
])
@pytest.mark.parametrize("status,state", [(200, "empty"), (206, "partial"), (201, "unknown")])
def test_partial_http_responses_cannot_certify_empty_or_spoof_transport_evidence(kind, response, status, state):
    module = importlib.import_module(kind + "_mcp")
    with patch.object(module, "_ds", return_value=CREDS), patch.object(module, "http_json", return_value=(status, response)):
        query = getattr(module, kind + ("_search" if kind == "jaeger" else "_query"))
        result = json.loads(query({"query": "synthetic"})["body"])
    assert result["collectionStatus"] == state


def test_loki_malformed_siblings_preserve_valid_logs_as_unverified():
    module = importlib.import_module("loki_mcp")
    row = {"stream": {"service_name": "synthetic"}, "values": [["1000000000", "valid log"]]}
    response = {"status": "success", "data": {"resultType": "streams", "result": [row, {"values": "invalid"}]}}
    with patch.object(module, "_ds", return_value=CREDS), patch.object(module, "http_json", return_value=(200, response)):
        result = json.loads(module.loki_query({"query": "synthetic"})["body"])
    assert result["result"] == [row]
    assert result["collectionStatus"] == "unknown"


def test_connect_headers_and_body_share_one_request_deadline():
    # Old behaviour granted the body read a fresh full `timeout` after headers arrived, so a
    # slow-but-alive upstream could hold the connector for ~2x the aligned HTTP timeout and hit the
    # Lambda wall. One monotonic deadline now spans open() and the body read.
    clock = {"now": 1000.0}
    body = iter([b"{", b"}", b""])

    class Slow(Response):
        def read1(self, n=-1):
            clock["now"] += 4  # each chunk arrives 4s apart
            return next(body)

    def slow_open(req, timeout=None):
        clock["now"] += timeout - 1  # connect + headers consumed almost the whole budget
        return Slow()

    with patch.object(dh.time, "monotonic", side_effect=lambda: clock["now"]), \
            patch.object(dh._opener, "open", side_effect=slow_open), pytest.raises(TimeoutError):
        dh.http_json("GET", CREDS["endpoint"], timeout=10)


def test_loki_limit_saturation_is_disclosed_as_partial():
    module = importlib.import_module("loki_mcp")
    hit = {"status": "success", "data": {"resultType": "streams", "result": [{"stream": {"a": "b"}, "values": [["1", "line"]]}]}}
    with patch.object(module, "load_datasource", return_value=CREDS), patch.object(module, "assert_host_allowed"), \
            patch.object(module, "http_json", return_value=(200, hit)):
        one = json.loads(module.loki_query_range({"query": '{a="b"}', "limit": 1})["body"])
        many = json.loads(module.loki_query_range({"query": '{a="b"}', "limit": 100})["body"])
    assert one["collectionStatus"] == "partial" and one["limitSaturated"] is True and one["truncated"] is False
    assert (one["requestedLimit"], one["returnedCount"]) == (1, 1)
    assert many["collectionStatus"] == "ok" and many["limitSaturated"] is False


def test_jaeger_limit_saturation_is_partial_but_not_loss():
    module = importlib.import_module("jaeger_mcp")
    trace = {"traceID": "a" * 16, "spans": [{"startTime": 1, "duration": 1, "operationName": "op", "processID": "p1"}],
             "processes": {"p1": {"serviceName": "svc"}}}
    with patch.object(module, "load_datasource", return_value=CREDS), patch.object(module, "assert_host_allowed"), \
            patch.object(module, "http_json", return_value=(200, {"data": [trace]})):
        one = json.loads(module.jaeger_search({"query": "service=svc&limit=1"})["body"])
        many = json.loads(module.jaeger_search({"query": "service=svc&limit=20"})["body"])
    assert one["collectionStatus"] == "partial" and one["limitSaturated"] is True and one["truncated"] is False
    assert many["collectionStatus"] == "ok" and many["limitSaturated"] is False
    assert (many["requestedLimit"], many["returnedCount"]) == (20, 1)


@pytest.mark.parametrize("kind", ["prometheus", "mimir", "loki", "tempo", "jaeger", "dynatrace", "datadog", "clickhouse"])
def test_connection_probe_reports_latency_and_fixed_sentences(kind):
    # The Test button contract is {ok, verified, latency_ms, error?}; a refused query must never echo
    # upstream text, and an SSRF policy block keeps its own classification.
    module = importlib.import_module(kind + "_mcp")
    with patch.object(module, "load_datasource", return_value={**CREDS, "endpoint": "https://169.254.169.254"}), \
            patch.object(module, "assert_host_allowed", side_effect=dh.SsrfBlocked("blocked")), \
            patch.object(module, "http_json", side_effect=AssertionError("must not be called")):
        probe = json.loads(getattr(module, kind + "_health")({})["body"])
    assert probe["ok"] is False and probe["verified"] == [] and isinstance(probe["latency_ms"], int)
    assert probe["error"] == "endpoint rejected by the private-network policy"
