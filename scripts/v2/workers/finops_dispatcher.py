"""EventBridge-scheduled (daily). Enqueues ONE `finops_baseline` job (ADR-020) — unlike
datasource_index_dispatcher/schedule_dispatcher there is no per-row fan-out; the rule engine itself
iterates the catalog against the whole account in a single run.

Idempotent against double-fire (EventBridge occasionally retries): idempotency_key is the UTC date.
worker_jobs DOES have a unique constraint covering this exact case — the base migration
`01KYVDMY8Y...` creates `uq_worker_jobs_idem_internal` as `UNIQUE(idempotency_key) WHERE
requested_by IS NULL`, and this dispatcher's insert_job call is requested_by=NULL (an internal
enqueue, no end-user principal) by default. The SELECT pre-check below is a fast-path only — it
narrows the window but does not close it: two concurrent EventBridge invocations can both pass the
pre-check before either inserts, and the second INSERT then hits that constraint. `_insert_once`
catches exactly that race (SQLSTATE 23505) and treats it the same as the pre-check hit, rather than
letting it propagate as an unhandled error.
Mirrors schedule_dispatcher/datasource_index_dispatcher: db.insert_job (ledger) + an SQS message
identical to the BFF's enqueueJob -> the existing dispatcher->SFN->Fargate path runs the job.
Read-only effect on AWS (the job itself only reads Compute Optimizer/inventory_resources)."""
import json
import os
import uuid
from datetime import datetime, timezone

import boto3
from pg8000.exceptions import DatabaseError

import db

QUEUE_URL = os.environ.get("JOBS_QUEUE_URL", "")
_sqs = boto3.client("sqs", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))
_UNIQUE_VIOLATION = "23505"


def _already_enqueued_today(conn, key):
    rows = conn.run(
        "SELECT 1 FROM worker_jobs WHERE type='finops_baseline' AND idempotency_key=:k LIMIT 1", k=key
    )
    return bool(rows)


def _insert_once(conn, job_id, payload, key):
    """Returns True if this call actually inserted the row, False if a concurrent dispatcher
    invocation won the race (uq_worker_jobs_idem_internal) — re-raises any other DatabaseError."""
    try:
        db.insert_job(conn, job_id, "finops_baseline", payload, idempotency_key=key)
        return True
    except DatabaseError as e:
        if e.args[0].get("C") == _UNIQUE_VIOLATION:
            return False
        raise


def lambda_handler(_event, _ctx):
    if not QUEUE_URL:
        raise RuntimeError("JOBS_QUEUE_URL is required for finops_dispatcher")  # fail loud
    key = f"finops_baseline:{datetime.now(timezone.utc).strftime('%Y-%m-%d')}"
    conn = db.connect()
    try:
        if _already_enqueued_today(conn, key):
            print(f"finops_dispatcher: already enqueued today ({key}), skipping")
            return {"enqueued": False, "reason": "already_enqueued_today"}
        job_id = str(uuid.uuid4())
        payload = {}
        if not _insert_once(conn, job_id, payload, key):
            print(f"finops_dispatcher: lost the enqueue race for {key}, skipping")
            return {"enqueued": False, "reason": "already_enqueued_today"}
        try:
            _sqs.send_message(
                QueueUrl=QUEUE_URL,
                MessageBody=json.dumps({"job_id": job_id, "type": "finops_baseline",
                                        "payload": payload, "dry_run": False}),
            )
        except Exception:
            try:
                conn.run("DELETE FROM worker_jobs WHERE job_id=:id AND status='queued'", id=job_id)
            except Exception:  # noqa: BLE001
                pass
            raise
        print(f"finops_dispatcher: enqueued job_id={job_id}")
        return {"enqueued": True, "job_id": job_id}
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass
