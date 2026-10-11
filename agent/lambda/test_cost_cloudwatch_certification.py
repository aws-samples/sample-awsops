"""truncated=false is a completeness certificate — these call sites must earn it."""
import json
import os
import sys
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import aws_cloudwatch_mcp as cw_mcp  # noqa: E402
import aws_cost_mcp as cost_mcp  # noqa: E402


def _cost(tool, pages):
    ce = mock.Mock()
    ce.get_cost_and_usage.side_effect = lambda **kw: pages[kw.get("NextPageToken", "p0")]
    with mock.patch.object(cost_mcp, "get_client", return_value=ce):
        return json.loads(cost_mcp.lambda_handler({"tool_name": tool, "arguments": {}}, None)["body"]), ce


def _page(groups, nxt=None):
    out = {"ResultsByTime": [{"Groups": [{"Keys": k, "Metrics": {"UnblendedCost": {"Amount": str(v)}}} for k, v in groups]}]}
    if nxt:
        out["NextPageToken"] = nxt
    return out


def test_cost_comparison_reads_every_page():
    pages = {"p0": _page([(["EC2"], 10.0)], "p1"), "p1": _page([(["S3"], 5.0)])}
    body, ce = _cost("get_cost_and_usage_comparisons", pages)
    assert body["currentTotal"] == 15.0 and body["previousTotal"] == 15.0
    assert ce.get_cost_and_usage.call_count == 4  # 2 periods x 2 pages
    assert body["comparisonMeta"]["truncated"] is False


def test_cost_drivers_rank_over_all_pages():
    pages = {"p0": _page([(["EC2", "BoxUsage"], 1.0)], "p1"), "p1": _page([(["NAT", "Bytes"], 99.0)])}
    body, _ = _cost("get_cost_comparison_drivers", pages)
    assert body["topDriversMeta"]["truncated"] is False  # both periods equal → no drivers, but certified


def _cw(tool, args, resp_name, resp):
    client = mock.Mock()
    getattr(client, resp_name).return_value = resp
    with mock.patch.object(cw_mcp, "get_client", return_value=client):
        return json.loads(cw_mcp.lambda_handler({"tool_name": tool, "arguments": args}, None)["body"]), client


def test_active_alarms_include_composite_alarms():
    body, client = _cw("get_active_alarms", {}, "describe_alarms", {
        "MetricAlarms": [], "CompositeAlarms": [{"AlarmName": "svc-down", "StateValue": "ALARM", "AlarmRule": "ALARM(a)"}]})
    assert client.describe_alarms.call_args.kwargs["AlarmTypes"] == ["CompositeAlarm", "MetricAlarm"]
    assert body["count"] == 1 and body["activeAlarms"][0]["type"] == "composite"


def test_running_insights_query_is_never_certified_complete():
    body, _ = _cw("get_logs_insight_query_results", {"query_id": "q"}, "get_query_results",
                  {"status": "Running", "results": []})
    assert body["truncated"] is True and body["more_pages"] is True
    body, _ = _cw("get_logs_insight_query_results", {"query_id": "q"}, "get_query_results",
                  {"status": "Complete", "results": []})
    assert body["truncated"] is False and body["total"] == 0


# ── review: bounded Cost Explorer paging, alarm caps, unknown (not empty) serverless caches ───────

def test_cost_paging_is_bounded_and_discloses_the_cut():
    pages = {"p0": _page([(["EC2"], 1.0)], "p1")}
    for i in range(1, 10):
        pages[f"p{i}"] = _page([([f"S{i}"], 1.0)], f"p{i + 1}")
    pages["p10"] = _page([(["last"], 1.0)])
    body, ce = _cost("get_cost_and_usage_comparisons", pages)
    assert ce.get_cost_and_usage.call_count == 2 * cost_mcp.CE_MAX_PAGES      # 2 periods, page-capped
    assert body["costPagesCut"] is True and body["comparisonMeta"]["more_pages"] is True
    assert "pagination stopped" in body["note"]


def test_cost_paging_stops_on_a_token_that_never_advances():
    pages = {"p0": _page([(["EC2"], 1.0)], "loop"), "loop": _page([(["S3"], 1.0)], "loop")}
    body, ce = _cost("get_cost_comparison_drivers", pages)
    assert ce.get_cost_and_usage.call_count == 4                              # 2 periods x 2 reads, then the repeat is cut
    assert body["topDriversMeta"]["truncated"] is True


def test_cost_paging_stops_when_the_time_budget_is_spent(monkeypatch):
    clock = iter(range(0, 1000, 25))
    monkeypatch.setattr(cost_mcp.time, "monotonic", lambda: next(clock))
    pages = {f"p{i}": _page([([f"S{i}"], 1.0)], f"p{i + 1}") for i in range(10)}
    pages["p0"] = _page([(["EC2"], 1.0)], "p1")
    body, ce = _cost("get_cost_and_usage_comparisons", pages)
    assert body["costPagesCut"] is True and ce.get_cost_and_usage.call_count < 2 * cost_mcp.CE_MAX_PAGES


def test_complete_cost_read_is_certified_without_a_cut_flag():
    pages = {"p0": _page([(["EC2"], 10.0)])}
    body, _ = _cost("get_cost_and_usage_comparisons", pages)
    assert "costPagesCut" not in body and body["comparisonMeta"]["truncated"] is False


def test_alarm_flood_cannot_crowd_out_composite_alarms():
    metric = [{"AlarmName": f"m{i}", "StateValue": "ALARM"} for i in range(30)]
    composite = [{"AlarmName": f"c{i}", "StateValue": "ALARM", "AlarmRule": "ALARM(x)"} for i in range(3)]
    body, _ = _cw("get_active_alarms", {}, "describe_alarms", {"MetricAlarms": metric, "CompositeAlarms": composite})
    types = [a["type"] for a in body["activeAlarms"]]
    assert types.count("composite") == 3 and len(types) == 20
    assert body["truncated"] is True and body["total"] == 33 and body["returned"] == 20


def test_dropped_composite_alarms_are_never_reported_complete():
    composite = [{"AlarmName": f"c{i}", "StateValue": "ALARM", "AlarmRule": "ALARM(x)"} for i in range(15)]
    body, _ = _cw("get_active_alarms", {}, "describe_alarms", {"MetricAlarms": [], "CompositeAlarms": composite})
    assert body["returned"] == 10 and body["total"] == 15 and body["truncated"] is True


def test_serverless_cache_read_failure_is_unknown_not_empty():
    import aws_valkey_mcp as valkey
    ec = mock.Mock()
    ec.describe_serverless_caches.side_effect = RuntimeError("not available")
    with mock.patch.object(valkey, "get_client", return_value=ec):
        body = json.loads(valkey.lambda_handler({"tool_name": "list_serverless_caches", "arguments": {}}, None)["body"])
    assert body["truncated"] is True and body["readFailed"] is True and "unknown, not empty" in body["note"]
