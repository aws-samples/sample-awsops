"""Measured EC2 memory, supplied by an already scoped CloudWatch client.

The default Linux/macOS CWAgent metric is supported. Absent/custom/Windows
instrumentation stays unknown; collection never installs or configures an agent.
"""
import datetime as dt
import math
import re

MAX_PAGES = 3
MAX_RESOURCES = 8
MAX_METRICS = 500
PERIOD = 3600
EXPECTED = 14 * 24


class CollectionGap(ValueError):
    """A controlled source gap that must veto memory qualification."""


def _utc(value):
    if not isinstance(value, dt.datetime) or value.tzinfo is None:
        return None
    return value.astimezone(dt.timezone.utc)


def _pages(client, operation, params, budget):
    iterator = iter(client.get_paginator(operation).paginate(**params))
    seen = set()
    for _ in range(MAX_PAGES):
        remaining = budget.remaining(analysis=True)
        config = getattr(client, "_client_config", None)
        minimum = (config.connect_timeout + config.read_timeout) if config is not None else 2
        if remaining <= minimum:
            raise CollectionGap("memory_metric_deadline")
        try:
            page = next(iterator)
        except StopIteration:
            return
        if not isinstance(page, dict):
            raise CollectionGap("memory_metric_malformed")
        yield page
        token = page.get("NextToken")
        if not token:
            return
        if token in seen:
            raise CollectionGap("memory_metric_repeated_token")
        seen.add(token)
    raise CollectionGap("memory_metric_page_cap")


def _metric(row, resource):
    if not isinstance(row, dict) or row.get("Namespace") != "CWAgent" or row.get("MetricName") != "mem_used_percent":
        return None
    dimensions = row.get("Dimensions")
    if not isinstance(dimensions, list) or not 1 <= len(dimensions) <= 30:
        return None
    pairs = []
    for item in dimensions:
        if (not isinstance(item, dict) or set(item) != {"Name", "Value"}
                or not isinstance(item["Name"], str) or not isinstance(item["Value"], str)
                or not item["Name"] or not item["Value"]
                or len(item["Name"]) > 255 or len(item["Value"]) > 1024):
            return None
        pairs.append((item["Name"], item["Value"]))
    if len({name for name, _ in pairs}) != len(pairs):
        return None
    values = dict(pairs)
    if values.get("InstanceId") != resource["resource_id"]:
        return None
    if any(values.get(key, resource["account"]) != resource["account"] for key in ("AccountId", "account_id")):
        return None
    return {"Namespace": "CWAgent", "MetricName": "mem_used_percent",
            "Dimensions": [{"Name": name, "Value": value} for name, value in pairs]}


def _qualified(samples, start, end):
    points = sorted(samples)
    return bool(len(points) / EXPECTED >= 0.9
                and points[0] - start.timestamp() <= 2 * PERIOD
                and end.timestamp() - points[-1] <= 2 * PERIOD
                and all(b - a <= 6 * PERIOD for a, b in zip(points, points[1:])))


def collect(client, resources, start, end, budget):
    """Return measured memory plus explicit gaps for a bounded EC2 batch."""
    resources = [r for r in resources if r.get("kind") == "ec2"]
    output = {r["id"]: {"complete": False, "reason": "memory_metric_absent", "sample_ratio": 0}
              for r in resources}
    start, end = _utc(start), _utc(end)
    if not start or not end or end - start != dt.timedelta(days=14):
        return {rid: {**row, "reason": "memory_metric_window_invalid"} for rid, row in output.items()}
    selected = {}
    for resource in resources[:MAX_RESOURCES]:
        rid = resource["id"]
        if (not re.fullmatch(r"i-(?:[a-f0-9]{8}|[a-f0-9]{17})", str(resource.get("resource_id", "")))
                or not re.fullmatch(r"\d{12}", str(resource.get("account", "")))):
            output[rid]["reason"] = "memory_metric_identity_unresolved"
            continue
        candidates = []
        try:
            for page in _pages(client, "list_metrics", {
                    "Namespace": "CWAgent", "MetricName": "mem_used_percent",
                    "Dimensions": [{"Name": "InstanceId", "Value": resource["resource_id"]}],
                    "IncludeLinkedAccounts": False}, budget):
                metrics = page.get("Metrics", [])
                owners = page.get("OwningAccounts")
                if not isinstance(metrics, list) or len(metrics) > MAX_METRICS:
                    raise CollectionGap("memory_metric_payload_cap")
                if owners is not None and (not isinstance(owners, list) or len(owners) != len(metrics)
                        or any(account != resource["account"] for account in owners)):
                    raise CollectionGap("memory_metric_foreign_account")
                for raw in metrics:
                    metric = _metric(raw, resource)
                    if metric is None:
                        raise CollectionGap("memory_metric_identity_unresolved")
                    candidates.append(metric)
                    if len(candidates) > 1:
                        raise CollectionGap("memory_metric_ambiguous")
        except CollectionGap as exc:
            output[rid]["reason"] = str(exc)
            continue
        except Exception:
            output[rid]["reason"] = "memory_metric_read_failed"
            continue
        if len(candidates) == 1:
            selected[f"memory{len(selected)}"] = (resource, candidates[0])
    for resource in resources[MAX_RESOURCES:]:
        output[resource["id"]]["reason"] = "memory_metric_resource_cap"
    if not selected:
        return output
    queries = [{"Id": qid, "MetricStat": {"Metric": metric, "Period": PERIOD,
                 "Stat": "Maximum", "Unit": "Percent"}, "ReturnData": True}
               for qid, (_, metric) in selected.items()]
    data = {qid: {"samples": {}, "statuses": [], "valid": True} for qid in selected}
    complete, failure = True, "memory_metric_samples_incomplete"
    try:
        for page in _pages(client, "get_metric_data", {
                "MetricDataQueries": queries, "StartTime": start, "EndTime": end,
                "MaxDatapoints": EXPECTED * len(queries)}, budget):
            rows = page.get("MetricDataResults", [])
            if not isinstance(rows, list) or len(rows) > len(queries):
                raise CollectionGap("memory_metric_payload_cap")
            for row in rows:
                if not isinstance(row, dict) or row.get("Id") not in selected:
                    raise CollectionGap("memory_metric_result_mismatch")
                target = data[row["Id"]]
                target["statuses"].append(row.get("StatusCode"))
                stamps, values = row.get("Timestamps", []), row.get("Values", [])
                if (not isinstance(stamps, list) or not isinstance(values, list)
                        or len(stamps) != len(values) or len(stamps) > EXPECTED):
                    target["valid"] = False
                    continue
                for stamp, value in zip(stamps, values):
                    stamp = _utc(stamp)
                    if (not stamp or not start <= stamp < end or isinstance(value, bool)
                            or not isinstance(value, (int, float)) or not math.isfinite(value)
                            or not 0 <= value <= 100):
                        target["valid"] = False
                        continue
                    bucket = math.floor(stamp.timestamp() / PERIOD) * PERIOD
                    if bucket in target["samples"]:
                        target["valid"] = False
                    else:
                        target["samples"][bucket] = float(value)
    except CollectionGap as exc:
        complete, failure = False, str(exc)
    except Exception:
        complete, failure = False, "memory_metric_read_failed"
    for qid, (resource, metric) in selected.items():
        row = data[qid]
        values = list(row["samples"].values())
        good = (complete and row["valid"] and bool(row["statuses"])
                and all(status == "Complete" for status in row["statuses"])
                and _qualified(row["samples"], start, end))
        summary = {"samples": len(values), "status": "Complete" if good else "incomplete",
                   "unit": "Percent", "namespace": "CWAgent", "metric_name": "mem_used_percent",
                   "dimensions": metric["Dimensions"], "period": PERIOD, "statistic": "Maximum"}
        if values:
            summary.update(min=min(values), max=max(values), mean=sum(values) / len(values))
        output[resource["id"]] = {"complete": good, "metric": summary,
            "sample_ratio": min(1, len(values) / EXPECTED),
            "reason": None if good else failure}
    return output
