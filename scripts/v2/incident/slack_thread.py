"""ADR-034/012 — best-effort secondary Slack thread. PORTED from src/lib/slack-notification.ts
(sendSlackResolvedUpdate(threadTs) + thread_ts reuse), ADAPTED to python + SSM creds. Gated behind
/ops/<project>/writeback/slack/enabled; a no-op when off / unconfigured. Best-effort: never raises."""
import json
import os
import urllib.request

PROJECT = os.environ.get("PROJECT", "awsops-v2")


def _ssm_get(name):
    import boto3
    try:
        return boto3.client("ssm", region_name=os.environ.get("AWS_REGION", "ap-northeast-2")
                            ).get_parameter(Name=name, WithDecryption=True)["Parameter"]["Value"]
    except Exception:
        return None


def post_best_effort(incident_id, body, prior_thread_ts):
    """Post one threaded Slack message (reusing prior_thread_ts if present). Returns the thread_ts
    or None. NEVER raises — Slack is the secondary channel; failure must not block anything."""
    if _ssm_get(f"/ops/{PROJECT}/writeback/slack/enabled") != "true":
        return prior_thread_ts
    webhook = _ssm_get(f"/ops/{PROJECT}/writeback/slack/webhook")
    if not webhook:
        return prior_thread_ts
    try:
        payload = {"text": body["title"][:3000]}
        if prior_thread_ts:
            payload["thread_ts"] = prior_thread_ts   # reuse the persistent thread (ADR-012 threadTs)
        req = urllib.request.Request(webhook, data=json.dumps(payload).encode("utf-8"),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            resp.read()
        return prior_thread_ts   # incoming-webhook mode doesn't return a new ts; reuse the prior
    except Exception:
        return prior_thread_ts
