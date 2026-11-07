"""Member credentials are registered and verified; refusal never uses host data."""
import pytest
from diagnosis import scoped_clients
from diagnosis.test_discovery import provider

ACCOUNT = "999900001111"


@pytest.fixture(autouse=True)
def configured_allowlist(monkeypatch):
    monkeypatch.setenv("DIAGNOSIS_MEMBER_ROLE_ARNS", f'["arn:aws:iam::{ACCOUNT}:role/ReadOnly"]')


def test_registered_role_must_also_be_in_applied_allowlist(monkeypatch):
    monkeypatch.setenv("DIAGNOSIS_MEMBER_ROLE_ARNS", "[]")
    monkeypatch.setattr(scoped_clients.boto3, "client", lambda *a, **k: pytest.fail("STS forbidden"))
    with pytest.raises(scoped_clients.ScopeError):
        scoped_clients.member_factory(Registry([["ReadOnly", "external"]]), ACCOUNT, Budget())


class Budget:
    def remaining(self, analysis=True):
        return 100


class Registry:
    def __init__(self, rows):
        self.rows = rows

    def run(self, sql, **params):
        if sql == "SHOW statement_timeout":
            return [["30s"]]
        if "set_config" in sql:
            return []
        assert "enabled" in sql and params["account"] == ACCOUNT
        return self.rows


def test_unregistered_member_makes_no_sts_call(monkeypatch):
    monkeypatch.setattr(scoped_clients.boto3, "client", lambda *a, **k: pytest.fail("STS forbidden"))
    with pytest.raises(scoped_clients.ScopeError):
        scoped_clients.member_factory(Registry([]), ACCOUNT, Budget())


# ExternalId is optional for first-party members (ADR-011), so None/"" are valid registrations.
@pytest.mark.parametrize("rows", [[["ReadOnly", 7]], [["ReadOnly", "x"]], [["bad/path", "external"]],
                                 [["ReadOnly", "external"], ["ReadOnly", "external"]]])
def test_invalid_registry_is_refused_before_assumption(monkeypatch, rows):
    monkeypatch.setattr(scoped_clients.boto3, "client", lambda *a, **k: pytest.fail("STS forbidden"))
    with pytest.raises(scoped_clients.ScopeError):
        scoped_clients.member_factory(Registry(rows), ACCOUNT, Budget())


@pytest.mark.parametrize("external", ["external"])
def test_assumed_principal_must_match_registered_account(monkeypatch, external):
    called = []

    class Sts:
        def assume_role(self, **params):
            called.append(params.get("ExternalId"))
            assert params["RoleArn"] == f"arn:aws:iam::{ACCOUNT}:role/ReadOnly"
            return {"AssumedRoleUser": {"Arn": "arn:aws:sts::111122223333:assumed-role/ReadOnly/test"},
                    "Credentials": {}}
    monkeypatch.setattr(scoped_clients.boto3, "client", lambda *a, **k: Sts())
    with pytest.raises(scoped_clients.ScopeError):
        scoped_clients.member_factory(Registry([["ReadOnly", external]]), ACCOUNT, Budget())
    # ADR-011: a first-party row (NULL ExternalId) assumes without one; a registered value is sent.
    assert called == [external or None]


@pytest.mark.parametrize("reported_account", [ACCOUNT, "111122223333"])
def test_verified_session_never_uses_host_service_credentials(monkeypatch, reported_account):
    created, assumed = [], []

    class Sts:
        def assume_role(self, **params):
            assumed.append(params["DurationSeconds"])
            return {"AssumedRoleUser": {"Arn": f"arn:aws:sts::{ACCOUNT}:assumed-role/ReadOnly/diagnosis"},
                    "Credentials": {"AccessKeyId": "test-access", "SecretAccessKey": "test-secret", "SessionToken": "test-token"}}

    class Session:
        def __init__(self, **credentials):
            assert credentials["aws_session_token"] == "test-token"

        def client(self, service, **params):
            if service == "sts":
                return type("Identity", (), {"get_caller_identity": lambda self: {"Account": reported_account}})()
            created.append((service, params))
            return object()

    def host_client(service, **kwargs):
        assert service == "sts", "A member data read attempted host credentials"
        return Sts()

    monkeypatch.setattr(scoped_clients.boto3, "client", host_client)
    monkeypatch.setattr(scoped_clients.boto3, "Session", Session)
    if reported_account != ACCOUNT:
        with pytest.raises(scoped_clients.ScopeError):
            scoped_clients.member_factory(Registry([["ReadOnly", "external"]]), ACCOUNT, Budget())
        assert not created
    else:
        factory = scoped_clients.member_factory(Registry([["ReadOnly", "external"]]), ACCOUNT, Budget())
        first = factory("cloudwatch", "ap-northeast-2", Budget())
        assert factory("cloudwatch", "ap-northeast-2", Budget()) is first
        assert factory("cloudwatch", "us-east-1", Budget()) is not first
        assert len(created) == 2 and assumed == [3600]
        # Long analyses re-assume before the 1h session expires; stale clients are dropped.
        clock = scoped_clients.time.monotonic() + 3600
        monkeypatch.setattr(scoped_clients.time, "monotonic", lambda: clock)
        assert factory("cloudwatch", "ap-northeast-2", Budget()) is not first
        assert assumed == [3600, 3600] and len(created) == 3


def test_discovery_member_metrics_use_only_injected_member_factory(provider, monkeypatch):
    from diagnosis import discovery
    from diagnosis.test_discovery import Database, inventory, I1
    calls = []
    monkeypatch.setattr(scoped_clients, "member_factory", lambda *a: lambda service, region, budget:
                        calls.append(service) or provider)
    result = discovery.collect(Database([inventory("ec2", I1, {}, account=ACCOUNT)]), ACCOUNT,
                               Budget(), scope=ACCOUNT)
    assert "cloudwatch" in calls and "compute-optimizer" in calls
    assert not provider.client_calls
    assert "member_live_sources_unsupported" not in result["gaps"]
