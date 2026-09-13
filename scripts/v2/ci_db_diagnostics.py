"""Read-only dev log diagnostics; never emit raw logs, role ARNs or credentials."""
import json
import os
import re
import subprocess
import sys
import time


def collect(config, aws, now_ms):
    if (not isinstance(config, dict) or set(config) != {"project", "region", "account"}
            or not re.fullmatch(r"[a-z][a-z0-9-]{1,39}", str(config.get("project", "")))
            or config.get("region") != "ap-northeast-2"
            or not re.fullmatch(r"[0-9]{12}", str(config.get("account", "")))):
        raise ValueError("Invalid development diagnostic scope")
    if aws(["sts", "get-caller-identity"]).get("Account") != config["account"]:
        raise ValueError("Development diagnostic account mismatch")
    patterns = {
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
    count, unparsed, latest = 0, 0, None
    categories = set()
    token = None
    for _ in range(3):
        args = ["logs", "filter-log-events", "--log-group-name", f"/ecs/{config['project']}-web",
                "--start-time", str(max(0, now_ms - 3_600_000)),
                "--filter-pattern", '"db_ping_failed"', "--limit", "100"]
        if token:
            args += ["--next-token", token]
        result = aws(args)
        for event in result.get("events", []):
            try:
                record = json.loads(re.sub(r"\x1b\[[0-9;]*m", "", event.get("message", "")).strip())
            except (ValueError, TypeError):
                unparsed += 1
                continue
            if not isinstance(record, dict) or record.get("evt") != "db_ping_failed":
                continue
            count += 1
            message = record.get("err")
            matched = {label for label, pattern in patterns.items()
                       if isinstance(message, str) and re.search(pattern, message, re.I)}
            categories.update(matched or {"unclassified"})
            timestamp = event.get("timestamp")
            if isinstance(timestamp, int) and timestamp >= 0:
                latest = max(latest or 0, timestamp)
        token = result.get("nextToken")
        if not token:
            break
        if not isinstance(token, str):
            raise ValueError("Invalid diagnostic pagination")
    return {"events": count, "categories": sorted(categories), "unparsed": unparsed,
            "latest_timestamp": latest, "truncated": bool(token)}

def configuration_snapshot(config, aws):
    project, region, account = (config[key] for key in ("project", "region", "account"))
    cluster = aws(["rds", "describe-db-clusters", "--db-cluster-identifier", f"{project}-aurora"])["DBClusters"][0]
    service = aws(["ecs", "describe-services", "--cluster", project, "--services", f"{project}-web"])["services"][0]
    definition = aws(["ecs", "describe-task-definition", "--task-definition", service["taskDefinition"]])["taskDefinition"]
    container = next(c for c in definition["containerDefinitions"] if c["name"] == "web")
    env = {entry["name"]: entry["value"] for entry in container.get("environment", [])}
    net = service["networkConfiguration"]["awsvpcConfiguration"]
    db_groups = [group["VpcSecurityGroupId"] for group in cluster["VpcSecurityGroups"]]
    groups = aws(["ec2", "describe-security-groups", "--group-ids", *db_groups])["SecurityGroups"]
    ingress = any(rule.get("IpProtocol") in ("tcp", "-1")
                  and (rule.get("IpProtocol") == "-1" or rule.get("FromPort", 65536) <= 5432 <= rule.get("ToPort", -1))
                  and any(pair.get("GroupId") in net["securityGroups"] for pair in rule.get("UserIdGroupPairs", []))
                  for group in groups for rule in group.get("IpPermissions", []))
    policy = aws(["iam", "get-role-policy", "--role-name", f"{project}-task",
                  "--policy-name", f"{project}-web-rds-iam-auth"])["PolicyDocument"]
    expected = f"arn:aws:rds-db:{region}:{account}:dbuser:{cluster['DbClusterResourceId']}/awsops_web"
    as_list = lambda value: value if isinstance(value, list) else [value]
    connect_allow = any(s.get("Effect") == "Allow" and not s.get("Condition")
                        and "rds-db:connect" in as_list(s.get("Action"))
                        and expected in as_list(s.get("Resource")) for s in policy.get("Statement", []))
    return {
        "cluster_available": cluster.get("Status") == "available",
        "iam_database_auth_enabled": cluster.get("IAMDatabaseAuthenticationEnabled") is True,
        "web_running_count": service.get("runningCount") if type(service.get("runningCount")) is int else None,
        "endpoint_matches_cluster": bool(cluster.get("Endpoint")) and env.get("AURORA_ENDPOINT") == cluster.get("Endpoint"),
        "database_matches": env.get("AURORA_DATABASE") == cluster.get("DatabaseName") == "awsops",
        "user_matches": env.get("AURORA_USER") == "awsops_web",
        "region_matches": env.get("AWS_REGION") == region,
        "task_role_matches": definition.get("taskRoleArn") == f"arn:aws:iam::{account}:role/{project}-task",
        "explicit_credential_override": any(key in env for key in ("AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY")),
        "db_ingress_from_web_groups": ingress,
        "identity_policy_has_expected_connect_allow": connect_allow,
    }


def main():
    config = json.load(sys.stdin)
    if isinstance(config, str):
        config = json.loads(config)

    def aws(args):
        result = subprocess.run(
            ["aws", *args, "--region", "ap-northeast-2", "--output", "json",
             "--no-cli-pager", "--no-paginate"], check=True, capture_output=True, text=True,
            timeout=30, env={**os.environ, "AWS_PAGER": "", "AWS_MAX_ATTEMPTS": "2"})
        return json.loads(result.stdout)

    result = collect(config, aws, int(time.time() * 1000))
    result["configuration"] = configuration_snapshot(config, aws)
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, TypeError, AttributeError, KeyError, IndexError, StopIteration, OSError, subprocess.SubprocessError):
        print("Development database diagnostics unavailable (details withheld)", file=sys.stderr)
        sys.exit(1)
