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
        # Gap L178: admin pause toggle (app_settings) — paused behaves exactly like a missing
        # topic: skip the publish but still stamp notified_at (reports completed while paused
        # are dropped from email, never queued for a stale blast on re-enable). A flag-read
        # failure fails OPEN — a broken settings read must not silently kill notifications.
        # Read BEFORE the nothing-pending early return so the response shape never lies.
        paused = False
        flag_read_failed = False
        try:
            rows = conn.run("SELECT value FROM app_settings WHERE key = 'diagnosis_notify_paused'")
            paused = bool(rows) and str(rows[0][0]).strip().lower() == "true"
        except Exception as e:  # noqa: BLE001 — fail-open by design
            flag_read_failed = True
            print(f"[diagnosis_digest] pause-flag read failed (fail-open, publishing): {e}")

        pending = ddb.list_pending_notifications(conn)
        if not pending:
            return {"digested": 0, "paused": paused}
        domain = os.environ.get("APP_DOMAIN", "")
        topic = os.environ.get("DIAGNOSIS_SNS_TOPIC_ARN", "")
        region = os.environ.get("AWS_REGION")
        if paused:
            print(f"[diagnosis_digest] notifications paused by admin - skipping publish for {len(pending)} report(s)")

        def url_for(report_id):
            return f"https://{domain}/ai-diagnosis?report={report_id}" if domain else ""

        message_id = None
        if topic and not paused:
            if len(pending) == 1:
                r = pending[0]
                md = _fetch_markdown(r["artifact_uri"])
                message_id = notify.publish_report(topic, r["title"], md, url_for(r["id"]), region=region)
            else:
                reports = []
                for r in pending:
                    md = _fetch_markdown(r["artifact_uri"])
                    teaser = notify.summarize(md, limit=_DIGEST_TEASER_LIMIT) if md else ""
                    reports.append({"title": r["title"], "report_url": url_for(r["id"]), "teaser": teaser})
                message_id = notify.publish_digest(topic, reports, region=region)
        # Stamp notified_at regardless of whether a topic is configured (flag-off / no topic still
        # drains the backlog so a later flag-on doesn't suddenly email a huge historical batch).
        # The DURABLE per-report delivery record is notify_outcome in Aurora (gap L178 round-3:
        # 'was report N ever emailed?' must outlive the 14-day log retention — the Lambda return
        # value is async-invoked and written nowhere).
        # Outcome precedence: no topic beats paused (nothing could have been sent either way);
        # 'emailed' requires a REAL MessageId — publish_report/digest swallow errors and return
        # None, and a throttled/denied publish must never be durably recorded as delivered.
        # A fail-open run (flag read failed) records its own marker so a pause/publish
        # divergence stays visible in the durable record.
        if not topic:
            outcome = "skipped_no_topic"
        elif paused:
            outcome = "dropped_paused"
        elif message_id is None:
            outcome = "publish_failed"
        else:
            outcome = "emailed_failopen" if flag_read_failed else "emailed"
        ddb.mark_notified(conn, [r["id"] for r in pending], outcome=outcome)
        if paused:
            # logged AFTER the stamp succeeded — an audit line must not precede its record.
            for r in pending:
                print(f"[diagnosis_digest] report id={r.get('id')} title={r.get('title')!r} DROPPED (paused)")
        return {"digested": len(pending), "paused": paused}
    finally:
        conn.close()
