"""AWSops v2 P2 — job-type registry. READ/COMPUTE only (no mutate ops until P3 ADR-029 controls).
Each handler: (payload: dict, dry_run: bool) -> (result_dict_or_None, artifact_bytes_or_None).
P2 ships ONE synthetic proof handler ('noop') exercising sleep / memory / optional OOM."""
import os
import time


def _noop(payload, dry_run):
    secs = int(payload.get("sleep_s", 0))
    mb = int(payload.get("alloc_mb", 0))
    if dry_run:
        return {"dry_run": True, "would_sleep_s": secs, "would_alloc_mb": mb}, None
    if secs:
        time.sleep(secs)
    blob = bytearray(mb * 1024 * 1024) if mb else None
    out = {"slept_s": secs, "alloc_mb": mb, "ok": True}
    del blob
    return out, None


def _upload_markdown(md, report_id):
    """[GATE-FIX CRITICAL] The shared worker runners DISCARD the artifact return value
    (worker_lambda.py / fargate_worker.py do `result, _artifact = fn(...)` and drop it; there
    is NO put_object in the worker tier). So _report uploads to S3 itself and returns the URI."""
    import boto3
    bucket = os.environ.get("ARTIFACT_BUCKET")
    if not bucket:
        raise RuntimeError("ARTIFACT_BUCKET not set")
    key = f"diagnosis/{report_id}.md"
    boto3.client("s3", region_name=os.environ.get("AWS_REGION", "ap-northeast-2")).put_object(
        Bucket=bucket, Key=key, Body=md.encode("utf-8"), ContentType="text/markdown")
    return f"s3://{bucket}/{key}"


_DOCX_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def _upload_bytes(body, key, content_type):
    import boto3
    bucket = os.environ.get("ARTIFACT_BUCKET")
    if not bucket:
        raise RuntimeError("ARTIFACT_BUCKET not set")
    boto3.client("s3", region_name=os.environ.get("AWS_REGION", "ap-northeast-2")).put_object(
        Bucket=bucket, Key=key, Body=body, ContentType=content_type)
    return f"s3://{bucket}/{key}"


def _export_artifacts(md, report_id):
    """Best-effort DOCX+PDF next to the report markdown (diagnosis/{id}.docx|pdf). A generation/upload
    failure (e.g. chromium crash) is logged and SKIPPED — the markdown is the source of truth and the
    report status must never depend on export success."""
    import traceback
    from diagnosis import exporters
    for ext, ct, fn in (("docx", _DOCX_CT, exporters.to_docx), ("pdf", "application/pdf", exporters.to_pdf)):
        try:
            _upload_bytes(fn(md), f"diagnosis/{report_id}.{ext}", ct)
        except Exception:  # noqa: BLE001 — export is non-fatal
            print(f"[export] {ext} generation failed (non-fatal):\n{traceback.format_exc()}")


def _report(payload, dry_run):
    """AI Diagnosis report. payload: {account, tier, requested_by, report_id}.
    The BFF creates the diagnosis_reports row (running) and passes report_id — this fixes the
    worker_job_id FK (handlers receive only `payload`, never job_id) and the UI race. _report
    uploads the markdown to S3 itself and writes artifact_uri. Read-only AWS data sources."""
    account = str(payload.get("account", ""))
    tier = payload.get("tier", "mid")
    model = payload.get("model", "sonnet")  # deep-tier may select 'opus'; resolver pins others to sonnet
    requested_by = payload.get("requested_by", "unknown")
    report_id = payload.get("report_id")
    if dry_run:
        return {"dry_run": True, "would_diagnose": account, "tier": tier}, None
    import db as wdb
    from diagnosis import db as ddb
    from diagnosis import report as rpt
    import traceback
    conn = wdb.connect()
    try:  # [PR#37 review CRITICAL] always release the pg8000 connection (was leaked every call → Aurora pool exhaustion under retries)
        # Fallback: if BFF didn't pre-create (older enqueue), create now (worker_job_id stays NULL).
        if not report_id:
            report_id = ddb.create_report(conn, worker_job_id=None, tier=tier, requested_by=requested_by)
        try:
            # A4 (V1 parity): stream per-section progress to diagnosis_reports as generate() advances.
            on_progress = (lambda c, t, s, p: ddb.update_progress(
                conn, report_id, current=c, total=t, section=s, phase=p))
            scope = payload.get("scope") or "self"
            md, summary, sources_used = rpt.generate(
                conn, account, tier, report_id=report_id, on_progress=on_progress, model=model,
                scope=scope)
            artifact_uri = _upload_markdown(md, report_id)
            _export_artifacts(md, report_id)  # best-effort DOCX+PDF; never fails the report
            try:  # auto title + suggested tags — best-effort, never fails the report
                meta = rpt.make_title_and_tags(md)
            except Exception:  # noqa: BLE001 — defensive (make_title_and_tags already swallows)
                meta = {"title": None, "tags": []}
            status = "partial" if summary.get("degraded") else "succeeded"
            ddb.finish_report(conn, report_id, status=status, sources_used=sources_used,
                              summary=summary, artifact_uri=artifact_uri,
                              title=meta["title"], tags=meta["tags"])
            # V1 parity: publish to the diagnosis SNS topic on EVERY completion (manual + scheduled) —
            # v1 notifies unconditionally; the destination/opt-out (email/Slack/Lambda fan-out) lives on
            # the SNS subscription side. Best-effort + flag-gated by the topic env (empty when
            # diagnosis_notify_enabled=false → no-op). `scheduled` only flavors the message wording.
            #
            # GOVERNANCE (ADR-040/041 external-comms): widening the trigger from scheduler-only to any
            # completed run (incl. an authed non-admin's manual run) is governed by, in order:
            #   1. diagnosis_notify_enabled — flag-OFF by default (no topic env → this block is a no-op);
            #   2. admin-curated recipients — subscriber add/remove is admin-only AND each address must
            #      complete the SNS email-confirmation handshake, so the *recipient set* is admin-vetted
            #      regardless of who triggers the run;
            #   3. owner directive — v1 parity (notify on every completion) is an explicit product call.
            # The published content (executive-summary teaser + deep link) and the recipient set are
            # IDENTICAL to the already-shipped scheduled path — this change widens *who can trigger*, not
            # *what is exposed or to whom* — so it adds no new DLP/redaction surface over the prior code.
            topic = os.environ.get("DIAGNOSIS_SNS_TOPIC_ARN", "")
            if topic:
                from diagnosis import notify
                domain = os.environ.get("APP_DOMAIN", "")
                url = f"https://{domain}/ai-diagnosis?report={report_id}" if domain else ""
                notify.publish_report(topic, meta.get("title"), md, url,
                                      region=os.environ.get("AWS_REGION"),
                                      scheduled=bool(payload.get("scheduled")))
            return {"report_id": report_id, "status": status, "artifact_uri": artifact_uri}, md.encode("utf-8")
        except Exception as e:  # noqa: BLE001
            print(traceback.format_exc())  # full trace → CloudWatch logs only
            # [review MINOR] str(e) to the DB (the error field reaches the client via /api/diagnosis/[id])
            ddb.finish_report(conn, report_id, status="failed", error=str(e))
            raise
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass


def _compliance(payload, dry_run):
    """CIS benchmark via Powerpipe (Fargate). payload: {benchmark, run_id, requested_by, scope}.
    The BFF pre-creates the compliance_runs row (run_id) — same pattern as _report (fixes the
    worker_job_id linkage + the UI race). Read-only: Powerpipe only QUERIES the Steampipe FDW."""
    import compliance
    benchmark = str(payload.get("benchmark", ""))
    run_id = payload.get("run_id")
    if dry_run:
        return {"dry_run": True, "would_run": benchmark}, None
    if benchmark not in compliance.ALLOWED:
        raise ValueError(f"benchmark not allowed: {benchmark!r}")
    import traceback
    import db as wdb
    conn = wdb.connect()
    try:  # always release the pg8000 connection (Aurora pool exhaustion guard, per _report)
        try:
            scope = str(payload.get("scope") or "all")
            doc = compliance.run_powerpipe(benchmark, compliance.steampipe_db_url(), scope)
            totals, controls = compliance.parse_powerpipe_json(doc)
            compliance.persist(conn, run_id, totals, controls)
            return {"run_id": run_id, "benchmark": benchmark, **totals}, None
        except Exception as e:  # noqa: BLE001 — surface on the run row, then re-raise (SFN Catch → failed)
            print(traceback.format_exc())  # full trace → CloudWatch only
            if run_id is not None:
                # Defense-in-depth: scrub any Steampipe password before persisting/surfacing the error.
                conn.run("UPDATE compliance_runs SET status='failed', finished_at=now(), error_message=:e WHERE id=:id",
                         e=compliance._scrub(str(e))[:2000], id=run_id)
            raise
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass


def _datasource_index(payload, dry_run):
    """(Re)build pre-computed diagnostic signals for one datasource (Prometheus/Mimir). Short + read-only
    (reads the cached schema, writes datasource_diag_signals) → lambda runtime. payload: {integration_id}."""
    iid = payload.get("integration_id")
    if dry_run:
        return {"dry_run": True, "would_index": iid}, None
    import db as wdb
    import datasource_index as dsi
    conn = wdb.connect()
    try:
        return dsi.run(payload, conn), None
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass


def _insight(payload, dry_run):
    """AI Insights generation (K8s/CloudWatch/cost → LLM bullets → ai_insights). Short + read-only →
    lambda runtime. Runtime-gated on AI_INSIGHTS_ENABLED inside insight.job.run."""
    if dry_run:
        return {"dry_run": True, "would_generate_insight": True}, None
    import db as wdb
    from insight import job as ijob
    conn = wdb.connect()
    try:
        return ijob.run(payload, conn), None
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass


# type -> (handler, runtime). runtime drives SFN routing (lambda<15min / fargate long+heavy).
REGISTRY = {
    "noop":             (_noop, "lambda"),
    "noop-heavy":       (_noop, "fargate"),
    "report":           (_report, "fargate"),
    "compliance":       (_compliance, "fargate"),
    "datasource_index": (_datasource_index, "lambda"),
    "insight":          (_insight, "lambda"),
}


def is_allowed(type_):
    return type_ in REGISTRY


def runtime_for(type_):
    return REGISTRY[type_][1]
