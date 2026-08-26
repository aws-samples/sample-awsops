"""Fargate worker entrypoint. Args: --job-id <id> [--oom]. Reads the job, runs the handler; --oom
allocates beyond the task memory limit to force an OOM kill (exit 137) -> SFN RunTask.sync catches
-> status_updater sets failed -> proves web is unaffected (spec §5)."""
import argparse
import db
import handlers

_OOM_CHUNK = 64 * 1024 * 1024  # OOM demo: 64 MiB allocation step until the task memory limit kills us


def _fail_report(conn, report_id, error):
    """Best-effort: surface a worker-tier crash on the diagnosis_reports row so the UI shows
    'failed' instead of an eternal 'running' (B1 / never-stuck). Never raises; finish_report's
    `WHERE status='running'` makes it a no-op when _report already marked the report failed."""
    if report_id is None:
        return
    try:
        from diagnosis import db as ddb
        ddb.finish_report(conn, report_id, status="failed", error=str(error)[:500])
    except Exception:  # noqa: BLE001
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job-id", required=True)
    ap.add_argument("--oom", action="store_true")
    args = ap.parse_args()
    conn = db.connect()
    try:
        if db.claim_running(conn, args.job_id, runtime="fargate") == 0:
            return  # already terminal/claimed (C7)
        job = db.get_job(conn, args.job_id)
        if job is None:
            raise SystemExit("job not found")
        if args.oom:
            hog = []
            while True:
                hog.append(bytearray(_OOM_CHUNK))  # allocate until OOM-killed
        # DB payload may be JSON null/scalar; coerce non-dict to {} (the SFN/lambda path is trusted).
        payload = job["payload"] if isinstance(job.get("payload"), dict) else {}
        # [B1] capture report_id BEFORE any lookup that can throw, so the failure paths can mark the
        # report failed even when REGISTRY[type] itself raises — the original KeyError: 'report'
        # (stale image) crashed here before any write-back → diagnosis_reports stuck 'running' forever.
        report_id = payload.get("report_id")
        entry = handlers.REGISTRY.get(job["type"])
        if entry is None:
            err = f"unknown job type: {job['type']!r} (worker image stale? handler not deployed)"
            db.finish_job(conn, args.job_id, "failed", error=err)
            _fail_report(conn, report_id, err)
            raise SystemExit(err)
        fn, _rt = entry
        try:
            result, _artifact = fn(payload, bool(job.get("dry_run")))  # C15: inline result only; NULL-safe dry_run
            db.finish_job(conn, args.job_id, "succeeded", result=result)
        except Exception as e:  # noqa: BLE001 — handler crashed mid-run; surface on job + report, re-raise
            try:
                db.finish_job(conn, args.job_id, "failed", error=str(e)[:500])
            except Exception:  # noqa: BLE001
                pass
            _fail_report(conn, report_id, e)
            raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
