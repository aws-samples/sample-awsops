"""The configuration reader accepts wrapped MCP arguments without losing scope."""
import json
import sys
from pathlib import Path
from unittest.mock import Mock

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import flowmonitor


@pytest.mark.parametrize("wrapped", [False, True])
def test_vpc_configuration_read_uses_the_selected_argument_shape(monkeypatch, wrapped):
    ec2 = Mock()
    ec2.describe_flow_logs.return_value = {"FlowLogs": [{
        "FlowLogId": "fl-0123456789abcdef0", "ResourceId": "vpc-0123456789abcdef0",
        "TrafficType": "ALL", "LogStatus": "ACTIVE", "LogDestination": "fixture-log-group",
    }]}
    monkeypatch.setattr(flowmonitor, "get_client", lambda service, region, role: ec2)
    arguments = {"vpc_id": "vpc-0123456789abcdef0", "region": "ap-northeast-2"}
    event = {"tool_name": "query_flow_logs", "arguments": arguments,
             "vpc_id": "vpc-0fedcba9876543210"} if wrapped else arguments
    response = flowmonitor.lambda_handler(event, None)
    assert response["statusCode"] == 200
    body = json.loads(response["body"])
    assert body["vpcId"] == "vpc-0123456789abcdef0" and body["count"] == 1
    assert "events" not in body
    ec2.describe_flow_logs.assert_called_once_with(
        Filters=[{"Name": "resource-id", "Values": ["vpc-0123456789abcdef0"]}],
    )


def test_wrapped_member_scope_is_forwarded_to_the_existing_cross_account_boundary(monkeypatch):
    ec2 = Mock()
    ec2.describe_flow_logs.return_value = {"FlowLogs": []}
    role = Mock(return_value="fixture-member-role")
    client = Mock(return_value=ec2)
    monkeypatch.setattr(flowmonitor, "get_role_arn", role)
    monkeypatch.setattr(flowmonitor, "get_client", client)
    response = flowmonitor.lambda_handler({
        "tool_name": "query_flow_logs",
        "arguments": {"vpc_id": "vpc-0123456789abcdef0", "region": "us-east-1",
                      "target_account_id": "111122223333"},
    }, None)
    assert response["statusCode"] == 200 and json.loads(response["body"])["count"] == 0
    role.assert_called_once_with("111122223333")
    client.assert_called_once_with("ec2", "us-east-1", "fixture-member-role")
