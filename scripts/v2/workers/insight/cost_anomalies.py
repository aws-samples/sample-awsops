"""Cost anomaly collector for AI Insights — day-over-day per-service spike detection.

Read-only (Cost Explorer GetCostAndUsage, aggregated $ only — no PII). A service is flagged ONLY when
BOTH the percentage jump and the absolute $ jump exceed the thresholds (suppresses cheap-but-spiky
noise like KMS/SNS). Bounded, never raises. `ce` is injectable for tests.
"""
import datetime
from datetime import timezone
import logging
import os

SPIKE_PCT = 50          # +50% day-over-day, AND
SPIKE_ABS_USD = 10      # +$10 absolute (both required → flag)
LOOKBACK_DAYS = 7
_CRIT_ABS_USD = 100     # absolute increase above this → critical, else warning
_MAX_ITEMS = 8


def _ce_client():
    import boto3
    return boto3.client("ce", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))


def _amount(group):
    try:
        return float(group["Metrics"]["UnblendedCost"]["Amount"])
    except (KeyError, ValueError, TypeError):
        return 0.0


def collect_cost_anomalies(ce=None):
    """Return {source:'cost', items:[{severity,title,detail,refs}], notes}. Never raises."""
    ce = ce or _ce_client()
    try:
        today = datetime.datetime.now(timezone.utc).date()
        # End is EXCLUSIVE in Cost Explorer. Use end=today so the last bucket is YESTERDAY (a completed
        # day), not today (partial/lagged → would make delta negative and silently suppress every spike).
        # days[-1]=yesterday, days[-2]=day-before — both complete → a real day-over-day comparison.
        end = today
        start = end - datetime.timedelta(days=LOOKBACK_DAYS + 1)
        resp = ce.get_cost_and_usage(
            TimePeriod={"Start": start.isoformat(), "End": end.isoformat()},
            Granularity="DAILY", Metrics=["UnblendedCost"],
            GroupBy=[{"Type": "DIMENSION", "Key": "SERVICE"}],
        )
    except Exception as e:  # noqa: BLE001 — read failure must never sink the insight run
        logging.warning("[insight.cost] get_cost_and_usage failed: %s", e)
        return {"source": "cost", "items": [], "notes": f"cost explorer error: {type(e).__name__}", "ok": False}

    days = resp.get("ResultsByTime") or []
    if len(days) < 2:
        return {"source": "cost", "items": [], "notes": "insufficient history for day-over-day", "ok": True}

    prev = {g["Keys"][0]: _amount(g) for g in (days[-2].get("Groups") or [])}
    curr = {g["Keys"][0]: _amount(g) for g in (days[-1].get("Groups") or [])}

    items = []
    for svc, now in curr.items():
        before = prev.get(svc, 0.0)
        delta = now - before
        if delta < SPIKE_ABS_USD:
            continue
        pct = (delta / before * 100) if before > 0 else float("inf")
        if pct < SPIKE_PCT:
            continue
        sev = "critical" if delta >= _CRIT_ABS_USD else "warning"
        pct_txt = "신규" if before == 0 else f"+{pct:.0f}%"
        items.append({
            "severity": sev,
            "title": f"비용 급증: {svc}",
            "detail": f"전일 ${before:.2f} → ${now:.2f} ({pct_txt}, +${delta:.2f})",
            "refs": {"service": svc},
        })
    items.sort(key=lambda i: 0 if i["severity"] == "critical" else 1)
    return {"source": "cost", "items": items[:_MAX_ITEMS], "notes": "", "ok": True}
