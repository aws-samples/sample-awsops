"""AWSops v2 ADR-034 — WriteBack stage Lambda (the RCA output channel).

Runs as the SM stage AFTER RootCause. Reads incidents.rca (does NOT re-run the model), renders a
recommendation-only body, routes OpsCenter-vs-Incident-Manager, performs ONE marked observability
write through the shared 029/036 executor functions (per-action role), and records status.

SAFETY / BINDING:
  - BEST-EFFORT, NON-BLOCKING: every AWS/Slack failure is caught + recorded 'failed' WITHOUT
    raising, so a write-back error NEVER stalls the incident or blocks the primary Slack/SNS path.
    (The SM Catch -> WriteBackSkipped is a second safety net.)
  - observability-write control subset: #1 per-action role (assume action_opscenter_write /
    action_incident_write); #3 single-operator (no 4-eyes — this is NOT the /api/actions path);
    #5 audit (incident_writeback rows); #6 idempotency (dedup_key UNIQUE).
  - #2 dry-run = render the body (status='rendered') with NO mutation. #4 rollback = resolve the
    OpsItem (executor _opsitem_resolve), exposed via phase='rollback'.
  - feedback-loop breaker: the write is MARKED (CreatedBy=AWSops-AIOps); the ingress drops it.
"""
import json
import os
import boto3

import db
import writeback_render as r
import slack_thread

# shared single-write surface from the 029/036 executor (same artifact when packaged together);
# import lazily so unit tests can stub boto3.
PROJECT = os.environ.get("PROJECT", "awsops-v2")
_REGION = os.environ.get("AWS_REGION", "ap-northeast-2")
_PUBLIC_BASE = os.environ.get("PUBLIC_BASE_URL", "")   # for the evidence link


def _assume(role_arn):
    c = boto3.client("sts", region_name=_REGION).assume_role(
        RoleArn=role_arn, RoleSessionName="awsops-writeback")["Credentials"]
    return boto3.Session(aws_access_key_id=c["AccessKeyId"], aws_secret_access_key=c["SecretAccessKey"],
                         aws_session_token=c["SessionToken"], region_name=_REGION)


def _load(conn, incident_id):
    rows = conn.run("SELECT id, severity, agent_space_version, rca, last_event_at, trigger_source "
                    "FROM incidents WHERE id=:i", i=incident_id)
    if not rows:
        return None
    cols = ["id", "severity", "agent_space_version", "rca", "last_event_at", "trigger_source"]
    inc = dict(zip(cols, rows[0]))
    if isinstance(inc["rca"], str):
        try:
            inc["rca"] = json.loads(inc["rca"])
        except (ValueError, TypeError):
            inc["rca"] = None
    fc = conn.run("SELECT count(*), array_agg(DISTINCT sub_agent) FROM incident_findings WHERE incident_id=:i", i=incident_id)
    inc["finding_count"], inc["data_sources"] = (fc[0][0] or 0), (fc[0][1] or [])
    return inc


def _record(conn, incident_id, dedup, target, status, source_object_id=None, detail=None, thread_ts=None):
    conn.run(
        "INSERT INTO incident_writeback (incident_id, dedup_key, target_system, status, "
        "source_object_id, rca_version, slack_thread_ts, detail) "
        "VALUES (:i,:k,:t,:s,:o,:v,:ts,:d::jsonb) "
        "ON CONFLICT (dedup_key) DO UPDATE SET status=:s, source_object_id=COALESCE(:o, incident_writeback.source_object_id), "
        "slack_thread_ts=COALESCE(:ts, incident_writeback.slack_thread_ts), detail=:d::jsonb",
        i=incident_id, k=dedup, t=target, s=status, o=source_object_id, v=r.RCA_VERSION,
        ts=thread_ts, d=json.dumps(detail or {}))
    conn.run("UPDATE incidents SET writeback_status=:s WHERE id=:i", s=status, i=incident_id)


def _route(inc):
    """Match an Incident Manager response plan for this alarm (config map or list). Returns the
    matched incidentRecordArn or None. Read-only ssm-incidents (incident-Lambda role)."""
    plan_map = json.loads(os.environ.get("WRITEBACK_RESPONSE_PLAN_MAP", "{}") or "{}")
    return plan_map.get(inc.get("trigger_source"))   # simplest binding: source->incidentRecordArn map


def lambda_handler(event, _ctx):
    incident_id = event["incident_id"]
    phase = event.get("phase", "execute")
    conn = db.connect()
    try:
        inc = _load(conn, incident_id)
        if not inc:
            return {"incident_id": incident_id, "writeback": "skipped", "reason": "no-incident"}
        ok, reason = r.sanitize_writeback_body(inc.get("rca"))
        dedup = r.dedup_key(incident_id)
        if not ok:
            _record(conn, incident_id, dedup, "opscenter", "skipped", detail={"reason": reason})
            return {"incident_id": incident_id, "writeback": "skipped", "reason": reason}

        matched_arn = _route(inc)
        target = r.route_decision(matched_arn)
        evidence = f"{_PUBLIC_BASE}/incidents/{incident_id}" if _PUBLIC_BASE else incident_id
        body = r.build_recommendation_body(inc, inc["rca"], evidence, inc["finding_count"], inc["data_sources"])

        if phase == "dry_run":   # ADR-034 #2 = render only, NO mutation
            _record(conn, incident_id, dedup, target, "rendered", detail={"body": body})
            return {"incident_id": incident_id, "writeback": "rendered", "body": body}

        # idempotency #6: claim the row; if it already succeeded, skip (re-fire reuses it).
        existing = conn.run("SELECT status, slack_thread_ts FROM incident_writeback WHERE dedup_key=:k", k=dedup)
        if existing and existing[0][0] in ("succeeded", "resolved"):
            return {"incident_id": incident_id, "writeback": "already-done"}
        prior_ts = existing[0][1] if existing else None

        source_object_id = None
        try:    # BEST-EFFORT: the single marked AWS write. Failure is recorded, NOT raised.
            import remediation_executor as ex
            if target == "incident_manager":
                sess = _assume(os.environ["ACTION_ROLE_INCIDENT_WRITE"])
                res = ex._incident_enrich(conn, {"incident_record_arn": matched_arn,
                      "event_time": inc["last_event_at"], "description": body["description"]}, sess)
                source_object_id = res["enriched"]
            else:
                sess = _assume(os.environ["ACTION_ROLE_OPSCENTER_CREATE_OPSITEM"])
                res = ex._opsitem_execute(conn, {"title": body["title"], "source": os.environ.get(
                      "WRITEBACK_OPSCENTER_SOURCE", PROJECT), "severity": _sev(inc["severity"]),
                      "description": body["description"]}, sess)
                source_object_id = res["ops_item_id"]
            status = "succeeded"
            detail = {"target": target, "marker": r.MARKER_VALUE}
        except Exception as e:    # noqa: BLE001 — best-effort: never block the primary notification
            status, detail = "failed", {"target": target, "error": f"{type(e).__name__}: {e}"[:1000]}

        thread_ts = slack_thread.post_best_effort(incident_id, body, prior_ts)  # secondary, also best-effort
        _record(conn, incident_id, dedup, target, status, source_object_id, detail, thread_ts)
        return {"incident_id": incident_id, "writeback": status, "target": target,
                "source_object_id": source_object_id}
    finally:
        conn.close()


def _sev(severity):
    return {"critical": "1", "warning": "3", "info": "4"}.get((severity or "").lower(), "3")
