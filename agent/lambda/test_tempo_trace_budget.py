"""Oversized real-shaped trace responses retain bounded usable spans."""
import copy
import base64
import json
from pathlib import Path
from unittest.mock import patch

import pytest
import tempo_mcp as tempo


CASE = json.loads((Path(__file__).resolve().parents[1]
                   / "fixtures/tempo-trace-budget-contract.json").read_text())


def read_trace(raw, status=200):
    with patch.object(tempo, "_ds", return_value={"endpoint": "https://fixture.invalid"}), \
            patch.object(tempo, "http_json", return_value=(200, raw)) as http:
        response = tempo.lambda_handler({
            "tool_name": "tempo_get_trace", "arguments": {"trace_id": CASE["traceId"]},
        }, None)
    http.assert_called_once()
    assert response["statusCode"] == status
    assert len(response["body"].encode("utf-8")) <= tempo.MAX_TOTAL_BYTES
    return json.loads(response["body"])


@pytest.mark.parametrize("root", ["batches", "resourceSpans"])
@pytest.mark.parametrize("scope", ["scopeSpans", "instrumentationLibrarySpans"])
def test_oversized_trace_retains_wire_contract(root, scope):
    raw = copy.deepcopy(CASE["raw"])
    batch = raw.pop("batches")[0]
    batch[scope] = batch.pop("scopeSpans")
    raw[root] = [batch]
    batch[scope][0]["spans"][0]["events"] = [{"name": "x" * tempo.MAX_TOTAL_BYTES}]
    original = copy.deepcopy(raw)
    expected = copy.deepcopy(CASE["expected"])
    expected[root] = expected.pop("batches")
    assert read_trace(raw) == expected
    assert raw == original


def test_projection_stays_within_real_utf8_budget_with_many_spans():
    raw = copy.deepcopy(CASE["raw"])
    spans = raw["batches"][0]["scopeSpans"][0]["spans"]
    template = {**spans[0], "name": "읽기" * 100, "links": []}
    spans[:] = [{**template, "spanId": f"{i + 1:016x}"} for i in range(5000)]
    body = read_trace(raw)
    projected = body["batches"][0]["scopeSpans"][0]["spans"]
    assert body["truncated"] is True
    assert 0 < len(projected) < len(spans)
    assert projected[0]["name"] == template["name"]
    assert projected[0]["spanId"] == spans[0]["spanId"]


def test_small_trace_is_unchanged():
    assert read_trace(CASE["raw"]) == {"truncated": False, **CASE["raw"]}

@pytest.mark.parametrize("truncated", [True, False, "unknown"])
def test_small_trace_preserves_upstream_completeness_without_trusting_no_fit_marker(truncated):
    raw = {**copy.deepcopy(CASE["raw"]), "truncated": truncated, "tracePayloadTruncated": True}
    original = copy.deepcopy(raw)
    body = read_trace(raw)
    assert body["truncated"] == truncated
    assert "tracePayloadTruncated" not in body
    assert raw == original


def test_projection_keeps_resource_identity_across_scopes_and_bounds_links():
    raw = copy.deepcopy(CASE["raw"])
    batch = raw["batches"][0]
    batch["scopeSpans"].append(copy.deepcopy(batch["scopeSpans"][0]))
    for scope in batch["scopeSpans"]:
        scope["spans"][0]["links"] *= 20_000
    body = read_trace(raw)
    assert len(body["batches"]) == 2
    for group in body["batches"]:
        assert group["resource"] == batch["resource"]
        assert len(group["scopeSpans"][0]["spans"][0]["links"]) == 64


def test_projection_does_not_hide_malformed_resource_metadata():
    raw = copy.deepcopy(CASE["raw"])
    raw["batches"][0]["resource"] = None
    raw["padding"] = "x" * tempo.MAX_TOTAL_BYTES
    assert "batches" not in read_trace(raw)


@pytest.mark.parametrize("field,value", [("spanId", ""), ("spanId", "0000000000000000"),
                                       ("startTimeUnixNano", None), ("endTimeUnixNano", "0")])
def test_no_fit_marker_cannot_hide_an_invalid_span(field, value):
    raw = copy.deepcopy(CASE["raw"])
    raw["batches"][0]["scopeSpans"][0]["spans"][0][field] = value
    with patch.object(tempo, "MAX_TOTAL_BYTES", 128):
        assert read_trace(raw).get("tracePayloadTruncated") is not True


def test_oversized_error_payload_cannot_become_projected_success():
    raw = copy.deepcopy(CASE["raw"])
    raw.update(error="upstream failed", padding="x" * tempo.MAX_TOTAL_BYTES)
    body = read_trace(raw, status=400)
    assert body["collectionStatus"] == "error"
    assert "batches" not in body

@pytest.mark.parametrize("field,value", [
    ("spanId", None), ("spanId", ""), ("spanId", "0000000000000000"),
    ("traceId", "2"), ("traceId", "00000000000000000000000000000000"),
    ("startTimeUnixNano", None), ("startTimeUnixNano", "-1"),
    ("endTimeUnixNano", "0"), ("endTimeUnixNano", str(1 << 64)),
    ("parentSpanId", None), ("parentSpanId", "bad"), ("name", {}),
    ("status", {"code": "invalid"}), ("links", [{"traceId": "2", "spanId": "0"}]),
])
@pytest.mark.parametrize("position", ["before", "after"])
def test_fitting_malformed_span_never_becomes_projected_evidence(field, value, position):
    raw = copy.deepcopy(CASE["raw"])
    spans = raw["batches"][0]["scopeSpans"][0]["spans"]
    bad = {**copy.deepcopy(spans[0]), field: value}
    spans.insert(0 if position == "before" else len(spans), bad)
    raw["padding"] = "x" * tempo.MAX_TOTAL_BYTES
    body = read_trace(raw)
    assert body["collectionStatus"] == "unknown"
    assert "batches" not in body and "projection" not in body
    assert body.get("tracePayloadTruncated") is not True

def test_identityless_fitting_span_is_not_projected():
    raw = copy.deepcopy(CASE["raw"])
    raw["batches"][0]["scopeSpans"][0]["spans"].insert(0, {})
    raw["padding"] = "x" * tempo.MAX_TOTAL_BYTES
    assert "batches" not in read_trace(raw)

def test_valid_base64_identity_survives_projection_and_no_fit_validation():
    raw = copy.deepcopy(CASE["raw"])
    span = raw["batches"][0]["scopeSpans"][0]["spans"][0]
    span["traceId"] = base64.b64encode(bytes.fromhex("0" * 31 + "1")).decode()
    span["spanId"] = base64.b64encode(bytes.fromhex("0" * 15 + "1")).decode()
    raw["padding"] = "x" * tempo.MAX_TOTAL_BYTES
    body = read_trace(raw)
    assert body["batches"][0]["scopeSpans"][0]["spans"][0]["spanId"] == span["spanId"]
    with patch.object(tempo, "MAX_TOTAL_BYTES", 128):
        assert read_trace(raw)["tracePayloadTruncated"] is True
