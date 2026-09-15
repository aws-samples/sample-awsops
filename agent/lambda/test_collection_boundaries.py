"""Bounded producer outputs and the actual Tempo child omission envelope."""
import importlib.util
import json
from pathlib import Path
from unittest import mock

import pytest

from test_collection_markers import MODULES, invoke

ROOT = Path(__file__).resolve().parents[2]
CHILD_CASES = json.loads((ROOT / "agent/fixtures/tempo-child-contract.json").read_text())


@pytest.mark.parametrize("case", CHILD_CASES, ids=lambda case: case["name"])
def test_actual_tempo_child_body_matches_adapter_fixture(case):
    with mock.patch.object(MODULES["tempo"], "MAX_TOTAL_BYTES", case["byteLimit"]):
        code, body, _ = invoke("tempo", case["upstream"], {"trace_id": "a1"}, tool="tempo_get_trace")
    assert code == 200
    assert body == case["body"]
    assert "preview" not in body


@pytest.mark.parametrize("kind", ["prometheus", "mimir"])
@pytest.mark.parametrize("shape", ["entry", "nested-entry", "sample", "matrix-sample", "result"])
def test_malformed_series_never_echo_large_values(kind, shape):
    secret = "PRIVATE" * 200_000
    data = {"resultType": "vector", "result": [secret]}
    if shape == "nested-entry":
        data["result"] = [[secret]]
    elif shape == "sample":
        data["result"] = [{"metric": {}, "value": [1, secret]}]
    elif shape == "matrix-sample":
        data = {"resultType": "matrix", "result": [{"metric": {}, "values": [[1, secret]]}]}
    elif shape == "result":
        data["result"] = secret
    _, body, _ = invoke(kind, {"status": "success", "data": data})
    encoded = json.dumps(body)
    assert len(encoded) < 1000
    assert "PRIVATE" not in encoded
    assert body["collectionStatus"] == "unknown"


@pytest.mark.parametrize("kind", ["prometheus", "mimir"])
def test_valid_rows_survive_beside_fixed_malformed_markers(kind):
    row = {"metric": {"client": "api", "server": "db"}, "value": [1, "7"]}
    _, body, _ = invoke(kind, {"status": "success", "data": {
        "resultType": "vector", "result": [row, "PRIVATE" * 1000]}})
    assert body["result"] == [row, None]
    assert body["collectionStatus"] == "unknown"


@pytest.mark.parametrize("kind", ["prometheus", "mimir"])
@pytest.mark.parametrize("result_type,value", [("scalar", "42"), ("string", "valid"), ("string", "PRIVATE" * 1000)])
def test_scalar_and_string_support_keeps_single_bounded_samples(kind, result_type, value):
    code, body, _ = invoke(kind, {"status": "success", "data": {
        "resultType": result_type, "result": [1, value]}})
    assert code == 200
    assert body["resultType"] == result_type
    assert body["result"] == ([1, value] if len(value) <= 4096 else [])
    assert body["collectionStatus"] == ("ok" if len(value) <= 4096 else "unknown")
    assert "count" not in body
    assert "PRIVATE" not in json.dumps(body)


@pytest.mark.parametrize("kind", ["prometheus", "mimir"])
@pytest.mark.parametrize("action,data", [
    ("query", {"resultType": "vector", "result": [{"metric": {"label": "x" * 4000}, "value": [1, "2"]}]}),
    ("labels", ["x" * 4000]),
    ("series", [{"label": "x" * 4000}]),
])
def test_query_and_discovery_outputs_have_a_byte_bound(kind, action, data):
    with mock.patch.object(MODULES[kind], "MAX_RESULT_BYTES", 512, create=True):
        _, body, _ = invoke(kind, {"status": "success", "data": data},
                            {"match": "up"}, tool=f"{kind}_{action}")
    assert len(json.dumps(body)) <= 512
    assert body["truncated"] is True
    assert body["collectionStatus"] == "partial"
    assert "x" * 100 not in json.dumps(body)


@pytest.mark.parametrize("kind", ["prometheus", "mimir"])
def test_large_error_text_has_a_fixed_bounded_error(kind):
    _, body, _ = invoke(kind, {"status": "error", "error": "PRIVATE" * 200_000})
    assert len(json.dumps(body)) < 1000
    assert "PRIVATE" not in json.dumps(body)


@pytest.mark.parametrize("metrics,complete", [
    (None, False), ({}, True), ({"inspectedBlocks": 10, "inspectedBytes": 500}, True),
    ({"completedJobs": 0, "totalJobs": 0}, True),
])
@pytest.mark.parametrize("nonempty", [False, True])
def test_counterless_tempo_uses_the_valid_synchronous_response(metrics, complete, nonempty):
    traces = [{"traceID": "a1"}] if nonempty else []
    _, body, _ = invoke("tempo", {"traces": traces, "metrics": metrics})
    assert body["collectionStatus"] == (("ok" if nonempty else "empty") if complete else "unknown")
    if not complete:
        assert body["completionReason"] == "search_response_unverified"
    assert body["traces"] == traces


@pytest.mark.parametrize("traces", [[], [{"traceID": "a1"}]])
def test_unknown_metric_fields_do_not_invalidate_or_supply_completion_proof(traces):
    metrics = {"inspectedBytes": "18446744073709551615", "inspectedBlocks": 10,
               "futureCounter": {"not": "a consulted counter"}}
    _, body, _ = invoke("tempo", {"traces": traces, "metrics": metrics})
    assert body["collectionStatus"] == ("ok" if traces else "empty")
    assert body["metrics"] == {"inspectedBytes": "18446744073709551615"}
    _, unknown, _ = invoke("tempo", {"metrics": {"futureCounter": 9}})
    assert unknown["collectionStatus"] == "unknown"
    _, invalid, _ = invoke("tempo", {"traces": traces, "metrics": {**metrics, "completedJobs": True}})
    assert invalid["collectionStatus"] == "unknown"


@pytest.mark.parametrize("payload,http_status,expected", [
    ({"metrics": {"completedJobs": 2}}, 200, "empty"),
    ({"metrics": {}}, 200, "empty"),
    ({"traces": []}, 200, "empty"),
    ({"metrics": {"inspectedBytes": "0"}}, 200, "empty"),
    ({"metrics": {"inspectedBytes": "500"}}, 206, "partial"),
    ({}, 200, "unknown"),
    ({"metrics": {"arbitraryPositiveCounter": 500}}, 200, "unknown"),
    ({"metrics": {"completedJobs": -1}}, 200, "unknown"),
    ({"metrics": {"completedJobs": 0, "totalJobs": 2}}, 200, "partial"),
    ({"metrics": {}, "warnings": ["incomplete"]}, 200, "partial"),
    ({"metrics": {}, "error": "query failed"}, 200, "error"),
])
def test_tempo_http_final_contract_does_not_use_counter_presence_as_proof(payload, http_status, expected):
    _, body, _ = invoke("tempo", payload, status=http_status)
    assert body["collectionStatus"] == expected
    if expected == "empty":
        assert body["traces"] == []


@pytest.mark.parametrize("metrics,expected", [
    ({"inspectedBytes": "18446744073709551615", "additionalMetrics": {"work": "-1"}}, "empty"),
    ({"inspectedBytes": "18446744073709551616"}, "unknown"),
    ({"completedJobs": 4294967296}, "unknown"),
    ({"inspectedBytes": "9" * 100_000}, "unknown"),
    ({"additionalMetrics": {"work": True}}, "unknown"),
])
def test_tempo_proto_metric_types_are_bounded(metrics, expected):
    _, body, _ = invoke("tempo", {"metrics": metrics})
    assert body["collectionStatus"] == expected


def test_tempo_bounds_requested_limit_without_an_extra_query():
    for given, expected in [(0, 1), (999999, 50), (None, 20)]:
        _, _, call = invoke("tempo", {"traces": [], "metrics": {"completedJobs": 1, "totalJobs": 1}},
                            {"limit": given})
        assert f"limit={expected}" in call.args[1]


def test_tempo_cannot_relabel_an_error_or_nontrace_body_as_bounded_trace_data():
    for upstream in [{"error": "PRIVATE" * 100}, {"raw": "PRIVATE" * 100},
                     {"batches": [], "junk": "PRIVATE" * 100, "tracePayloadTruncated": True}]:
        with mock.patch.object(MODULES["tempo"], "MAX_TOTAL_BYTES", 128):
            _, body, _ = invoke("tempo", upstream, {"trace_id": "a1"}, tool="tempo_get_trace")
        assert body.get("tracePayloadTruncated") is not True
        assert "PRIVATE" not in json.dumps(body)


def test_catalog_teaches_completion_for_every_affected_tool():
    spec = importlib.util.spec_from_file_location("boundary_catalog", ROOT / "scripts/v2/agentcore/catalog.py")
    catalog = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(catalog)
    tools = {tool["name"]: tool for target in catalog.TARGETS.values() for tool in target["tools"]}
    affected = ["clickhouse_query", "clickhouse_tables", "clickhouse_describe", "tempo_search"]
    affected += [f"{kind}_{action}" for kind in ("prometheus", "mimir")
                 for action in ("query", "query_range", "labels", "series")]
    for name in affected:
        description = tools[name]["description"]
        assert "collectionStatus" in description, name
        assert "partial" in description and "unknown" in description and "empty" in description, name
        if name.startswith(("prometheus_", "mimir_")):
            assert "payload_truncated" in description, name
    trace_description = tools["tempo_get_trace"]["description"]
    for marker in ("tracePayloadTruncated", "tracePayloadUnverified", "partial", "unknown", "absence"):
        assert marker in trace_description, marker
