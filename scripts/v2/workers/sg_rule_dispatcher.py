"""SG Rules & Usage — daily dispatcher (EventBridge-scheduled). Creates ONE internal `sg_rule_scan`
job per enabled `sg_flow_sources` row. Same enqueue pattern as schedule_dispatcher.py: db.insert_job
(worker_jobs ledger) + an SQS message identical to the web BFF's enqueueJob — the existing
dispatcher -> Step Functions -> Fargate path runs the scan.

The generic `POST /api/jobs` rejects 'sg_rule_scan' (web/app/api/jobs/route.ts's fixed ALLOWED
set). This dispatcher, and the admin-only POST /api/sg/rules/refresh route (which calls
lib/jobs.ts's enqueueJob directly, the same internal path), are the ONLY two places that ever
enqueue this job type — per the design spec's Daily pipeline section.
"""
import json
import os
import uuid

import boto3

import db

QUEUE_URL = os.environ.get("JOBS_QUEUE_URL", "")
_sqs = boto3.client("sqs", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))


def _enqueue_one(conn, source_row, trigger):
    account_id, region = source_row[0], source_row[1]
    job_id = str(uuid.uuid4())
    payload = {"account_id": account_id, "region": region, "trigger": trigger}
    db.insert_job(conn, job_id, "sg_rule_scan", payload, requested_by=None)
    try:
        _sqs.send_message(QueueUrl=QUEUE_URL, MessageBody=json.dumps({
            "job_id": job_id, "type": "sg_rule_scan", "payload": payload, "dry_run": False,
        }))
    except Exception as e:  # noqa: BLE001
        # MINOR fix: an SQS send failure AFTER db.insert_job must not leave the ledger row
        # orphaned as `queued` forever (EventBridge won't retry this Lambda invocation on its own
        # schedule for another 24h, and nothing else would ever mark this specific row terminal) —
        # mark it `failed` immediately so the reaper/API/UI see a real terminal state instead of a
        # silently-stuck queued row.
        db.finish_job(conn, job_id, "failed", error=f"sqs send_message failed: {e}")
        raise
    return job_id


def lambda_handler(_event, _ctx):
    conn = db.connect()
    try:
        rows = conn.run("SELECT account_id, region FROM sg_flow_sources WHERE enabled")
        enqueued = []
        failed = []
        for row in rows:
            try:
                job_id = _enqueue_one(conn, row, trigger="daily")
                enqueued.append({"account_id": row[0], "region": row[1], "job_id": job_id})
            except Exception as e:  # noqa: BLE001 — one source's enqueue failure must not block others
                print(f"[sg_rule_dispatcher] enqueue failed for {row[0]}/{row[1]}: {e}")
                failed.append({"account_id": row[0], "region": row[1], "error": str(e)})
        return {"enqueued": enqueued, "failed": failed}
    finally:
        conn.close()
