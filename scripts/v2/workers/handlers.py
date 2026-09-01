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
    # Report output language (gap L50). Allowlist fail-closed to 'ko' — a bad value must never
    # reach the prompt (the BFF validates too; this is worker-side defense).
    lang = payload.get("lang", "ko")
    if lang not in ("ko", "en", "zh", "ja"):
        lang = "ko"
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
            on_progress = (lambda c, t, s, p, done=None: ddb.update_progress(
                conn, report_id, current=c, total=t, section=s, phase=p, completed=done))
            scope = payload.get("scope") or "self"
            md, summary, sources_used = rpt.generate(
                conn, account, tier, report_id=report_id, on_progress=on_progress, model=model,
                scope=scope, lang=lang)
            artifact_uri = _upload_markdown(md, report_id)
            _export_artifacts(md, report_id)  # best-effort DOCX+PDF; never fails the report
            try:  # auto title + suggested tags — best-effort, never fails the report
                meta = rpt.make_title_and_tags(md, lang)
            except Exception:  # noqa: BLE001 — defensive (make_title_and_tags already swallows)
                meta = {"title": None, "tags": []}
            status = "partial" if summary.get("degraded") else "succeeded"
            ddb.finish_report(conn, report_id, status=status, sources_used=sources_used,
                              summary=summary, artifact_uri=artifact_uri,
                              title=meta["title"], tags=meta["tags"])
            # GOVERNANCE (ADR-040/041 external-comms): notification is no longer published here —
            # a completed report just leaves diagnosis_reports.notified_at NULL. A periodic digest
            # Lambda (diagnosis_digest.py, ~15min) batches everything with notified_at IS NULL into
            # ONE SNS email and stamps notified_at, instead of one email per completion (v1 parity's
            # "notify on every completion, unconditionally" — which floods the inbox when many
            # reports finish in a short window). Recipient set / content scope are unchanged from the
            # prior per-report path (admin-curated, SNS-confirmed subscribers) — only the send timing
            # and batching changed, so no new governance surface.
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
    """(Re)build pre-computed diagnostic signals for one datasource. Short + read-only
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


def _sg_rule_scan(payload, dry_run):
    """SG Rules & Usage daily/manual scan (ADR-019, sg_rule_scan.py). payload:
    {account_id, region, trigger}. Read-only (Role A DescribeSecurityGroupRules/
    DescribeNetworkInterfaces via the reused AWSopsReadOnlyRole; Role B Athena query only via the
    isolated broker Lambda — this handler never assumes AWSopsSgRuleAthenaRole itself). Fargate
    runtime: pagination across every SGR/ENI in an account/region plus one-or-more Athena-broker
    round-trips per day processed can comfortably exceed a lambda-tier budget."""
    account_id = payload.get("account_id")
    region = payload.get("region")
    if dry_run:
        return {"dry_run": True, "would_scan": account_id, "region": region}, None
    import db as wdb
    import sg_rule_scan as sgs
    conn = wdb.connect()
    try:
        return sgs.run(payload, conn), None
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass


def _network_path(payload, dry_run):
    """Network Path Check (BASELINE.md §2 register row — no governing ADR; ADR-019 §Decision
    explicitly excludes this flag, see network_path.py's module docstring for the disambiguation),
    design spec
    docs/superpowers/specs/2026-08-13-network-path-check-design.md). payload: {run_id, definition}
    (definition = the run's immutable definition_snapshot). Read-only: resolve -> discover ->
    verify -> conclude over cached topology + live SG/NACL/route/TGW/VPN/DX/Network Firewall/ELBv2/
    K8s-policy reads (no Reachability Analyzer path creation, no mutation, no active probe).
    Fargate runtime: Kubernetes policy evaluation and multi-account route analysis can exceed a
    short lambda invocation budget (same reasoning as _sg_rule_scan)."""
    run_id = payload.get("run_id")
    if dry_run:
        return {"dry_run": True, "would_run": run_id}, None
    # [L5 docs-consistency + safety fix] A second, structurally independent fail-closed gate at the
    # dispatch site itself — the web BFF gate (web/lib/network-path-gate.ts) and the Terraform count
    # gate (network-path.tf's `local.npc`, which controls whether this env var is even set on the
    # task) are the primary gates, but this handler must not blindly trust that a `network_path`
    # message reaching the worker implies the feature is actually enabled (defense-in-depth,
    # matching the SAME KIND of short-circuit `sg_rule_scan.run()` itself does on
    # `SG_RULE_ATHENA_BROKER_ARN` — that check lives inside sg_rule_scan.py, not in this file).
    if os.environ.get("NETWORK_PATH_CHECK_ENABLED") != "true":
        return {"status": "disabled", "reason": "NETWORK_PATH_CHECK_ENABLED is not set (feature flag off)"}, None
    import db as wdb
    import network_path as npc
    conn = wdb.connect()
    try:
        return npc.run(payload, conn), None
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


def _finops_baseline(payload, dry_run):
    """ADR-020 FinOps baseline-recommendations engine (daily). Read-only Compute Optimizer calls +
    inventory_resources reads -> finops_findings (Cost Explorer/Cost Optimization Hub/Budgets-based
    rules are catalogued as future work — this version calls neither). Fargate runtime (matches the
    ADR's "same Fargate worker as diagnosis" framing; a full Compute Optimizer + LLM-explanation
    pass can run longer than the lambda job's time budget)."""
    if dry_run:
        return {"dry_run": True, "would_run_finops_baseline": True}, None
    import db as wdb
    from finops import engine
    conn = wdb.connect()
    try:
        return engine.run(payload, conn), None
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
    "finops_baseline":  (_finops_baseline, "fargate"),
    "sg_rule_scan":     (_sg_rule_scan, "fargate"),
    "network_path":     (_network_path, "fargate"),
}


def is_allowed(type_):
    return type_ in REGISTRY


def runtime_for(type_):
    return REGISTRY[type_][1]
