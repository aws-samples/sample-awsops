"""EventBridge-scheduled (hourly). Scans report_schedules for due rows and enqueues an AI-diagnosis
`report` job per due schedule — the v2 equivalent of v1's in-process report-scheduler.

Read-only effect on AWS: it only enqueues a diagnosis job (the diagnosis itself is read-only).
Idempotent against double-fire: the due rows are CLAIMED atomically by advancing next_run_at in the same
UPDATE … RETURNING (a concurrent invocation sees the advanced next_run_at and claims 0 rows). A per-row
enqueue failure is logged and does NOT block the other due schedules. Enqueue is the canonical dual-write:
db.insert_job (worker_jobs ledger) + an SQS message identical to the BFF's enqueueJob, so the existing
dispatcher→Step-Functions→Fargate path runs the report. The Fargate `_report` handler self-creates the
diagnosis_reports row when no report_id is supplied, so this dispatcher does not pre-create it.
"""
import json
import os
import uuid

import boto3

import db

QUEUE_URL = os.environ.get("JOBS_QUEUE_URL", "")
HOST_ACCOUNT = os.environ.get("AWS_ACCOUNT_ID", "")  # account to diagnose (single-account host)
_sqs = boto3.client("sqs", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))

# Advance-first claim: add one interval to next_run_at for every enabled+due row, RETURNING the claimed rows.
_CLAIM_SQL = (
    "UPDATE report_schedules "
    "SET last_run_at = now(), next_run_at = now() + (CASE schedule_type "
    "  WHEN 'weekly' THEN interval '7 days' "
    "  WHEN 'biweekly' THEN interval '14 days' "
    "  ELSE interval '1 month' END) "
    "WHERE enabled = true AND next_run_at <= now() "
    "RETURNING user_sub, schedule_type, config"
)


def _coerce_config(config):
    """pg8000 usually returns JSONB as a dict, but tolerate a JSON string (and anything else) so a row can
    never throw AFTER the claim already advanced next_run_at (that would silently drop the scheduled run)."""
    if isinstance(config, str):
        try:
            return json.loads(config)
        except (ValueError, TypeError):
            return {}
    return config if isinstance(config, dict) else {}


def _create_report(conn, tier, requested_by, model):
    """Pre-create a visible 'running' diagnosis_reports row mirroring the BFF createReport — including
    `model` (UI metadata) and `parent_report_id` (diff lineage = most-recent SUCCEEDED report of the same
    tier) — so a scheduled run is tracked, shows its model, supports regression diff, and a pre-_report
    failure is not invisible."""
    rows = conn.run(
        "INSERT INTO diagnosis_reports (worker_job_id, tier, requested_by, status, parent_report_id, model) "
        "VALUES (NULL, :t, :rb, 'running', "
        "  (SELECT id FROM diagnosis_reports WHERE tier = :t AND status = 'succeeded' AND deleted_at IS NULL "
        "   ORDER BY created_at DESC LIMIT 1), :m) RETURNING id",
        t=tier, rb=requested_by, m=model,
    )
    return rows[0][0]


def _enqueue_report(conn, user_sub, config):
    cfg = _coerce_config(config)
    account = cfg.get("account") or HOST_ACCOUNT
    tier = cfg.get("tier", "mid")
    # only the deep tier may select opus; light/mid are pinned to sonnet (matches the BFF/worker resolver).
    model = "opus" if (tier == "deep" and cfg.get("model") == "opus") else "sonnet"
    report_id = _create_report(conn, tier, user_sub, model)  # visible 'running' row first
    job_id = str(uuid.uuid4())
    payload = {
        "account": account,
        "tier": tier,
        "model": model,
        "requested_by": user_sub,
        "report_id": report_id,  # _report uses this → no duplicate self-created row
        "scheduled": True,
    }
    db.insert_job(conn, job_id, "report", payload)  # durable ledger row (FK target for the link)
    conn.run("UPDATE diagnosis_reports SET worker_job_id = :jid WHERE id = :rid", jid=job_id, rid=report_id)
    try:
        _sqs.send_message(
            QueueUrl=QUEUE_URL,
            MessageBody=json.dumps({"job_id": job_id, "type": "report", "payload": payload, "dry_run": False}),
        )
    except Exception:
        # Ledger row + report exist but no SFN trigger — mark the report failed (mirrors the BFF's
        # EnqueueDeliveryError handling) so it never appears stuck 'running'. Re-raise → counted as failed.
        conn.run(
            "UPDATE diagnosis_reports SET status = 'failed', error = 'enqueue delivery failed' WHERE id = :rid",
            rid=report_id,
        )
        raise
    return job_id


def lambda_handler(_event, _ctx):
    if not QUEUE_URL:
        raise RuntimeError("JOBS_QUEUE_URL is required for schedule_dispatcher")  # fail loud, not silent no-op
    conn = db.connect()
    try:
        due = conn.run(_CLAIM_SQL)  # atomic claim+advance
        enqueued, failed = [], []
        for row in due or []:
            user_sub, _schedule_type, config = row[0], row[1], row[2]
            try:
                enqueued.append(_enqueue_report(conn, user_sub, config))
            except Exception as exc:  # noqa: BLE001 — one bad row must not block the rest
                print(f"schedule_dispatcher: enqueue failed for {user_sub}: {exc}")
                failed.append(user_sub)
        out = {"due": len(due or []), "enqueued": len(enqueued), "failed": len(failed)}
        print(f"schedule_dispatcher: {out}")
        return out
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass
