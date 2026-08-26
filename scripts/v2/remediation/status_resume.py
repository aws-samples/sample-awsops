# scripts/v2/remediation/status_resume.py
"""EventBridge rule on SSM Automation 'EC2 Automation Step Status-change'/'status-change' →
resume the parked SFN task. Looks up the worker_jobs row by automation_execution_id, then
SendTaskSuccess (Success/CompletedWithSuccess) or SendTaskFailure (Failed/TimedOut/Cancelled).
Poll getAutomationExecution as a fallback when the event lacks a terminal status."""
import json
import os
import boto3
import db

_sfn = boto3.client("stepfunctions", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))
_ssm = boto3.client("ssm", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))
_TERMINAL_OK = {"Success", "CompletedWithSuccess"}
_TERMINAL_BAD = {"Failed", "TimedOut", "Cancelled", "CompletedWithFailure"}


def lambda_handler(event, _ctx):
    detail = event.get("detail", {})
    exec_id = detail.get("ExecutionId") or detail.get("automation-execution-id")
    status = detail.get("Status")
    if exec_id and status not in (_TERMINAL_OK | _TERMINAL_BAD):
        status = _ssm.get_automation_execution(AutomationExecutionId=exec_id)[
            "AutomationExecution"]["AutomationExecutionStatus"]
    conn = db.connect()
    try:
        rows = conn.run("SELECT job_id, task_token FROM worker_jobs WHERE automation_execution_id=:e", e=exec_id)
        if not rows:
            return {"matched": False, "exec_id": exec_id}
        job_id, token = rows[0]
        if not token:
            return {"matched": True, "no_token": True}  # reaper backstop
        if status in _TERMINAL_OK:
            db.finish_job(conn, job_id, "succeeded", result={"automation_execution_id": exec_id})
            _sfn.send_task_success(taskToken=token, output=json.dumps({"job_id": job_id, "status": "succeeded"}))
        else:
            _sfn.send_task_failure(taskToken=token, error="SsmAutomationFailed", cause=f"status={status}")
        return {"matched": True, "status": status}
    finally:
        conn.close()
