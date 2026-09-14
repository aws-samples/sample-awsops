"""Manual development audit. Fixed reads only; public output is an explicit projection."""
import argparse
import base64
from datetime import datetime, timedelta, timezone
import json
import math
import os
from pathlib import Path
import re
import sys

from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from ci_runtime_policy import verify_caller, verify_role


REGION = "ap-northeast-2"
OUTPUTS = ("runtime_deployment", "agentcore", "agent_sql_reader_secret_arn", "aurora_database")
READER_SQL = """SELECT current_user = 'awsops_sql_reader' AS reader,
NOT (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls) AS restricted
FROM pg_catalog.pg_roles WHERE rolname = current_user"""
LEDGER_SQL = """SELECT resource_type, status, row_count, unknown_attribute_count,
to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS started_at,
to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS finished_at,
to_char(last_success_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_success_at
FROM sql_reader.inventory_sync_runs WHERE account_id = 'self' ORDER BY resource_type LIMIT 257"""
COUNTS_SQL = """SELECT resource_type, count(*) AS row_count,
to_char(min(captured_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS oldest_at,
to_char(max(captured_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS newest_at
FROM sql_reader.inventory_resources WHERE account_id IN ('self', :host)
GROUP BY resource_type ORDER BY resource_type LIMIT 257"""
CLOUDFRONT_SQL = """SELECT count(*) AS row_count,
to_char(max(captured_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS newest_at
FROM sql_reader.inventory_resources WHERE account_id IN ('self', :host)
AND resource_type = 'cloudfront' AND resource_id = :distribution"""
SQL = (READER_SQL, LEDGER_SQL, COUNTS_SQL, CLOUDFRONT_SQL)
READS = {
    ("sts", "get_caller_identity"), ("ecs", "describe_services"),
    ("ecs", "list_tasks"), ("ecs", "describe_tasks"),
    ("lambda", "get_function_configuration"), ("lambda", "get_policy"),
    ("events", "describe_rule"), ("events", "list_targets_by_rule"),
    ("cloudwatch", "get_metric_data"), ("ssm", "get_parameter"),
    ("bedrock-agentcore-control", "get_agent_runtime"),
    ("rds", "describe_db_clusters"), ("rds-data", "execute_statement"),
}


class ReadOnlyViolation(RuntimeError):
    pass


def require(condition):
    if not condition:
        raise ValueError("invalid_scope_or_response")


class ReadAPI:
    def __init__(self, factory):
        self.factory, self.clients = factory, {}

    def __call__(self, service, operation, **kwargs):
        if (service, operation) not in READS or (
            service == "rds-data" and kwargs.get("sql") not in SQL
        ):
            raise ReadOnlyViolation("read_only_violation")
        if service not in self.clients:
            self.clients[service] = self.factory(
                service, region_name=REGION,
                config=Config(connect_timeout=5, read_timeout=30,
                              retries={"total_max_attempts": 2, "mode": "standard"}))
        return getattr(self.clients[service], operation)(**kwargs)


def validate_context(env):
    require(env.get("GITHUB_REPOSITORY") == "aws-samples/sample-awsops"
            and env.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
            and env.get("GITHUB_REF") == "refs/heads/dev"
            and env.get("AWS_REGION") == REGION)
    require(re.fullmatch(r"[a-z][a-z0-9-]{1,39}", env.get("EXPECTED_PROJECT", "")))
    verify_role(env.get("AWS_ACCOUNT_ID_DEV"), env.get("RUNTIME_ROLE_ARN"))


def validate_outputs(outputs, env):
    validate_context(env)
    runtime = outputs["runtime_deployment"]
    account, project = env["AWS_ACCOUNT_ID_DEV"], env["EXPECTED_PROJECT"]
    require(runtime["schema_version"] == 1 and runtime["account_id"] == account
            and runtime["project"] == project and runtime["region"] == REGION)
    arn = lambda service, resource: f"arn:aws:{service}:{REGION}:{account}:{resource}"
    role = lambda name: f"arn:aws:iam::{account}:role/{project}-{name}"
    web, inventory, agent = runtime["web"], runtime["inventory"], runtime["agentcore"]
    require(web["cluster"] == project and web["service"] == f"{project}-web"
            and web["task_role_arn"] == role("task"))
    for feature in ("inventory", "agentcore"):
        require(type(runtime["features"][feature]) is bool)
    if runtime["features"]["inventory"]:
        require(inventory["service"] == f"{project}-steampipe"
                and inventory["task_role_arn"] == role("steampipe-task")
                and inventory["sync_function_name"] == f"{project}-inv-sync"
                and inventory["sync_function_arn"] == arn("lambda", f"function:{project}-inv-sync"))
        require(re.fullmatch(re.escape(arn("ecs", f"task-definition/{project}-steampipe:")) + r"[1-9]\d*",
                             inventory["task_definition_arn"]))
        require(len(base64.b64decode(inventory["sync_code_sha256"], validate=True)) == 32)
    if runtime["features"]["agentcore"]:
        ac = outputs["agentcore"]
        require(ac["project"] == project and ac["region"] == REGION
                and ac["role_arn"] == agent["role_arn"] == role("agentcore")
                and ac["ssm_runtime_arn"] == agent["runtime_arn_param"]
                == f"/ops/{project}/agentcore/runtime_arn")
        require(re.fullmatch(re.escape(arn("secretsmanager", f"secret:ops/{project}/agent/sql-reader-"))
                             + r"[A-Za-z0-9]{6}", outputs["agent_sql_reader_secret_arn"]))
    require(outputs["aurora_database"] == "awsops")
    require(re.fullmatch(r"[A-Z0-9]{8,32}", runtime["known"]["cloudfront_distribution_id"]))
    return runtime


def number(value):
    if value is None:
        return None
    require(type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1e15)
    return value


def stamp(value):
    if value is None:
        return None
    if isinstance(value, str):
        require(len(value) <= 40)
        value = re.sub(r"([+-]\d{2})(\d{2})$", r"\1:\2", value)
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
    require(isinstance(value, datetime) and value.tzinfo is not None)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def revision(arn, project, account, component):
    match = re.fullmatch(
        re.escape(f"arn:aws:ecs:{REGION}:{account}:task-definition/{project}-{component}:") + r"([1-9]\d*)",
        arn)
    require(match)
    return int(match[1])


def ecs_snapshot(read, runtime, component):
    project, account = runtime["project"], runtime["account_id"]
    service = f"{project}-{component}"
    cluster = f"arn:aws:ecs:{REGION}:{account}:cluster/{project}"
    response = read("ecs", "describe_services", cluster=cluster, services=[service])
    require(not response.get("failures") and len(response["services"]) == 1)
    item = response["services"][0]
    require(item["clusterArn"] == cluster and item["serviceName"] == service
            and item["serviceArn"] == f"arn:aws:ecs:{REGION}:{account}:service/{project}/{service}")
    target_revision = revision(item["taskDefinition"], project, account, component)
    state_matches = (item["taskDefinition"] == runtime["inventory"]["task_definition_arn"]
                     if component == "steampipe" else None)
    listed = read("ecs", "list_tasks", cluster=cluster, serviceName=service,
                  desiredStatus="RUNNING", maxResults=100)
    task_arns = listed["taskArns"]
    require(len(task_arns) <= 100 and len(set(task_arns)) == len(task_arns))
    require(all(re.fullmatch(re.escape(f"arn:aws:ecs:{REGION}:{account}:task/{project}/")
                             + r"[a-f0-9]{32}", arn) for arn in task_arns))
    response = read("ecs", "describe_tasks", cluster=cluster, tasks=task_arns) if task_arns else {"tasks": []}
    tasks = response["tasks"]
    require(len(tasks) <= 100)
    for task in tasks:
        require(task["taskArn"] in task_arns and task["clusterArn"] == cluster
                and task["group"] == f"service:{service}")
    task_revisions = {t["taskArn"]: revision(t["taskDefinitionArn"], project, account, component) for t in tasks}
    running_tasks = [t for t in tasks if t.get("lastStatus") == "RUNNING"]
    revisions = sorted({task_revisions[t["taskArn"]] for t in running_tasks})
    healthy = sum(t.get("healthStatus") == "HEALTHY" for t in running_tasks)
    unknown_health = sum(t.get("healthStatus") not in ("HEALTHY", "UNHEALTHY") for t in running_tasks)
    desired, running, pending = (number(item[k]) for k in ("desiredCount", "runningCount", "pendingCount"))
    require(None not in (desired, running, pending))
    incomplete = bool(listed.get("nextToken") or response.get("failures")
                      or len({t["taskArn"] for t in tasks}) != len(task_arns) or len(running_tasks) != running)
    ready = (item.get("status") == "ACTIVE" and desired > 0 and running == desired and pending == 0
             and healthy == desired and revisions == [target_revision]
             and state_matches is not False
             and all(t.get("lastStatus") == "RUNNING" for t in tasks))
    return {"status": "UNKNOWN" if incomplete or unknown_health else "READY" if ready else "NOT_READY",
            "desired": desired, "running": running, "pending": pending, "healthy_tasks": healthy,
            "unknown_health_tasks": unknown_health, "target_revision": target_revision,
            "running_revisions": revisions, "target_matches_state": state_matches,
            "sample_incomplete": incomplete}


def lambda_snapshot(read, runtime):
    inventory = runtime["inventory"]
    item = read("lambda", "get_function_configuration", FunctionName=inventory["sync_function_arn"])
    require(item["FunctionArn"] == inventory["sync_function_arn"])
    sha = item["CodeSha256"]
    require(len(base64.b64decode(sha, validate=True)) == 32)
    matches = sha == inventory["sync_code_sha256"]
    state, update = item.get("State"), item.get("LastUpdateStatus")
    require(state in ("Pending", "Active", "Inactive", "Failed")
            and update in ("Successful", "Failed", "InProgress"))
    return {"status": "READY" if state == "Active" and update == "Successful" and matches else "NOT_READY",
            "state": state, "update_status": update, "code_sha256": sha,
            "code_matches_state": matches, "last_modified": stamp(item.get("LastModified"))}


def schedule_snapshot(read, runtime):
    name = f"{runtime['project']}-inv-sync-ec2"
    rule = f"arn:aws:events:{REGION}:{runtime['account_id']}:rule/{name}"
    function = runtime["inventory"]["sync_function_arn"]
    item = read("events", "describe_rule", Name=name)
    require(item["Arn"] == rule)
    listed = read("events", "list_targets_by_rule", Rule=name, Limit=100)
    targets = listed["Targets"]
    require(len(targets) <= 100)
    target_matches = (not listed.get("NextToken") and len(targets) == 1
                      and targets[0].get("Arn") == function
                      and targets[0].get("Id") == "inv-sync-ec2"
                      and json.loads(targets[0].get("Input", "null")) == {"type": "all"}
                      and not targets[0].get("InputPath") and not targets[0].get("InputTransformer"))
    policy = json.loads(read("lambda", "get_policy", FunctionName=function)["Policy"])
    statements = policy.get("Statement", [])
    statements = [statements] if isinstance(statements, dict) else statements
    permission = any(
        s.get("Effect") == "Allow" and s.get("Principal") == {"Service": "events.amazonaws.com"}
        and s.get("Action") == "lambda:InvokeFunction" and s.get("Resource") == function
        and s.get("Condition") in ({"ArnLike": {"AWS:SourceArn": rule}},
                                   {"ArnEquals": {"AWS:SourceArn": rule}})
        for s in statements)
    enabled, cadence = item.get("State") == "ENABLED", item.get("ScheduleExpression") == "rate(15 minutes)"
    return {"status": "READY" if enabled and cadence and target_matches and permission else "NOT_READY",
            "enabled": enabled, "rate_15_minutes": cadence, "target_all_matches": target_matches,
            "permission_matches": permission, "effective_permission": "UNKNOWN"}


def metric_snapshot(read, runtime, now):
    end = now.replace(second=0, microsecond=0)
    start = end - timedelta(hours=2)
    specs = {
        "schedule_invocations": ("AWS/Events", "Invocations", "RuleName", f"{runtime['project']}-inv-sync-ec2"),
        "lambda_invocations": ("AWS/Lambda", "Invocations", "FunctionName", runtime["inventory"]["sync_function_name"]),
        "lambda_errors": ("AWS/Lambda", "Errors", "FunctionName", runtime["inventory"]["sync_function_name"]),
    }
    queries = [{"Id": key, "ReturnData": True, "MetricStat": {
        "Metric": {"Namespace": ns, "MetricName": name, "Dimensions": [{"Name": dimension, "Value": value}]},
        "Period": 60, "Stat": "Sum",
    }} for key, (ns, name, dimension, value) in specs.items()]
    response = read("cloudwatch", "get_metric_data", MetricDataQueries=queries,
                    StartTime=start, EndTime=end, MaxDatapoints=360, ScanBy="TimestampAscending")
    result = {key: {"status": "UNKNOWN", "sum": None, "datapoints": 0} for key in specs}
    result.update(window_start=stamp(start), window_end=stamp(end), attribution="not_correlated")
    rows = response["MetricDataResults"]
    for key in specs:
        matches = [r for r in rows if r.get("Id") == key]
        if len(matches) != 1:
            continue
        row = matches[0]
        times, values = row.get("Timestamps", []), row.get("Values", [])
        if (response.get("NextToken") or response.get("Messages") or row.get("Messages")
                or row.get("StatusCode") != "Complete" or not 0 < len(times) == len(values) <= 120):
            continue
        parsed = [datetime.fromisoformat(stamp(t).replace("Z", "+00:00")) for t in times]
        if len(set(parsed)) != len(parsed) or not all(start <= t < end for t in parsed):
            continue
        numbers = [number(v) for v in values]
        require(None not in numbers)
        result[key] = {"status": "OBSERVED", "sum": sum(numbers), "datapoints": len(numbers)}
    return result


def runtime_snapshot(read, runtime):
    agent = runtime["agentcore"]
    value = read("ssm", "get_parameter", Name=agent["runtime_arn_param"], WithDecryption=False)["Parameter"]["Value"]
    if value in ("", "PENDING"):
        return {"status": "NOT_READY", "runtime_parameter_ready": False}
    match = re.fullmatch(
        re.escape(f"arn:aws:bedrock-agentcore:{REGION}:{runtime['account_id']}:runtime/")
        + r"(awsops_v2_agent-[A-Za-z0-9]{1,64})", value)
    require(match)
    item = read("bedrock-agentcore-control", "get_agent_runtime", agentRuntimeId=match[1])
    require(item["agentRuntimeArn"] == value and item["agentRuntimeName"] == "awsops_v2_agent")
    matches = item.get("roleArn") == agent["role_arn"]
    state = item.get("status")
    require(state in ("CREATING", "CREATE_FAILED", "UPDATING", "UPDATE_FAILED", "READY", "DELETING"))
    version = item.get("agentRuntimeVersion")
    require(isinstance(version, str) and re.fullmatch(r"[1-9]\d*", version))
    return {"status": "READY" if state == "READY" and matches else "NOT_READY",
            "runtime_parameter_ready": True, "runtime_status": state,
            "role_matches_state": matches, "version": int(version)}


def data_snapshot(read, runtime, outputs, now):
    account, project = runtime["account_id"], runtime["project"]
    cluster = f"arn:aws:rds:{REGION}:{account}:cluster:{project}-aurora"
    clusters = read("rds", "describe_db_clusters", DBClusterIdentifier=f"{project}-aurora")["DBClusters"]
    require(len(clusters) == 1 and clusters[0]["DBClusterArn"] == cluster
            and clusters[0]["DBClusterIdentifier"] == f"{project}-aurora"
            and clusters[0]["DatabaseName"] == outputs["aurora_database"]
            and clusters[0].get("HttpEndpointEnabled") is True)

    def query(sql, parameters=()):
        response = read("rds-data", "execute_statement", resourceArn=cluster,
                        secretArn=outputs["agent_sql_reader_secret_arn"], database=outputs["aurora_database"],
                        sql=sql, parameters=list(parameters), formatRecordsAs="JSON", continueAfterTimeout=False)
        require(not response.get("numberOfRecordsUpdated"))
        text = response["formattedRecords"]
        require(isinstance(text, str) and len(text) <= 262144)
        records = json.loads(text)
        require(isinstance(records, list) and len(records) <= 257)
        return records

    identity = query(READER_SQL)
    require(len(identity) == 1 and identity[0].get("reader") is True and identity[0].get("restricted") is True)
    host = {"name": "host", "value": {"stringValue": account}}
    ledger = query(LEDGER_SQL)
    counts = query(COUNTS_SQL, [host])
    known = query(CLOUDFRONT_SQL, [host, {"name": "distribution", "value": {
        "stringValue": runtime["known"]["cloudfront_distribution_id"]}}])

    def project_row(row, ledger=False):
        result = {"row_count": number(row.get("row_count"))}
        for field in (("started_at", "finished_at", "last_success_at") if ledger else ("oldest_at", "newest_at")):
            result[field] = stamp(row.get(field))
        if "resource_type" in row:
            require(re.fullmatch(r"[a-z][a-z0-9_]{0,63}", row["resource_type"]))
            result["resource_type"] = row["resource_type"]
        if ledger:
            state = row.get("status")
            result["status"] = state if state in ("running", "succeeded", "partial", "failed") else "UNKNOWN"
            result["unknown_attribute_count"] = number(row.get("unknown_attribute_count"))
        reference = result.get("last_success_at" if ledger else "newest_at")
        result["fresh_within_2h"] = (0 <= (now - datetime.fromisoformat(reference.replace("Z", "+00:00"))).total_seconds() <= 7200
                                    if reference else None)
        return result

    require(len(known) == 1)
    return {"status": "OBSERVED", "coverage": "observed_types_only", "completeness": "UNKNOWN",
            "ledger_scope": "collector_aggregate_self", "resource_scope": "host_self_and_account",
            "truncated": len(ledger) > 256 or len(counts) > 256,
            "ledger": [project_row(r, True) for r in ledger[:256]],
            "resource_counts": [project_row(r) for r in counts[:256]],
            "known_cloudfront": project_row(known[0])}


def collect(outputs, env, read, now=None):
    runtime = validate_outputs(outputs, env)  # No clients/reads before all configured identities agree.
    verify_caller(read("sts", "get_caller_identity"), env["AWS_ACCOUNT_ID_DEV"], env["RUNTIME_ROLE_ARN"])
    now = now or datetime.now(timezone.utc)
    errors = []

    def observe(fn):
        try:
            return fn()
        except (ClientError, BotoCoreError, ValueError, KeyError, TypeError, IndexError) as error:
            code = error.response.get("Error", {}).get("Code") if isinstance(error, ClientError) else None
            reason = "access_denied" if code in ("AccessDenied", "AccessDeniedException", "UnauthorizedOperation") else "read_unavailable"
            errors.append(reason)
            return {"status": "UNKNOWN", "reason": reason}

    enabled = runtime["features"]
    disabled = {"status": "DISABLED"}
    report = {
        "schema_version": 1, "observed_at": stamp(now),
        "deployment": {
            "web": observe(lambda: ecs_snapshot(read, runtime, "web")),
            "steampipe": observe(lambda: ecs_snapshot(read, runtime, "steampipe")) if enabled["inventory"] else disabled,
            "sync_lambda": observe(lambda: lambda_snapshot(read, runtime)) if enabled["inventory"] else disabled,
            "agentcore": observe(lambda: runtime_snapshot(read, runtime)) if enabled["agentcore"] else disabled,
        },
        "events": {
            "schedule": observe(lambda: schedule_snapshot(read, runtime)) if enabled["inventory"] else disabled,
            "metrics": observe(lambda: metric_snapshot(read, runtime, now)) if enabled["inventory"] else disabled,
        },
        "data": observe(lambda: data_snapshot(read, runtime, outputs, now)) if enabled["agentcore"] else {
            "status": "UNKNOWN", "reason": "reader_not_configured", "completeness": "UNKNOWN"},
    }
    report["read_errors"] = len(errors)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("guard", "caller", "audit"))
    parser.add_argument("--directory", type=Path)
    args = parser.parse_args(argv)
    try:
        validate_context(os.environ)
        if args.mode == "guard":
            return 0
        import boto3
        read = ReadAPI(boto3.client)
        if args.mode == "caller":
            verify_caller(read("sts", "get_caller_identity"), os.environ["AWS_ACCOUNT_ID_DEV"],
                          os.environ["RUNTIME_ROLE_ARN"])
            return 0
        require(args.directory is not None)
        outputs = {}
        for key in OUTPUTS:
            path = args.directory / f"{key}.json"
            require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 131072)
            outputs[key] = json.loads(path.read_text())
        report = collect(outputs, os.environ, read)
        code = 1 if report["read_errors"] else 0
    except Exception:
        report, code = {"status": "UNKNOWN", "reason": "audit_failed"}, 1
    text = json.dumps(report, indent=2, allow_nan=False)
    print(text)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
            summary.write("## Development deployment observations\n\n```json\n" + text + "\n```\n")
    return code


if __name__ == "__main__":
    sys.exit(main())
