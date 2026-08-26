"""K8s events collector for AI Insights — recent notable Warning events per onboarded EKS cluster.

Read-only LIST of core/v1 Events via the Kubernetes API using the presigned-STS `k8s-aws-v1.` bearer
token (the SAME pattern as agent/lambda/istio_read_mcp.py), over the stdlib (urllib + ssl). Requires
the WORKER role to hold an EKS Access Entry (AmazonEKSViewPolicy) — registered out-of-band by the
cluster owner via scripts/v2/eks/register-insight-access.sh. If absent, the cluster is gracefully
skipped (the insight run continues with CloudWatch + cost).

PII: the event `message` free-text is NEVER exported (it can carry tokens/paths). Only non-PII
metadata — reason, involvedObject kind/name/namespace, cluster, count — is emitted. Never raises.
"""
import base64
import datetime
import json
import logging
import os
import ssl
from datetime import timezone
from urllib.request import Request, urlopen

_WINDOW_S = 3600  # only surface Warning events seen within the last hour (avoid stale events)

# Notable Warning reasons (cadvisor/kubelet/scheduler). OOM is critical; the rest warning.
_CRITICAL_REASONS = {"OOMKilling", "OOMKilled"}
_NOTABLE_REASONS = _CRITICAL_REASONS | {
    "FailedScheduling", "BackOff", "CrashLoopBackOff", "Failed", "Unhealthy",
    "FailedMount", "Evicted", "NodeNotReady", "FailedCreatePodSandBox",
}
_MAX_PER_CLUSTER = 25
_MAX_TOTAL = 40


def _clusters():
    return [c.strip() for c in (os.environ.get("ONBOARD_EKS_CLUSTERS") or "").split(",") if c.strip()]


def _is_recent(e, now=None):
    """True if the event's last-seen time is within _WINDOW_S (or no timestamp → keep, conservative)."""
    ts = e.get("lastTimestamp") or e.get("eventTime") or (e.get("series") or {}).get("lastObservedTime")
    if not ts:
        return True
    try:
        dt = datetime.datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        now = now or datetime.datetime.now(timezone.utc)
        return (now - dt).total_seconds() <= _WINDOW_S
    except (ValueError, TypeError):
        return True


def _parse_events(cluster, events, now=None):
    """Aggregate notable, RECENT Warning events into non-PII items, keyed by (reason, kind, namespace)."""
    agg = {}
    for e in events or []:
        if not isinstance(e, dict) or e.get("type") != "Warning":
            continue
        reason = e.get("reason")
        if reason not in _NOTABLE_REASONS:
            continue
        if not _is_recent(e, now):
            continue
        obj = e.get("involvedObject") or {}
        kind, name, ns = obj.get("kind"), obj.get("name"), obj.get("namespace")
        key = (reason, kind, ns)
        try:
            cnt = int(e.get("count") or 1)
        except (TypeError, ValueError):
            cnt = 1
        if key not in agg:
            agg[key] = {
                "severity": "critical" if reason in _CRITICAL_REASONS else "warning",
                # refs key on (reason, kind, namespace) — an aggregate over potentially many objects, so
                # NO single `name` (would mislabel the group + leak `None` when absent). count carries scale.
                "refs": {"cluster": cluster, "namespace": ns, "kind": kind, "reason": reason, "count": 0},
            }
        agg[key]["refs"]["count"] += cnt
    items = []
    for v in agg.values():
        r = v["refs"]
        v["title"] = f"K8s {r['reason']}: {r['kind']} in {r['namespace']} (×{r['count']})"
        v["detail"] = f"{r['cluster']}: {r['reason']} on {r['kind']} in namespace {r['namespace']}"  # no message (PII)
        items.append(v)
    items.sort(key=lambda i: (0 if i["severity"] == "critical" else 1, -i["refs"]["count"]))
    return items[:_MAX_PER_CLUSTER]


# ── live k8s API session (presigned-STS), mirrors istio_read_mcp ─────────────────────────────────
def _default_getter(cluster):
    """Resolve the cluster k8s API + token and LIST Warning events. Raises on auth/HTTP error (caller skips)."""
    import boto3
    from botocore.signers import RequestSigner
    region = os.environ.get("AWS_REGION", "ap-northeast-2")
    eks = boto3.client("eks", region_name=region)
    c = eks.describe_cluster(name=cluster)["cluster"]
    endpoint, ca = c["endpoint"], c["certificateAuthority"]["data"]
    sts = boto3.client("sts", region_name=region)
    signer = RequestSigner(sts.meta.service_model.service_id, region, "sts", "v4",
                           sts._request_signer._credentials, sts._request_signer._event_emitter)
    signed = signer.generate_presigned_url(
        {"method": "GET",
         "url": f"https://sts.{region}.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15",
         "body": {}, "headers": {"x-k8s-aws-id": cluster}, "context": {}},
        region_name=region, expires_in=60, operation_name="")
    token = "k8s-aws-v1." + base64.urlsafe_b64encode(signed.encode()).rstrip(b"=").decode()
    ctx = ssl.create_default_context(cadata=base64.b64decode(ca).decode())
    req = Request(endpoint + "/api/v1/events?fieldSelector=type%3DWarning&limit=200",
                  headers={"Authorization": f"Bearer {token}"})
    with urlopen(req, timeout=10, context=ctx) as r:  # noqa: S310 — fixed EKS https endpoint
        return json.loads(r.read().decode()).get("items", [])


def collect_k8s_events(clusters=None, getter=None):
    """Return {source:'k8s', items:[...], notes}. Never raises; per-cluster errors skip gracefully."""
    clusters = clusters if clusters is not None else _clusters()
    if not clusters:
        # not an error — the feature simply has no clusters to read (k8s signal absent, not failed)
        return {"source": "k8s", "items": [], "notes": "no onboarded clusters (ONBOARD_EKS_CLUSTERS empty)", "ok": True}
    getter = getter or _default_getter
    items, skipped = [], []
    for c in clusters:
        try:
            items.extend(_parse_events(c, getter(c)))
        except Exception as e:  # noqa: BLE001 — access-entry missing / HTTP / token → skip this cluster
            logging.warning("[insight.k8s] cluster %s skipped: %s", c, e)
            skipped.append(c)
    items.sort(key=lambda i: 0 if i["severity"] == "critical" else 1)
    notes = (f"skipped clusters: {', '.join(skipped)}" if skipped else "")
    # ok=False only when EVERY configured cluster failed to read (total k8s blackout) → counts as a
    # collector failure for the job's degraded/failed status (M2); a partial skip is still ok.
    ok = len(skipped) < len(clusters)
    return {"source": "k8s", "items": items[:_MAX_TOTAL], "notes": notes, "ok": ok}
