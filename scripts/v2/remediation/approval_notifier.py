# scripts/v2/remediation/approval_notifier.py
"""ApprovalWait Task-Token target. Records awaiting_approval + the token (so the web execute route
can SendTaskSuccess to the SAME token) and returns — the SM parks until the token resolves or the
ApprovalWait TimeoutSeconds expires (fail-closed → no execution). 4-eyes (a DIFFERENT approver) is
enforced by the web execute route (ADR-029 #4 / ADR-036 #2)."""
import db


def lambda_handler(event, _ctx):
    job_id, token = event["job_id"], event["taskToken"]
    conn = db.connect()
    try:
        conn.run("UPDATE worker_jobs SET status='awaiting_approval', task_token=:t, plan_id=:p "
                 "WHERE job_id=:j AND status NOT IN ('succeeded','failed','canceled','manual_intervention')",
                 t=token, p=event.get("plan_id"), j=job_id)
        return {"job_id": job_id, "awaiting_approval": True}
    finally:
        conn.close()
