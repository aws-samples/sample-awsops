"""Datadog query-access and result-loss regressions; provider transport is mocked."""
import json
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import datadog_mcp as dd


def body(value):
    return json.loads(value["body"])


CREDS = {"endpoint": "https://provider.example.test", "apiKey": "synthetic-api", "appKey": "synthetic-app"}


def test_api_key_validation_alone_cannot_pass_when_metric_query_is_denied():
    with patch.object(dd, "load_datasource", return_value=CREDS), patch.object(dd, "assert_host_allowed"), \
            patch.object(dd, "_get", side_effect=[{"valid": True}, dd._ApiError("synthetic-app denied")]) as request:
        result = body(dd.datadog_health({}))
    assert result["ok"] is False
    assert request.call_args_list[1].args[1] == "/api/v1/query"
    assert "synthetic-app" not in json.dumps(result)


def test_health_accepts_a_successfully_queried_empty_probe_and_bounds_its_window():
    with patch.object(dd, "load_datasource", return_value=CREDS), patch.object(dd, "assert_host_allowed"), \
            patch.object(dd.time, "time", return_value=1000), \
            patch.object(dd, "_get", side_effect=[{"valid": True}, {"status": "ok", "series": []}]) as request:
        probe = body(dd.datadog_health({}))
        assert probe["ok"] is True and probe["verified"] == ["query"] and isinstance(probe["latency_ms"], int)
    params = request.call_args_list[1].args[2]
    assert params["from"] == "940" and params["to"] == "1000"
    assert "{*}" not in params["query"]


def test_invalid_api_key_never_starts_a_metric_probe():
    with patch.object(dd, "load_datasource", return_value=CREDS), patch.object(dd, "assert_host_allowed"), \
            patch.object(dd, "_get", return_value={"valid": False}) as request:
        assert body(dd.datadog_health({}))["ok"] is False
    request.assert_called_once()


def test_health_does_not_accept_an_unverified_query_envelope():
    with patch.object(dd, "load_datasource", return_value=CREDS), patch.object(dd, "assert_host_allowed"), \
            patch.object(dd, "_get", side_effect=[{"valid": True}, {"status": "error", "series": []}]):
        assert body(dd.datadog_health({}))["ok"] is False


def test_bearer_connection_tests_the_metric_operation_without_api_key_validation():
    creds = {"endpoint": CREDS["endpoint"], "authType": "bearer", "token": "synthetic-bearer"}
    with patch.object(dd, "load_datasource", return_value=creds), patch.object(dd, "assert_host_allowed"), \
            patch.object(dd, "_get", return_value={"status": "ok", "series": []}) as request:
        probe = body(dd.datadog_health({}))
        assert probe["ok"] is True and probe["verified"] == ["query"] and isinstance(probe["latency_ms"], int)
    request.assert_called_once()
    assert request.call_args.args[1] == "/api/v1/query"


def _deadline_probe(validate_cost):
    """Run the key-pair health probe with a fake monotonic clock; validate consumes `validate_cost` s."""
    clock = [100.0]
    timeouts = []

    def fake_get(creds, path, params=None, *, timeout=None):
        timeouts.append((path, timeout))
        if path == "/api/v1/validate":
            clock[0] += validate_cost
            return {"valid": True}
        return {"status": "ok", "series": []}

    creds = {**CREDS, "timeoutS": 20}
    with patch.object(dd, "load_datasource", return_value=creds), patch.object(dd, "assert_host_allowed"), \
            patch.object(dd.time, "monotonic", side_effect=lambda: clock[0]), \
            patch.object(dd, "_get", side_effect=fake_get):
        probe = body(dd.datadog_health({}))
    return probe, timeouts


def test_health_requests_share_one_deadline():
    probe, timeouts = _deadline_probe(validate_cost=15)
    assert probe["ok"] is True
    (validate_path, validate_timeout), (query_path, query_timeout) = timeouts
    assert validate_path == "/api/v1/validate" and query_path == "/api/v1/query"
    assert validate_timeout == 20
    assert query_timeout < 20
    # elapsed validate time plus the query's allowance never exceeds the saved budget
    assert 15 + query_timeout <= 20


def test_health_exhausted_deadline_skips_the_metric_query():
    probe, timeouts = _deadline_probe(validate_cost=25)
    assert probe["ok"] is False
    assert [path for path, _ in timeouts] == ["/api/v1/validate"]


def test_point_limit_is_disclosed_and_preserves_other_series():
    points = [[1000 + i, i] for i in range(dd.MAX_POINTS + 1)]
    response = {"status": "ok", "series": [
        {"metric": "large", "pointlist": points}, {"metric": "small", "pointlist": [[1000, 0]]},
    ]}
    with patch.object(dd, "_ds", return_value=CREDS), patch.object(dd, "_get", return_value=response):
        result = body(dd.datadog_query({"query": "avg:fixture.metric{*}"}))
    assert len(result["series"][0]["pointlist"]) == dd.MAX_POINTS
    assert result["series"][1]["pointlist"] == [[1000, 0]]
    assert result["truncated"] is True and result["collectionStatus"] == "partial"
    assert len(response["series"][0]["pointlist"]) == dd.MAX_POINTS + 1


def test_outer_series_limit_is_disclosed_and_an_exact_point_limit_is_not():
    with patch.object(dd, "_ds", return_value=CREDS), patch.object(dd, "_get", return_value={
        "status": "ok", "series": [{"metric": str(i), "pointlist": [[1000, 1]]} for i in range(dd.MAX_SERIES + 1)],
    }):
        result = body(dd.datadog_query({"query": "avg:fixture.metric{*}"}))
    assert len(result["series"]) == dd.MAX_SERIES and result["truncated"] is True
    with patch.object(dd, "_ds", return_value=CREDS), patch.object(dd, "_get", return_value={
        "status": "ok", "series": [{"metric": "exact", "pointlist": [[1000, 1]] * dd.MAX_POINTS}],
    }):
        assert body(dd.datadog_query({"query": "avg:fixture.metric{*}"}))["truncated"] is False


def test_custom_header_pair_is_not_overridden_by_stale_dedicated_keys():
    creds = {**CREDS, "authType": "custom_header", "headerName": "DD-API-KEY", "headerValue": "fresh-api",
             "headerName2": "DD-APPLICATION-KEY", "headerValue2": "fresh-app"}
    headers = dd._headers(creds)
    assert headers["DD-API-KEY"] == "fresh-api" and headers["DD-APPLICATION-KEY"] == "fresh-app"
