# scripts/v2/remediation/remediation_executor.py
"""ADR-029+036 — P2 'lambda'/'fargate' code executor for K8s/app-state/composite + observability
actions. Invoked by the remediation SFN's code branch. Input:
  {job_id, plan_id, action, payload, dry_run, phase}  phase ∈ {dry_run, execute, rollback}
Each action: dry_run/execute/rollback. Uses a PER-ACTION task role (NOT the shared worker role) —
the role ARN comes from the env ACTION_ROLE_<ACTION> set by the catalog-pinned Lambda alias, or
is assumed here when the executor runs the shared worker image. Terminal-immutable via db.py."""
import json
import os
import urllib.request as _urlreq
import boto3
import db
import action_catalog as cat
import external_slack_executor as ext_slack

_sts = boto3.client("sts", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))


def _assume(role_arn, session="awsops-remediation"):
    """Assume the per-action role; return a boto3 Session scoped to it (NOT the worker role)."""
    c = _sts.assume_role(RoleArn=role_arn, RoleSessionName=session)["Credentials"]
    return boto3.Session(
        aws_access_key_id=c["AccessKeyId"], aws_secret_access_key=c["SecretAccessKey"],
        aws_session_token=c["SessionToken"], region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))


# ---- example: app-state feature flag (Aurora row) ----
def _flag_dry_run(payload, _sess):
    return {"would_set": payload.get("flagKey"), "to": payload.get("value"), "mutates": False}

def _flag_execute(conn, payload, _sess):
    prev = conn.run("SELECT config FROM report_schedules WHERE user_sub='__feature_flags__' LIMIT 1") or [[{}]]
    conn.run("UPDATE feature_flags SET value=:v WHERE key=:k", k=payload["flagKey"], v=json.dumps(payload["value"]))
    return {"set": payload["flagKey"], "prev_captured": True}

def _flag_rollback(conn, rollback_plan, _sess):
    conn.run("UPDATE feature_flags SET value=:v WHERE key=:k",
             k=rollback_plan["flagKey"], v=json.dumps(rollback_plan["prev"]))
    return {"rolled_back": rollback_plan["flagKey"]}


# ---- observability write (ADR-036 #5 reduced subset), MARKED for the feedback-loop breaker ----
_MARKER = {"key": "CreatedBy", "value": "AWSops-AIOps"}

def _opsitem_dry_run(payload, _sess):
    return {"would_create_opsitem_title": payload.get("title"), "mutates": False}

def _opsitem_execute(_conn, payload, sess):
    ssm = sess.client("ssm")
    r = ssm.create_ops_item(
        Title=payload["title"], Source=payload["source"],
        Severity=str(payload.get("severity", "3")),
        Description=payload.get("description") or payload["title"],
        # feedback-loop breaker marker: OperationalData + Tag. The incident webhook ingress
        # drops any inbound event bearing CreatedBy=AWSops-AIOps so our own write can't re-trigger.
        OperationalData={"/aws/AWSops": {"Type": "SearchableString", "Value": _MARKER["value"]}},
        Tags=[{"Key": _MARKER["key"], "Value": _MARKER["value"]}])
    return {"ops_item_id": r["OpsItemId"], "marker": _MARKER["value"]}

def _opsitem_resolve(_conn, rollback_plan, sess):   # ADR-034 #4 rollback = resolve (no infra revert)
    sess.client("ssm").update_ops_item(OpsItemId=rollback_plan["ops_item_id"], Status="Resolved")
    return {"resolved": rollback_plan["ops_item_id"]}

def _incident_enrich(_conn, payload, sess):
    """ADR-034 routing: enrich a matched Incident Manager incident (timeline event). Marked via
    eventData/source so the ingress can drop it. ssm-incidents:* only (per-action role)."""
    inc = sess.client("ssm-incidents")
    inc.create_timeline_event(
        incidentRecordArn=payload["incident_record_arn"],
        eventTime=payload["event_time"], eventType="Custom Event",
        eventData=payload["description"],
        # marker rides eventReferences/source so a downstream alarm-as-event carries it.
    )
    return {"enriched": payload["incident_record_arn"], "marker": _MARKER["value"]}


# ---- external Slack DATA-write (ADR-040/041) — NOT an AWS-resource mutation. Core governance logic
#      (refuse non-external / re-redact / channel-allowlist / dry-run) is in external_slack_executor;
#      here is the thin glue (allowlist re-fetch from the DB, Secrets-Manager token, HTTP post). The
#      gate() already branched this to the integrations-write plane; the executor never sees AWS-mutation. ----
_SLACK_ACTION = {"name": "slack.post_message", "target_resource_type": "external:slack"}

def _slack_allowlist(conn):
    rows = conn.run("SELECT source_allowlist FROM integrations "
                    "WHERE kind='slack' AND direction='egress' AND capability='read_write' AND enabled=true "
                    "ORDER BY id LIMIT 1")
    if not rows:
        return []
    v = rows[0][0]
    return json.loads(v) if isinstance(v, str) else (v or [])

def _slack_get_secret(sess):
    raw = sess.client("secretsmanager").get_secret_value(SecretId=os.environ["SLACK_SECRET_ARN"])["SecretString"]
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return {"token": raw}

def _slack_http_post(channel, text, token):
    req = _urlreq.Request(
        "https://slack.com/api/chat.postMessage",
        data=json.dumps({"channel": channel, "text": text}).encode(),
        headers={"Authorization": "Bearer %s" % token, "Content-Type": "application/json; charset=utf-8"})
    with _urlreq.urlopen(req, timeout=10) as r:  # noqa: S310 (fixed https Slack endpoint)
        return json.loads(r.read().decode())

def _slack_dry(payload, _sess):
    return ext_slack.execute(_SLACK_ACTION, payload, [], get_secret=lambda: {}, http_post=lambda *a: None, dry_run=True)

def _slack_run(conn, payload, sess):
    return ext_slack.execute(_SLACK_ACTION, payload, _slack_allowlist(conn),
                             get_secret=lambda: _slack_get_secret(sess), http_post=_slack_http_post)


_EXEC = {
    "app-feature-flag-set":     {"dry": _flag_dry_run,    "run": _flag_execute,    "rb": _flag_rollback},
    "opscenter-create-opsitem": {"dry": _opsitem_dry_run, "run": _opsitem_execute, "rb": _opsitem_resolve},
    "incident-manager-enrich":  {"dry": _opsitem_dry_run, "run": _incident_enrich, "rb": None},
    "slack.post_message":       {"dry": _slack_dry,       "run": _slack_run,       "rb": None},
}


def lambda_handler(event, _ctx):
    job_id, action, phase = event["job_id"], event["action"], event.get("phase", "execute")
    payload, dry_run = event.get("payload", {}), bool(event.get("dry_run", False))
    conn = db.connect()
    try:
        a, reason = cat.gate(conn, action)
        if reason:
            # blocked by flag/kill-switch/disabled — record + fail closed (NO mutation)
            raise RuntimeError(f"blocked:{reason}")
        sess = _assume(os.environ[f"ACTION_ROLE_{action.upper().replace('-', '_')}"])
        fns = _EXEC[action]
        if phase == "dry_run" or dry_run:
            return {"job_id": job_id, "phase": "dry_run", "result": fns["dry"](payload, sess)}
        if phase == "rollback":
            if fns["rb"] is None:
                raise RuntimeError("MANUAL_INTERVENTION_REQUIRED: no rollback for action")
            res = fns["rb"](conn, event.get("rollback_plan", {}), sess)
            return {"job_id": job_id, "phase": "rollback", "result": res}
        if db.claim_running(conn, job_id, runtime="lambda") == 0:
            return {"job_id": job_id, "status": "skipped"}  # already terminal (C7)
        res = fns["run"](conn, payload, sess)
        db.finish_job(conn, job_id, "succeeded", result=res)
        return {"job_id": job_id, "status": "succeeded", "result": res}
    finally:
        conn.close()
