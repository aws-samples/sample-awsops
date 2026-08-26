"""AWSops v2 ADR-032 — incident_stage_failed Lambda (the SM Catch target).

The SM's StageFailed path invokes this then the reused P2 status_updater (which terminalizes the
worker_jobs row — SFN cannot write VPC Aurora directly). This Lambda marks the failing
incident_stages row 'failed' TERMINAL-IMMUTABLY and rolls incidents.status. It mirrors
scripts/v2/workers/status_updater.py's conditional, immutable write.

SAFETY: bounded conditional UPDATEs only. A 'failed' write CANNOT overwrite a stage already
'succeeded' (terminal-immutable, same guard as lifecycle.transition_stage). Never overwrites a
terminal/resolved incident. NO AWS mutation.
"""
import json
import os

import db
import lifecycle

PROJECT = os.environ.get("PROJECT", "awsops-v2")


def _fail_running_stage(conn, incident_id, error):
    """Mark the incident's currently-running stage(s) 'failed' — immutable: a succeeded stage is
    never overwritten (transition_stage guards NOT IN terminal). Returns rows affected."""
    rows = conn.run(
        "UPDATE incident_stages SET status = 'failed', detail = :d::jsonb "
        "WHERE incident_id = :iid AND status = 'running' RETURNING id",
        iid=incident_id, d=json.dumps({"error": error}))
    return len(rows)


def lambda_handler(event, _ctx):
    """SM StageFailed Task. Input: {job_id, incident_id?, error}. Sets the running stage 'failed'
    (terminal-immutable) + rolls incidents.status='stalled' (never overwriting resolved). Returns
    a marker. The downstream status_updater handles the worker_jobs terminal-failed write."""
    incident_id = event.get("incident_id")
    err = event.get("error")
    if isinstance(err, (dict, list)):
        err = json.dumps(err)[:2000]
    err = (err or "incident stage failed (SM catch)")[:2000]

    if not incident_id:
        return {"incident_id": None, "stages_failed": 0}

    conn = db.connect()
    try:
        n = _fail_running_stage(conn, incident_id, err)
        # roll the incident to a terminal-ish 'stalled' — never resurrect/overwrite resolved.
        conn.run(
            "UPDATE incidents SET status = 'stalled' "
            "WHERE id = :iid AND status NOT IN ('resolved','skipped','stalled')", iid=incident_id)
        return {"incident_id": incident_id, "stages_failed": n}
    finally:
        conn.close()
