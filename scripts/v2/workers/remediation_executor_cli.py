# scripts/v2/remediation/remediation_executor_cli.py
"""Fargate entrypoint for the P2-code remediation executor (long/composite/OOM-prone actions).
Args: --job-id <id> --action <name> [--phase execute|rollback]. Builds the lambda-style event and
delegates to remediation_executor.lambda_handler. CMD (not ENTRYPOINT) — the SFN command replaces CMD."""
import argparse
import remediation_executor as ex
import db


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job-id", required=True)
    ap.add_argument("--action", required=True)
    ap.add_argument("--phase", default="execute")
    args = ap.parse_args()
    conn = db.connect()
    try:
        job = db.get_job(conn, args.job_id) or {}
        payload = job["payload"] if isinstance(job.get("payload"), dict) else {}
    finally:
        conn.close()
    ex.lambda_handler({"job_id": args.job_id, "action": args.action, "phase": args.phase, "payload": payload}, None)


if __name__ == "__main__":
    main()
