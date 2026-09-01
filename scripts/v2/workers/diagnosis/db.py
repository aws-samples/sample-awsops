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


def update_progress(conn, report_id, current, total, section, phase="render", completed=None):
    """Live per-section progress (기둥 A / V1 parity). No-op when report_id is None (older enqueue
    fallback path). Writes ONLY while status='running' so it never resurrects a finished/reaped row.
    The baseline touch_updated_at() trigger advances updated_at on each write = the reaper heartbeat
    (기둥 B): a worker that keeps emitting progress looks alive; one that dies goes stale."""
    if report_id is None:
        return 0
    rows = conn.run(
        "UPDATE diagnosis_reports SET progress=:p::jsonb "
        "WHERE id=:id AND status='running' RETURNING id",
        # `completed` (gap L177): titles of the sections that have finished rendering, in
        # completion order — additive JSONB key, absent for the collect/assemble phases and on
        # old rows (readers must tolerate its absence).
        p=json.dumps({"current": current, "total": total, "section": section, "phase": phase,
                      **({"completed": completed} if completed else {})}),
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


_NOTIFY_OUTCOMES = ("emailed", "emailed_failopen", "publish_failed", "dropped_paused", "skipped_no_topic")


def mark_notified(conn, report_ids, outcome="emailed"):
    """Stamp notified_at=now() + the durable delivery outcome on the given report ids.
    outcome vocabulary (also CHECK-constrained in the migration): 'emailed' (MessageId
    confirmed), 'emailed_failopen' (published while the pause-flag read failed),
    'publish_failed' (SNS publish returned no MessageId — still drained, never retried),
    'dropped_paused' (admin pause — gap L178), 'skipped_no_topic'.
    No-op on an empty list (avoids an `= ANY('{}')` no-match query for nothing)."""
    if outcome not in _NOTIFY_OUTCOMES:
        raise ValueError(f"invalid notify outcome: {outcome!r}")
    if not report_ids:
        return 0
    try:
        rows = conn.run(
            "UPDATE diagnosis_reports SET notified_at=now(), notify_outcome=:oc "
            "WHERE id = ANY(:ids) RETURNING id",
            ids=list(report_ids), oc=outcome,
        )
    except Exception as e:  # noqa: BLE001 — deploy-ordering guard, see below
        # A worker image deployed BEFORE the notify_outcome migration must still stamp
        # notified_at — failing here AFTER the SNS publish would leave the rows pending and
        # the 15-minute schedule re-emailing the same reports until `make migrate` runs.
        print(f"[db] notify_outcome write failed (pre-migration? stamping notified_at only): {e}")
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
    # finished_at (L176): the terminal-write timestamp — stamped for every terminal status so
    # the UI's elapsed stat never needs updated_at (which later meta edits keep advancing).
    sets = ["status=:s", "sources_used=:su::jsonb", "summary=:sm::jsonb", "artifact_uri=:a", "error=:e",
            "finished_at=now()"]
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
