"""Offline FinOps response contracts, validated by botocore Stubber.

Field names follow the official Compute Optimizer API response syntax:
https://docs.aws.amazon.com/compute-optimizer/latest/APIReference/API_GetEC2InstanceRecommendations.html
https://docs.aws.amazon.com/compute-optimizer/latest/APIReference/API_GetRDSDatabaseRecommendations.html
https://docs.aws.amazon.com/compute-optimizer/latest/APIReference/API_GetECSServiceRecommendations.html
https://docs.aws.amazon.com/compute-optimizer/latest/APIReference/API_GetLambdaFunctionRecommendations.html
https://docs.aws.amazon.com/boto3/latest/reference/services/cost-optimization-hub/client/list_recommendations.html
https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_GetSavingsPlansPurchaseRecommendation.html
"""
import copy
import json
import sys
from pathlib import Path

import boto3
from botocore.httpsession import URLLib3Session
from botocore.stub import Stubber
import pytest

sys.path.insert(0, str(Path(__file__).parent))
import aws_finops_mcp as finops


# Synthetic identifiers; each complete response is SDK-validated before dispatch.
CASES = {
    "ec2": {
        "method": "get_ec2_instance_recommendations",
        "collection": "instanceRecommendations",
        "options": "recommendationOptions",
        "record": {
            "instanceArn": "arn:aws:ec2:ap-northeast-2:123456789012:instance/i-0123456789abcdef0",
            "instanceName": "fixture",
            "currentInstanceType": "m5.xlarge",
            "finding": "OVER_PROVISIONED",
        },
        "option": {
            "instanceType": "m5.large", "performanceRisk": 1.0,
            "migrationEffort": "VeryLow", "rank": 1,
        },
        "expected": {
            "instanceArn": "arn:aws:ec2:ap-northeast-2:123456789012:instance/i-0123456789abcdef0",
            "instanceName": "fixture",
            "currentType": "m5.xlarge",
            "finding": "OVER_PROVISIONED",
            "recommendedType": "m5.large",
            "performanceRisk": 1.0,
            "migrationEffort": "VeryLow",
        },
    },
    "rds": {
        "method": "get_rds_database_recommendations",
        "collection": "rdsDBRecommendations",
        "options": "instanceRecommendationOptions",
        "record": {
            "resourceArn": "arn:aws:rds:ap-northeast-2:123456789012:db:fixture",
            "currentDBInstanceClass": "db.m5.xlarge",
            "engine": "postgres",
            "instanceFinding": "Overprovisioned",
            "storageFinding": "Optimized",
        },
        "option": {"dbInstanceClass": "db.m5.large", "rank": 1},
        "expected": {
            "resourceArn": "arn:aws:rds:ap-northeast-2:123456789012:db:fixture",
            "currentDBInstanceClass": "db.m5.xlarge",
            "engine": "postgres",
            "finding": "Overprovisioned",
            "recommendedDBInstanceClass": "db.m5.large",
        },
    },
    "ecs": {
        "method": "get_ecs_service_recommendations",
        "collection": "ecsServiceRecommendations",
        "options": "serviceRecommendationOptions",
        "record": {
            "serviceArn": "arn:aws:ecs:ap-northeast-2:123456789012:service/fixture/api",
            "finding": "Overprovisioned",
            "launchType": "Fargate",
            "currentServiceConfiguration": {"cpu": 1024, "memory": 2048},
        },
        "option": {"cpu": 512, "memory": 1024},
        "expected": {
            "serviceArn": "arn:aws:ecs:ap-northeast-2:123456789012:service/fixture/api",
            "finding": "Overprovisioned",
            "launchType": "Fargate",
            "currentCpu": 1024, "currentMemory": 2048,
            "recommendedCpu": 512, "recommendedMemory": 1024,
        },
    },
    "lambda": {
        "method": "get_lambda_function_recommendations",
        "collection": "lambdaFunctionRecommendations",
        "options": "memorySizeRecommendationOptions",
        "record": {
            "functionArn": "arn:aws:lambda:ap-northeast-2:123456789012:function:fixture",
            "finding": "NotOptimized",
            "currentMemorySize": 2048,
        },
        "option": {"memorySize": 1024, "rank": 1},
        "expected": {
            "functionArn": "arn:aws:lambda:ap-northeast-2:123456789012:function:fixture",
            "finding": "NotOptimized",
            "currentMemory": 2048, "recommendedMemory": 1024,
        },
    },
}


def response_for(resource_type, value=12.5):
    case = CASES[resource_type]
    option = copy.deepcopy(case["option"])
    option["savingsOpportunity"] = {
        "savingsOpportunityPercentage": 25.0,
        "estimatedMonthlySavings": {"value": value, "currency": "USD"},
    }
    # These are distinct estimates; never silently replace the base estimate.
    option["savingsOpportunityAfterDiscounts"] = {
        "estimatedMonthlySavings": {"value": 3.0, "currency": "USD"},
    }
    record = copy.deepcopy(case["record"])
    record[case["options"]] = [option]
    return {case["collection"]: [record]}


def first_option(response, resource_type):
    case = CASES[resource_type]
    return response[case["collection"]][0][case["options"]][0]


@pytest.fixture
def stubber(monkeypatch, request):
    def forbid_network(*args, **kwargs):
        pytest.fail("FinOps contract tests must never make AWS HTTP requests")

    monkeypatch.setattr(URLLib3Session, "send", forbid_network)
    service_name = getattr(request, "param", "compute-optimizer")
    region_name = "ap-northeast-2" if service_name == "compute-optimizer" else "us-east-1"
    client = boto3.Session(
        aws_access_key_id="testing",
        aws_secret_access_key="testing",
        aws_session_token="testing",
        region_name=region_name,
    ).client(service_name)

    def get_client(service, region, role_arn):
        assert (service, region, role_arn) == (service_name, region_name, None)
        return client

    monkeypatch.setattr(finops, "get_client", get_client)
    with Stubber(client) as stub:
        yield stub
        stub.assert_no_pending_responses()
    client.close()


def enqueue(stubber, resource_type, response):
    stubber.add_response(CASES[resource_type]["method"], response, {"maxResults": 50})


def invoke(resource_type="all"):
    result = finops.lambda_handler({
        "tool_name": "get_rightsizing_recommendations",
        "arguments": {"resource_type": resource_type},
    }, None)
    assert result["statusCode"] == 200, result["body"]
    return json.loads(result["body"])


@pytest.mark.parametrize("resource_type", CASES)
def test_nested_savings_and_resource_fields(stubber, resource_type):
    enqueue(stubber, resource_type, response_for(resource_type))
    body = invoke(resource_type)
    result = body["results"][resource_type]
    assert result["count"] == 1
    assert result["recommendations"] == [{
        **CASES[resource_type]["expected"],
        "estimatedMonthlySavings": 12.5,
        "currency": "USD",
    }]
    assert body["totalEstimatedMonthlySavings"] == 12.5
    assert body["currency"] == "USD"


@pytest.mark.parametrize("resource_type", CASES)
def test_explicit_zero_remains_known(stubber, resource_type):
    enqueue(stubber, resource_type, response_for(resource_type, value=0.0))
    body = invoke(resource_type)
    assert body["results"][resource_type]["recommendations"][0]["estimatedMonthlySavings"] == 0.0
    assert body["totalEstimatedMonthlySavings"] == 0.0


@pytest.mark.parametrize("resource_type", CASES)
@pytest.mark.parametrize("missing", ["options", "empty_options", "opportunity", "estimate", "value"])
def test_missing_savings_is_unknown_even_with_discounted_estimate(stubber, resource_type, missing):
    response = response_for(resource_type)
    case = CASES[resource_type]
    record = response[case["collection"]][0]
    option = first_option(response, resource_type)
    if missing == "options":
        record.pop(case["options"])
    elif missing == "empty_options":
        record[case["options"]] = []
    elif missing == "opportunity":
        option.pop("savingsOpportunity")
    elif missing == "estimate":
        option["savingsOpportunity"].pop("estimatedMonthlySavings")
    else:
        option["savingsOpportunity"]["estimatedMonthlySavings"].pop("value")
    enqueue(stubber, resource_type, response)
    body = invoke(resource_type)
    assert body["results"][resource_type]["count"] == 1
    assert body["results"][resource_type]["recommendations"][0]["estimatedMonthlySavings"] is None
    assert body["totalEstimatedMonthlySavings"] is None


@pytest.mark.parametrize("resource_type", CASES)
def test_currency_is_not_invented(stubber, resource_type):
    response = response_for(resource_type)
    first_option(response, resource_type)["savingsOpportunity"]["estimatedMonthlySavings"].pop("currency")
    enqueue(stubber, resource_type, response)
    body = invoke(resource_type)
    row = body["results"][resource_type]["recommendations"][0]
    assert row["estimatedMonthlySavings"] == 12.5
    assert row["currency"] is None
    assert body["totalEstimatedMonthlySavings"] is None


def test_all_advertised_resources_are_included_in_total(stubber):
    for resource_type in CASES:
        enqueue(stubber, resource_type, response_for(resource_type))
    body = invoke()
    assert set(body["results"]) == {"ec2", "rds", "ecs", "lambda"}
    assert all(result["count"] == 1 for result in body["results"].values())
    assert body["totalEstimatedMonthlySavings"] == 50.0


@pytest.mark.parametrize("incomplete", ["missing_savings", "api_error", "mixed_currency"])
def test_partial_success_preserves_rows_but_not_a_misleading_total(stubber, incomplete):
    for resource_type in CASES:
        response = response_for(resource_type)
        if resource_type == "rds":
            if incomplete == "api_error":
                stubber.add_client_error(
                    CASES[resource_type]["method"],
                    service_error_code="AccessDeniedException",
                    service_message="Fixture: unavailable",
                    expected_params={"maxResults": 50},
                )
                continue
            savings = first_option(response, resource_type)["savingsOpportunity"]["estimatedMonthlySavings"]
            if incomplete == "missing_savings":
                savings.pop("value")
            else:
                savings["currency"] = "CNY"
        enqueue(stubber, resource_type, response)
    body = invoke()
    assert body["results"]["ec2"]["recommendations"][0]["estimatedMonthlySavings"] == 12.5
    assert body["results"]["lambda"]["recommendations"][0]["estimatedMonthlySavings"] == 12.5
    assert body["totalEstimatedMonthlySavings"] is None


@pytest.mark.parametrize("resource_type", CASES)
def test_no_recommendations_is_zero(stubber, resource_type):
    enqueue(stubber, resource_type, {CASES[resource_type]["collection"]: []})
    body = invoke(resource_type)
    assert body["results"][resource_type]["count"] == 0
    assert body["totalEstimatedMonthlySavings"] == 0


@pytest.mark.parametrize("resource_type", CASES)
def test_api_failure_is_unknown_not_zero(stubber, resource_type):
    stubber.add_client_error(
        CASES[resource_type]["method"],
        service_error_code="OptInRequiredException",
        service_message="Fixture: account not enrolled",
        expected_params={"maxResults": 50},
    )
    body = invoke(resource_type)
    assert "OptInRequiredException" in body["results"][resource_type]["error"]
    assert len(body["results"][resource_type]["error"]) <= 200
    assert body["totalEstimatedMonthlySavings"] is None


@pytest.mark.parametrize("resource_type", ["ec2", "rds", "ecs"])
def test_response_errors_are_preserved_and_prevent_a_complete_total(stubber, resource_type):
    response = response_for(resource_type)
    response["errors"] = [{"identifier": "fixture", "code": "AccessDeniedException", "message": "Unavailable"}]
    enqueue(stubber, resource_type, response)
    body = invoke(resource_type)
    assert body["results"][resource_type]["count"] == 1
    assert body["results"][resource_type]["errors"] == response["errors"]
    assert body["totalEstimatedMonthlySavings"] is None


@pytest.mark.parametrize("resource_type", CASES)
def test_next_page_is_disclosed_without_another_request(stubber, resource_type):
    response = response_for(resource_type)
    response["nextToken"] = "fixture-next-page"
    enqueue(stubber, resource_type, response)
    body = invoke(resource_type)
    assert body["results"][resource_type]["count"] == 1
    assert body["results"][resource_type]["truncated"] is True
    assert body["totalEstimatedMonthlySavings"] is None


def test_unsupported_resource_type_is_an_error_without_querying_aws(monkeypatch):
    def forbid_client(*args, **kwargs):
        pytest.fail("Unsupported resource types must not create an AWS client")

    monkeypatch.setattr(finops, "get_client", forbid_client)
    result = finops.lambda_handler({
        "tool_name": "get_rightsizing_recommendations",
        "arguments": {"resource_type": "ebs"},
    }, None)
    assert result["statusCode"] == 500
    assert "Unsupported resource_type" in json.loads(result["body"])["error"]


@pytest.mark.parametrize("stubber", ["cost-optimization-hub"], indirect=True)
def test_hub_resource_type_uses_current_resource_type(stubber):
    stubber.add_response("list_recommendations", {
        "items": [{
            "recommendationId": "fixture",
            "accountId": "123456789012",
            "region": "us-east-1",
            "resourceId": "i-0123456789abcdef0",
            "resourceArn": "arn:aws:ec2:us-east-1:123456789012:instance/i-0123456789abcdef0",
            "currentResourceType": "Ec2Instance",
            "recommendedResourceType": "Ec2Instance",
            "actionType": "Rightsize",
            "estimatedMonthlySavings": 12.5,
            "estimatedSavingsPercentage": 25.0,
            "currencyCode": "USD",
            "currentResourceSummary": "m5.xlarge",
            "recommendedResourceSummary": "m5.large",
            "implementationEffort": "Low",
            "source": "ComputeOptimizer",
        }],
    }, {"maxResults": 50, "filter": {"resourceTypes": ["Ec2Instance"]}})
    result = finops.lambda_handler({
        "tool_name": "get_cost_optimization_hub_recommendations",
        "arguments": {"resource_type": "Ec2Instance"},
    }, None)
    assert result["statusCode"] == 200
    body = json.loads(result["body"])
    assert body["recommendations"][0]["resourceType"] == "Ec2Instance"
    assert body["recommendations"][0]["resourceId"] == "i-0123456789abcdef0"
    assert body["totalEstimatedMonthlySavings"] == 12.5


@pytest.mark.parametrize("stubber", ["ce"], indirect=True)
def test_savings_plan_resource_fields_use_nested_details(stubber):
    stubber.add_response("get_savings_plans_purchase_recommendation", {
        "SavingsPlansPurchaseRecommendation": {
            "SavingsPlansPurchaseRecommendationDetails": [{
                "AccountId": "123456789012",
                "HourlyCommitmentToPurchase": "0.5",
                "EstimatedMonthlySavingsAmount": "12.5",
                "EstimatedSavingsPercentage": "25",
                "EstimatedROI": "50",
                "CurrentAverageHourlyOnDemandSpend": "1",
                "SavingsPlansDetails": {"Region": "us-east-1", "InstanceFamily": "m5"},
            }],
            "SavingsPlansPurchaseRecommendationSummary": {
                "EstimatedMonthlySavingsAmount": "12.5",
            },
        },
    }, {
        "SavingsPlansType": "EC2_INSTANCE_SP", "TermInYears": "ONE_YEAR",
        "PaymentOption": "NO_UPFRONT", "LookbackPeriodInDays": "SIXTY_DAYS",
    })
    result = finops.lambda_handler({
        "tool_name": "get_savings_plans_recommendations",
        "arguments": {"savings_plan_type": "EC2_INSTANCE_SP"},
    }, None)
    assert result["statusCode"] == 200
    body = json.loads(result["body"])
    assert body["recommendations"][0]["region"] == "us-east-1"
    assert body["recommendations"][0]["instanceFamily"] == "m5"
    assert body["recommendations"][0]["estimatedMonthlySavings"] == "12.5"
