# scripts/v2/remediation/record_ssm_start.py
"""ADR-036 ssm branch: start the SSM Automation, persist AutomationExecutionId + the SFN task
token to worker_jobs IMMEDIATELY (so a SFN timeout cannot orphan a running automation; the reaper
reconciles), then return. The SM stays in .waitForTaskToken until status_resume sends the token.
Gated: cat.gate must pass (flag + kill-switch + enabled) BEFORE any StartAutomationExecution."""
import os
import boto3
import db
import action_catalog as cat
import ssm_bridge

_ssm = boto3.client("ssm", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))


def lambda_handler(event, _ctx):
    job_id, action = event["job_id"], event["action"]
    token = event["taskToken"]                    # passed by the SFN .waitForTaskToken Parameters
    conn = db.connect()
    try:
        a, reason = cat.gate(conn, action)
        if reason:
            raise RuntimeError(f"blocked:{reason}")  # SFN Catch → status_updater failed (NO start)
        if db.claim_running(conn, job_id, runtime="ssm") == 0:
            return {"status": "skipped"}             # already terminal (idempotent re-entry)
        params = ssm_bridge.build_start_params(a, event.get("payload", {}), dry_run=bool(event.get("dry_run")))
        exec_id = _ssm.start_automation_execution(**params)["AutomationExecutionId"]
        conn.run("UPDATE worker_jobs SET automation_execution_id=:e, task_token=:t, status='running' "
                 "WHERE job_id=:j AND status NOT IN ('succeeded','failed','canceled')",
                 e=exec_id, t=token, j=job_id)
        return {"automation_execution_id": exec_id}
    finally:
        conn.close()
