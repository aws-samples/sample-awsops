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

        # ADR-020 parity with the diagnosis_reports reconciliation above: engine.run() writes the
        # finops_runs row 'running' BEFORE evaluating anything and only reaches its own 'failed'/
        # 'succeeded'/'partial' write via a Python return or `except` — a hard kill (Fargate OOM,
        # exactly the risk class ADR-020 puts this job on Fargate to survive for the *rule*
        # evaluation, not for the run-row write itself) leaves it 'running' forever. finops_runs
        # has no updated_at/heartbeat column (unlike diagnosis_reports), so staleness is judged
        # from started_at directly — a review round caught that nothing reconciled this at all
        # (the reaper only touches worker_jobs), so the card showed no in-progress or failed
        # indicator, just an indefinitely stale 'running' row.
        fr = conn.run(
            "UPDATE finops_runs SET status='failed', finished_at=now(), "
            "error='reaped: stale running (worker likely killed before finishing)' "
            "WHERE status='running' AND started_at < now() - make_interval(mins => :m) RETURNING id",
            m=R)
        out["reaped_finops_runs"] = len(fr)

        # ADR-019 SG Rules & Usage: sg_rule_scan_runs has no unique constraint on
        # (flow_source_id, partition_start, partition_end) — every scan attempt inserts a NEW row,
        # and a partition's "current" status is whichever row for that partition has the latest
        # started_at (design spec's Data model section). A run stuck 'running' (worker died mid-scan,
        # e.g. OOM or a hard Fargate kill) or 'queued' (never dispatched) must still be reaped the
        # same way worker_jobs rows are, so a stale run never blocks the next admin refresh/daily
        # attempt from being visible as failed rather than eternally in-flight.
        sgr_run = conn.run(
            "UPDATE sg_rule_scan_runs SET status='failed', error_code='reaped: stale running' "
            "WHERE status='running' AND started_at < now() - make_interval(mins => :m) RETURNING id",
            m=R)
        out["reaped_sg_rule_scan_runs_running"] = len(sgr_run)
        if _dispatch_enabled():
            sgr_q = conn.run(
                "UPDATE sg_rule_scan_runs SET status='failed', error_code='reaped: stale queued' "
                "WHERE status='queued' AND started_at < now() - make_interval(mins => :m) RETURNING id",
                m=Q)
            out["reaped_sg_rule_scan_runs_queued"] = len(sgr_q)
        else:
            out["reaped_sg_rule_scan_runs_queued"] = "skipped (dispatch ESM disabled)"

        # Network Path Check (BASELINE.md §2 register row — no governing ADR; ADR-019 §Decision
        # explicitly excludes this flag, see network_path.py's module docstring for the
        # disambiguation. design spec "Error handling": "Stale run ->
        # a dedicated reaper query added to scripts/v2/workers/reaper.py reconciles network_path_runs
        # the same way it already does for worker_jobs/diagnosis_reports"). Extended additively —
        # the sg_rule_scan_runs reaping above is untouched. Mirrors worker_jobs' own
        # running/queued split (network_path_runs has no separate started_at column, so
        # created_at is the staleness clock for both states, same as the schema's own
        # idx_network_path_runs_stale partial index).
        npc_run = conn.run(
            "UPDATE network_path_runs SET status='failed', overall_status='failed', finished_at=now() "
            "WHERE status='running' AND created_at < now() - make_interval(mins => :m) RETURNING id",
            m=R)
        out["reaped_network_path_runs_running"] = len(npc_run)
        if _dispatch_enabled():
            npc_q = conn.run(
                "UPDATE network_path_runs SET status='failed', overall_status='failed', finished_at=now() "
                "WHERE status='queued' AND created_at < now() - make_interval(mins => :m) RETURNING id",
                m=Q)
            out["reaped_network_path_runs_queued"] = len(npc_q)
        else:
            out["reaped_network_path_runs_queued"] = "skipped (dispatch ESM disabled)"
        return out
    finally:
        conn.close()
