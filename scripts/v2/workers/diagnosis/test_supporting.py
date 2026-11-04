"""Native account summaries retain scope, currency and bounded coverage."""
import datetime as dt
import pytest

ACCOUNT = "111122223333"


class Budget:
    def remaining(self, analysis=True):
        return 1000


def base():
    return {"resources": [], "evidence": [], "relationships": [],
            "coverage": {"account": ACCOUNT, "storage_scope": "self"},
            "gaps": [], "degraded": [], "incomplete": [],
            "native_sources": {k: {"status": "not_collected"} for k in
                               ("cost", "posture", "what_changed", "commitment", "idle", "datasources_obs")}}


class Client:
    def get_cost_and_usage(self, **kwargs):
        assert kwargs["Filter"]["Dimensions"]["Values"] == [ACCOUNT]
        return {"ResultsByTime": [{"Estimated": True, "Groups": [
            {"Keys": ["Amazon EC2"], "Metrics": {"UnblendedCost": {"Amount": "14.5", "Unit": "USD"}}},
            {"Keys": ["Amazon RDS"], "Metrics": {"UnblendedCost": {"Amount": "10", "Unit": "EUR"}}},
        ]}]}

    def get_findings(self, **kwargs):
        assert kwargs["Filters"]["AwsAccountId"][0]["Value"] == ACCOUNT
        return {"Findings": [{"AwsAccountId": ACCOUNT, "Severity": {"Label": "HIGH"}}],
                "NextToken": "more"}

    def lookup_events(self, **kwargs):
        return {"Events": [{"EventName": "ModifyDBInstance", "EventSource": "rds.amazonaws.com",
                            "EventTime": dt.datetime.now(dt.timezone.utc),
                            "Username": "private-user", "CloudTrailEvent": "secret-raw-log"}]}

    def get_reservation_coverage(self, **kwargs):
        return {"Total": {"CoverageHours": {"CoverageHoursPercentage": "75.0"}}}

    def get_savings_plans_coverage(self, **kwargs):
        return {"SavingsPlansCoverages": [{"Coverage": {"CoveragePercentage": "60.0"}}]}


@pytest.fixture
def providers(monkeypatch):
    from diagnosis import supporting
    monkeypatch.setenv("DIAGNOSIS_HOST_ACCOUNT_ID", ACCOUNT)
    monkeypatch.setattr(supporting, "_client", lambda *a: Client())
    return supporting


def test_supporting_sources_are_host_scoped_and_never_leak_raw_events(providers):
    result = providers.collect(base(), Budget(), scope="self")
    assert {e["source"] for e in result["evidence"]} == {"cost", "posture", "what_changed", "commitment"}
    assert all(e["account"] == ACCOUNT and e["resource_ids"] == [] for e in result["evidence"])
    import json
    text = json.dumps(result)
    assert "private-user" not in text and "secret-raw-log" not in text
    assert "ModifyDBInstance" in text
    assert "posture_page_cap" in result["incomplete"]
    assert result["native_sources"]["cost"]["status"] == "ok"


def test_mixed_currency_costs_stay_per_service_and_partial_month(providers):
    result = providers.collect(base(), Budget(), scope="self")
    cost = next(e for e in result["evidence"] if e["source"] == "cost")["facts"]
    assert {g["currency"] for g in cost["cost_groups"]} == {"USD", "EUR"}
    assert cost["resource_cost"] is False and cost["partial_month"] is True
    assert "total_savings" not in cost and "mixed_currency" in result["gaps"]


def test_member_scope_and_wrong_host_account_never_use_native_clients(providers, monkeypatch):
    monkeypatch.setattr(providers, "_client", lambda *a: pytest.fail("host read occurred"))
    member = base()
    member["coverage"].update(account="999900001111", storage_scope="999900001111")
    assert not providers.collect(member, Budget(), scope="999900001111")["evidence"]
    assert not providers.collect(member, Budget(), scope="self")["evidence"]


def test_repeated_cost_page_tokens_stop_at_bound(providers, monkeypatch):
    class Pages(Client):
        def get_cost_and_usage(self, **kwargs):
            return {"ResultsByTime": [], "NextPageToken": "repeat"}
    monkeypatch.setattr(providers, "_client", lambda *a: Pages())
    result = providers.collect(base(), Budget(), scope="self")
    assert "cost_repeated_token" in result["incomplete"]


def test_deadline_exhaustion_skips_all_provider_calls(providers, monkeypatch):
    class Expired:
        def remaining(self, analysis=True):
            return 0
    monkeypatch.setattr(providers, "_client", lambda *a: pytest.fail("expired call"))
    result = providers.collect(base(), Expired(), scope="self")
    assert not result["evidence"] and "supporting_deadline_exhausted" in result["degraded"]


def test_all_native_requests_match_locked_sdk_shapes(providers, monkeypatch):
    import boto3
    from botocore.validate import validate_parameters

    session = boto3.Session(aws_access_key_id="offline", aws_secret_access_key="offline")

    class ShapeChecked(Client):
        def __init__(self, service):
            self.model = session.client(service, region_name="ap-northeast-2").meta.service_model

        def __getattribute__(self, name):
            value = super().__getattribute__(name)
            if name.startswith(("get_", "lookup_")) and callable(value):
                def checked(**kwargs):
                    operation = "".join(part.title() for part in name.split("_"))
                    validate_parameters(kwargs, self.model.operation_model(operation).input_shape)
                    return value(**kwargs)
                return checked
            return value

    monkeypatch.setattr(providers, "_client", lambda service, *a: ShapeChecked(service))
    result = providers.collect(base(), Budget(), scope="self")
    assert all(result["native_sources"][key]["status"] in {"ok", "partial"}
               for key in ("cost", "posture", "what_changed", "commitment"))
    assert not result["degraded"]
