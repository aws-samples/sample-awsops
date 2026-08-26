"""AWSops v2 ADR-032 — incident_watchdog Lambda (per-stage timeout reaper).

EventBridge-driven (the gated rule fires only when the lifecycle flag is on). It flips any
incident_stage that has been 'running' past its timeout_seconds to 'stalled', then rolls each
owning incident to 'stalled' (never overwriting a terminal/resolved incident). It emits a notify
marker (a log line + a returned list) for each.

Addendum binding (b)+(d): resume-from-checkpoint is IMPLICIT — the SM re-enters a stage via its
deterministic idempotency key and a fresh checkpoint advances last_checkpoint_at, so a stage making
progress is NEVER reaped. The watchdog only terminalizes the truly-stuck (no checkpoint within the
configured timeout). It is the single source of liveness; it does NOT cancel SFN or mutate AWS.

SAFETY: two bounded conditional UPDATEs. 'stalled' cannot overwrite 'succeeded'/'failed' (terminal-
immutable) nor a 'resolved' incident. NO AWS mutation.
"""
import os

import db

PROJECT = os.environ.get("PROJECT", "awsops-v2")

# Flip running stages whose last checkpoint is older than their per-row timeout_seconds. The
# timeout is the SSM-configured snapshot stored on the row (NOT a hardcoded constant). A row with a
# NULL timeout_seconds is treated as never-timed-out here (defensive — should not occur in practice).
_STALL_SQL = (
    "UPDATE incident_stages SET status = 'stalled' "
    "WHERE status = 'running' AND timeout_seconds IS NOT NULL "
    "AND last_checkpoint_at < now() - (timeout_seconds || ' seconds')::interval "
    "RETURNING id, incident_id"
)


def lambda_handler(_event, _ctx):
    """EventBridge tick. Terminalizes stuck stages → stalled, rolls each incident → stalled
    (never a terminal/resolved one), emits a notify marker per incident. Returns {stalled:[...]}."""
    conn = db.connect()
    notified = []
    try:
        rows = conn.run(_STALL_SQL)
        for r in rows:
            incident_id = r[1]
            # roll the incident — but NEVER overwrite a terminal/resolved incident (binding (d)).
            updated = conn.run(
                "UPDATE incidents SET status = 'stalled' "
                "WHERE id = :iid AND status NOT IN ('resolved','skipped','stalled') RETURNING id",
                iid=incident_id)
            if updated:
                print(f"WATCHDOG stalled incident={incident_id} stage={r[0]}")  # notify marker
                notified.append(incident_id)
        return {"stalled": notified, "stages_reaped": len(rows)}
    finally:
        conn.close()
