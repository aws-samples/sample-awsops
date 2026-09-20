import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile


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
        {"address": summary.COLLECTOR, "values": {"function_name": "PRIVATE_FUNCTION"}},
    ]}}}, "resource_changes": [
        change(summary.GROUP, {"name": "deployment-verifiers", "user_pool_id": "PRIVATE_POOL", "role_arn": None}),
        change(summary.MEMBER, {"group_name": "deployment-verifiers", "user_pool_id": "PRIVATE_POOL", "username": "PRIVATE_USER"}),
        change(summary.COLLECTOR, {"function_name": "PRIVATE_FUNCTION", "role": "PRIVATE_ROLE", "source_code_hash": HASH},
               ["update"], {"function_name": "PRIVATE_FUNCTION", "role": "PRIVATE_ROLE", "source_code_hash": "previous"}),
    ], "output_changes": {}}


def test_expected_rollout_projects_checks_without_values():
    result = summary.project(plan())
    assert result["no_changes_outside_expected_scope"]
    assert len(result["resource_changes"]) == 3
    assert "PRIVATE" not in json.dumps(result)
    assert result["resource_changes"][-1]["configured_code_sha256"] == HASH
    assert result["planned_changes"] == {
        "verifier_group_created": True, "managed_demo_enrolled": True,
        "collector_code_updated": True, "readiness_enabled_in_output": False}


def test_no_changes_is_not_resource_presence_or_readiness_confirmation():
    result = summary.project({"format_version": "1.2"})
    assert result["no_changes_outside_expected_scope"]
    assert not any(result["planned_changes"].values())
    assert result["resource_changes"] == result["output_changes"] == []


def test_address_moves_are_outside_scope_even_with_noop_or_known_updates():
    for index, actions in ((0, ["no-op"]), (2, ["no-op"]), (2, ["update"])):
        value = plan()
        row = value["resource_changes"][index]
        row["previous_address"] = 'module.PRIVATE_STACK.aws_lambda_function.PRIVATE_NAME'
        row["change"]["actions"] = actions
        if actions == ["no-op"]:
            row["change"]["before"] = copy.deepcopy(row["change"]["after"])
        result = summary.project(value)
        assert not result["no_changes_outside_expected_scope"]
        assert not result["resource_changes"][index]["matches_expected_scope"]
        assert "PRIVATE" not in json.dumps(result)


def test_imports_unknown_shapes_and_action_invocations_remain_unreviewed():
    for change in ("import", "unknown", "action", "deferred"):
        value = plan()
        row = value["resource_changes"][0]
        if change == "import":
            row["change"]["actions"] = ["no-op"]
            row["change"]["importing"] = {"id": "PRIVATE_ID"}
        elif change == "unknown":
            row["change"]["after_unknown"] = True
        elif change == "action":
            value["action_invocations"] = [{"config": "PRIVATE_ACTION"}]
        else:
            value["deferred_changes"] = [{"reason": "PRIVATE_REASON"}]
        result = summary.project(value)
        assert not result["no_changes_outside_expected_scope"]
        assert "PRIVATE" not in json.dumps(result)


def test_real_terraform_import_is_not_hidden_by_noop_actions():
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        root.joinpath("main.tf").write_text(
            'resource "terraform_data" "example" {}\n'
            'import {\n to = terraform_data.example\n id = "PRIVATE_IMPORT"\n}\n')
        env = {k: v for k, v in os.environ.items() if not k.startswith(("AWS_", "TF_"))}
        env.update(CHECKPOINT_DISABLE="1", AWS_EC2_METADATA_DISABLED="true",
                   AWS_CONFIG_FILE="/dev/null", AWS_SHARED_CREDENTIALS_FILE="/dev/null",
                   TF_CLI_CONFIG_FILE="/dev/null")
        for command in (
            ["terraform", "init", "-backend=false", "-input=false"],
            ["terraform", "plan", "-input=false", "-out=tfplan"],
        ):
            result = subprocess.run(command, cwd=root, env=env, text=True,
                                    capture_output=True, timeout=15)
            assert result.returncode == 0, result.stderr
        value = json.loads(subprocess.check_output(
            ["terraform", "show", "-json", "tfplan"], cwd=root, env=env, text=True, timeout=15))
        resource = value["resource_changes"][0]
        assert resource["change"]["actions"] == ["no-op"]
        assert resource["change"]["importing"]
        result = summary.project(value)
        assert not result["no_changes_outside_expected_scope"]
        assert len(result["resource_changes"]) == 1
        assert "PRIVATE_IMPORT" not in json.dumps(result)


def test_import_metadata_excludes_every_recognized_action_path():
    for index in range(3):
        for importing in ({"id": "PRIVATE_IMPORT"}, {}, False):
            value = plan()
            value["resource_changes"][index]["change"]["importing"] = importing
            result = summary.project(value)
            assert not result["no_changes_outside_expected_scope"]
            assert not result["resource_changes"][index]["matches_expected_scope"]
            assert "configured_code_sha256" not in result["resource_changes"][index]
            assert "PRIVATE" not in json.dumps(result)


def test_sensitive_or_unmatched_collector_hash_is_not_published():
    for change in ("sensitive", "role"):
        value = plan()
        row = value["resource_changes"][2]
        if change == "sensitive":
            row["change"]["after_sensitive"] = {"source_code_hash": True}
        else:
            row["change"]["after"]["role"] = "PRIVATE_OTHER_ROLE"
        result = summary.project(value)
        assert not result["planned_changes"]["collector_code_updated"]
        assert "configured_code_sha256" not in result["resource_changes"][2]


def test_unexpected_resource_and_sensitive_key_are_never_published():
    value = plan()
    value["resource_changes"][0]["address"] = 'aws_iam_role.items["PRIVATE_PASSWORD"]'
    value["resource_changes"][0]["change"]["after"] = {"secret": "PRIVATE_SECRET"}
    result = summary.project(value)
    assert not result["no_changes_outside_expected_scope"]
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
        assert not result["no_changes_outside_expected_scope"]
        assert "PRIVATE" not in json.dumps(result)


def test_membership_only_checks_the_existing_groups_iam_role():
    for role in (None, "PRIVATE_ADMIN_ROLE"):
        value = plan()
        value["resource_changes"] = [value["resource_changes"][1]]
        value["prior_state"]["values"]["root_module"]["resources"].append({
            "address": summary.GROUP,
            "values": {"name": "deployment-verifiers", "user_pool_id": "PRIVATE_POOL", "role_arn": role},
        })
        result = summary.project(value)
        assert result["no_changes_outside_expected_scope"] is (role is None)
        assert result["planned_changes"]["managed_demo_enrolled"] is (role is None)
        assert "PRIVATE" not in json.dumps(result)
    value["prior_state"]["values"]["root_module"]["resources"].pop()
    assert not summary.project(value)["no_changes_outside_expected_scope"]


def test_deletes_unknown_roles_and_unrecognized_outputs_remain_unreviewed():
    value = plan()
    value["resource_changes"][0]["change"]["after_unknown"]["role_arn"] = True
    value["resource_changes"][1]["change"]["actions"] = ["delete"]
    value["output_changes"] = {"PRIVATE_OUTPUT": {"actions": ["update"], "after": "PRIVATE_SECRET"}}
    result = summary.project(value)
    assert not result["no_changes_outside_expected_scope"]
    assert "PRIVATE" not in json.dumps(result)


def test_only_the_two_expected_output_deltas_are_projected():
    value = plan()
    value["output_changes"] = {
        "agentcore": {"actions": ["update"],
                      "before": {"role_arn": "PRIVATE_ROLE", "deployment_readiness_enabled": False},
                      "after": {"role_arn": "PRIVATE_ROLE", "deployment_readiness_enabled": True}},
        "runtime_deployment": {"actions": ["update"],
                               "before": {"inventory": {"sync_code_sha256": "TYwIZpErPrCndYW8xYnWWh3mI1YW6yiPScDIEh+Q+o8="}},
                               "after": {"inventory": {"sync_code_sha256": HASH}}},
    }
    original = copy.deepcopy(value)
    result = summary.project(value)
    assert result["no_changes_outside_expected_scope"]
    assert value == original
    assert "PRIVATE" not in json.dumps(result)
    value["output_changes"]["agentcore"]["after"]["role_arn"] = "PRIVATE_OTHER_ROLE"
    assert not summary.project(value)["no_changes_outside_expected_scope"]


def test_output_changes_share_the_report_row_budget():
    for resources in ([], plan()["resource_changes"]):
        value = plan()
        value["resource_changes"] = resources
        value["output_changes"] = {
            f"PRIVATE_{i}": {"actions": ["update"], "before": "PRIVATE_OLD", "after": "PRIVATE_NEW"}
            for i in range(257)
        }
        result = summary.project(value)
        assert result["truncated"]
        assert len(result["resource_changes"]) + len(result["output_changes"]) == 256
        assert not result["no_changes_outside_expected_scope"]
        assert "PRIVATE" not in json.dumps(result)


def test_capped_changes_cannot_be_mistaken_for_complete_review():
    value = plan()
    value["resource_changes"] = value["resource_changes"] * 100
    result = summary.project(value)
    assert result["truncated"]
    assert len(result["resource_changes"]) == 256
    assert not result["no_changes_outside_expected_scope"]


def test_workflow_projects_only_manual_dev_plans_before_encryption():
    import yaml
    root = Path(__file__).resolve().parents[2]
    steps = yaml.safe_load((root / ".github/workflows/terraform.yml").read_text())["jobs"]["plan"]["steps"]
    index = next(i for i, step in enumerate(steps)
                 if step.get("name") == "Project bounded readiness changes without private plan values")
    step = steps[index]
    assert step["if"] == "github.event_name == 'workflow_dispatch' && steps.restore.outputs.skip != '1' && env.TARGET == 'dev' && vars.CI_READINESS_ENABLED_DEV == 'true' && (inputs.plan_scope || 'full') == 'full'"
    assert step["continue-on-error"] is True
    assert step["timeout-minutes"] == 2
    assert next(i for i, s in enumerate(steps) if s.get("name") == "Check planned DNS operations") < index
    assert index < next(i for i, s in enumerate(steps) if s.get("name") == "Encrypt plan artifact")
    assert step["run"].strip() == (
        'set -euo pipefail\n'
        'readiness_rc=0\n'
        'readiness_summary="$(terraform show -json tfplan 2>/dev/null |\n'
        '  python3 ../../scripts/v2/ci_readiness_plan_summary.py)" || readiness_rc=$?\n'
        '{\n'
        "  printf '### Bounded readiness plan changes\\n\\n```json\\n'\n"
        "  printf '%s\\n' \"$readiness_summary\"\n"
        "  printf '```\\n'\n"
        '} | tee -a "$GITHUB_STEP_SUMMARY"\n'
        'exit "$readiness_rc"'
    )


def test_workflow_fences_success_and_sanitized_failure_without_hiding_status():
    import yaml
    root = Path(__file__).resolve().parents[2]
    steps = yaml.safe_load((root / ".github/workflows/terraform.yml").read_text())["jobs"]["plan"]["steps"]
    step = next(s for s in steps if s.get("name") == "Project bounded readiness changes without private plan values")
    for payload, expected_code in [(json.dumps(plan()), 0), ('{"PRIVATE_BROKEN":', 1)]:
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            command = temporary / "terraform"
            command.write_text("#!/usr/bin/env python3\nprint(" + repr(payload) + ")\n")
            command.chmod(0o700)
            output = temporary / "summary.md"
            env = {**os.environ, "PATH": str(temporary) + os.pathsep + os.environ["PATH"],
                   "GITHUB_STEP_SUMMARY": str(output)}
            result = subprocess.run(["bash", "-e", "-c", step["run"]],
                                    cwd=root / "terraform/foundation", env=env,
                                    capture_output=True, text=True, timeout=10)
            assert result.returncode == expected_code
            rendered = output.read_text()
            assert rendered.startswith("### Bounded readiness plan changes\n\n```json\n")
            assert rendered.endswith("```\n")
            assert "PRIVATE" not in rendered + result.stdout + result.stderr
