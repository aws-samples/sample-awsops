"""Bounded account summaries supporting all pillars without resource cost attribution."""
from copy import deepcopy
import datetime as dt
import hashlib
import math
import os
import threading

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError, ParamValidationError

_clients = {}
_lock = threading.Lock()
_MAX_PAGES = 3
_REGION = os.environ.get("AWS_REGION", "ap-northeast-2")


class _SupportingDeadline(Exception):
    """The worker's own analysis budget ran out. A provider/socket TimeoutError is not this."""


def _client(service, region, budget):
    remaining = budget.remaining()
    if remaining < 10:
        raise _SupportingDeadline()
    timeout = min(15, max(1, int(remaining - 5)))
    key = (service, region, timeout)
    with _lock:
        if key not in _clients:
            _clients[key] = boto3.client(
                service, region_name=region, config=Config(
                    connect_timeout=3, read_timeout=timeout,
                    retries={"total_max_attempts": 1}, max_pool_connections=4))
        return _clients[key]


def _numeric(value, *, percent=False):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or (percent and not 0 <= number <= 100):
        return None
    return number


def _mark(bundle, category, value):
    if value not in bundle[category]:
        bundle[category].append(value)


def _now():
    return dt.datetime.now(dt.timezone.utc)


def _cost(client, account, budget, bundle, now):
    # Cost Explorer's End is exclusive. On the first day of a month the
    # month-to-date window is empty, so summarize the previous full month.
    month_start = now.date().replace(day=1)
    partial = now.date() != month_start
    first = month_start if partial else (month_start - dt.timedelta(days=1)).replace(day=1)
    start, end = first.isoformat(), (now.date() if partial else month_start).isoformat()
    groups, token, seen, complete = [], None, set(), True
    for page_number in range(_MAX_PAGES):
        if budget.remaining() < 10:
            raise _SupportingDeadline()
        params = {"TimePeriod": {"Start": start, "End": end}, "Granularity": "MONTHLY",
                  "Metrics": ["UnblendedCost"],
                  "GroupBy": [{"Type": "DIMENSION", "Key": "SERVICE"}],
                  "Filter": {"Dimensions": {"Key": "LINKED_ACCOUNT", "Values": [account]}}}
        if token:
            params["NextPageToken"] = token
        # IAM ce:GetCostAndUsage (us-east-1): workers.tf worker_diagnosis Sid DiagnosisDataSourcesReadOnly (runtime_read_condition).
        result = client.get_cost_and_usage(**params)
        for period in result.get("ResultsByTime", []):
            for group in period.get("Groups", []):
                metric = group.get("Metrics", {}).get("UnblendedCost", {})
                keys = group.get("Keys", [])
                amount = _numeric(metric.get("Amount"))
                if not keys or amount is None or not isinstance(metric.get("Unit"), str):
                    _mark(bundle, "incomplete", "cost_invalid_group")
                    complete = False
                    continue
                groups.append({"service": str(keys[0])[:160], "amount": amount,
                               "currency": metric["Unit"][:12],
                               "estimated": period.get("Estimated") is True})
        token = result.get("NextPageToken")
        if not token:
            break
        if token in seen:
            _mark(bundle, "incomplete", "cost_repeated_token")
            complete = False
            break
        seen.add(token)
        if page_number == _MAX_PAGES - 1:
            _mark(bundle, "incomplete", "cost_page_cap")
            complete = False
    if len(groups) > 40:
        _mark(bundle, "incomplete", "cost_group_cap")
        complete = False
    currencies = {group["currency"] for group in groups}
    if len(currencies) > 1:
        _mark(bundle, "gaps", "mixed_currency")
    # Keep provider service-level amounts. Never infer resource cost or add currencies.
    return ({"cost_groups": groups[:40], "resource_cost": False, "partial_month": partial},
            {"start": start, "end": end},
            {"complete": complete, "returned": min(40, len(groups)),
             "total": len(groups), "omitted": max(0, len(groups) - 40)})


_SORT_REJECTED_CODES = frozenset(("InvalidInputException", "ValidationException"))


def _posture(client, account, bundle):
    query = {"Filters": {"AwsAccountId": [{"Value": account, "Comparison": "EQUALS"}],
                         "RecordState": [{"Value": "ACTIVE", "Comparison": "EQUALS"}],
                         "WorkflowStatus": [{"Value": "NEW", "Comparison": "EQUALS"}]},
             "MaxResults": 100}
    order = "severity_desc"
    try:
        try:
            # Highest severity first, so a capped page is the worst findings, not an arbitrary
            # sample (sources.collect_posture parity); fall back unsorted and say so.
            # IAM securityhub:GetFindings (both calls): workers.tf worker_diagnosis Sid DiagnosisDataSourcesReadOnly (runtime_read_condition).
            response = client.get_findings(
                SortCriteria=[{"Field": "SeverityNormalized", "SortOrder": "desc"}], **query)
        except (ClientError, ParamValidationError) as error:
            if isinstance(error, ClientError) and error.response.get("Error", {}).get("Code") not in _SORT_REJECTED_CODES:
                raise
            response = client.get_findings(**query)
            order = "unsorted"
            _mark(bundle, "incomplete", "posture_unsorted_sample")
    except ClientError as error:
        # Not subscribed is a steady state, not a failure (sources.collect_posture parity).
        if error.response.get("Error", {}).get("Code") != "InvalidAccessException":
            raise
        return {"enabled": False, "posture_counts": {}}, {"filter": "ACTIVE_NEW"}, {"complete": True, "returned": 0}
    rows = response.get("Findings", [])[:100]
    counts = {}
    for row in rows:
        if row.get("AwsAccountId") != account:
            _mark(bundle, "incomplete", "posture_scope_mismatch")
            continue
        severity = row.get("Severity", {}).get("Label")
        if severity not in {"INFORMATIONAL", "LOW", "MEDIUM", "HIGH", "CRITICAL"}:
            severity = "UNKNOWN"
        counts[severity] = counts.get(severity, 0) + 1
    more = bool(response.get("NextToken"))
    if more:
        _mark(bundle, "incomplete", "posture_page_cap")
    return ({"enabled": True, "posture_counts": counts, "sampled": True, "continuation": more, "order": order},
            {"filter": "ACTIVE_NEW"}, {"complete": not more, "returned": len(rows), "order": order})


def _changes(client, account, bundle, now):
    # IAM cloudtrail:LookupEvents: workers.tf worker_diagnosis Sid DiagnosisDataSourcesReadOnly (runtime_read_condition).
    response = client.lookup_events(
        StartTime=now - dt.timedelta(hours=24), EndTime=now, MaxResults=50,
        LookupAttributes=[{"AttributeKey": "ReadOnly", "AttributeValue": "false"}])
    rows = []
    for event in response.get("Events", [])[:50]:
        # No CloudTrailEvent JSON, username, raw resource list or message.
        event_time = event.get("EventTime")
        if not isinstance(event_time, dt.datetime):
            _mark(bundle, "incomplete", "change_time_unknown")
            continue
        rows.append({"event_name": str(event.get("EventName", ""))[:100],
                     "event_source": str(event.get("EventSource", ""))[:100],
                     "event_time": event_time.isoformat()})
    more = bool(response.get("NextToken"))
    if more:
        _mark(bundle, "incomplete", "changes_page_cap")
    return ({"change_events": rows, "sampled": True, "continuation": more},
            {"start": (now - dt.timedelta(hours=24)).isoformat(), "end": now.isoformat()},
            {"complete": not more, "returned": len(rows)})


def _commitment(client, account, budget, bundle, now):
    params = {"TimePeriod": {"Start": (now.date() - dt.timedelta(days=30)).isoformat(),
                            "End": now.date().isoformat()},
              "Filter": {"Dimensions": {"Key": "LINKED_ACCOUNT", "Values": [account]}}}
    # IAM ce:GetReservationCoverage/GetSavingsPlansCoverage (below; us-east-1): workers.tf worker_diagnosis Sid DiagnosisDataSourcesReadOnly (runtime_read_condition).
    ri = client.get_reservation_coverage(**params)
    if budget.remaining() < 10:
        raise _SupportingDeadline()
    ri_percent = _numeric(ri.get("Total", {}).get("CoverageHours", {}).get(
        "CoverageHoursPercentage"), percent=True)
    rows = [{"service": "ReservedInstances", "percentage": ri_percent}]
    # MONTHLY rows each carry their own TimePeriod; bounded continuation keeps
    # completeness honest instead of treating any first-page token as permanent.
    more, token, seen = bool(ri.get("NextPageToken")), None, set()
    for page_number in range(_MAX_PAGES):
        if budget.remaining() < 10:
            raise _SupportingDeadline()
        sp = client.get_savings_plans_coverage(**params, Granularity="MONTHLY", MaxResults=20,
                                               **({"NextToken": token} if token else {}))
        for row in sp.get("SavingsPlansCoverages", [])[:20]:
            period = row.get("TimePeriod") if isinstance(row.get("TimePeriod"), dict) else {}
            rows.append({"service": "SavingsPlans",
                         "start": str(period.get("Start"))[:32] if period.get("Start") else None,
                         "end": str(period.get("End"))[:32] if period.get("End") else None,
                         "percentage": _numeric(row.get("Coverage", {}).get("CoveragePercentage"),
                                                percent=True)})
        token = sp.get("NextToken")
        if not token:
            break
        if token in seen or page_number == _MAX_PAGES - 1:
            more = True
            break
        seen.add(token)
    if more:
        _mark(bundle, "incomplete", "commitment_page_cap")
    return ({"commitment_coverage": rows, "sampled": more},
            {"start": params["TimePeriod"]["Start"], "end": params["TimePeriod"]["End"]},
            {"complete": not more, "returned": len(rows)})


def collect(bundle, budget, *, scope):
    result = deepcopy(bundle)
    account = result.get("coverage", {}).get("account")
    # Applied host identity must match; member reads never use this path.
    if scope != "self" or result.get("coverage", {}).get("storage_scope") != "self":
        return result
    if not account or account != os.environ.get("DIAGNOSIS_HOST_ACCOUNT_ID"):
        _mark(result, "gaps", "supporting_host_unknown")  # host identity absent/mismatched: all skipped
        return result
    now = _now()
    plans = [
        ("cost", "ce", "us-east-1", _cost), ("posture", "securityhub", _REGION, _posture),
        ("what_changed", "cloudtrail", _REGION, _changes), ("commitment", "ce", "us-east-1", _commitment),
    ]
    for key, service, region, fn in plans:
        if budget.remaining() < 10:
            # A self-imposed bound, never data-quality loss: incomplete, with remaining plans unread.
            _mark(result, "incomplete", "supporting_deadline_exhausted")
            for later, *_ in plans[plans.index((key, service, region, fn)):]:
                result.setdefault("native_sources", {})[later] = {"status": "not_collected", "reason": "deadline"}
            break
        try:
            client = _client(service, region, budget)
            if key == "cost" or key == "commitment":
                facts, window, coverage = fn(client, account, budget, result, now)
            elif key == "what_changed":
                facts, window, coverage = fn(client, account, result, now)
            else:
                facts, window, coverage = fn(client, account, result)
            regions = result.get("coverage", {}).get("regions")
            others = sorted(set(regions.get("selected", []) if isinstance(regions, dict) else []) - {region})
            if service != "ce" and others:  # single-region API; never claim scope-wide coverage
                coverage = {**coverage, "complete": False, "regions_not_queried": others}
                _mark(result, "gaps", ("posture" if key == "posture" else "changes") + "_single_region")
            captured = now.isoformat()
            record_id = "summary-" + hashlib.sha256(
                f"{account}:{key}:{captured}".encode()).hexdigest()[:24]
            result["evidence"].append({
                "id": record_id, "source": key, "kind": "scope_summary",
                "resource_ids": [], "account": account,
                "region": "global" if service == "ce" else region,
                "facts": facts, "captured_at": captured, "fresh": True,
                "window": window, "coverage": coverage})
            result.setdefault("native_sources", {})[key] = {
                "status": "ok" if coverage.get("complete") else "partial",
                "window": window, "coverage": coverage}
            missing = f"{key}_not_collected"
            if missing in result["gaps"]:
                result["gaps"].remove(missing)
        except _SupportingDeadline:  # the shared deadline ran out mid-plan: not a provider failure
            _mark(result, "incomplete", "supporting_deadline_exhausted")
            result.setdefault("native_sources", {})[key] = {"status": "not_collected", "reason": "deadline"}
        except Exception:  # fixed diagnostics; no provider exception data in reports
            _mark(result, "degraded", f"{key}_read_failed")
            result.setdefault("native_sources", {})[key] = {"status": "failed"}
    # Use the same final byte/citation bound as discovery; no second context budget.
    from .discovery import _finish
    return _finish(result)
