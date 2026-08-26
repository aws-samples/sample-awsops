"""EventBridge-scheduled (every 6 hours). Enqueues a single `insight` job so the AI-Insights panel is
periodically refreshed without an Explore/dashboard visit. Mirrors schedule_dispatcher /
datasource_index_dispatcher: db.insert_job (ledger) + an SQS message identical to the BFF's enqueueJob
→ the existing dispatcher→SFN→Lambda path runs the `insight` handler (itself runtime-gated on
AI_INSIGHTS_ENABLED). Read-only effect on AWS. Single-account ('self') → one enqueue per fire.
"""
import json
import os
import uuid

import boto3

import db

QUEUE_URL = os.environ.get("JOBS_QUEUE_URL", "")
_sqs = boto3.client("sqs", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))


def lambda_handler(_event, _ctx):
    if not QUEUE_URL:
        raise RuntimeError("JOBS_QUEUE_URL is required for insight_dispatcher")  # fail loud
    conn = db.connect()
    try:
        # M2: EventBridge/Lambda is at-least-once — dedup against a recently enqueued/running insight job
        # so a duplicate fire/retry doesn't trigger a second Bedrock run (mirrors the BFF refresh guard).
        recent = conn.run(
            "SELECT 1 FROM worker_jobs WHERE type='insight' AND status IN ('queued','running') "
            "AND created_at > now() - interval '30 minutes' LIMIT 1")
        if recent:
            print("insight_dispatcher: recent insight job exists — skipping (dedup)")
            return {"enqueued": 0, "deduped": True}
        job_id = str(uuid.uuid4())
        payload = {"scheduled": True}
        db.insert_job(conn, job_id, "insight", payload)
        try:
            _sqs.send_message(
                QueueUrl=QUEUE_URL,
                MessageBody=json.dumps({"job_id": job_id, "type": "insight",
                                        "payload": payload, "dry_run": False}),
            )
        except Exception as exc:  # noqa: BLE001 — drop the orphan 'queued' row, then RE-RAISE
            print(f"insight_dispatcher: enqueue failed: {exc}")
            try:
                conn.run("DELETE FROM worker_jobs WHERE job_id=:id AND status='queued'", id=job_id)
            except Exception:  # noqa: BLE001
                pass
            # M4: re-raise so EventBridge/Lambda retries the schedule — otherwise the 6h refresh is
            # silently lost (a swallowed return would look like a successful no-op invocation).
            raise
        print("insight_dispatcher: enqueued 1")
        return {"enqueued": 1}
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass
