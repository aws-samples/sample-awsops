import copy
import importlib.util
import json
from pathlib import Path


SPEC = importlib.util.spec_from_file_location(
    "summary", Path(__file__).with_name("ci_readiness_plan_summary.py"))
summary = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(summary)
HASH = "ilglk4b1XbT9KO4x3Ab6UOVhOCHcbDb++ZbFlkZfdOw="


def plan():
    def change(address, after, actions=None, before=None):
        return {"address": address, "change": {
            "actions": actions or ["create"], "before": before, "after": after, "after_unknown": {}}}
    return {"format_version": "1.2", "prior_state": {"values": {"root_module": {"resources": [
        {"address": "aws_cognito_user_pool.main", "values": {"id": "PRIVATE_POOL"}},
        {"address": "aws_cognito_user.demo[0]", "values": {"username": "PRIVATE_USER"}},
    ]}}}, "resource_changes": [
        change(summary.GROUP, {"name": "deployment-verifiers", "user_pool_id": "PRIVATE_POOL", "role_arn": None}),
        change(summary.MEMBER, {"group_name": "deployment-verifiers", "user_pool_id": "PRIVATE_POOL", "username": "PRIVATE_USER"}),
        change(summary.COLLECTOR, {"role": "PRIVATE_ROLE", "source_code_hash": HASH},
               ["update"], {"role": "PRIVATE_ROLE", "source_code_hash": "previous"}),
    ], "output_changes": {}}


def test_expected_rollout_projects_checks_without_values():
    result = summary.project(plan())
    assert result["all_changes_match_expected_scope"]
    assert len(result["resource_changes"]) == 3
    assert "PRIVATE" not in json.dumps(result)
    assert result["resource_changes"][-1]["configured_code_sha256"] == HASH


def test_unexpected_resource_and_sensitive_key_are_never_published():
    value = plan()
    value["resource_changes"][0]["address"] = 'aws_iam_role.items["PRIVATE_PASSWORD"]'
    value["resource_changes"][0]["change"]["after"] = {"secret": "PRIVATE_SECRET"}
    result = summary.project(value)
    assert not result["all_changes_match_expected_scope"]
    assert result["resource_changes"][0]["resource"] == "other_resource"
    assert "PRIVATE" not in json.dumps(result)


def test_membership_role_and_collector_scope_mismatches_are_not_reviewed_as_expected():
    for index, field, replacement in [
        (0, "role_arn", "PRIVATE_ADMIN_ROLE"), (0, "name", "admins"),
        (1, "username", "PRIVATE_OTHER_USER"), (1, "user_pool_id", "PRIVATE_OTHER_POOL"),
        (2, "role", "PRIVATE_OTHER_ROLE"), (2, "environment", {"secret": "PRIVATE_SECRET"}),
    ]:
        value = plan()
        value["resource_changes"][index]["change"]["after"][field] = replacement
        result = summary.project(value)
        assert not result["all_changes_match_expected_scope"]
        assert "PRIVATE" not in json.dumps(result)


def test_deletes_unknown_roles_and_unrecognized_outputs_remain_unreviewed():
    value = plan()
    value["resource_changes"][0]["change"]["after_unknown"]["role_arn"] = True
    value["resource_changes"][1]["change"]["actions"] = ["delete"]
    value["output_changes"] = {"PRIVATE_OUTPUT": {"actions": ["update"], "after": "PRIVATE_SECRET"}}
    result = summary.project(value)
    assert not result["all_changes_match_expected_scope"]
    assert "PRIVATE" not in json.dumps(result)


def test_only_the_two_expected_output_deltas_are_projected():
    value = plan()
    value["prior_state"]["values"]["root_module"]["resources"].append({
        "address": "aws_cloudfront_distribution.main", "values": {"id": "PRIVATE_CF"}})
    value["output_changes"] = {
        "agentcore": {"actions": ["update"],
                      "before": {"role_arn": "PRIVATE_ROLE", "deployment_readiness_enabled": False, "readiness_cloudfront_id": None},
                      "after": {"role_arn": "PRIVATE_ROLE", "deployment_readiness_enabled": True, "readiness_cloudfront_id": "PRIVATE_CF"}},
        "runtime_deployment": {"actions": ["update"],
                               "before": {"inventory": {"sync_code_sha256": "TYwIZpErPrCndYW8xYnWWh3mI1YW6yiPScDIEh+Q+o8="}},
                               "after": {"inventory": {"sync_code_sha256": HASH}}},
    }
    original = copy.deepcopy(value)
    result = summary.project(value)
    assert result["all_changes_match_expected_scope"]
    assert value == original
    assert "PRIVATE" not in json.dumps(result)
    value["output_changes"]["agentcore"]["after"]["role_arn"] = "PRIVATE_OTHER_ROLE"
    assert not summary.project(value)["all_changes_match_expected_scope"]


def test_capped_changes_cannot_be_mistaken_for_complete_review():
    value = plan()
    value["resource_changes"] = value["resource_changes"] * 100
    result = summary.project(value)
    assert result["truncated"]
    assert len(result["resource_changes"]) == 256
    assert not result["all_changes_match_expected_scope"]
