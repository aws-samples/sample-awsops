"""Connection identity, bounded I/O, query proof and result-completion regressions."""
import importlib
import http.client
import io
import json
import socket
import sys
import time
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


@pytest.mark.parametrize("entry", ["absent", None, {}, {"token": "synthetic"}, []])
def test_explicit_instance_without_its_own_key_never_borrows_the_kind_mirror(entry):
    secrets = {"prometheus": CREDS, **({} if entry == "absent" else {"7": entry})}
    with patch.object(dh, "_load_secret_map", return_value=secrets):
        with pytest.raises(dh.NotConnected, match="requested datasource instance"):
            dh.load_datasource("prometheus", instance_id=7)
        assert dh.load_datasource("prometheus") == CREDS


def test_explicit_default_instance_resolves_its_own_stamped_mirror_only():
    mirror = {**CREDS, "instanceId": "3"}
    with patch.object(dh, "_load_secret_map", return_value={"prometheus": mirror}):
        assert dh.load_datasource("prometheus", instance_id=3) == mirror
        assert dh.load_datasource("prometheus", instance_id="3") == mirror
        with pytest.raises(dh.NotConnected):
            dh.load_datasource("prometheus", instance_id=7)  # stamped for another instance


def test_backfilled_legacy_default_remains_readable_without_lending_to_siblings():
    with patch.object(dh, "_load_secret_map", return_value={"7": CREDS, "prometheus": CREDS}):
        assert dh.load_datasource("prometheus", instance_id=7) == CREDS
        with pytest.raises(dh.NotConnected):
            dh.load_datasource("prometheus", instance_id=8)


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


@pytest.mark.parametrize("status", [200, 403])
def test_blocking_socket_read_uses_only_budget_remaining_after_headers(status):
    client, peer = socket.socketpair()
    client.settimeout(1.5)
    peer.sendall(f"HTTP/1.1 {status} Synthetic\r\nContent-Length: 2\r\n\r\n".encode())
    response = http.client.HTTPResponse(client)
    response.begin()

    def delayed_open(req, timeout=None):
        time.sleep(1.0)  # Header/connect phase has already spent most of the total budget.
        if status == 403:
            raise urllib.error.HTTPError(CREDS["endpoint"], status, "denied", {}, response)
        return response

    start = time.monotonic()
    try:
        with patch.object(dh._opener, "open", side_effect=delayed_open):
            if status == 200:
                with pytest.raises(TimeoutError):
                    dh.http_json("GET", CREDS["endpoint"], timeout=1.5)
            else:
                assert dh.http_json("GET", CREDS["endpoint"], timeout=1.5) == (
                    403, {"error": "error body read deadline exceeded"})
        # The original 1.5s socket timeout would take 2.5s including delayed headers.
        assert time.monotonic() - start < 2.0
        assert response.isclosed()
    finally:
        response.close()
        client.close()
        peer.close()


@pytest.mark.parametrize("failure", [ConnectionResetError(), http.client.IncompleteRead(b"synthetic-private")])
def test_broken_error_body_keeps_status_and_never_echoes_partial_content(failure):
    class Broken(Response):
        def read1(self, n=-1):
            raise failure

    stream = Broken()
    error = urllib.error.HTTPError(CREDS["endpoint"], 403, "denied", {}, stream)
    with patch.object(dh._opener, "open", side_effect=error):
        assert dh.http_json("GET", CREDS["endpoint"]) == (
            403, {"error": "error body could not be read"})
    assert stream.closed


@pytest.mark.parametrize("tid,valid", [("1", True), ("abc123", True), ("a" * 16, True),
                                      ("B" * 32, True), ("", False), ("a" * 33, False),
                                      ("xyz", False), ("1\n", False)])
def test_jaeger_search_accepts_unpadded_ids_without_accepting_malformed_ids(tid, valid):
    module = importlib.import_module("jaeger_mcp")
    trace = {"traceID": tid, "spans": [{"startTime": 1, "duration": 1, "operationName": "op"}], "processes": {}}
    with patch.object(module, "_ds", return_value=CREDS), patch.object(module, "_get", return_value={"data": [trace]}):
        result = json.loads(module.jaeger_search({"query": "svc"})["body"])
    assert result["collectionStatus"] == ("ok" if valid else "unknown")
    assert result["returnedCount"] == int(valid)
    if valid:
        assert result["traces"][0]["traceID"] == tid


def test_loki_metric_series_do_not_saturate_the_log_line_limit():
    module = importlib.import_module("loki_mcp")
    data = {"resultType": "vector", "result": [{"metric": {}, "value": [1, "2"]}]}
    result = json.loads(module._query_response(data, requested=1)["body"])
    assert result["collectionStatus"] == "ok"
    assert result["limitSaturated"] is False


def test_loki_returned_count_describes_retained_lines_after_local_bound():
    module = importlib.import_module("loki_mcp")
    data = {"resultType": "streams", "result": [{"stream": {}, "values": [["1", "a"], ["2", "b"]]}]}
    with patch.object(module, "MAX_TOTAL_LINES", 1):
        result = json.loads(module._query_response(data, requested=10)["body"])
    assert result["truncated"] is True
    assert result["returnedCount"] == len(result["result"][0]["values"]) == 1


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


def test_loki_buildinfo_and_legacy_label_envelopes_are_accepted():
    module = importlib.import_module("loki_mcp")
    reply = lambda method, url, **kw: (200, {"version": "3.1.0"}) if "/status/buildinfo" in url else (200, {"status": "success"})
    with patch.object(module, "load_datasource", return_value=CREDS), patch.object(module, "assert_host_allowed"), \
            patch.object(module, "http_json", side_effect=reply):
        schema = json.loads(module.loki_schema({})["body"])
        labels = json.loads(module.loki_labels({})["body"])
    assert schema["version"] == "3.1.0" and schema["labels"] == [] and schema["truncated"] is False
    assert labels["labels"] == []


def test_loki_query_still_requires_the_envelope():
    module = importlib.import_module("loki_mcp")
    with patch.object(module, "load_datasource", return_value=CREDS), patch.object(module, "assert_host_allowed"), \
            patch.object(module, "http_json", return_value=(200, {"status": "success"})), pytest.raises(module._ApiError):
        module.loki_query_range({"query": '{a="b"}'})


@pytest.mark.parametrize("kind,tool,reply", [
    ("prometheus", "prometheus_schema", {"status": "success", "data": []}),
    ("mimir", "mimir_schema", {"status": "success", "data": []}),
    ("loki", "loki_schema", {"status": "success", "data": []}),
    ("jaeger", "jaeger_schema", {"data": []}),
    ("dynatrace", "dynatrace_schema", {"metrics": []}),
    ("datadog", "datadog_schema", {"metrics": []}),
    ("tempo", "tempo_schema", {"tagNames": []}),
])
def test_discovery_calls_keep_the_fixed_http_budget_under_a_tight_query_bound(kind, tool, reply):
    module = importlib.import_module(kind + "_mcp")
    calls = []

    def record(method, url, **kw):
        calls.append(kw["timeout"])
        return 200, reply

    with patch.object(module, "load_datasource", return_value={**CREDS, "timeoutS": 2}), \
            patch.object(module, "assert_host_allowed"), patch.object(module, "http_json", side_effect=record):
        getattr(module, tool)({})
    # Tempo's optional buildinfo/type evidence keeps its own shorter fixed budget.
    allowed = {dh.HTTP_TIMEOUT, getattr(module, "_SCHEMA_TIMEOUT_S", dh.HTTP_TIMEOUT)}
    assert calls and dh.HTTP_TIMEOUT in calls and set(calls) <= allowed and 2 not in calls


def test_query_tools_still_apply_the_saved_query_bound():
    module = importlib.import_module("prometheus_mcp")
    calls = []

    def record(method, url, **kw):
        calls.append(kw["timeout"])
        return 200, {"status": "success", "data": {"resultType": "vector", "result": []}}

    with patch.object(module, "load_datasource", return_value={**CREDS, "timeoutS": 2}), \
            patch.object(module, "assert_host_allowed"), patch.object(module, "http_json", side_effect=record):
        module.prometheus_query({"query": "up"})
    assert calls == [5]  # 2s execution ceiling + 3s transport margin


def test_header_phase_is_bounded_by_the_request_deadline():
    import time as _time

    def slow_open(req, timeout=None):
        _time.sleep(0.6)
        return Response(b"{}")

    with patch.object(dh._opener, "open", side_effect=slow_open), pytest.raises(TimeoutError):
        started = _time.monotonic()
        dh.http_json("GET", CREDS["endpoint"], timeout=0.2)
    assert _time.monotonic() - started < 0.5


def test_header_deadline_closes_the_tracked_connection():
    import time as _time

    class FakeSock:
        how = None

        def shutdown(self, how):
            self.how = how

    class FakeConn:
        closed = False

        def __init__(self):
            self.sock = FakeSock()

        def close(self):
            self.closed = True

    held = {}

    def slow_open(req, timeout=None):
        held["conn"] = req._awsops_tracker.conn = FakeConn()
        _time.sleep(0.6)
        return Response(b"{}")

    with patch.object(dh._opener, "open", side_effect=slow_open), pytest.raises(TimeoutError):
        dh.http_json("GET", CREDS["endpoint"], timeout=0.2)
    assert held["conn"].closed is True
    assert held["conn"].sock.how == socket.SHUT_RDWR


def test_late_http_error_body_is_closed_after_a_header_timeout():
    import time as _time
    stream = io.BytesIO(b"late")

    def slow_error(req, timeout=None):
        _time.sleep(0.4)
        raise urllib.error.HTTPError(CREDS["endpoint"], 500, "late", {}, stream)

    with patch.object(dh._opener, "open", side_effect=slow_error), pytest.raises(TimeoutError):
        dh.http_json("GET", CREDS["endpoint"], timeout=0.15)
    for _ in range(30):
        if stream.closed:
            break
        _time.sleep(0.05)
    assert stream.closed


def test_jaeger_byte_bound_keeps_the_traces_contract():
    module = importlib.import_module("jaeger_mcp")
    trace = {"traceID": "a" * 16, "spans": [{"startTime": 1, "duration": 1, "operationName": "x" * 500}],
             "processes": {}}
    with patch.object(module, "MAX_TOTAL_BYTES", 200), patch.object(module, "load_datasource", return_value=CREDS), \
            patch.object(module, "assert_host_allowed"), patch.object(module, "http_json", return_value=(200, {"data": [trace]})):
        body = json.loads(module.jaeger_search({"query": "svc"})["body"])
    assert body["traces"] == [] and body["truncated"] is True
    assert body["returnedCount"] == 1 and body["collectionStatus"] == "partial"
    with patch.object(module, "MAX_TOTAL_BYTES", 200), patch.object(module, "load_datasource", return_value=CREDS), \
            patch.object(module, "assert_host_allowed"), patch.object(module, "http_json", return_value=(503, {"data": [trace]})), \
            pytest.raises(module._ApiError):
        module.jaeger_search({"query": "svc"})
