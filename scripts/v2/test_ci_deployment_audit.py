"""Offline behavior tests; neither the workflow nor AWS is dispatched."""
import base64
from copy import deepcopy
from datetime import datetime, timezone
import fnmatch
import json
import os
from pathlib import Path
import subprocess

from botocore.exceptions import ClientError
import pytest
import yaml

import ci_deployment_audit as audit


ACCOUNT = "123456789012"
PROJECT = "fixture-dev"
REGION = "ap-northeast-2"
ROLE = f"arn:aws:iam::{ACCOUNT}:role/fixture-ci"
RUNTIME_ROLE = f"arn:aws:iam::{ACCOUNT}:role/{PROJECT}-agentcore"
CLUSTER = f"arn:aws:ecs:{REGION}:{ACCOUNT}:cluster/{PROJECT}"
FUNCTION = f"arn:aws:lambda:{REGION}:{ACCOUNT}:function:{PROJECT}-inv-sync"
RULE = f"arn:aws:events:{REGION}:{ACCOUNT}:rule/{PROJECT}-inv-sync-ec2"
RUNTIME = f"arn:aws:bedrock-agentcore:{REGION}:{ACCOUNT}:runtime/awsops_v2_agent-fixture"
CODE_SHA = base64.b64encode(b"x" * 32).decode()
NOW = datetime(2026, 9, 14, 4, 0, tzinfo=timezone.utc)
ENV = {
    "GITHUB_REPOSITORY": "aws-samples/sample-awsops",
    "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REF": "refs/heads/dev",
    "AWS_REGION": REGION, "AWS_ACCOUNT_ID_DEV": ACCOUNT, "RUNTIME_ROLE_ARN": ROLE,
    "EXPECTED_PROJECT": PROJECT,
}


def definition(component, revision=3):
    return f"arn:aws:ecs:{REGION}:{ACCOUNT}:task-definition/{PROJECT}-{component}:{revision}"


def outputs():
    return {
        "runtime_deployment": {
            "schema_version": 1, "account_id": ACCOUNT, "region": REGION, "project": PROJECT,
            "features": {"inventory": True, "agentcore": True, "workers": True},
            "web": {"cluster": PROJECT, "service": f"{PROJECT}-web",
                    "task_role_arn": f"arn:aws:iam::{ACCOUNT}:role/{PROJECT}-task"},
            "inventory": {"service": f"{PROJECT}-steampipe",
                          "task_definition_arn": definition("steampipe"),
                          "task_role_arn": f"arn:aws:iam::{ACCOUNT}:role/{PROJECT}-steampipe-task",
                          "sync_function_name": f"{PROJECT}-inv-sync", "sync_function_arn": FUNCTION,
                          "sync_code_sha256": CODE_SHA},
            "agentcore": {"role_arn": RUNTIME_ROLE,
                          "runtime_arn_param": f"/ops/{PROJECT}/agentcore/runtime_arn"},
            "known": {"cloudfront_distribution_id": "E123456789ABC"},
        },
        "agentcore": {"project": PROJECT, "region": REGION, "role_arn": RUNTIME_ROLE,
                      "ssm_runtime_arn": f"/ops/{PROJECT}/agentcore/runtime_arn"},
        "agent_sql_reader_secret_arn":
            f"arn:aws:secretsmanager:{REGION}:{ACCOUNT}:secret:ops/{PROJECT}/agent/sql-reader-Ab1234",
        "aurora_database": "awsops",
    }


class FakeAWS:
    def __init__(self):
        self.calls = []
        self.overrides = {}

    def __call__(self, service, operation, **params):
        self.calls.append((service, operation, params))
        key = (service, operation)
        if key in self.overrides:
            value = self.overrides[key]
            if isinstance(value, Exception):
                raise value
            return deepcopy(value)
        if operation == "get_caller_identity":
            return {"Account": ACCOUNT, "Arn": f"arn:aws:sts::{ACCOUNT}:assumed-role/fixture-ci/session"}
        if operation == "describe_services":
            name = params["services"][0]
            component = name.removeprefix(f"{PROJECT}-")
            return {"services": [{"serviceName": name, "clusterArn": CLUSTER,
                                 "serviceArn": f"arn:aws:ecs:{REGION}:{ACCOUNT}:service/{PROJECT}/{name}",
                                 "status": "ACTIVE", "desiredCount": 1, "runningCount": 1,
                                 "pendingCount": 0, "taskDefinition": definition(component)}]}
        if operation == "list_tasks":
            component = params["serviceName"].removeprefix(f"{PROJECT}-")
            suffix = "a" if component == "web" else "b"
            return {"taskArns": [f"arn:aws:ecs:{REGION}:{ACCOUNT}:task/{PROJECT}/{suffix * 32}"]}
        if operation == "describe_tasks":
            component = "web" if params["tasks"][0].endswith("a" * 32) else "steampipe"
            return {"tasks": [{"taskArn": params["tasks"][0], "clusterArn": CLUSTER,
                              "group": f"service:{PROJECT}-{component}",
                              "lastStatus": "RUNNING", "healthStatus": "HEALTHY",
                              "taskDefinitionArn": definition(component)}]}
        if operation == "get_function_configuration":
            return {"FunctionArn": FUNCTION, "State": "Active", "LastUpdateStatus": "Successful",
                    "CodeSha256": CODE_SHA, "LastModified": "2026-09-14T03:00:00.000+0000"}
        if operation == "describe_rule":
            return {"Arn": RULE, "State": "ENABLED", "ScheduleExpression": "rate(15 minutes)"}
        if operation == "list_targets_by_rule":
            return {"Targets": [{"Id": "inv-sync-ec2", "Arn": FUNCTION, "Input": '{"type":"all"}'}]}
        if operation == "get_policy":
            return {"Policy": json.dumps({"Statement": [{
                "Effect": "Allow", "Principal": {"Service": "events.amazonaws.com"},
                "Action": "lambda:InvokeFunction", "Resource": FUNCTION,
                "Condition": {"ArnLike": {"AWS:SourceArn": RULE}},
            }]})}
        if operation == "get_metric_data":
            return {"MetricDataResults": [
                {"Id": q["Id"], "StatusCode": "Complete", "Timestamps": [NOW.replace(hour=3)],
                 "Values": [0 if q["Id"] == "lambda_errors" else 2]}
                for q in params["MetricDataQueries"]
            ]}
        if operation == "get_parameter":
            return {"Parameter": {"Value": RUNTIME}}
        if operation == "get_agent_runtime":
            return {"agentRuntimeArn": RUNTIME, "agentRuntimeName": "awsops_v2_agent",
                    "status": "READY", "roleArn": RUNTIME_ROLE, "agentRuntimeVersion": "2"}
        if operation == "describe_db_clusters":
            return {"DBClusters": [{
                "DBClusterArn": f"arn:aws:rds:{REGION}:{ACCOUNT}:cluster:{PROJECT}-aurora",
                "DBClusterIdentifier": f"{PROJECT}-aurora", "DatabaseName": "awsops",
                "HttpEndpointEnabled": True,
            }]}
        if operation == "execute_statement":
            sql = params["sql"]
            if sql == audit.READER_SQL:
                records = [{"reader": True, "restricted": True}]
            elif sql == audit.LEDGER_SQL:
                records = [{"resource_type": "cloudfront", "status": "succeeded", "row_count": 1,
                            "last_success_row_count": 1, "unknown_attribute_count": 0,
                            "started_at": "2026-09-14T03:30:00Z",
                            "finished_at": "2026-09-14T03:31:00Z",
                            "last_success_at": "2026-09-14T03:31:00Z"}]
            elif sql == audit.COUNTS_SQL:
                records = [{"resource_type": "cloudfront", "row_count": 1,
                            "oldest_at": "2026-09-14T03:31:00Z", "newest_at": "2026-09-14T03:31:00Z"}]
            elif sql == audit.CLOUDFRONT_SQL:
                records = [{"row_count": 1, "oldest_at": "2026-09-14T03:31:00Z",
                            "newest_at": "2026-09-14T03:31:00Z"}]
            else:
                raise AssertionError("Unexpected SQL")
            return {"formattedRecords": json.dumps(records)}
        raise AssertionError(f"Unexpected mock operation: {service}/{operation}")


@pytest.mark.parametrize("key,value", [
    ("GITHUB_REPOSITORY", "Atom-oh/awsops"), ("GITHUB_EVENT_NAME", "pull_request"),
    ("GITHUB_REF", "refs/heads/main"), ("GITHUB_REF", "refs/heads/preview"),
    ("AWS_REGION", "us-east-1"), ("AWS_ACCOUNT_ID_DEV", ""),
    ("RUNTIME_ROLE_ARN", ROLE.replace(ACCOUNT, "999999999999")),
    ("EXPECTED_PROJECT", "../other"),
])
def test_context_rejected_before_any_api(key, value):
    aws = FakeAWS()
    with pytest.raises(ValueError):
        audit.collect(outputs(), {**ENV, key: value}, aws, NOW)
    assert aws.calls == []


@pytest.mark.parametrize("path,value", [
    (("runtime_deployment", "account_id"), "999999999999"),
    (("runtime_deployment", "project"), "foreign"),
    (("runtime_deployment", "web", "service"), "foreign-web"),
    (("runtime_deployment", "inventory", "sync_function_arn"), FUNCTION.replace(ACCOUNT, "999999999999")),
    (("runtime_deployment", "inventory", "task_definition_arn"), definition("foreign")),
    (("agentcore", "role_arn"), RUNTIME_ROLE.replace(PROJECT, "foreign")),
    (("agent_sql_reader_secret_arn",), f"arn:aws:secretsmanager:{REGION}:{ACCOUNT}:secret:rds!cluster-master"),
])
def test_foreign_outputs_rejected_before_any_api(path, value):
    data, aws = outputs(), FakeAWS()
    parent = data
    for key in path[:-1]:
        parent = parent[key]
    parent[path[-1]] = value
    with pytest.raises(ValueError):
        audit.collect(data, ENV, aws, NOW)
    assert aws.calls == []


def test_complete_observations_are_not_complete_inventory():
    aws = FakeAWS()
    report = audit.collect(outputs(), ENV, aws, NOW)
    assert report["deployment"]["web"]["status"] == "OBSERVED"
    assert report["deployment"]["web"]["target_matches_state"] is None
    assert report["deployment"]["steampipe"]["running_revisions"] == [3]
    assert report["deployment"]["sync_lambda"]["code_matches_state"] is True
    assert report["deployment"]["agentcore"]["role_matches_state"] is True
    assert report["events"]["schedule"]["permission_matches"] is True
    assert report["events"]["metrics"]["lambda_errors"]["sum"] == 0
    assert report["data"]["coverage"] == "observed_types_only"
    assert report["data"]["completeness"] == "UNKNOWN"
    assert report["data"]["known_cloudfront"]["row_count"] == 1
    assert report["read_errors"] == 0
    encoded = json.dumps(report)
    assert ACCOUNT not in encoded and "arn:aws" not in encoded and "sql-reader" not in encoded
    queries = [p for _, op, p in aws.calls if op == "execute_statement"]
    assert len(queries) == 4
    assert all(p["secretArn"] == outputs()["agent_sql_reader_secret_arn"] for p in queries)
    assert all(p["sql"].lstrip().startswith("SELECT ") for p in queries)


@pytest.mark.parametrize("result", [
    {"Id": "lambda_errors", "StatusCode": "Complete", "Timestamps": [], "Values": []},
    {"Id": "lambda_errors", "StatusCode": "PartialData", "Timestamps": [NOW], "Values": [0]},
    {"Id": "lambda_errors", "StatusCode": "Forbidden", "Timestamps": [], "Values": []},
])
def test_missing_or_partial_metrics_are_unknown_not_zero(result):
    aws = FakeAWS()
    aws.overrides["cloudwatch", "get_metric_data"] = {"MetricDataResults": [result]}
    item = audit.collect(outputs(), ENV, aws, NOW)["events"]["metrics"]["lambda_errors"]
    assert item["status"] == "UNKNOWN" and item["sum"] is None


def test_foreign_task_not_described():
    aws = FakeAWS()
    aws.overrides["ecs", "list_tasks"] = {"taskArns": [CLUSTER.replace(ACCOUNT, "999999999999")]}
    assert audit.collect(outputs(), ENV, aws, NOW)["deployment"]["web"]["status"] == "UNKNOWN"
    assert not any(op == "describe_tasks" for _, op, _ in aws.calls)


@pytest.mark.parametrize("runtime", ["PENDING", "", RUNTIME.replace(ACCOUNT, "999999999999")])
def test_pending_and_foreign_runtime_never_reach_control_api(runtime):
    aws = FakeAWS()
    aws.overrides["ssm", "get_parameter"] = {"Parameter": {"Value": runtime}}
    assert audit.collect(outputs(), ENV, aws, NOW)["deployment"]["agentcore"]["status"] != "READY"
    assert not any(op == "get_agent_runtime" for _, op, _ in aws.calls)


def test_wrong_caller_stops_after_sts():
    aws = FakeAWS()
    aws.overrides["sts", "get_caller_identity"] = {
        "Account": ACCOUNT, "Arn": f"arn:aws:sts::{ACCOUNT}:assumed-role/wrong/session"}
    with pytest.raises(ValueError):
        audit.collect(outputs(), ENV, aws, NOW)
    assert len(aws.calls) == 1


def test_errors_are_safe_and_other_sections_survive():
    aws = FakeAWS()
    aws.overrides["lambda", "get_function_configuration"] = ClientError(
        {"Error": {"Code": "AccessDeniedException", "Message": "SECRET raw-token=never-print"}}, "GetFunctionConfiguration")
    report = audit.collect(outputs(), ENV, aws, NOW)
    assert report["deployment"]["sync_lambda"] == {"status": "UNKNOWN", "reason": "access_denied"}
    assert report["deployment"]["web"]["status"] == "OBSERVED"
    assert report["read_errors"] == 1
    assert "SECRET" not in json.dumps(report) and "raw-token" not in json.dumps(report)


def test_unexpected_database_identity_never_reads_inventory():
    aws = FakeAWS()
    aws.overrides["rds-data", "execute_statement"] = {
        "formattedRecords": '[{"reader":false,"restricted":false}]'}
    assert audit.collect(outputs(), ENV, aws, NOW)["data"]["status"] == "UNKNOWN"
    assert len([1 for _, op, _ in aws.calls if op == "execute_statement"]) == 1


def test_read_adapter_rejects_mutations_without_creating_client():
    def forbidden(*args, **kwargs):
        raise AssertionError("Client creation must not happen")
    api = audit.ReadAPI(forbidden)
    with pytest.raises(audit.ReadOnlyViolation):
        api("ecs", "run_task", cluster=CLUSTER)
    with pytest.raises(audit.ReadOnlyViolation):
        api("rds-data", "execute_statement", sql="DELETE FROM inventory_resources")


def workflow():
    path = Path(__file__).resolve().parents[2] / ".github/workflows/audit-deployment.yml"
    return yaml.safe_load(path.read_text())


@pytest.mark.parametrize("key,value", [
    ("GITHUB_REPOSITORY", "foreign/repo"), ("GITHUB_REF", "refs/heads/main"),
    ("GITHUB_EVENT_NAME", "push"),
])
def test_actual_workflow_guard_rejects_wrong_context(key, value):
    script = workflow()["jobs"]["guard"]["steps"][0]["run"]
    result = subprocess.run(["bash", "-c", script], env={**os.environ, **ENV, key: value},
                            capture_output=True, text=True)
    assert result.returncode != 0


def test_actual_workflow_guard_accepts_development():
    script = workflow()["jobs"]["guard"]["steps"][0]["run"]
    assert subprocess.run(["bash", "-c", script], env={**os.environ, **ENV},
                          capture_output=True).returncode == 0


@pytest.mark.parametrize("failure", ["", "init", "output"])
def test_actual_capture_keeps_outputs_private_and_removes_backend(tmp_path, failure):
    directory, binaries = tmp_path / "audit", tmp_path / "bin"
    binaries.mkdir()
    fake = binaries / "terraform"
    fake.write_text("""#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
with open(os.environ['CALL_LOG'], 'a') as log: log.write(json.dumps(args) + '\\n')
assert not any(k.startswith(('TF_LOG', 'TF_CLI_ARGS')) for k in os.environ)
if 'init' in args:
    data = pathlib.Path(os.environ['TF_DATA_DIR'])
    data.mkdir()
    (data / 'terraform.tfstate').write_text('PRIVATE_BACKEND')
if os.environ['FAILURE'] in args:
    print('SECRET_TEST_DETAIL', file=sys.stderr)
    sys.exit(1)
print('{}')
""")
    fake.chmod(0o755)
    steps = workflow()["jobs"]["audit"]["steps"]
    capture = next(s["run"] for s in steps if s.get("name", "").startswith("Capture only"))
    cleanup = next(s for s in steps if s.get("name", "").startswith("Always remove"))
    env = {**os.environ, **ENV, "PATH": f"{binaries}:{os.environ['PATH']}",
           "AUDIT_DIR": str(directory), "FAILURE": failure, "CALL_LOG": str(tmp_path / "calls"),
           "BACKEND_B64": base64.b64encode(b'bucket="private-test-state"').decode(),
           "TF_LOG": "TRACE", "TF_CLI_ARGS": "-not-an-audit-argument"}
    result = subprocess.run(["bash", "-c", capture], env=env, capture_output=True, text=True)
    assert (result.returncode == 0) == (failure == "")
    assert not (directory / "backend.hcl").exists() and not (directory / "tfdata").exists()
    assert "PRIVATE_BACKEND" not in result.stdout + result.stderr
    assert "SECRET_TEST_DETAIL" not in result.stdout + result.stderr
    assert directory.stat().st_mode & 0o777 == 0o700
    if not failure:
        assert {p.stem for p in directory.iterdir()} == set(audit.OUTPUTS)
        assert all(p.stat().st_mode & 0o777 == 0o600 for p in directory.iterdir())
        calls = [json.loads(line) for line in (tmp_path / "calls").read_text().splitlines()]
        assert len(calls) == 5
        assert all(args[1] == "output" and args[2] == "-json" for args in calls[1:])
    assert cleanup["if"] == "always()"
    subprocess.run(["bash", "-c", cleanup["run"]], env=env, check=True)
    assert not directory.exists()


def test_actual_cli_retains_safe_partial_report_and_fails_on_read_error(tmp_path, monkeypatch, capsys):
    for key, value in ENV.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(tmp_path / "summary"))
    for key, value in outputs().items():
        (tmp_path / f"{key}.json").write_text(json.dumps(value))
    aws = FakeAWS()
    aws.overrides["lambda", "get_function_configuration"] = ClientError(
        {"Error": {"Code": "AccessDeniedException", "Message": "SECRET_SHOULD_NOT_APPEAR"}}, "GetFunctionConfiguration")
    monkeypatch.setattr(audit, "ReadAPI", lambda factory: aws)
    assert audit.main(["audit", "--directory", str(tmp_path)]) == 1
    text = capsys.readouterr().out
    report = json.loads(text)
    assert report["deployment"]["web"]["status"] == "OBSERVED"
    assert report["read_errors"] == 1
    assert "SECRET_SHOULD_NOT_APPEAR" not in text + (tmp_path / "summary").read_text()


def test_actual_cli_rejects_bad_context_without_any_client(monkeypatch, capsys):
    monkeypatch.setenv("GITHUB_REF", "refs/heads/main")
    monkeypatch.delenv("GITHUB_STEP_SUMMARY", raising=False)
    monkeypatch.setattr(audit, "ReadAPI", lambda _: pytest.fail("must fail before client factory"))
    assert audit.main(["guard"]) == 1
    assert json.loads(capsys.readouterr().out) == {"status": "UNKNOWN", "reason": "audit_failed"}


def test_old_steampipe_revision_cannot_satisfy_applied_revision():
    data = outputs()
    data["runtime_deployment"]["inventory"]["task_definition_arn"] = definition("steampipe", 4)
    observed = audit.collect(data, ENV, FakeAWS(), NOW)["deployment"]["steampipe"]
    assert observed["status"] == "NOT_READY" and observed["target_matches_state"] is False


def test_missing_task_health_is_unknown():
    aws = FakeAWS()
    original = aws.__call__
    def read(service, operation, **params):
        response = original(service, operation, **params)
        if operation == "describe_tasks":
            del response["tasks"][0]["healthStatus"]
        return response
    assert audit.collect(outputs(), ENV, read, NOW)["deployment"]["web"]["status"] == "UNKNOWN"


def test_desired_running_task_is_not_reported_as_actually_running_while_pending():
    aws = FakeAWS()
    def read(service, operation, **params):
        response = aws(service, operation, **params)
        if operation == "describe_tasks":
            response["tasks"][0]["lastStatus"] = "PENDING"
        return response
    item = audit.collect(outputs(), ENV, read, NOW)["deployment"]["web"]
    assert item["status"] != "READY"
    assert item["running_revisions"] == []
    assert item["healthy_tasks"] == 0


def test_disabled_inventory_and_agentcore_do_not_discover_resources():
    data, aws = outputs(), FakeAWS()
    data["runtime_deployment"]["features"].update(inventory=False, agentcore=False)
    data["agentcore"] = None
    data["agent_sql_reader_secret_arn"] = ""
    result = audit.collect(data, ENV, aws, NOW)
    assert result["deployment"]["steampipe"]["status"] == "DISABLED"
    assert result["deployment"]["agentcore"]["status"] == "DISABLED"
    assert result["data"]["completeness"] == "UNKNOWN"
    assert all(service in ("sts", "ecs") for service, _, _ in aws.calls)


def test_wrong_schedule_target_or_permission_never_looks_ready():
    aws = FakeAWS()
    aws.overrides["events", "list_targets_by_rule"] = {"Targets": [{
        "Id": "inv-sync-ec2", "Arn": FUNCTION.replace(PROJECT, "foreign"), "Input": '{"type":"all"}'}]}
    item = audit.collect(outputs(), ENV, aws, NOW)["events"]["schedule"]
    assert item["status"] == "NOT_READY" and item["target_all_matches"] is False
    assert all(params["FunctionName"] == FUNCTION for _, op, params in aws.calls if op == "get_policy")
    aws.overrides["lambda", "get_policy"] = {"Policy": '{"Statement":[]}'}
    assert audit.collect(outputs(), ENV, aws, NOW)["events"]["schedule"]["permission_matches"] is False


def test_foreign_runtime_role_is_not_ready():
    aws = FakeAWS()
    aws.overrides["bedrock-agentcore-control", "get_agent_runtime"] = {
        "agentRuntimeArn": RUNTIME, "agentRuntimeName": "awsops_v2_agent", "status": "READY",
        "roleArn": RUNTIME_ROLE.replace(PROJECT, "foreign"), "agentRuntimeVersion": "2"}
    item = audit.collect(outputs(), ENV, aws, NOW)["deployment"]["agentcore"]
    assert item["status"] == "NOT_READY" and item["role_matches_state"] is False


def test_session_policy_cannot_authorize_mutations_or_master_secret():
    policy = audit.session_policy(ENV)
    def permits(action, resource):
        return any(s["Effect"] == "Allow" and action in s["Action"]
                   and any(fnmatch.fnmatchcase(resource, pattern)
                           for pattern in ([s["Resource"]] if isinstance(s["Resource"], str) else s["Resource"]))
                   for s in policy["Statement"])
    assert permits("ecs:DescribeServices", f"arn:aws:ecs:{REGION}:{ACCOUNT}:service/{PROJECT}/{PROJECT}-web")
    assert permits("lambda:GetFunctionConfiguration", FUNCTION)
    assert permits("rds-data:ExecuteStatement", f"arn:aws:rds:{REGION}:{ACCOUNT}:cluster:{PROJECT}-aurora")
    assert permits("secretsmanager:GetSecretValue", outputs()["agent_sql_reader_secret_arn"])
    assert not permits("secretsmanager:GetSecretValue",
                       f"arn:aws:secretsmanager:{REGION}:{ACCOUNT}:secret:rds!cluster-master")
    assert not permits("ssm:GetParameter", f"arn:aws:ssm:{REGION}:{ACCOUNT}:parameter/foreign/password")
    for action in ("ecs:RunTask", "ecs:StopTask", "ecs:UpdateService", "lambda:InvokeFunction",
                   "events:PutRule", "iam:PutRolePolicy", "s3:PutObject"):
        assert not permits(action, FUNCTION)
    for statement in policy["Statement"]:
        assert all("*" not in action for action in statement["Action"])
        if statement["Resource"] == "*":
            assert statement["Condition"]


def test_session_policy_fits_sts_limit_at_max_project_length():
    policy = audit.session_policy({**ENV, "EXPECTED_PROJECT": "a" * 40})
    assert len(json.dumps(policy, separators=(",", ":"))) <= 2048


def test_guard_publishes_only_validated_session_restriction(tmp_path, monkeypatch):
    for key, value in ENV.items():
        monkeypatch.setenv(key, value)
    output = tmp_path / "output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    assert audit.main(["guard"]) == 0
    name, value = output.read_text().strip().split("=", 1)
    assert name == "session_policy" and json.loads(value) == audit.session_policy(ENV)
    workflow_config = workflow()["jobs"]["audit"]["steps"]
    credential_step = next(s for s in workflow_config if s.get("uses", "").startswith("aws-actions/"))
    assert credential_step["with"]["inline-session-policy"] == "${{ steps.scope.outputs.session_policy }}"
    assert credential_step["with"]["role-duration-seconds"] == 900


def test_mixed_capture_times_are_reported_without_invented_product_freshness():
    aws = FakeAWS()
    def read(service, operation, **params):
        result = aws(service, operation, **params)
        if operation == "execute_statement" and params["sql"] == audit.COUNTS_SQL:
            rows = json.loads(result["formattedRecords"])
            rows[0]["oldest_at"] = "2026-09-13T01:00:00Z"
            result["formattedRecords"] = json.dumps(rows)
        return result
    result = audit.collect(outputs(), ENV, read, NOW)["data"]
    assert result["resource_counts"][0]["oldest_at"] == "2026-09-13T01:00:00Z"
    assert "fresh_within_2h" not in json.dumps(result)
    assert result["completeness"] == "UNKNOWN"


def test_malformed_section_retains_other_observations():
    aws = FakeAWS()
    aws.overrides["events", "list_targets_by_rule"] = {"Targets": [None]}
    result = audit.collect(outputs(), ENV, aws, NOW)
    assert result["events"]["schedule"] == {"status": "UNKNOWN", "reason": "unexpected_state"}
    assert result["data"]["status"] == "OBSERVED"


def test_metric_forbidden_counts_as_read_error_without_losing_other_groups():
    aws = FakeAWS()
    aws.overrides["cloudwatch", "get_metric_data"] = {"MetricDataResults": [
        {"Id": "lambda_errors", "StatusCode": "Forbidden", "Timestamps": [], "Values": []}]}
    result = audit.collect(outputs(), ENV, aws, NOW)
    assert result["events"]["metrics"]["lambda_errors"]["reason"] == "access_denied"
    assert result["read_errors"] == 1
    assert result["data"]["status"] == "OBSERVED"


def test_summary_write_error_does_not_publish_exception(tmp_path, monkeypatch, capsys):
    for key, value in ENV.items():
        monkeypatch.setenv(key, value)
    for key, value in outputs().items():
        (tmp_path / f"{key}.json").write_text(json.dumps(value))
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(tmp_path))
    monkeypatch.setattr(audit, "ReadAPI", lambda factory: FakeAWS())
    assert audit.main(["audit", "--directory", str(tmp_path)]) == 1
    captured = capsys.readouterr()
    assert not captured.out
    assert json.loads(captured.err) == {"status": "UNKNOWN", "reason": "report_failed"}
    assert str(tmp_path) not in captured.err


def test_inventory_disabled_remains_explicit_when_reader_is_available():
    data = outputs()
    data["runtime_deployment"]["features"]["inventory"] = False
    result = audit.collect(data, ENV, FakeAWS(), NOW)
    assert result["data"]["inventory_enabled"] is False
    assert result["data"]["completeness"] == "UNKNOWN"
    assert result["events"]["schedule"]["status"] == "DISABLED"
