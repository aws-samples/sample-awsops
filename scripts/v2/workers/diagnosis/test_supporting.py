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
    # Mid-month clock: the month-to-date window is non-empty on every real run date.
    monkeypatch.setattr(supporting, "_now", lambda: dt.datetime(2026, 11, 6, 9, tzinfo=dt.timezone.utc))
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
    assert not {"posture_single_region", "changes_single_region"} & set(result["gaps"])
    data = base()
    data["coverage"]["regions"] = {"selected": [providers._REGION, "us-west-2"]}
    result = providers.collect(data, Budget(), scope="self")
    assert {"posture_single_region", "changes_single_region"} <= set(result["gaps"])
    changes = result["native_sources"]["what_changed"]
    assert changes["status"] == "partial" and changes["coverage"]["regions_not_queried"] == ["us-west-2"]
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


def test_unsubscribed_security_hub_is_steady_state_not_degraded(providers, monkeypatch):
    from botocore.exceptions import ClientError

    class Unsubscribed(Client):
        def get_findings(self, **kwargs):
            raise ClientError({"Error": {"Code": "InvalidAccessException"}}, "GetFindings")
    monkeypatch.setattr(providers, "_client", lambda *a: Unsubscribed())
    result = providers.collect(base(), Budget(), scope="self")
    posture = next(e for e in result["evidence"] if e["source"] == "posture")
    assert posture["facts"]["enabled"] is False and posture["fresh"] is True
    assert "posture_read_failed" not in result["degraded"]
    assert result["native_sources"]["posture"]["status"] == "ok"


def test_posture_sample_is_highest_severity_first_with_unsorted_fallback_disclosed(providers, monkeypatch):
    from botocore.exceptions import ClientError
    calls = []

    class Sorted(Client):
        def get_findings(self, **kwargs):
            calls.append(kwargs)
            return super().get_findings(**kwargs)
    monkeypatch.setattr(providers, "_client", lambda *a: Sorted())
    result = providers.collect(base(), Budget(), scope="self")
    assert calls[0]["SortCriteria"] == [{"Field": "SeverityNormalized", "SortOrder": "desc"}]
    posture = next(e for e in result["evidence"] if e["source"] == "posture")
    assert posture["facts"]["order"] == "severity_desc"

    class Rejects(Client):
        def get_findings(self, **kwargs):
            if "SortCriteria" in kwargs:
                raise ClientError({"Error": {"Code": "InvalidInputException"}}, "GetFindings")
            return super().get_findings(**kwargs)
    monkeypatch.setattr(providers, "_client", lambda *a: Rejects())
    result = providers.collect(base(), Budget(), scope="self")
    posture = next(e for e in result["evidence"] if e["source"] == "posture")
    assert posture["facts"]["order"] == "unsorted" and "posture_unsorted_sample" in result["incomplete"]


def test_deadline_mid_plan_is_not_reported_as_a_provider_failure(providers, monkeypatch):
    class Slow(Client):
        def get_findings(self, **kwargs):
            raise TimeoutError("supporting_deadline_exhausted")
    monkeypatch.setattr(providers, "_client", lambda *a: Slow())
    result = providers.collect(base(), Budget(), scope="self")
    assert "posture_read_failed" not in result["degraded"]
    assert result["native_sources"]["posture"] == {"status": "not_collected", "reason": "deadline"}


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


def test_first_day_of_month_summarizes_previous_full_month(providers, monkeypatch):
    windows = []

    class Recording(Client):
        def get_cost_and_usage(self, **kwargs):
            windows.append(kwargs["TimePeriod"])
            return super().get_cost_and_usage(**kwargs)

    monkeypatch.setattr(providers, "_client", lambda *a: Recording())
    monkeypatch.setattr(providers, "_now", lambda: dt.datetime(2026, 12, 1, 0, 5, tzinfo=dt.timezone.utc))
    result = providers.collect(base(), Budget(), scope="self")
    assert windows == [{"Start": "2026-11-01", "End": "2026-12-01"}]
    assert "cost_read_failed" not in result["degraded"]
    cost = next(e for e in result["evidence"] if e["source"] == "cost")
    assert cost["facts"]["partial_month"] is False
    assert cost["window"] == {"start": "2026-11-01", "end": "2026-12-01"}
    assert result["native_sources"]["cost"]["status"] == "ok"
    # January 1 rolls back across the year boundary.
    monkeypatch.setattr(providers, "_now", lambda: dt.datetime(2027, 1, 1, tzinfo=dt.timezone.utc))
    providers.collect(base(), Budget(), scope="self")
    assert windows[-1] == {"Start": "2026-12-01", "End": "2027-01-01"}


def test_savings_plans_coverage_is_monthly_period_labelled_and_paginated(providers, monkeypatch):
    calls = []

    class Paged(Client):
        def get_savings_plans_coverage(self, **kwargs):
            calls.append(kwargs)
            assert kwargs["Granularity"] == "MONTHLY"
            month = "10" if "NextToken" not in kwargs else "11"
            page = {"SavingsPlansCoverages": [{
                "TimePeriod": {"Start": f"2026-{month}-01", "End": f"2026-{month}-28"},
                "Coverage": {"CoveragePercentage": "60.0"}}]}
            return {**page, "NextToken": "p2"} if "NextToken" not in kwargs else page

    monkeypatch.setattr(providers, "_client", lambda *a: Paged())
    result = providers.collect(base(), Budget(), scope="self")
    commitment = next(e for e in result["evidence"] if e["source"] == "commitment")
    plans = [r for r in commitment["facts"]["commitment_coverage"] if r["service"] == "SavingsPlans"]
    assert [(r["start"], r["end"]) for r in plans] == [("2026-10-01", "2026-10-28"), ("2026-11-01", "2026-11-28")]
    assert [c.get("NextToken") for c in calls] == [None, "p2"]
    assert commitment["coverage"]["complete"] is True and "commitment_page_cap" not in result["incomplete"]


def test_absent_or_mismatched_host_identity_marks_the_skip(providers, monkeypatch):
    monkeypatch.setattr(providers, "_client", lambda *a: pytest.fail("host read occurred"))
    for value in (None, "999900001111"):
        if value is None:
            monkeypatch.delenv("DIAGNOSIS_HOST_ACCOUNT_ID")
        else:
            monkeypatch.setenv("DIAGNOSIS_HOST_ACCOUNT_ID", value)
        result = providers.collect(base(), Budget(), scope="self")
        assert "supporting_host_unknown" in result["gaps"] and not result["evidence"]
    member = base()
    member["coverage"].update(account="999900001111", storage_scope="999900001111")
    assert "supporting_host_unknown" not in providers.collect(member, Budget(), scope="999900001111")["gaps"]
