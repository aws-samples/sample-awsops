"""Memory qualification uses actual per-instance samples, never a declared flag."""
import copy
import datetime as dt
import math

import pytest

from diagnosis import discovery, memory_metrics
from diagnosis.evidence import EvidenceIndex
from diagnosis.test_discovery import (ACCOUNT, REGION, NOW, I1, I2, Budget, Database,
                                     inventory, metric_response, recommendation, provider)

START = NOW - dt.timedelta(days=14)
RESOURCE = {"id": "r-instance", "resource_id": I1, "kind": "ec2", "region": REGION,
            "account": ACCOUNT, "facts": {"instance_type": "m7g.xlarge"}}
DIMS = [{"Name": "InstanceId", "Value": I1}, {"Name": "ImageId", "Value": "ami-example"}]
METRIC = {"Namespace": "CWAgent", "MetricName": "mem_used_percent", "Dimensions": DIMS}


class CloudWatch:
    def __init__(self, listings=None, results=None):
        self.listings = listings if listings is not None else [{"Metrics": [METRIC]}]
        self.results = results
        self.calls = []

    def get_paginator(self, operation):
        owner = self

        class Pages:
            def paginate(self, **params):
                owner.calls.append((operation, params))
                if operation == "list_metrics":
                    yield from copy.deepcopy(owner.listings)
                elif operation == "get_metric_data":
                    if owner.results is not None:
                        yield from copy.deepcopy(owner.results)
                    else:
                        yield series(params["MetricDataQueries"][0]["Id"])
                else:
                    raise AssertionError(operation)
        return Pages()


class CombinedCloudWatch(CloudWatch):
    """Native and memory queries share the same injected scoped client."""
    def get_paginator(self, operation):
        if operation == "get_metric_data":
            owner = self
            class Pages:
                def paginate(self, **params):
                    owner.calls.append((operation, params))
                    namespace = params["MetricDataQueries"][0]["MetricStat"]["Metric"]["Namespace"]
                    if namespace == "CWAgent":
                        if owner.results is not None:
                            for page in copy.deepcopy(owner.results):
                                for row in page.get("MetricDataResults", []):
                                    row["Id"] = params["MetricDataQueries"][0]["Id"]
                                yield page
                        else:
                            yield series(params["MetricDataQueries"][0]["Id"])
                    else:
                        yield metric_response(params)
            return Pages()
        return super().get_paginator(operation)


def series(qid="memory0", *, values=None, stamps=None, status="Complete"):
    return {"MetricDataResults": [{"Id": qid, "StatusCode": status,
        "Timestamps": stamps if stamps is not None else [START + dt.timedelta(hours=i) for i in range(336)],
        "Values": values if values is not None else [35] * 336}]}


def result(client, resource=RESOURCE, budget=None):
    return memory_metrics.collect(client, [resource], START, NOW, budget or Budget())[resource["id"]]


def test_measured_scoped_series_preserves_dimensions_and_enables_memory():
    cw = CloudWatch()
    item = result(cw)
    assert item["complete"] is True
    assert item["sample_ratio"] == 1
    assert item["metric"] == {"min": 35.0, "max": 35.0, "mean": 35.0, "samples": 336,
        "status": "Complete", "unit": "Percent", "namespace": "CWAgent",
        "metric_name": "mem_used_percent", "dimensions": DIMS, "period": 3600,
        "statistic": "Maximum"}
    listings = next(args for op, args in cw.calls if op == "list_metrics")
    assert listings["Dimensions"] == [{"Name": "InstanceId", "Value": I1}]
    assert listings["IncludeLinkedAccounts"] is False
    query = next(args for op, args in cw.calls if op == "get_metric_data")
    assert query["StartTime"] == START and query["EndTime"] == NOW
    assert query["MetricDataQueries"][0]["MetricStat"]["Metric"]["Dimensions"] == DIMS


def test_exact_instance_series_is_preferred_over_appended_dimension_sets():
    exact = {**METRIC, "Dimensions": [{"Name": "InstanceId", "Value": I1}]}
    cw = CloudWatch(listings=[{"Metrics": [METRIC, exact, {**METRIC, "Dimensions": DIMS[::-1]}]}])
    item = result(cw)
    assert item["complete"] is True and item["metric"]["dimensions"] == exact["Dimensions"]


@pytest.mark.parametrize("metrics", [[], [METRIC, METRIC],
    [METRIC, {**METRIC, "Dimensions": DIMS + [{"Name": "InstanceType", "Value": "m7g.xlarge"}]}],
    [{**METRIC, "Dimensions": [{"Name": "InstanceId", "Value": I2}]}],
    [{**METRIC, "Dimensions": [{"Name": "AutoScalingGroupName", "Value": "fleet"}]}],
    [{**METRIC, "Namespace": "AWS/EC2"}],
    [{**METRIC, "Dimensions": DIMS + [{"Name": "AccountId", "Value": "999900001111"}]}],
    [{**METRIC, "Dimensions": DIMS + [{"Name": "InstanceId", "Value": I1}]}]])
def test_absent_ambiguous_or_unscoped_series_never_fetches_samples(metrics):
    cw = CloudWatch(listings=[{"Metrics": metrics}])
    assert result(cw)["complete"] is False
    assert not any(op == "get_metric_data" for op, _ in cw.calls)


def test_linked_account_response_cannot_qualify_host_memory():
    cw = CloudWatch(listings=[{"Metrics": [METRIC], "OwningAccounts": ["999900001111"]}])
    assert result(cw)["complete"] is False
    assert not any(op == "get_metric_data" for op, _ in cw.calls)


def test_valid_series_cannot_hide_conflicting_foreign_identity_in_same_listing():
    foreign = {**METRIC, "Dimensions": DIMS + [{"Name": "AccountId", "Value": "999900001111"}]}
    cw = CloudWatch(listings=[{"Metrics": [METRIC, foreign]}])
    assert result(cw)["complete"] is False
    assert not any(op == "get_metric_data" for op, _ in cw.calls)


def test_error_during_listing_makes_memory_unavailable():
    class Refused(CloudWatch):
        def get_paginator(self, operation):
            raise PermissionError("simulated")
    item = result(Refused())
    assert item["complete"] is False
    assert item["reason"] == "memory_metric_read_failed"


def test_repeated_listing_token_cannot_complete_memory_discovery():
    cw = CloudWatch(listings=[{"Metrics": [METRIC], "NextToken": "repeat"},
                             {"Metrics": [], "NextToken": "repeat"}])
    item = result(cw)
    assert item["complete"] is False
    assert item["reason"] == "memory_metric_repeated_token"


@pytest.mark.parametrize("fault", ["partial_status", "few_samples", "outside", "nan", "negative",
                                  "over_percent", "duplicate_hour", "trailing_gap", "length_mismatch"])
def test_bad_or_unrepresentative_samples_do_not_qualify(fault):
    page = series()
    row = page["MetricDataResults"][0]
    if fault == "partial_status":
        row["StatusCode"] = "PartialData"
    elif fault == "few_samples":
        row["Values"], row["Timestamps"] = row["Values"][:20], row["Timestamps"][:20]
    elif fault == "outside":
        row["Timestamps"][0] = START - dt.timedelta(hours=1)
    elif fault == "nan":
        row["Values"][0] = math.nan
    elif fault == "negative":
        row["Values"][0] = -1
    elif fault == "over_percent":
        row["Values"][0] = 101
    elif fault == "duplicate_hour":
        row["Timestamps"] = [START + dt.timedelta(minutes=i) for i in range(336)]
    elif fault == "trailing_gap":
        row["Values"], row["Timestamps"] = row["Values"][:310], row["Timestamps"][:310]
    elif fault == "length_mismatch":
        row["Values"] = row["Values"][:-1]
    item = result(CloudWatch(results=[page]))
    assert item["complete"] is False
    assert item["reason"]


def test_representative_small_distributed_gaps_can_qualify():
    page = series()
    row = page["MetricDataResults"][0]
    row["Timestamps"] = [stamp for i, stamp in enumerate(row["Timestamps"]) if i % 24 != 12]
    row["Values"] = [35] * len(row["Timestamps"])
    assert result(CloudWatch(results=[page]))["complete"] is True


def test_capped_listing_does_not_assume_unique_remaining_metric():
    cw = CloudWatch(listings=[{"Metrics": [METRIC] if i == 0 else [], "NextToken": str(i)} for i in range(5)])
    item = result(cw)
    assert item["complete"] is False
    assert "cap" in item["reason"]
    assert not any(op == "get_metric_data" for op, _ in cw.calls)


def test_deadline_before_listing_makes_no_provider_call():
    cw = CloudWatch()
    item = result(cw, budget=Budget(1))
    assert item["complete"] is False
    assert cw.calls == []


def test_integration_enables_guarded_sizing_and_keeps_original_metric_scope(provider):
    cw = CombinedCloudWatch()
    provider.ec2 = [{"instanceRecommendations": [{**recommendation(), "tags": [],
        "utilizationMetrics": [{"name": name, "statistic": "Maximum", "value": 25} for name in
             ("Memory", "EBS_READ_OPS_PER_SECOND", "EBS_WRITE_OPS_PER_SECOND")]}]}]
    bundle = {"resources": [copy.deepcopy(RESOURCE)], "evidence": [], "relationships": [],
              "coverage": {"account": ACCOUNT}, "gaps": [], "degraded": [], "incomplete": []}
    # Sizing also requires the resource's own current, complete inventory row.
    discovery._evidence(bundle, "inventory", "inventory", [RESOURCE["id"]], RESOURCE["facts"], NOW,
                        region=REGION, fresh=True, coverage={"complete": True})
    used = []
    factory = lambda service, region, budget: used.append((service, region)) or cw
    discovery._metrics(bundle, Budget(), bundle["resources"], client_factory=factory)
    discovery._provider_sizing(bundle, Budget(), bundle["resources"])
    assert used == [("cloudwatch", REGION)]
    index = EvidenceIndex(bundle, ACCOUNT)
    metric = next(row for row in index.evidence.values() if row["kind"] == "metrics")
    assert metric["facts"]["missing_memory"] is False
    assert metric["facts"]["dimensions"] == [{"Name": "InstanceId", "Value": I1}]
    assert metric["facts"]["metrics"]["MemoryUtilization"]["Maximum"]["dimensions"] == DIMS
    assert index.validate_finding({"id": "candidate", "pillar": "cost_optimization", "severity": "medium",
        "resource_ids": [RESOURCE["id"]], "evidence_ids": list(index.evidence), "claim": "sizing_candidate",
        "explanation": "Manually verify the provider candidate.", "prerequisites": [],
        "verification": "provider_sizing"})["claim"] == "sizing_candidate"


def test_native_and_memory_windows_share_one_clock_capture(provider, monkeypatch):
    calls = []
    def ticking_now():
        calls.append(True)
        return NOW + dt.timedelta(microseconds=len(calls))
    monkeypatch.setattr(discovery, "_now", ticking_now)
    cw = CombinedCloudWatch()
    bundle = {"resources": [copy.deepcopy(RESOURCE)], "evidence": [], "relationships": [],
              "coverage": {"account": ACCOUNT}, "gaps": [], "degraded": [], "incomplete": []}
    discovery._metrics(bundle, Budget(), bundle["resources"], client_factory=lambda *args: cw)
    query = next(args for op, args in cw.calls if op == "get_metric_data")
    assert query["EndTime"] - query["StartTime"] == dt.timedelta(days=14)
    assert any(args["MetricDataQueries"][0]["MetricStat"]["Metric"]["Namespace"] == "CWAgent"
               for op, args in cw.calls if op == "get_metric_data")


@pytest.mark.parametrize("fault", ["absent", "duplicate", "foreign", "partial"])
def test_integration_never_uses_provider_memory_to_replace_missing_measurement(provider, fault):
    listing, samples = [{"Metrics": [METRIC]}], None
    if fault == "absent":
        listing = [{"Metrics": []}]
    elif fault == "duplicate":
        listing = [{"Metrics": [METRIC, METRIC]}]
    elif fault == "foreign":
        listing[0]["OwningAccounts"] = ["999900001111"]
    else:
        samples = [series(status="PartialData")]
    cw = CombinedCloudWatch(listings=listing, results=samples)
    provider.ec2 = [{"instanceRecommendations": [{**recommendation(), "tags": [],
        "utilizationMetrics": [{"name": name, "statistic": "Maximum", "value": 25} for name in
             ("Memory", "EBS_READ_OPS_PER_SECOND", "EBS_WRITE_OPS_PER_SECOND")]}]}]
    bundle = {"resources": [copy.deepcopy(RESOURCE)], "evidence": [], "relationships": [],
              "coverage": {"account": ACCOUNT}, "gaps": [], "degraded": [], "incomplete": []}
    discovery._metrics(bundle, Budget(), bundle["resources"], client_factory=lambda *args: cw)
    discovery._provider_sizing(bundle, Budget(), bundle["resources"])
    index = EvidenceIndex(bundle, ACCOUNT)
    metric = next(row for row in index.evidence.values() if row["kind"] == "metrics")
    assert metric["facts"]["missing_memory"] is True
    assert index.validate_finding({"id": "candidate", "pillar": "cost_optimization", "severity": "medium",
        "resource_ids": [RESOURCE["id"]], "evidence_ids": list(index.evidence), "claim": "sizing_candidate",
        "explanation": "Manually verify the provider candidate.", "prerequisites": [],
        "verification": "provider_sizing"})["claim"] == "hypothesis"
