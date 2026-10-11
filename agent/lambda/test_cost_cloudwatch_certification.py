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
