"""Source-only graph producer contracts; Runtime receipt-wire tests follow the core."""
import copy
import json
from pathlib import Path
from unittest.mock import patch

import pytest
import prometheus_mcp as prom
import mimir_mcp as mimir
import tempo_mcp as tempo
import clickhouse_mcp as clickhouse


TEMPO_CASES = json.loads((Path(__file__).resolve().parents[1]
                         / "fixtures/tempo-topology-contract.json").read_text())


@pytest.mark.parametrize("case", TEMPO_CASES, ids=lambda case: case["name"])
def test_actual_tempo_producer_matches_graph_fixture(case):
    with patch.object(tempo, "_ds", return_value={"endpoint": "https://fixture.invalid"}), \
            patch.object(tempo, "http_json", return_value=(200, copy.deepcopy(case["upstream"]))) as http:
        out = tempo.lambda_handler({"tool_name": "tempo_search", "arguments": {"query": "{}"}}, None)
    http.assert_called_once()
    assert out["statusCode"] == 200
    assert json.loads(out["body"]) == case["body"]


ZERO = {"metric": {"client": "api", "server": "db"}, "value": [1, "0"]}


@pytest.mark.parametrize("module,tool", [(prom, "prometheus_query"), (mimir, "mimir_query")])
@pytest.mark.parametrize("rows,status,warnings,expected", [
    ([], "success", [], "empty"),
    ([ZERO], "success", [], "ok"),
    ([ZERO], "success", ["partial upstream result"], "partial"),
    ([], "success", ["partial upstream result"], "partial"),
    ([], None, [], "unknown"),
    (None, "success", [], "unknown"),
])
def test_metric_completion_and_warning_evidence_survives(module, tool, rows, status, warnings, expected):
    response = {"data": {"resultType": "vector", "result": copy.deepcopy(rows)}}
    if status is not None:
        response["status"] = status
    if warnings:
        response["warnings"] = warnings
    with patch.object(module, "_ds", return_value={"endpoint": "https://fixture.invalid"}), \
            patch.object(module, "http_json", return_value=(200, response)) as http:
        out = module.lambda_handler({"tool_name": tool, "arguments": {"query": "up"}}, None)
    http.assert_called_once()
    body = json.loads(out["body"])
    assert body["collectionStatus"] == expected
    if rows:
        assert body["result"] == rows  # Observed zero is preserved, including partial responses.


META = [{"name": "TraceId", "type": "String"}]


@pytest.mark.parametrize("response,expected", [
    ({"meta": META, "data": [], "rows": 0}, "empty"),
    ({"meta": META, "data": [{"TraceId": "a"}], "rows": 1}, "ok"),
    ({"meta": META, "rows": 0}, "unknown"),
    ({"data": [], "rows": 0}, "unknown"),
    ({"meta": META, "data": []}, "empty"),
    ({"meta": META, "data": [None], "rows": 1}, "partial"),
    ({"meta": META, "data": [], "rows": 0, "exception": "fixture error"}, "error"),
    ({"meta": META, "data": [], "rows": 0, "rows_before_limit_at_least": 1}, "partial"),
])
def test_clickhouse_computes_completion_from_observed_response(response, expected):
    with patch.object(clickhouse, "load_datasource", return_value={"endpoint": "https://fixture.invalid"}), \
            patch.object(clickhouse, "assert_host_allowed"), \
            patch.object(clickhouse, "http_json", return_value=(200, copy.deepcopy(response))):
        out = clickhouse.clickhouse_query({"sql": "SELECT TraceId FROM traces"})
    body = json.loads(out["body"])
    assert body["collectionStatus"] == expected
    assert body["rows"] == response.get("data", [])
    assert "exception" not in body
