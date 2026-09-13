"""Advisory dev diagnostics: project read responses into a fixed public schema."""
from collections import Counter
import json
import math
import os
import re
import subprocess
import sys
import time


READ_OPERATIONS = frozenset({
    ("sts", "get-caller-identity"), ("logs", "filter-log-events"),
    ("rds", "describe-db-clusters"), ("ecs", "describe-services"),
    ("ecs", "describe-task-definition"), ("ec2", "describe-security-groups"),
    ("iam", "get-role-policy"),
    ("rds", "describe-db-log-files"), ("rds", "download-db-log-file-portion"),
})
READ_ERRORS = (ValueError, TypeError, AttributeError, KeyError, IndexError,
               StopIteration, OSError, subprocess.SubprocessError)
CREDENTIAL_NAMES = frozenset({
    "AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN", "AWS_SHARED_CREDENTIALS_FILE", "AWS_CONFIG_FILE",
    "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_AUTHORIZATION_TOKEN",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
})
ERROR_PATTERNS = {
    "iam_database_auth": r"PAM authentication failed",
    "database_auth": r"password authentication failed",
    "web_role_missing": r'role .*awsops_web.*does not exist',
    "database_permission": r"permission denied",
    "connection_timeout": r"connection timeout|timeout expired|ETIMEDOUT",
    "database_dns": r"getaddrinfo|ENOTFOUND|EAI_AGAIN",
    "connection_refused": r"ECONNREFUSED",
    "aws_credentials": r"Could not load credentials|CredentialsProviderError",
    "tls": r"certificate|SSL|TLS",
    "token_type": r"password must be a string",
    "connection_limit": r"too many connections",
}
CONNECTION_PHASES = frozenset({
    "dns_tcp_connect", "tcp_connect", "tls_negotiation", "tls_handshake",
    "postgres_startup", "iam_token", "postgres_authentication",
})
CONNECTION_MILESTONES = (
    "dns_resolved", "tcp_connected", "ssl_accepted", "tls_connected",
    "password_requested", "token_started", "token_ready", "authenticated",
)


def valid_duration(value):
    return type(value) in (int, float) and 0 <= value <= 3_600_000 and math.isfinite(value)


def connection_timing(record, timestamp):
    phase, elapsed = record.get("phase"), record.get("elapsed_ms")
    if not isinstance(phase, str) or phase not in CONNECTION_PHASES or not valid_duration(elapsed):
        return None
    declared = record.get("milestones_ms")
    milestones = {} if not isinstance(declared, dict) else {
        key: declared[key] for key in CONNECTION_MILESTONES
        if valid_duration(declared.get(key)) and declared[key] <= elapsed
    }
    return {"phase": phase, "elapsed_ms": elapsed, "timestamp_ms": timestamp, "milestones_ms": milestones}


def aws_read(args):
    if tuple(args[:2]) not in READ_OPERATIONS:
        raise ValueError("Diagnostic operation is not allowed")
    result = subprocess.run(
        ["aws", *args, "--region", "ap-northeast-2", "--output", "json",
         "--no-cli-pager", "--no-paginate"], check=True, capture_output=True, text=True,
        timeout=30, env={**os.environ, "AWS_PAGER": "", "AWS_MAX_ATTEMPTS": "2"})
    return json.loads(result.stdout)


def classify(message):
    if not isinstance(message, str):
        return {"unclassified"}
    # "SSL off"/"no encryption" describe an HBA rejection, not a TLS diagnosis.
    if re.search(r"no pg_hba\.conf entry", message, re.I):
        return {"database_hba"}
    return {label for label, pattern in ERROR_PATTERNS.items()
            if re.search(pattern, message, re.I)} or {"unclassified"}


def collect(config, aws, now_ms):
    if (not isinstance(config, dict) or set(config) != {"project", "region", "account"}
            or not re.fullmatch(r"[a-z][a-z0-9-]{1,39}", str(config.get("project", "")))
            or config.get("region") != "ap-northeast-2"
            or not re.fullmatch(r"[0-9]{12}", str(config.get("account", "")))):
        raise ValueError("Invalid development diagnostic scope")
    if aws(["sts", "get-caller-identity"]).get("Account") != config["account"]:
        raise ValueError("Development diagnostic account mismatch")
    summary = {
        "status": "unavailable", "scan_order": "oldest_first",
        "window_start_ms": max(0, now_ms - 3_600_000), "window_end_ms": now_ms,
        "pages_read": 0, "events": 0, "ignored": 0, "unparsed": 0,
        "categories": [], "category_counts": {}, "earliest_timestamp_ms": None,
        "latest_timestamp_ms": None, "truncated": False,
        "event_counts": {"db_ping_failed": 0, "db_connection_failed": 0},
        "phase_counts": {}, "latest_connection": None,
    }
    counts, phase_counts = Counter(), Counter()
    token = None
    for _ in range(3):
        args = ["logs", "filter-log-events", "--log-group-name", f"/ecs/{config['project']}-web",
                "--start-time", str(summary["window_start_ms"]), "--end-time", str(now_ms),
                "--filter-pattern", '{ ($.evt = "db_ping_failed") || ($.evt = "db_connection_failed") }',
                "--limit", "100"]
        if token:
            args += ["--next-token", token]
        try:
            result = aws(args)
            events = result["events"]
            if not isinstance(events, list):
                raise ValueError("Invalid log page")
            token = result.get("nextToken")
            if token is not None and not isinstance(token, str):
                raise ValueError("Invalid diagnostic pagination")
        except READ_ERRORS:
            summary["status"] = "partial" if summary["pages_read"] else "unavailable"
            summary["truncated"] = True
            break
        summary["pages_read"] += 1
        summary["status"] = "available"
        for event in events:
            try:
                timestamp = event["timestamp"]
                if type(timestamp) is not int:
                    raise ValueError("Invalid event timestamp")
                record = json.loads(re.sub(r"\x1b\[[0-9;]*m", "", event.get("message", "")).strip())
            except READ_ERRORS:
                summary["unparsed"] += 1
                continue
            if (not isinstance(record, dict) or record.get("evt") not in ("db_ping_failed", "db_connection_failed")
                    or not summary["window_start_ms"] <= timestamp < now_ms):
                summary["ignored"] += 1
                continue
            event_type = record["evt"]
            if event_type == "db_connection_failed":
                timing = connection_timing(record, timestamp)
                if timing is None:
                    summary["ignored"] += 1
                    continue
                phase_counts[timing["phase"]] += 1
                previous = summary["latest_connection"]
                if previous is None or timestamp >= previous["timestamp_ms"]:
                    summary["latest_connection"] = timing
            else:
                counts.update(classify(record.get("err")))
            summary["events"] += 1
            summary["event_counts"][event_type] += 1
            earliest, latest = summary["earliest_timestamp_ms"], summary["latest_timestamp_ms"]
            summary["earliest_timestamp_ms"] = timestamp if earliest is None else min(earliest, timestamp)
            summary["latest_timestamp_ms"] = timestamp if latest is None else max(latest, timestamp)
        summary["truncated"] = bool(token)
        if not token:
            break
    summary["categories"] = sorted(counts)
    summary["category_counts"] = dict(sorted(counts.items()))
    summary["phase_counts"] = dict(sorted(phase_counts.items()))
    return summary


def configuration_snapshot(config, aws):
    project, region, account = (config[key] for key in ("project", "region", "account"))
    unavailable = dict.fromkeys(
        ("cluster", "service", "service_target_definition", "db_security_groups", "identity_policy"), True)

    def read(source, loader):
        try:
            value = loader()
            if not isinstance(value, dict):
                raise ValueError("Invalid metadata object")
        except READ_ERRORS:
            return None
        unavailable[source] = False
        return value

    cluster = read("cluster", lambda: aws([
        "rds", "describe-db-clusters", "--db-cluster-identifier", f"{project}-aurora"])["DBClusters"][0])
    service = read("service", lambda: aws([
        "ecs", "describe-services", "--cluster", project, "--services", f"{project}-web"])["services"][0])
    definition = read("service_target_definition", lambda: aws([
        "ecs", "describe-task-definition", "--task-definition", service["taskDefinition"]])["taskDefinition"])
    policy = read("identity_policy", lambda: aws([
        "iam", "get-role-policy", "--role-name", f"{project}-task",
        "--policy-name", f"{project}-web-rds-iam-auth"])["PolicyDocument"])
    snapshot = {
        "sources_unavailable": unavailable,
        "definition_basis": "service_target_not_running_tasks",
        "credential_check_basis": "declarations_only_not_runtime",
        **dict.fromkeys((
            "cluster_available", "iam_database_auth_enabled", "service_running_count",
            "endpoint_matches_cluster", "database_matches", "user_matches", "region_matches",
            "task_role_matches", "credential_env_override_declared", "credential_secret_override_declared",
            "environment_files_declared", "db_ingress_from_web_groups",
            "identity_policy_has_expected_connect_allow")),
    }
    if cluster is not None:
        snapshot["cluster_available"] = cluster.get("Status") == "available"
        snapshot["iam_database_auth_enabled"] = cluster.get("IAMDatabaseAuthenticationEnabled") is True
    if service is not None and type(service.get("runningCount")) is int:
        snapshot["service_running_count"] = service["runningCount"]
    try:
        container = next(c for c in definition["containerDefinitions"] if c["name"] == "web")
        env = {entry["name"]: entry["value"] for entry in container.get("environment", [])}
        secrets = {entry["name"] for entry in container.get("secrets", [])}
        snapshot.update({
            "user_matches": env.get("AURORA_USER") == "awsops_web",
            "region_matches": env.get("AWS_REGION") == region,
            "task_role_matches": definition.get("taskRoleArn") == f"arn:aws:iam::{account}:role/{project}-task",
            "credential_env_override_declared": bool(CREDENTIAL_NAMES.intersection(env)),
            "credential_secret_override_declared": bool(CREDENTIAL_NAMES.intersection(secrets)),
            "environment_files_declared": bool(container.get("environmentFiles")),
        })
        if cluster is not None:
            snapshot["endpoint_matches_cluster"] = (
                bool(cluster.get("Endpoint")) and env.get("AURORA_ENDPOINT") == cluster.get("Endpoint"))
            snapshot["database_matches"] = env.get("AURORA_DATABASE") == cluster.get("DatabaseName") == "awsops"
    except READ_ERRORS:
        unavailable["service_target_definition"] = True
    try:
        db_groups = [group["VpcSecurityGroupId"] for group in cluster["VpcSecurityGroups"]]
        if not db_groups:
            raise ValueError("Missing database security groups")
        groups = aws(["ec2", "describe-security-groups", "--group-ids", *db_groups])["SecurityGroups"]
        net = service["networkConfiguration"]["awsvpcConfiguration"]
        snapshot["db_ingress_from_web_groups"] = any(
            rule.get("IpProtocol") in ("tcp", "-1")
            and (rule.get("IpProtocol") == "-1" or rule.get("FromPort", 65536) <= 5432 <= rule.get("ToPort", -1))
            and any(pair.get("GroupId") in net["securityGroups"] for pair in rule.get("UserIdGroupPairs", []))
            for group in groups for rule in group.get("IpPermissions", []))
        unavailable["db_security_groups"] = False
    except READ_ERRORS:
        pass
    try:
        expected = f"arn:aws:rds-db:{region}:{account}:dbuser:{cluster['DbClusterResourceId']}/awsops_web"
        as_list = lambda value: value if isinstance(value, list) else [value]
        snapshot["identity_policy_has_expected_connect_allow"] = any(
            s.get("Effect") == "Allow" and not s.get("Condition")
            and "rds-db:connect" in as_list(s.get("Action"))
            and expected in as_list(s.get("Resource")) for s in policy["Statement"])
    except READ_ERRORS:
        pass
    snapshot["status"] = ("unavailable" if all(unavailable.values()) else
                          "partial" if any(unavailable.values()) else "available")
    return snapshot


def server_log_snapshot(config, aws):
    summary = {
        "status": "unavailable", "listing_truncated": False, "tail_truncated": None,
        "listing_pages_read": 0, "tail_line_limit": 500, "lines_examined": 0,
        "matching_lines": 0, "category_counts": {}, "selected_last_written_ms": None,
    }
    instance = f"{config['project']}-aurora-1"
    selected, marker = None, None
    try:
        for _ in range(3):
            args = ["rds", "describe-db-log-files", "--db-instance-identifier", instance,
                    "--filename-contains", "postgresql", "--max-records", "100"]
            if marker:
                args += ["--marker", marker]
            page = aws(args)
            files = page["DescribeDBLogFiles"]
            if not isinstance(files, list):
                raise ValueError("Invalid server log listing")
            for item in files:
                name, written = item["LogFileName"], item["LastWritten"]
                if not isinstance(name, str) or type(written) is not int or written < 0:
                    raise ValueError("Invalid server log metadata")
                if "postgresql" in name and (selected is None or written > selected[0]):
                    selected = (written, name)
            summary["listing_pages_read"] += 1
            marker = page.get("Marker")
            if marker is not None and not isinstance(marker, str):
                raise ValueError("Invalid server log pagination")
            if not marker:
                break
        summary["listing_truncated"] = bool(marker)
    except READ_ERRORS:
        summary["listing_truncated"] = True
    if selected is None:
        return summary
    summary["selected_last_written_ms"] = selected[0]
    try:
        # Omitting Marker requests the most recent tail, not the file's beginning.
        tail = aws(["rds", "download-db-log-file-portion", "--db-instance-identifier", instance,
                    "--log-file-name", selected[1], "--number-of-lines", "500"])
        data, pending = tail["LogFileData"], tail["AdditionalDataPending"]
        if not isinstance(data, str) or type(pending) is not bool:
            raise ValueError("Invalid server log tail")
        lines = data.splitlines()
        summary["tail_truncated"] = pending or len(lines) >= 500 or len(data.encode("utf-8")) >= 1_048_576
        counts = Counter()
        for line in lines:
            if re.search(r"\bawsops_web\b", line):
                summary["matching_lines"] += 1
                counts.update(classify(line))
        summary["lines_examined"] = len(lines)
        summary["category_counts"] = dict(sorted(counts.items()))
        summary["status"] = "partial" if summary["listing_truncated"] else "available"
    except READ_ERRORS:
        pass
    return summary


def main():
    if sys.argv[1:] != ["--target", "dev"]:
        raise ValueError("Explicit development target is required")
    config = json.load(sys.stdin)
    if isinstance(config, str):
        config = json.loads(config)

    result = {"logs": collect(config, aws_read, int(time.time() * 1000))}
    result["configuration"] = configuration_snapshot(config, aws_read)
    result["server_logs"] = server_log_snapshot(config, aws_read)
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # This advisory tool never reports exception text, including unexpected failures.
        print(json.dumps({"status": "unavailable"}))
        sys.exit(1)
