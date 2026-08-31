"""EventBridge-scheduled (~15min). Batches every diagnosis_reports row with notified_at IS NULL
into ONE SNS email instead of the prior one-email-per-completion path (see diagnosis/notify.py's
module docstring for why). A batch of exactly one report reuses the original full executive-summary
format (build_message/publish_report) — the common case, since digests are short (~15min) and
usually catch one completion; a batch of several uses the compact digest format with a short
per-report teaser. Read-only on all diagnosis data sources except the notified_at stamp; s3:GetObject
(scoped to diagnosis/*, best-effort — a fetch failure just means no teaser) and sns:Publish are the
only external actions. No-op (no publish, no DB write) when there is nothing pending."""
import os
import re

import boto3

import db
from diagnosis import db as ddb
from diagnosis import notify

_DIGEST_TEASER_LIMIT = 200  # short per-report one-liner in a multi-report digest — see notify.py

_s3 = None


def _s3_client():
    global _s3
    if _s3 is None:
        _s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION"))
    return _s3


def _fetch_markdown(artifact_uri):
    """Best-effort fetch of a report's markdown from its s3://bucket/key artifact_uri. Returns ""
    on any failure (missing URI, deleted object, permission issue) — a teaser is a nice-to-have,
    never worth failing the digest run over."""
    if not artifact_uri:
        return ""
    m = re.match(r"^s3://([^/]+)/(.+)$", artifact_uri)
    if not m:
        return ""
    try:
        body = _s3_client().get_object(Bucket=m.group(1), Key=m.group(2))["Body"].read()
        return body.decode("utf-8")
    except Exception as e:  # noqa: BLE001 — best-effort; never fail the digest run
        print(f"[diagnosis_digest] markdown fetch failed for {artifact_uri} (non-fatal): {e}")
        return ""


def lambda_handler(_event, _ctx):
    conn = db.connect()
    try:
        pending = ddb.list_pending_notifications(conn)
        if not pending:
            return {"digested": 0}
        domain = os.environ.get("APP_DOMAIN", "")
        topic = os.environ.get("DIAGNOSIS_SNS_TOPIC_ARN", "")
        region = os.environ.get("AWS_REGION")

        def url_for(report_id):
            return f"https://{domain}/ai-diagnosis?report={report_id}" if domain else ""

        if topic:
            if len(pending) == 1:
                r = pending[0]
                md = _fetch_markdown(r["artifact_uri"])
                notify.publish_report(topic, r["title"], md, url_for(r["id"]), region=region)
            else:
                reports = []
                for r in pending:
                    md = _fetch_markdown(r["artifact_uri"])
                    teaser = notify.summarize(md, limit=_DIGEST_TEASER_LIMIT) if md else ""
                    reports.append({"title": r["title"], "report_url": url_for(r["id"]), "teaser": teaser})
                notify.publish_digest(topic, reports, region=region)
        # Stamp notified_at regardless of whether a topic is configured (flag-off / no topic still
        # drains the backlog so a later flag-on doesn't suddenly email a huge historical batch).
        ddb.mark_notified(conn, [r["id"] for r in pending])
        return {"digested": len(pending)}
    finally:
        conn.close()
