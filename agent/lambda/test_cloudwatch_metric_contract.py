"""Offline metric requests match the registered tools and botocore API shapes."""
import importlib.util
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import Mock

import botocore.session
from botocore.validate import validate_parameters
from jsonschema import Draft202012Validator
import pytest

sys.path.insert(0, str(Path(__file__).parent))
import aws_cloudwatch_mcp as cloudwatch

_spec = importlib.util.spec_from_file_location(
    "cloudwatch_contract_catalog", Path(__file__).resolve().parents[2] / "scripts/v2/agentcore/catalog.py",
)
catalog = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(catalog)
SCHEMAS = {tool["name"]: tool["inputSchema"]
           for tool in catalog.TARGETS["cloudwatch-mcp-target"]["tools"]}
MODEL = botocore.session.get_session().get_service_model("cloudwatch")


@pytest.fixture
def clients(monkeypatch):
    cw, logs = Mock(), Mock()
    cw.list_metrics.return_value = {"Metrics": []}
    cw.get_metric_statistics.return_value = {"Datapoints": []}
    monkeypatch.setattr(cloudwatch, "get_client", lambda service, *_: cw if service == "cloudwatch" else logs)
    return cw, logs


def invoke(tool, args):
    response = cloudwatch.lambda_handler({"tool_name": tool, "arguments": args}, None)
    return response["statusCode"], json.loads(response["body"])


def test_namespace_only_metadata_omits_absent_metric_name(clients):
    cw, _ = clients
    status, body = invoke("get_metric_metadata", {"namespace": "AWS/RDS"})
    assert status == 200 and body["metrics"] == []
    request = cw.list_metrics.call_args.kwargs
    assert request == {"Namespace": "AWS/RDS"}
    validate_parameters(request, MODEL.operation_model("ListMetrics").input_shape)


def test_metadata_can_filter_metric_and_verified_dimensions(clients):
    cw, _ = clients
    status, _ = invoke("get_metric_metadata", {
        "namespace": "AWS/RDS", "metric_name": "DatabaseConnections",
        "dimensions": {"DBInstanceIdentifier": "fixture"},
    })
    assert status == 200
    request = cw.list_metrics.call_args.kwargs
    assert request == {"Namespace": "AWS/RDS", "MetricName": "DatabaseConnections",
                       "Dimensions": [{"Name": "DBInstanceIdentifier", "Value": "fixture"}]}
    validate_parameters(request, MODEL.operation_model("ListMetrics").input_shape)


def test_percentile_metric_uses_extended_statistics_and_preserves_known_value(clients):
    cw, _ = clients
    cw.get_metric_statistics.return_value = {"Datapoints": [{
        "Timestamp": datetime(2026, 10, 1, tzinfo=timezone.utc),
        "ExtendedStatistics": {"p95": 72.25}, "Unit": "Percent",
    }]}
    status, body = invoke("get_metric_data", {
        "namespace": "AWS/EC2", "metric_name": "CPUUtilization",
        "dimensions": {"InstanceId": "i-0123456789abcdef0"},
        "statistic": "p95", "minutes": 20160, "period": 3600, "unit": "Percent",
    })
    assert status == 200 and body["datapoints"][0]["value"] == 72.25
    request = cw.get_metric_statistics.call_args.kwargs
    assert request["ExtendedStatistics"] == ["p95"] and "Statistics" not in request
    assert request["Unit"] == "Percent"
    assert (request["EndTime"] - request["StartTime"]).total_seconds() == 14 * 86400
    validate_parameters(request, MODEL.operation_model("GetMetricStatistics").input_shape)


@pytest.mark.parametrize("over", [
    {"minutes": 0}, {"minutes": 20161}, {"minutes": True}, {"minutes": "60"},
    {"period": 0}, {"period": 61}, {"period": True},
    {"minutes": 20160, "period": 60}, {"statistic": "arbitrary"},
    {"dimensions": {"InstanceId": None}}, {"dimensions": {"": "fixture"}},
    {"dimensions": [{"Name": "InstanceId"}]}, {"unit": "Invalid"},
    {"namespace": None}, {"metric_name": "CPUUtilization\nPRIVATE"},
])
def test_invalid_metric_request_is_rejected_before_any_provider_call(clients, over):
    cw, logs = clients
    status, body = invoke("get_metric_data", {"namespace": "AWS/EC2", "metric_name": "CPUUtilization", **over})
    assert status == 400 and "PRIVATE" not in json.dumps(body)
    assert cw.mock_calls == [] and logs.mock_calls == []


def test_missing_metric_value_remains_unknown_instead_of_zero(clients):
    cw, _ = clients
    cw.get_metric_statistics.return_value = {"Datapoints": [{"Timestamp": datetime(2026, 10, 1)}]}
    status, body = invoke("get_metric_data", {"namespace": "AWS/EC2", "metric_name": "CPUUtilization"})
    assert status == 200 and body["datapoints"][0]["value"] is None


@pytest.mark.parametrize("dimensions", [
    {"DBInstanceIdentifier": "fixture"},
    [{"Name": "DBInstanceIdentifier", "Value": "fixture"}],
])
def test_standard_statistics_accept_existing_dimension_shapes_without_unit_none(clients, dimensions):
    cw, _ = clients
    status, _ = invoke("get_metric_data", {
        "namespace": "AWS/RDS", "metric_name": "DatabaseConnections", "dimensions": dimensions,
        "statistic": "Maximum", "minutes": 1440, "period": 3600,
    })
    assert status == 200
    request = cw.get_metric_statistics.call_args.kwargs
    assert request["Statistics"] == ["Maximum"] and "Unit" not in request
    assert request["Dimensions"] == [{"Name": "DBInstanceIdentifier", "Value": "fixture"}]
    validate_parameters(request, MODEL.operation_model("GetMetricStatistics").input_shape)


def test_registered_metric_schema_admits_sizing_inputs_and_rejects_invalid_bounds():
    schema = SCHEMAS["get_metric_data"]
    request = {"namespace": "AWS/RDS", "metric_name": "DatabaseConnections",
               "dimensions": {"DBInstanceIdentifier": "fixture"}, "statistic": "p95",
               "minutes": 20160, "period": 3600, "unit": "Count"}
    Draft202012Validator(schema).validate(request)
    for key in ["dimensions", "statistic", "minutes", "period", "unit"]:
        assert key in schema["properties"]
    for invalid in [{"minutes": 20161}, {"period": 61}, {"statistic": "arbitrary"}, {"unit": "Invalid"}]:
        assert list(Draft202012Validator(schema).iter_errors({**request, **invalid}))
    metadata_schema = SCHEMAS["get_metric_metadata"]
    Draft202012Validator(metadata_schema).validate({"namespace": "AWS/RDS"})
    assert "metric_name" in metadata_schema["properties"] and "dimensions" in metadata_schema["properties"]
    assert "metric_name" not in metadata_schema.get("required", [])
