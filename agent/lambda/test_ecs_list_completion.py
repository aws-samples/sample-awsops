"""ECS list completeness must include the subsequent describe result."""
import json
from unittest import mock

import pytest
import aws_ecs_mcp as ecs_mcp


@pytest.mark.parametrize("operation,list_method,list_field,describe_method,detail_field,row", [
    ("list_clusters", "list_clusters", "clusterArns", "describe_clusters", "clusters",
     {"clusterName": "one", "status": "ACTIVE"}),
    ("list_services", "list_services", "serviceArns", "describe_services", "services",
     {"serviceName": "one", "status": "ACTIVE"}),
    ("list_tasks", "list_tasks", "taskArns", "describe_tasks", "tasks",
     {"taskArn": "task/one", "lastStatus": "RUNNING"}),
])
@pytest.mark.parametrize("with_failure", [False, True])
def test_missing_descriptions_are_partial(operation, list_method, list_field,
                                         describe_method, detail_field, row, with_failure):
    client = mock.Mock()
    getattr(client, list_method).return_value = {list_field: ["one", "two"]}
    response = {detail_field: [row]}
    if with_failure:
        response["failures"] = [{"arn": "two", "reason": "MISSING", "detail": "private detail"}]
    getattr(client, describe_method).return_value = response
    with mock.patch.object(ecs_mcp, "get_client", return_value=client):
        body = json.loads(ecs_mcp.handle_resource({"operation": operation, "cluster": "c"})["body"])
    assert body["returned"] == len(body[detail_field]) == 1
    assert body["total"] == 2
    assert body["truncated"] is True and body["details_incomplete"] is True
    assert "private detail" not in json.dumps(body)


def test_all_failed_descriptions_are_not_certified_empty():
    client = mock.Mock()
    client.list_services.return_value = {"serviceArns": ["one"]}
    client.describe_services.return_value = {"services": [], "failures": [{"reason": "MISSING"}]}
    with mock.patch.object(ecs_mcp, "get_client", return_value=client):
        body = json.loads(ecs_mcp.handle_resource({"operation": "list_services", "cluster": "c"})["body"])
    assert body["services"] == [] and body["returned"] == 0
    assert body["truncated"] is True and body["total"] == 1


def test_complete_descriptions_remain_complete_and_preserve_list_pagination():
    client = mock.Mock()
    client.describe_services.return_value = {
        "services": [{"serviceName": "one", "status": "ACTIVE"}], "failures": []}
    for token in (None, "next"):
        client.list_services.return_value = {"serviceArns": ["one"], "nextToken": token}
        with mock.patch.object(ecs_mcp, "get_client", return_value=client):
            body = json.loads(ecs_mcp.handle_resource({"operation": "list_services", "cluster": "c"})["body"])
        assert body["returned"] == body["total"] == 1
        assert body["truncated"] is bool(token)
        assert "details_incomplete" not in body
