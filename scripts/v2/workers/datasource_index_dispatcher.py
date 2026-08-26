"""EventBridge-scheduled (daily). Enqueues a `datasource_index` job per enabled datasource instance,
across all 5 connector kinds (prometheus/mimir/clickhouse/tempo/loki), so pre-built diagnostic signals
AND pre-built topology-graph queries are rebuilt when a datasource's schema drifts — independent of
Explore/topology-rebuild visits. "At least weekly" per the registry-driven graph-sources design
(docs/superpowers/specs/2026-07-08-registry-graph-sources-design.md) is satisfied by this existing
daily cadence; no new schedule was added. Mirrors schedule_dispatcher: db.insert_job (ledger) + an
SQS message identical to the BFF's enqueueJob → the existing dispatcher→SFN→Lambda path runs the
`datasource_index` handler. Read-only effect on AWS (the index job reads a cached schema, optionally
re-introspects live; the diagnosis/graph egress is separately gated). A per-instance enqueue failure
is isolated.
"""
import json
import os
import uuid

import boto3

import db

QUEUE_URL = os.environ.get("JOBS_QUEUE_URL", "")
_sqs = boto3.client("sqs", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))

# All 5 datasource-kind egress-read connectors that are enabled. Widened from prometheus/mimir-only
# (diag-signals v1 scope) once graph_catalog.py gave every kind something to pre-build.
_LIST_SQL = (
    "SELECT id, name, kind FROM integrations "
    "WHERE direction='egress' AND capability='read' AND enabled=true "
    "AND kind IN ('prometheus','mimir','clickhouse','tempo','loki') ORDER BY id"
)


def _enqueue_index(conn, integration_id, kind):
    job_id = str(uuid.uuid4())
    # kind travels with the payload — the job would otherwise have to re-look it up (it needs it
    # before any schema cache row necessarily exists, e.g. a first-ever run for a new instance).
    payload = {"integration_id": integration_id, "kind": kind}
    db.insert_job(conn, job_id, "datasource_index", payload)  # durable ledger row
    try:
        _sqs.send_message(
            QueueUrl=QUEUE_URL,
            MessageBody=json.dumps({"job_id": job_id, "type": "datasource_index",
                                    "payload": payload, "dry_run": False}),
        )
    except Exception:
        # SQS delivery failed → drop the orphan ledger row so it doesn't linger 'queued' until the reaper.
        try:
            conn.run("DELETE FROM worker_jobs WHERE job_id=:id AND status='queued'", id=job_id)
        except Exception:  # noqa: BLE001
            pass
        raise
    return job_id


def lambda_handler(_event, _ctx):
    if not QUEUE_URL:
        raise RuntimeError("JOBS_QUEUE_URL is required for datasource_index_dispatcher")  # fail loud
    conn = db.connect()
    try:
        rows = conn.run(_LIST_SQL) or []
        enqueued, failed = 0, 0
        for row in rows:
            iid, _name, kind = row[0], row[1], row[2]
            try:
                _enqueue_index(conn, iid, kind)
                enqueued += 1
            except Exception as exc:  # noqa: BLE001 — one bad instance must not block the rest
                print(f"datasource_index_dispatcher: enqueue failed for integration {iid}: {exc}")
                failed += 1
        out = {"instances": len(rows), "enqueued": enqueued, "failed": failed}
        print(f"datasource_index_dispatcher: {out}")
        return out
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass
