"""WS-A2 — FinOps depth collectors (idle waste, RI/SP coverage, cost MoM + usage-type).
New file so it does not touch the concurrent data-branch's test_sources.py. No live AWS/DB."""
from diagnosis import sources


class FakeAggConn:
    """idle() now aggregates in SQL — return one aggregate row per query."""
    def __init__(self, ebs_agg, stopped):
        self.ebs_agg = ebs_agg  # (count, gb, est_usd)
        self.stopped = stopped

    def run(self, sql, **_kw):
        if "resource_type='ebs_volume'" in sql:
            return [list(self.ebs_agg)]
        if "resource_type='ec2'" in sql:
            return [[self.stopped]]
        return []


def test_collect_idle_maps_sql_aggregates():
    d = sources.collect_idle(FakeAggConn((2, 110.0, 10.26), 1))["data"]
    assert d["unattached_ebs"] == {"count": 2, "gb": 110.0, "est_monthly_usd": 10.26}
    assert d["stopped_ec2"]["count"] == 1
    assert "데이터 불가" in d["note"]  # EIP/snapshots honestly flagged


def test_collect_idle_degrades_on_db_error():
    class Boom:
        def run(self, *a, **k):
            raise RuntimeError("db down")
    assert sources.collect_idle(Boom())["degraded"] is True  # never raises


class FakeCE:
    def __init__(self):
        self.calls = []

    def get_cost_and_usage(self, TimePeriod, Granularity, Metrics, GroupBy=None, **_kw):  # noqa: N803
        key = GroupBy[0]["Key"] if GroupBy else None
        self.calls.append(key)
        if key == "SERVICE":
            return {"ResultsByTime": [{"Groups": [{"Keys": ["EC2"], "Metrics": {"UnblendedCost": {"Amount": "123.456"}}}]}]}
        if key == "USAGE_TYPE":
            return {"ResultsByTime": [{"Groups": [
                {"Keys": ["NatGateway-Bytes"], "Metrics": {"UnblendedCost": {"Amount": "40"}}},
                {"Keys": ["DataTransfer-Out"], "Metrics": {"UnblendedCost": {"Amount": "60"}}},
            ]}]}
        return {"ResultsByTime": [
            {"TimePeriod": {"Start": "2026-04-01"}, "Total": {"UnblendedCost": {"Amount": "100"}}},
            {"TimePeriod": {"Start": "2026-05-01"}, "Total": {"UnblendedCost": {"Amount": "200"}}},
        ]}

    def get_reservation_coverage(self, TimePeriod):  # noqa: N803
        return {"Total": {"CoverageHours": {"CoverageHoursPercentage": "55.5"}}}

    def get_savings_plans_coverage(self, TimePeriod):  # noqa: N803
        return {"SavingsPlansCoverages": [{"Coverage": {"CoveragePercentage": "30.0"}}]}


class PagedCE(FakeCE):
    """USAGE_TYPE returns two pages — verifies _ce_grouped follows NextPageToken (no truncation)."""
    def get_cost_and_usage(self, TimePeriod, Granularity, Metrics, GroupBy=None, NextPageToken=None, **_kw):  # noqa: N803
        key = GroupBy[0]["Key"] if GroupBy else None
        if key == "USAGE_TYPE" and not NextPageToken:
            self.calls.append(key)
            return {"NextPageToken": "p2", "ResultsByTime": [{"Groups": [
                {"Keys": ["NatGateway-Bytes"], "Metrics": {"UnblendedCost": {"Amount": "40"}}}]}]}
        if key == "USAGE_TYPE":
            self.calls.append("USAGE_TYPE#2")
            return {"ResultsByTime": [{"Groups": [
                {"Keys": ["DataTransfer-Out"], "Metrics": {"UnblendedCost": {"Amount": "60"}}}]}]}
        return super().get_cost_and_usage(TimePeriod, Granularity, Metrics, GroupBy)


def test_collect_cost_adds_mom_trend_and_usage_types(monkeypatch):
    fake = FakeCE()
    monkeypatch.setattr(sources, "_ce_client", lambda: fake)
    d = sources.collect_cost()["data"]
    assert d["mtd_by_service"]["EC2"] == 123.46
    assert [m["total"] for m in d["monthly_totals"]] == [100.0, 200.0]
    assert d["top_usage_types"]["DataTransfer-Out"] == 60.0  # sorted desc
    assert set(fake.calls) == {"SERVICE", "USAGE_TYPE", None}  # exactly 3 distinct CE calls


def test_collect_cost_paginates_usage_types(monkeypatch):
    paged = PagedCE()
    monkeypatch.setattr(sources, "_ce_client", lambda: paged)
    d = sources.collect_cost()["data"]
    # both pages aggregated → neither driver dropped by single-page truncation
    assert d["top_usage_types"] == {"DataTransfer-Out": 60.0, "NatGateway-Bytes": 40.0}
    assert "USAGE_TYPE#2" in paged.calls  # second page was fetched


def test_collect_commitment_coverage(monkeypatch):
    monkeypatch.setattr(sources, "_ce_client", lambda: FakeCE())
    d = sources.collect_commitment()["data"]
    assert d["ri_coverage_pct"] == 55.5 and d["sp_coverage_pct"] == 30.0


def test_collect_commitment_degrades_per_call(monkeypatch):
    class PartialCE(FakeCE):
        def get_reservation_coverage(self, TimePeriod):  # noqa: N803
            raise RuntimeError("AccessDenied")
    monkeypatch.setattr(sources, "_ce_client", lambda: PartialCE())
    d = sources.collect_commitment()["data"]
    assert d["ri_coverage_pct"] is None      # RI denied → None
    assert d["sp_coverage_pct"] == 30.0       # SP still resolves
