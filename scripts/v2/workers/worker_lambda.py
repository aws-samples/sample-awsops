"""SFN-invoked short worker. Input: {job_id, type, payload, dry_run}. Runs the handler, writes
running -> succeeded via db.py. On exception, raises so SFN Retry/Catch handle it (Catch ->
status_updater sets failed). C7: if claim_running lost the race (job already terminal), skip."""
import db
import handlers


def lambda_handler(event, _ctx):
    job_id, type_ = event["job_id"], event["type"]
    payload, dry_run = event.get("payload", {}), bool(event.get("dry_run", False))
    conn = db.connect()
    try:
        if db.claim_running(conn, job_id, runtime="lambda") == 0:
            return {"job_id": job_id, "status": "skipped"}  # already terminal/claimed (C7)
        fn, _rt = handlers.REGISTRY[type_]
        result, _artifact = fn(payload, dry_run)  # C15: inline result only; artifact upload deferred to P3
        db.finish_job(conn, job_id, "succeeded", result=result)
        return {"job_id": job_id, "status": "succeeded"}
    finally:
        conn.close()
