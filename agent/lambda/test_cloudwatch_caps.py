"""Capped CloudWatch list results must disclose the cap (cap_list metadata)."""
import json
import os
import sys
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import aws_cloudwatch_mcp as cw_mcp  # noqa: E402


def _call(tool, args, logs=None, cw=None):
    def client(service, *a, **k):
        return logs if service == "logs" else cw
    with mock.patch.object(cw_mcp, "get_client", side_effect=client):
        return json.loads(cw_mcp.lambda_handler({"tool_name": tool, "arguments": args}, None)["body"])


def test_describe_log_groups_api_side_cap_uses_next_token():
    logs = mock.Mock()
    logs.describe_log_groups.return_value = {"logGroups": [{"logGroupName": "g"}], "nextToken": "n"}
    body = _call("describe_log_groups", {}, logs=logs, cw=mock.Mock())
    assert body["truncated"] is True and body["more_pages"] is True and body["returned"] == 1


def test_describe_log_groups_complete_when_no_token():
    logs = mock.Mock()
    logs.describe_log_groups.return_value = {"logGroups": []}
    body = _call("describe_log_groups", {}, logs=logs, cw=mock.Mock())
    assert (body["truncated"], body["total"]) == (False, 0)  # certified empty


def test_alarm_history_and_log_events_disclose_pages():
    cw = mock.Mock()
    cw.describe_alarm_history.return_value = {"AlarmHistoryItems": [{}], "NextToken": "n"}
    assert _call("get_alarm_history", {"alarm_name": "a"}, logs=mock.Mock(), cw=cw)["more_pages"] is True
    logs = mock.Mock()
    logs.filter_log_events.return_value = {"events": [{"message": "x"}] * 3, "nextToken": "n"}
    body = _call("analyze_log_group", {"log_group": "g"}, logs=logs, cw=mock.Mock())
    assert body["more_pages"] is True and body["matchingEvents"] == 3
