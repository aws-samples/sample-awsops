"""SNS email notification for AI-diagnosis reports.

A periodic digest Lambda (diagnosis_digest.py, ~15min) batches every diagnosis_reports row with
notified_at IS NULL into ONE plaintext email (title + deep link per report) and publishes it to one
dedicated SNS topic; SNS fans it out to the confirmed email subscribers (the mailing list, managed
in-app via /api/diagnosis/subscribers), or to whatever else is subscribed (Slack/Lambda/HTTPS) — the
destination is decided on the subscription side. (Prior design published one email per completed
report, unconditionally — replaced by the digest batch to avoid flooding the inbox when many reports
finish in a short window; build_message/publish_report are kept for reuse, not on the hot path.)

Governance (ADR-040/041): the ONLY write here is sns:Publish to a single, terraform-provisioned, IAM-
scoped topic — a governed external-comms write, NOT the permanently-frozen AWS-resource-mutation class.
Read-only on all diagnosis data sources. Best-effort by contract: a publish failure (throttle, bad
config, SNS outage) is logged and swallowed — it must NEVER fail or downgrade the report/digest run.
"""
import re

import boto3

_MAX_SUMMARY = 1200
# Per-entry teaser inside a multi-report digest — much shorter than the single-report _MAX_SUMMARY
# (1200) since a digest can list several reports and each one only needs a one-liner, not a full
# executive summary (that's what the deep link is for).
_DIGEST_TEASER_LIMIT = 200
# SNS requires an ASCII Subject (≤100 chars, no leading whitespace/newlines). The Korean title goes in
# the body — a non-ASCII Subject is rejected by SNS (→ publish fails → no email). Keep this ASCII.
_SUBJECT = "[AWSops] AI Diagnosis Report"

_sns = None


def _client(region=None):
    global _sns
    if _sns is None:
        _sns = boto3.client("sns", region_name=region) if region else boto3.client("sns")
    return _sns


def _strip_markdown(text):
    """Markdown → readable plaintext for an SNS email body (email is plaintext, not HTML)."""
    out = []
    for line in text.splitlines():
        s = line.rstrip()
        # GFM table separator row (`| --- | :--: |`) carries no info in plaintext → drop it.
        if re.match(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$", s):
            continue
        s = re.sub(r"^#{1,6}\s+", "", s)            # heading markers
        s = s.replace("|", "  ")                     # table cell pipes → spaces
        s = re.sub(r"\*\*(.+?)\*\*", r"\1", s)      # bold
        s = re.sub(r"`([^`]+)`", r"\1", s)           # inline code
        out.append(s)
    plain = re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip()
    return plain


def summarize(md, limit=_MAX_SUMMARY):
    """Extract the executive-summary (the first `## ` section) as a plaintext teaser, truncated."""
    if not md:
        return ""
    m = re.search(r"(?m)^##\s+.*$", md)
    body = md[m.start():] if m else md
    # cut at the next section header (skip the leading '## ' we just matched)
    nxt = re.search(r"(?m)^##\s+", body[3:])
    if nxt:
        body = body[: nxt.start() + 3]
    plain = _strip_markdown(body)
    if len(plain) > limit:
        plain = plain[:limit].rstrip() + " …"
    return plain


def build_message(title, md, report_url, scheduled=False):
    """Return (subject, body) for the SNS publish. Subject is ASCII; title/teaser/link in the body.
    `scheduled` only flavors the footer (auto-schedule vs on-demand run)."""
    heading = (title or "AI 진단 리포트").strip()
    teaser = summarize(md)
    parts = [heading, "=" * 40, ""]
    if teaser:
        parts += [teaser, ""]
    parts += ["-" * 40, "전체 리포트 보기:"]
    if report_url:
        parts.append(report_url)
    origin = ("AWSops 자동 진단 스케줄에 의해" if scheduled
              else "AWSops 진단 완료 시")
    parts += [
        "",
        f"이 메일은 {origin} 발송되었습니다.",
        "수신 거부 / 구독 관리는 관리자에게 문의하세요.",
    ]
    return _SUBJECT, "\n".join(parts)


def publish_report(topic_arn, title, md, report_url, region=None, scheduled=False):
    """Best-effort publish to the diagnosis SNS topic. Returns the MessageId, or None on any
    failure / when no topic is configured. NEVER raises (notification must not fail the report).
    Kept for reuse (build_message/summarize); the per-report auto-publish call site was removed —
    see build_digest_message/publish_digest for the current notify path."""
    if not topic_arn:
        return None
    try:
        subject, body = build_message(title, md, report_url, scheduled=scheduled)
        resp = _client(region).publish(TopicArn=topic_arn, Subject=subject, Message=body)
        mid = resp.get("MessageId")
        kind = "scheduled" if scheduled else "manual"
        print(f"[notify] published {kind} report → {topic_arn} (MessageId={mid})")
        return mid
    except Exception as e:  # noqa: BLE001 — notification is best-effort; never fail the report
        print(f"[notify] publish failed (non-fatal): {e}")
        return None


def build_digest_message(reports):
    """Return (subject, body) for a batched digest covering multiple completed reports.
    `reports` is a list of {"title": str, "report_url": str, "teaser": str|None} dicts, oldest-first.
    `teaser` (caller-supplied, e.g. via summarize(md, limit=_DIGEST_TEASER_LIMIT)) is a short one-line
    excerpt — omitted when unavailable (e.g. the artifact couldn't be fetched) rather than left blank.
    Skips the scheduled/manual distinction (diagnosis_reports doesn't persist that, and a batch can
    legitimately mix both)."""
    n = len(reports)
    parts = [f"완료된 진단 리포트 {n}건", "=" * 40, ""]
    for r in reports:
        title = (r.get("title") or "AI 진단 리포트").strip()
        parts.append(f"• {title}")
        teaser = r.get("teaser")
        if teaser:
            parts.append(f"  {teaser}")
        url = r.get("report_url")
        if url:
            parts.append(f"  {url}")
        parts.append("")
    parts += [
        "-" * 40,
        "이 메일은 AWSops 진단 다이제스트(주기 배치)로 발송되었습니다.",
        "수신 거부 / 구독 관리는 관리자에게 문의하세요.",
    ]
    return _SUBJECT, "\n".join(parts)


def publish_digest(topic_arn, reports, region=None):
    """Best-effort publish of a batched digest. Returns the MessageId, or None on any failure /
    when no topic is configured / when `reports` is empty (no digest for zero reports). NEVER
    raises (notification must not fail the digest Lambda's run)."""
    if not topic_arn or not reports:
        return None
    try:
        subject, body = build_digest_message(reports)
        resp = _client(region).publish(TopicArn=topic_arn, Subject=subject, Message=body)
        mid = resp.get("MessageId")
        print(f"[notify] published digest of {len(reports)} report(s) → {topic_arn} (MessageId={mid})")
        return mid
    except Exception as e:  # noqa: BLE001 — notification is best-effort; never fail the digest run
        print(f"[notify] digest publish failed (non-fatal): {e}")
        return None
