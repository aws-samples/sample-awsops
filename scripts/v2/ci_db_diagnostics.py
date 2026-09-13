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

    print(json.dumps(collect(config, aws, int(time.time() * 1000))))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, TypeError, AttributeError, OSError, subprocess.SubprocessError):
        print("Development database diagnostics unavailable (details withheld)", file=sys.stderr)
        sys.exit(1)
