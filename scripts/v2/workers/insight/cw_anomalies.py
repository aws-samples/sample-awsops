"""CloudWatch anomaly collector for AI Insights — alarms currently in ALARM state.

Read-only (cloudwatch:DescribeAlarms). Emits non-PII metadata only: alarm name, namespace, dimension
NAMES (not values), and the state reason (a CloudWatch-generated threshold string, no user data).
Bounded pagination, never raises. `cw_client` injectable for tests.
"""
import logging
import os

_MAX_ITEMS = 12
_MAX_PAGES = 5


def _cw_client():
    import boto3
    return boto3.client("cloudwatch", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))


def _item(a, composite=False):
    dims = [d.get("Name") for d in (a.get("Dimensions") or []) if d.get("Name")]  # NAMES only (no values)
    ns = a.get("Namespace") or ("composite" if composite else None)
    # spec §5: alarm name·namespace·dimension NAMES only. StateReason is NOT exported — it embeds
    # datapoint/threshold VALUES (e.g. "[85.0] > threshold (80.0)") which the value-redaction rule forbids.
    return {
        "severity": "warning",
        "title": f"CloudWatch 알람: {a.get('AlarmName', '?')}",
        "detail": f"ALARM 상태{f' ({ns})' if ns else ''}",
        "refs": {"alarm": a.get("AlarmName"), "namespace": ns, "dimensions": dims},
    }


def collect_cw_anomalies(cw_client=None):
    """Return {source:'cloudwatch', items:[...], notes}. Never raises."""
    cw_client = cw_client or _cw_client()
    items, token, pages = [], None, 0
    try:
        while pages < _MAX_PAGES:
            kw = {"StateValue": "ALARM", "MaxRecords": 100}
            if token:
                kw["NextToken"] = token
            resp = cw_client.describe_alarms(**kw)
            for a in (resp.get("MetricAlarms") or []):
                items.append(_item(a))
            for a in (resp.get("CompositeAlarms") or []):
                items.append(_item(a, composite=True))
            token = resp.get("NextToken")
            pages += 1
            if not token:
                break
    except Exception as e:  # noqa: BLE001
        logging.warning("[insight.cw] describe_alarms failed: %s", e)
        return {"source": "cloudwatch", "items": [], "notes": f"cloudwatch error: {type(e).__name__}", "ok": False}
    return {"source": "cloudwatch", "items": items[:_MAX_ITEMS], "notes": "", "ok": True}
