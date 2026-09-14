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
LEDGER_SQL = """SELECT resource_type, status, row_count, last_success_row_count, unknown_attribute_count,
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
to_char(min(captured_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS oldest_at,
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
    ("bedrock-agentcore-control", "list_gateways"),
    ("bedrock-agentcore-control", "get_gateway"),
    ("bedrock-agentcore-control", "list_gateway_targets"),
    ("bedrock-agentcore-control", "get_gateway_target"),
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


def backend_policy(env):
    """Bind the bootstrap session to the configured default-workspace state object."""
    validate_context(env)
    require(env.get("TF_WORKSPACE", "default") in ("", "default"))
    encoded = env.get("BACKEND_B64", "")
    require(isinstance(encoded, str) and 0 < len(encoded) <= 22000)
    text = base64.b64decode("".join(encoded.split()), validate=True).decode()
    require(len(text) <= 16384)
    fields = {}
    allowed = {"bucket", "key", "region", "encrypt", "use_lockfile", "workspace_key_prefix", "kms_key_id"}
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith(("#", "//")):
            continue
        match = re.fullmatch(r'\s*(\w+)\s*=\s*("(?:[^"\\]|\\.)*"|true|false)\s*(?:(?:#|//).*)?', line)
        require(match and match[1] in allowed and match[1] not in fields)
        fields[match[1]] = json.loads(match[2])
    bucket, key = fields.get("bucket", ""), fields.get("key", "")
    require(isinstance(bucket, str) and re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", bucket))
    require(isinstance(key, str) and re.fullmatch(r"[A-Za-z0-9._/-]{1,512}", key))
    require(fields.get("region") == REGION and fields.get("encrypt", True) is True)
    require(all(isinstance(v, (str, bool)) and "${" not in str(v) and "%{" not in str(v) for v in fields.values()))
    account = env["AWS_ACCOUNT_ID_DEV"]
    resources = [f"arn:aws:s3:::{bucket}", f"arn:aws:s3:::{bucket}/{key}"]
    kms = fields.get("kms_key_id", "*")
    require(kms == "*" or re.fullmatch(re.escape(f"arn:aws:kms:{REGION}:{account}:key/") + r"[a-f0-9-]{36}", kms))
    return {"Version": "2012-10-17", "Statement": [
        {"Effect": "Allow", "Action": ["sts:GetCallerIdentity"], "Resource": "*",
         "Condition": {"StringEquals": {"aws:RequestedRegion": REGION}}},
        {"Effect": "Allow", "Action": ["s3:GetObject", "s3:ListBucket", "s3:GetBucketLocation"],
         "Resource": resources, "Condition": {"StringEquals": {"aws:ResourceAccount": account}}},
        {"Effect": "Allow", "Action": ["kms:Decrypt"], "Resource": kms,
         "Condition": {"StringEquals": {"aws:ResourceAccount": account,
             "kms:ViaService": f"s3.{REGION}.amazonaws.com",
             "kms:EncryptionContext:aws:s3:arn": resources}}},
    ]}


def session_policy(env, outputs):
    """Audit-only session, after the separately restricted backend capture is gone."""
    runtime = validate_outputs(outputs, env)
    account, project = env["AWS_ACCOUNT_ID_DEV"], env["EXPECTED_PROJECT"]
    arn = lambda service, resource: f"arn:aws:{service}:{REGION}:{account}:{resource}"
    actions = ["ecs:DescribeServices", "ecs:DescribeTasks", "lambda:GetFunctionConfiguration",
               "lambda:GetPolicy", "events:DescribeRule", "events:ListTargetsByRule",
               "ssm:GetParameter", "rds:DescribeDBClusters"]
    resources = [arn("ecs", f"service/{project}/{project}-*"), arn("ecs", f"task/{project}/*"),
                 arn("lambda", f"function:{project}-inv-sync"), arn("events", f"rule/{project}-inv-sync-ec2"),
                 arn("ssm", f"parameter/ops/{project}/agentcore/runtime_arn"),
                 arn("rds", f"cluster:{project}-aurora")]
    if runtime["features"]["agentcore"]:
        actions += ["rds-data:ExecuteStatement", "secretsmanager:GetSecretValue"]
        resources.append(outputs["agent_sql_reader_secret_arn"])
    policy = {"Version": "2012-10-17", "Statement": [
        {"Effect": "Allow", "Action": ["sts:GetCallerIdentity", "cloudwatch:GetMetricData",
                                      "bedrock-agentcore:ListGateways", "bedrock-agentcore:GetAgentRuntime",
                                      "bedrock-agentcore:GetGateway", "bedrock-agentcore:ListGatewayTargets",
                                      "bedrock-agentcore:GetGatewayTarget"],
         "Resource": "*", "Condition": {"StringEquals": {"aws:RequestedRegion": REGION}}},
        # ListTasks without containerInstance needs Resource:*; cluster ARN resources do not authorize it.
        {"Effect": "Allow", "Action": ["ecs:ListTasks"], "Resource": "*", "Condition": {
            "ArnEquals": {"ecs:cluster": arn("ecs", f"cluster/{project}")},
            "StringEquals": {"aws:RequestedRegion": REGION}}},
        {"Effect": "Allow", "Action": actions, "Resource": resources,
         "Condition": {"StringEquals": {"aws:RequestedRegion": REGION}}},
    ]}
    require(len(json.dumps(policy, separators=(",", ":"))) <= 2048)
    return policy


def publish_policy(policy):
    # Missing/failed output publication must stop before configure-aws-credentials can run.
    require(os.environ.get("GITHUB_OUTPUT"))
    text = json.dumps(policy, separators=(",", ":"))
    require(len(text) <= 2048)
    directory = Path(os.environ["AUDIT_DIR"])
    require(directory.is_dir() and not directory.is_symlink() and directory.stat().st_mode & 0o077 == 0)
    path = directory / "session-policy.json"
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as file:
        file.write(text)
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"policy_file={path}\n")


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
        require(isinstance(ac.get("lambda_arns", {}), dict))
        expected_rds = ac.get("lambda_arns", {}).get("rds-mcp")
        if expected_rds is not None:
            require(expected_rds == arn("lambda", f"function:{project}-agent-rds-mcp"))
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
    if not response.get("services") and response.get("failures") and all(
            failure.get("reason") == "MISSING" for failure in response["failures"]):
        return {"status": "NOT_READY", "reason": "service_missing"}
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
    best_status = "READY" if state_matches is True else "OBSERVED"
    return {"status": "UNKNOWN" if incomplete or unknown_health else best_status if ready else "NOT_READY",
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
            and update in ("Successful", "Failed", "InProgress", None))
    return {"status": "READY" if state == "Active" and update == "Successful" and matches else "NOT_READY",
            "state": state, "update_status": update or "UNKNOWN", "code_sha256": sha,
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
    try:
        policy = json.loads(read("lambda", "get_policy", FunctionName=function)["Policy"])
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") != "ResourceNotFoundException":
            raise
        policy = {"Statement": []}
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
                    StartTime=start, EndTime=end, MaxDatapoints=1000, ScanBy="TimestampAscending")
    result = {key: {"status": "UNKNOWN", "sum": None, "datapoints": 0} for key in specs}
    result.update(window_start=stamp(start), window_end=stamp(end), attribution="not_correlated", read_errors=0)
    rows = response["MetricDataResults"]
    for key in specs:
        matches = [r for r in rows if r.get("Id") == key]
        if len(matches) != 1:
            continue
        row = matches[0]
        if row.get("StatusCode") in ("Forbidden", "InternalError"):
            result[key]["reason"] = "access_denied" if row["StatusCode"] == "Forbidden" else "read_unavailable"
            result["read_errors"] += 1
            continue
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
    require(state in ("CREATING", "CREATE_FAILED", "UPDATING", "UPDATE_FAILED", "READY", "DELETING", "DELETE_FAILED"))
    version = item.get("agentRuntimeVersion")
    require(isinstance(version, str) and re.fullmatch(r"[1-9]\d*", version))
    return {"status": "OBSERVED" if state == "READY" and matches else "NOT_READY",
            "invocation_readiness": "UNKNOWN", "applied_version_matches": None,
            "runtime_parameter_ready": True, "runtime_status": state,
            "role_matches_state": matches, "version": int(version)}


def gateway_snapshot(read, runtime, outputs):
    """Only the named data gateway/RDS target; provider prose and ARNs never escape."""
    expected_role = outputs["agentcore"]["role_arn"]
    expected_lambda = outputs["agentcore"].get("lambda_arns", {}).get("rds-mcp")
    if not expected_lambda:
        return {"status": "UNKNOWN", "reason": "rds_target_not_configured"}
    control = "bedrock-agentcore-control"
    listing = read(control, "list_gateways", maxResults=100)
    require(not listing.get("nextToken"))
    matches = [g for g in listing["items"] if g.get("name") == "awsops-v2-data-gateway"]
    if not matches:
        return {"status": "NOT_READY", "reason": "data_gateway_missing"}
    require(len(matches) == 1)
    gid = matches[0]["gatewayId"]
    require(re.fullmatch(r"awsops-v2-data-gateway-[a-z0-9]{10}", gid))
    gateway_arn = f"arn:aws:bedrock-agentcore:{REGION}:{runtime['account_id']}:gateway/{gid}"
    gateway = read(control, "get_gateway", gatewayIdentifier=gid)
    require(gateway["gatewayArn"] == gateway_arn and gateway["gatewayId"] == gid
            and gateway["name"] == "awsops-v2-data-gateway")
    role = gateway["roleArn"]
    require(re.fullmatch(r"arn:aws:iam::\d{12}:role/[A-Za-z0-9_+=,.@/-]+", role))

    def reasons(values):
        require(isinstance(values, list))
        projected = []
        for text in values[:8]:
            require(isinstance(text, str))
            sample = text[:4096].lower()
            categories = [name for name, tokens in (
                ("mentions_permission", ("denied", "unauthorized", "forbidden")),
                ("mentions_role", ("role",)), ("mentions_lambda", ("lambda",)),
                ("mentions_schema", ("schema",)), ("mentions_quota", ("quota",)),
                ("mentions_timeout", ("timeout", "timed out")),
            ) if any(token in sample for token in tokens)]
            projected.append({"categories": categories or ["unclassified"],
                              "classification_truncated": len(text) > 4096})
        return {"count": len(values), "truncated": len(values) > 8, "items": projected}

    states = {"CREATING", "UPDATING", "UPDATE_UNSUCCESSFUL", "DELETING", "READY", "FAILED",
              "SYNCHRONIZING", "SYNCHRONIZE_UNSUCCESSFUL", "CREATE_PENDING_AUTH",
              "UPDATE_PENDING_AUTH", "SYNCHRONIZE_PENDING_AUTH"}
    result = {"status": "OBSERVED" if gateway.get("status") == "READY" and role == expected_role else "NOT_READY",
              "gateway_status": gateway.get("status") if gateway.get("status") in states else "UNKNOWN",
              "gateway_role_matches_state": role == expected_role,
              "gateway_status_reasons": reasons(gateway.get("statusReasons", [])),
              "gateway_updated_at": stamp(gateway.get("updatedAt"))}
    try:
        targets = read(control, "list_gateway_targets", gatewayIdentifier=gid, maxResults=100)
        require(not targets.get("nextToken"))
        matches = [t for t in targets["items"] if t.get("name") == "rds-mcp-target"]
        if not matches:
            return {**result, "status": "NOT_READY", "target_status": "MISSING", "target_lambda_matches_state": False}
        require(len(matches) == 1 and re.fullmatch(r"[A-Za-z0-9]{10}", matches[0]["targetId"]))
        target = read(control, "get_gateway_target", gatewayIdentifier=gid, targetId=matches[0]["targetId"])
        require(target["gatewayArn"] == gateway_arn and target["targetId"] == matches[0]["targetId"]
                and target["name"] == "rds-mcp-target")
        actual_lambda = target.get("targetConfiguration", {}).get("mcp", {}).get("lambda", {}).get("lambdaArn")
        require(actual_lambda is None or re.fullmatch(
            r"arn:aws:lambda:[a-z0-9-]+:\d{12}:function:[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)?", actual_lambda))
        result.update(target_status=target.get("status") if target.get("status") in states else "UNKNOWN",
                      target_lambda_matches_state=actual_lambda == expected_lambda,
                      target_status_reasons=reasons(target.get("statusReasons", [])),
                      target_updated_at=stamp(target.get("updatedAt")))
        if target.get("status") != "READY" or actual_lambda != expected_lambda:
            result["status"] = "NOT_READY"
        return result
    except ClientError as error:
        code = error.response.get("Error", {}).get("Code")
        reason = "access_denied" if code in ("AccessDenied", "AccessDeniedException") else "read_unavailable"
        return {**result, "status": "NOT_READY" if result["status"] == "NOT_READY" else "PARTIAL",
                "target_status": "UNKNOWN", "target_reason": reason, "read_errors": 1}


def data_snapshot(read, runtime, outputs):
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
            result["last_success_row_count"] = number(row.get("last_success_row_count"))
            result["unknown_attribute_count"] = number(row.get("unknown_attribute_count"))
        return result

    require(len(known) == 1)
    return {"status": "OBSERVED", "coverage": "observed_types_only", "completeness": "UNKNOWN",
            "inventory_enabled": runtime["features"]["inventory"],
            "ledger_scope": "collector_aggregate_self", "resource_scope": "persisted_self_or_host_id",
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
        except (ClientError, BotoCoreError, ValueError, KeyError, TypeError, IndexError, AttributeError) as error:
            code = error.response.get("Error", {}).get("Code") if isinstance(error, ClientError) else None
            reason = ("access_denied" if code in ("AccessDenied", "AccessDeniedException", "UnauthorizedOperation")
                      else "read_unavailable" if isinstance(error, (ClientError, BotoCoreError)) else "unexpected_state")
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
            "data_gateway": observe(lambda: gateway_snapshot(read, runtime, outputs)) if enabled["agentcore"] else disabled,
        },
        "events": {
            "schedule": observe(lambda: schedule_snapshot(read, runtime)) if enabled["inventory"] else disabled,
            "metrics": observe(lambda: metric_snapshot(read, runtime, now)) if enabled["inventory"] else disabled,
        },
        "data": observe(lambda: data_snapshot(read, runtime, outputs)) if enabled["agentcore"] else {
            "status": "UNKNOWN", "reason": "reader_not_configured", "completeness": "UNKNOWN",
            "inventory_enabled": enabled["inventory"]},
    }
    report["read_errors"] = (len(errors) + report["events"]["metrics"].get("read_errors", 0)
                             + report["deployment"]["data_gateway"].get("read_errors", 0))
    return report


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("guard", "caller", "audit-policy", "audit"))
    parser.add_argument("--directory", type=Path)
    args = parser.parse_args(argv)
    try:
        validate_context(os.environ)
        if args.mode == "guard":
            require(os.environ.get("GITHUB_OUTPUT"))
            publish_policy(backend_policy(os.environ))
            return 0
        if args.mode == "caller":
            import boto3
            read = ReadAPI(boto3.client)
            verify_caller(read("sts", "get_caller_identity"), os.environ["AWS_ACCOUNT_ID_DEV"],
                          os.environ["RUNTIME_ROLE_ARN"])
            return 0
        require(args.directory is not None)
        outputs = {}
        for key in OUTPUTS:
            path = args.directory / f"{key}.json"
            require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 131072)
            outputs[key] = json.loads(path.read_text())
        if args.mode == "audit-policy":
            publish_policy(session_policy(os.environ, outputs))
            return 0
        import boto3
        read = ReadAPI(boto3.client)
        report = collect(outputs, os.environ, read)
        code = 1 if report["read_errors"] else 0
    except Exception as error:
        reason = "read_only_violation" if isinstance(error, ReadOnlyViolation) else "audit_failed"
        report, code = {"status": "UNKNOWN", "reason": reason}, 1
    try:
        text = json.dumps(report, indent=2, allow_nan=False)
        print(text)
    except Exception:
        print('{"status":"UNKNOWN","reason":"report_failed"}', file=sys.stderr)
        return 1
    try:
        if os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
                summary.write("## Development deployment observations\n\n```json\n" + text + "\n```\n")
    except Exception:
        print("::warning::audit_summary_unavailable", file=sys.stderr)
    return code


if __name__ == "__main__":
    sys.exit(main())
