"""Registered member credentials, isolated from the worker's host session."""
import re
import json
import os
import boto3
from botocore.config import Config


class ScopeError(ValueError):
    """A member could not be authorized or its credentials verified."""


def member_factory(conn, account, budget):
    if not re.fullmatch(r"\d{12}", str(account)) or budget.remaining(analysis=True) <= 5:
        raise ScopeError("member_scope_unavailable")
    timeout = min(10, max(1, int(budget.remaining(analysis=True) - 2)))
    config = Config(connect_timeout=1, read_timeout=timeout,
                    retries={"total_max_attempts": 1, "mode": "standard"})
    # The report account alone cannot authorize assuming an arbitrary role.
    previous = conn.run("SHOW statement_timeout")[0][0]
    try:
        conn.run("SELECT set_config('statement_timeout', :timeout, false)", timeout=f"{timeout * 1000}ms")
        rows = conn.run("SELECT role_name,external_id FROM accounts "
                        "WHERE account_id=:account AND enabled AND NOT is_host", account=account)
    finally:
        conn.run("SELECT set_config('statement_timeout', :timeout, false)", timeout=str(previous))
    if len(rows) != 1 or len(rows[0]) != 2:
        raise ScopeError("member_not_registered")
    role, external = rows[0]
    if (not isinstance(role, str) or not re.fullmatch(r"[A-Za-z0-9_+=,.@-]{1,64}", role)
            or (external not in (None, "") and (not isinstance(external, str)
                or not re.fullmatch(r"[\w+=,.@:/-]{2,1224}", external)))):
        raise ScopeError("member_registry_unqualified")
    role_arn = f"arn:aws:iam::{account}:role/{role}"
    try:
        allowed = json.loads(os.environ.get("DIAGNOSIS_MEMBER_ROLE_ARNS", "[]"))
    except (ValueError, TypeError):
        raise ScopeError("member_allowlist_invalid") from None
    if not isinstance(allowed, list) or len(allowed) > 32 or role_arn not in allowed:
        raise ScopeError("member_role_not_allowed")
    if budget.remaining(analysis=True) <= 3:
        raise ScopeError("member_discovery_deadline")
    config = Config(connect_timeout=1, read_timeout=min(10, max(1, int(budget.remaining(analysis=True) - 2))),
                    retries={"total_max_attempts": 1, "mode": "standard"})
    # ExternalId is optional for first-party members (migration 01KW39F7...).
    result = boto3.client("sts", config=config).assume_role(
        RoleArn=role_arn, RoleSessionName="awsops-diagnosis-read", DurationSeconds=900,
        **({"ExternalId": external} if external else {}))
    expected = f"arn:aws:sts::{account}:assumed-role/{role}/"
    if not result.get("AssumedRoleUser", {}).get("Arn", "").startswith(expected):
        raise ScopeError("member_principal_mismatch")
    credentials = result.get("Credentials", {})
    if not all(credentials.get(k) for k in ("AccessKeyId", "SecretAccessKey", "SessionToken")):
        raise ScopeError("member_credentials_missing")
    session = boto3.Session(aws_access_key_id=credentials["AccessKeyId"],
                            aws_secret_access_key=credentials["SecretAccessKey"],
                            aws_session_token=credentials["SessionToken"])
    if budget.remaining(analysis=True) <= 3:
        raise ScopeError("member_discovery_deadline")
    config = Config(connect_timeout=1, read_timeout=min(10, max(1, int(budget.remaining(analysis=True) - 2))),
                    retries={"total_max_attempts": 1, "mode": "standard"})
    if session.client("sts", config=config).get_caller_identity().get("Account") != account:
        raise ScopeError("member_identity_mismatch")
    clients = {}

    def client(service, region, current_budget):
        remaining = current_budget.remaining(analysis=True)
        if remaining <= 2:
            raise TimeoutError("member_discovery_deadline")
        timeout = min(10, max(1, int(remaining - 1)))
        key = service, region, timeout
        if key not in clients:
            clients[key] = session.client(service, region_name=region, config=Config(
                connect_timeout=1, read_timeout=timeout,
                retries={"total_max_attempts": 1, "mode": "standard"}))
        return clients[key]
    return client
