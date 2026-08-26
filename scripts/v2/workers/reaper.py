"""EventBridge-scheduled. Reconciles stale jobs. C12: uses make_interval (not string concat); and
does NOT reap 'queued' jobs while the dispatcher ESM is disabled (kill-switch pause) so paused jobs
survive. 'running' stale -> failed always. Conservative: failed (not re-run) to avoid dup side-effects."""
import os
import boto3
import db

Q = int(os.environ.get("QUEUED_STALE_MIN", "30"))
R = int(os.environ.get("RUNNING_STALE_MIN", "60"))
_ESM_UUID = os.environ.get("DISPATCH_ESM_UUID", "")
_lam = boto3.client("lambda", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))


def _dispatch_enabled():
    if not _ESM_UUID:
        return True
    try:
        return _lam.get_event_source_mapping(UUID=_ESM_UUID).get("State") in ("Enabled", "Enabling")
    except Exception:
        return True  # fail-open: a transient describe error shouldn't block running-job reaping


def lambda_handler(_event, _ctx):
    conn = db.connect()
    try:
        r = conn.run(
            "UPDATE worker_jobs SET status='failed', error='reaped: stale running' "
            "WHERE status='running' AND updated_at < now() - make_interval(mins => :m) RETURNING job_id",
            m=R)
        out = {"reaped_running": len(r)}
        if _dispatch_enabled():
            q = conn.run(
                "UPDATE worker_jobs SET status='failed', error='reaped: stale queued' "
                "WHERE status='queued' AND updated_at < now() - make_interval(mins => :m) RETURNING job_id",
                m=Q)
            out["reaped_queued"] = len(q)
        else:
            out["reaped_queued"] = "skipped (dispatch ESM disabled)"
        # ADR-029+036: remediation reconciliation (slow backstop only). Remediation rows carry an
        # automation_execution_id; the EventBridge status_resume path is the PRIMARY completion path
        # and the resume Lambda owns the terminal write. The reaper NEVER blindly fails them (a still-
        # running SSM automation must not be reaped) and NEVER touches 'manual_intervention' (a
        # terminal operator state). It only SELECTs stale rows for visibility/count + logs them.
        rem = conn.run(
            "SELECT job_id, automation_execution_id FROM worker_jobs "
            "WHERE status IN ('running','awaiting_approval') "
            "AND automation_execution_id IS NOT NULL "
            "AND updated_at < now() - make_interval(mins => :m)", m=R)
        out["stale_remediation_rows"] = len(rem)
        for job_id, _exec_id in rem:
            print(f"REMEDIATION stale (resume Lambda should finalize) job_id={job_id}")

        # B2 (V1 stale-guard parity): reconcile diagnosis_reports too — status_updater/worker only
        # touch worker_jobs, so a worker that dies BEFORE _report's finish_report (KeyError, OOM
        # exit137, DB-connect fail, hard kill) leaves the report 'running' forever and the UI shows
        # an eternal "진단중". Fail a running report when its linked worker job failed OR it has gone
        # stale (no progress heartbeat for RUNNING_STALE_MIN — update_progress advances updated_at).
        dr = conn.run(
            "UPDATE diagnosis_reports SET status='failed', "
            "error='reaped: worker failed or stale (no progress heartbeat)' "
            "WHERE status='running' AND ("
            "  worker_job_id IN (SELECT job_id FROM worker_jobs WHERE status='failed') "
            "  OR updated_at < now() - make_interval(mins => :m)) RETURNING id",
            m=R)
        out["reaped_reports"] = len(dr)
        return out
    finally:
        conn.close()
