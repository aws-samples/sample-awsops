"""Tests for cross_account.get_role_arn host-account short-circuit.

Regression: a chat targeting the host account injected target_account_id=<host>,
and get_role_arn built arn:aws:iam::<host>:role/AWSopsReadOnlyRole and tried to
AssumeRole it — but that role exists only in onboarded *target* accounts, so STS
returned AccessDenied. Same-account access must use the Lambda's own role.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))
import cross_account as ca  # noqa: E402

HOST = "123456789012"


@pytest.fixture(autouse=True)
def _host_env(monkeypatch):
    # Pin the host account via env so tests make no STS call.
    monkeypatch.setenv("AWSOPS_HOST_ACCOUNT_ID", HOST)
    monkeypatch.delenv("AWSOPS_ROLE_NAME", raising=False)
    ca._host_account_id.cache_clear()
    yield
    ca._host_account_id.cache_clear()


def test_host_account_returns_none():
    # querying the host account itself → no cross-account role → use exec role
    assert ca.get_role_arn(HOST) is None
    assert ca.get_role_arn(f"  {HOST}  ") is None  # tolerate stray whitespace


def test_other_account_builds_arn():
    assert ca.get_role_arn("222222222222") == "arn:aws:iam::222222222222:role/AWSopsReadOnlyRole"


def test_empty_or_none_returns_none():
    assert ca.get_role_arn(None) is None
    assert ca.get_role_arn("") is None


def test_custom_role_name(monkeypatch):
    monkeypatch.setenv("AWSOPS_ROLE_NAME", "MyReadRole")
    assert ca.get_role_arn("222222222222") == "arn:aws:iam::222222222222:role/MyReadRole"


def test_host_detected_via_sts_when_env_unset(monkeypatch):
    # env unset → _host_account_id falls back to STS GetCallerIdentity; the host
    # short-circuit must still fire (and other accounts still build the ARN).
    monkeypatch.delenv("AWSOPS_HOST_ACCOUNT_ID", raising=False)

    class _STS:
        def get_caller_identity(self):
            return {"Account": HOST}

    monkeypatch.setattr(ca.boto3, "client", lambda *a, **k: _STS())
    ca._host_account_id.cache_clear()
    assert ca._host_account_id() == HOST
    assert ca.get_role_arn(HOST) is None  # host → no assume
    assert ca.get_role_arn("222222222222") == "arn:aws:iam::222222222222:role/AWSopsReadOnlyRole"
    ca._host_account_id.cache_clear()


def test_host_unresolved_falls_through_to_cross_account(monkeypatch):
    # env unset + STS fails → host is None → a real account still builds the ARN
    # (degraded = pre-fix cross-account path; the logged warning is the signal).
    monkeypatch.delenv("AWSOPS_HOST_ACCOUNT_ID", raising=False)

    def _boom(*a, **k):
        raise RuntimeError("no sts")

    monkeypatch.setattr(ca.boto3, "client", _boom)
    ca._host_account_id.cache_clear()
    assert ca._host_account_id() is None
    assert ca.get_role_arn("222222222222") == "arn:aws:iam::222222222222:role/AWSopsReadOnlyRole"
    ca._host_account_id.cache_clear()


def test_get_client_host_account_does_not_assume(monkeypatch):
    # role_arn is None for the host account → get_client must NOT AssumeRole
    def _boom(*a, **k):
        raise AssertionError("must not AssumeRole for the host account")

    monkeypatch.setattr(ca, "_assume_role", _boom)
    monkeypatch.setattr(ca.boto3, "client", lambda *a, **k: ("client", a, k))

    role_arn = ca.get_role_arn(HOST)  # None
    client = ca.get_client("cloudwatch", "ap-northeast-2", role_arn)
    assert client[0] == "client"  # plain boto3 client, no creds injected


def test_get_client_other_account_does_assume(monkeypatch):
    seen = {}

    def _fake_assume(role_arn, suffix=None):
        seen["role_arn"] = role_arn
        return {"aws_access_key_id": "k", "aws_secret_access_key": "s", "aws_session_token": "t"}

    monkeypatch.setattr(ca, "_assume_role", _fake_assume)
    monkeypatch.setattr(ca.boto3, "client", lambda *a, **k: ("client", a, k))

    role_arn = ca.get_role_arn("222222222222")
    ca.get_client("cloudwatch", "ap-northeast-2", role_arn)
    assert seen["role_arn"] == "arn:aws:iam::222222222222:role/AWSopsReadOnlyRole"


# ---- get_credentials (sigv4 signing creds for OpenSearch) ----
def test_get_credentials_host_uses_session_not_assume(monkeypatch):
    # Host account → default provider chain (the Lambda's own creds), never a self-assume.
    sentinel = object()

    class _Sess:
        def get_credentials(self):
            return sentinel

    monkeypatch.setattr(ca.boto3, "Session", lambda: _Sess())

    def _boom(*a, **k):
        raise AssertionError("_assume_role must not be called for the host account")

    monkeypatch.setattr(ca, "_assume_role", _boom)
    assert ca.get_credentials(HOST) is sentinel
    assert ca.get_credentials(None) is sentinel


def test_get_credentials_other_builds_credentials(monkeypatch):
    monkeypatch.setattr(ca, "_assume_role", lambda role_arn, suffix=None: {
        "aws_access_key_id": "AKIAEXAMPLE",
        "aws_secret_access_key": "secretkey",
        "aws_session_token": "tok",
    })
    c = ca.get_credentials("222222222222")
    assert c.access_key == "AKIAEXAMPLE"
    assert c.secret_key == "secretkey"
    assert c.token == "tok"


# ---- resolve_tool_name (AgentCore Gateway passes the tool via client_context, not event) ----
class _FakeContext:
    def __init__(self, custom=None):
        self.client_context = _FakeClientContext(custom) if custom is not None else None


class _FakeClientContext:
    def __init__(self, custom):
        self.custom = custom


def test_resolve_tool_name_prefers_event_tool_name():
    # BFF direct-invoke path (datasource explorer) still puts tool_name in the event.
    ctx = _FakeContext(custom={"bedrockAgentCoreToolName": "clickhouse-mcp-target___clickhouse_schema"})
    assert ca.resolve_tool_name({"tool_name": "clickhouse_tables"}, ctx) == "clickhouse_tables"


def test_resolve_tool_name_falls_back_to_client_context():
    # Gateway invoke path: event has no tool_name, only client_context.custom.
    ctx = _FakeContext(custom={"bedrockAgentCoreToolName": "clickhouse-mcp-target___clickhouse_tables"})
    assert ca.resolve_tool_name({}, ctx) == "clickhouse_tables"


def test_resolve_tool_name_strips_only_the_last_separator():
    # Tool names can themselves contain underscores; only the target___tool separator splits.
    ctx = _FakeContext(custom={"bedrockAgentCoreToolName": "iam-mcp-target___list_role_policies"})
    assert ca.resolve_tool_name({}, ctx) == "list_role_policies"


def test_resolve_tool_name_no_context_returns_default():
    assert ca.resolve_tool_name({}, None) == ""
    assert ca.resolve_tool_name({}, None, default="fallback_tool") == "fallback_tool"


def test_resolve_tool_name_context_without_client_context_attr():
    class _Bare:
        pass

    assert ca.resolve_tool_name({}, _Bare()) == ""


def test_resolve_tool_name_client_context_without_custom():
    ctx = _FakeContext(custom=None)
    assert ca.resolve_tool_name({}, ctx) == ""
