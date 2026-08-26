"""AWSops v2 ADR-032 — Prevention stage Lambda (Phase-4 SKELETON).

Thin terminal stage: from the RCA category it writes ONE prevention_recommendations row and
advances incidents.status='prevention'. The full Phase-4 prevention/learning loop is deferred; this
stage exists so the SM has a real terminal write and the schema seam is exercised. It only runs when
the lifecycle flag is on (the SM is gated), so it is inert by default.

SAFETY: a single bounded INSERT + one status UPDATE. NO mutation of AWS resources, recommend-only.
"""
import os

import db

PROJECT = os.environ.get("PROJECT", "awsops-v2")

# RCA category -> (prevention category, recommendation text). Skeleton mapping; refined in Phase 4.
_PREVENTION = {
    "deployment": ("testing", "Add a pre-deploy canary + automatic rollback gate for this service."),
    "capacity": ("infra", "Add a proactive scaling alarm / headroom buffer for the affected resource."),
    "configuration": ("code", "Add a config-validation check to CI for the changed parameter."),
    "dependency": ("observability", "Add a dependency health probe + alert for the upstream service."),
    "security": ("observability", "Add a detective control / alert for the implicated security signal."),
    "infrastructure": ("infra", "Add an infrastructure health alarm for the affected component."),
    "unknown": ("observability", "Add observability for the signals that were missing during triage."),
}


def lambda_handler(event, _ctx):
    """SM Prevention Task (terminal). Input: {job_id, incident_id}. Writes ONE
    prevention_recommendations row + advances status. Returns {incident_id, recommendation}."""
    incident_id = event["incident_id"]
    conn = db.connect()
    try:
        rows = conn.run("SELECT rca->>'category' FROM incidents WHERE id = :iid", iid=incident_id)
        category = (rows[0][0] if rows and rows[0][0] else "unknown")
        prev_cat, text = _PREVENTION.get(category, _PREVENTION["unknown"])
        conn.run(
            "INSERT INTO prevention_recommendations (incident_id, category, recommendation) "
            "VALUES (:iid, :c, :r)", iid=incident_id, c=prev_cat, r=text)
        conn.run(
            "UPDATE incidents SET status = 'prevention' "
            "WHERE id = :iid AND status NOT IN ('resolved','stalled','skipped')", iid=incident_id)
        return {"incident_id": incident_id, "recommendation": {"category": prev_cat, "text": text}}
    finally:
        conn.close()
