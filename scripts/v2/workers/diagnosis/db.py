"""AWSops v2 — diagnosis_reports CRUD (pg8000). Mirrors workers/db.py conventions."""
import json

_TERMINAL = ("succeeded", "failed", "partial")


def _as_dict(v):
    """pg8000 may hand back JSONB as a dict already, or as a str — normalize to dict."""
    if isinstance(v, dict):
        return v
    if isinstance(v, str):
        try:
            return json.loads(v)
        except (ValueError, TypeError):
            return {}
    return {}


def list_active_invariants(conn):
    """Active (admin-promoted) invariants only — the deterministic engine evaluates these against
    the live 'actual' state. Read-only; params normalized to a dict."""
    rows = conn.run(
        "SELECT id, kind, target, params, severity FROM architecture_intent WHERE status='active'"
    )
    return [{"id": r[0], "kind": r[1], "target": r[2],
             "params": _as_dict(r[3]), "severity": r[4]} for r in rows]


def get_report_summary(conn, report_id):
    """Return a report's (parent_report_id, summary-dict) for diff lineage, or (None, {})."""
    rows = conn.run(
        "SELECT parent_report_id, summary FROM diagnosis_reports WHERE id=:id", id=report_id
    )
    if not rows:
        return None, {}
    return rows[0][0], _as_dict(rows[0][1])


def create_report(conn, worker_job_id, tier, requested_by):
    rows = conn.run(
        "INSERT INTO diagnosis_reports (worker_job_id, tier, requested_by, status) "
        "VALUES (:jid, :t, :rb, 'running') RETURNING id",
        jid=worker_job_id, t=tier, rb=requested_by,
    )
    return rows[0][0]


def update_progress(conn, report_id, current, total, section, phase="render"):
    """Live per-section progress (기둥 A / V1 parity). No-op when report_id is None (older enqueue
    fallback path). Writes ONLY while status='running' so it never resurrects a finished/reaped row.
    The baseline touch_updated_at() trigger advances updated_at on each write = the reaper heartbeat
    (기둥 B): a worker that keeps emitting progress looks alive; one that dies goes stale."""
    if report_id is None:
        return 0
    rows = conn.run(
        "UPDATE diagnosis_reports SET progress=:p::jsonb "
        "WHERE id=:id AND status='running' RETURNING id",
        p=json.dumps({"current": current, "total": total, "section": section, "phase": phase}),
        id=report_id,
    )
    return len(rows)


def list_pending_notifications(conn):
    """Completed reports not yet folded into a digest email (notified_at IS NULL). Oldest-first so
    the digest lists them in completion order. Only succeeded/partial — a failed report has nothing
    worth emailing. artifact_uri (may be NULL on old/broken rows) lets the caller fetch the report
    markdown for a teaser — best-effort, so a missing artifact just means no teaser, not a failure."""
    rows = conn.run(
        "SELECT id, title, artifact_uri FROM diagnosis_reports "
        "WHERE notified_at IS NULL AND status IN ('succeeded','partial') "
        "ORDER BY created_at"
    )
    return [{"id": r[0], "title": r[1], "artifact_uri": r[2]} for r in rows]


def mark_notified(conn, report_ids):
    """Stamp notified_at=now() on the given report ids (after a successful digest publish). No-op
    on an empty list (avoids an `= ANY('{}')` no-match query for nothing)."""
    if not report_ids:
        return 0
    rows = conn.run(
        "UPDATE diagnosis_reports SET notified_at=now() WHERE id = ANY(:ids) RETURNING id",
        ids=list(report_ids),
    )
    return len(rows)


def finish_report(conn, report_id, status, sources_used=None, summary=None,
                  artifact_uri=None, error=None, title=None, tags=None):
    assert status in _TERMINAL
    # title/tags are set ONLY when provided — the failure path (status='failed', no title/tags) must
    # not clobber an auto-title, and pg won't accept None into the NOT NULL tags column.
    sets = ["status=:s", "sources_used=:su::jsonb", "summary=:sm::jsonb", "artifact_uri=:a", "error=:e"]
    kw = {"s": status, "su": json.dumps(sources_used or []), "sm": json.dumps(summary or {}),
          "a": artifact_uri, "e": error, "id": report_id}
    if title is not None:
        sets.append("title=:t2"); kw["t2"] = title
    if tags is not None:
        sets.append("tags=:tg"); kw["tg"] = tags
    rows = conn.run(
        "UPDATE diagnosis_reports SET " + ", ".join(sets)
        + " WHERE id=:id AND status='running' RETURNING id",
        **kw,
    )
    return len(rows)
