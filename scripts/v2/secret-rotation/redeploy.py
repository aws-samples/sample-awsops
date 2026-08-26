"""Force a new ECS deployment when the Aurora master secret rotates.

Triggered by an EventBridge rule on the Secrets Manager `RotationSucceeded` event for the Aurora
master secret. Long-running services (e.g. the web BFF) inject the DB password via ECS
`secrets`/valueFrom at TASK START, so after a rotation the running task keeps the pre-rotation
password and Aurora auth fails (`password authentication failed`). force-new-deployment makes ECS
start fresh tasks that re-read the rotated secret. Read-only toward AWS resources except this
rolling restart of the named services.
"""
import os
import re
import sys

import boto3


def _secret_key(arn_or_name):
    """Fallback secret key ONLY for when the event doesn't carry a full ARN: the name after
    ':secret:' with the SM random `-XXXXXX` suffix stripped. This is lossy on purpose (it drops
    account/region/the real suffix), so callers must try an exact string match first — see
    _matches_target — and use this only as a last resort for a bare-name event field."""
    name = str(arn_or_name).split(":secret:")[-1]
    return re.sub(r"-[A-Za-z0-9]{6}$", "", name)


def _matches_target(got, want):
    """True iff `got` (the event's secret id) identifies the same secret as `want`
    (AURORA_SECRET_ARN). Tries an EXACT match first (both full ARNs — the common, unambiguous
    case) before falling back to the lossy name-only comparison, so two different secrets that
    happen to share a truncated base name can't collide when the event carries a full ARN."""
    if got == want:
        return True
    return _secret_key(got) == _secret_key(want)


def _event_secret_id(event):
    """The rotated secret's id/ARN — the field path varies across event shapes, so try each."""
    d = event.get("detail", {}) or {}
    for path in (("additionalEventData", "SecretId"), ("serviceEventDetails", "secretId"), ("requestParameters", "secretId")):
        v = d
        for k in path:
            v = v.get(k) if isinstance(v, dict) else None
        if v:
            return str(v)
    return None


def handler(event, context):
    cluster = os.environ["CLUSTER"]
    services = [s for s in os.environ.get("SERVICES", "").split(",") if s]
    want = os.environ.get("AURORA_SECRET_ARN", "").strip()
    got = _event_secret_id(event)
    # FAIL-CLOSED: redeploy ONLY when we positively confirm this is the Aurora master secret (the rule
    # matches RotationSucceeded broadly across accounts/secrets). Skip — never restart prod web — if
    # the target secret is unconfigured, the event id is missing, or it doesn't match EXACTLY (by
    # canonical key; no substring matching). Each skip logs WARN so a wrong event shape is visible.
    if not want:
        print("[secret-rotation-redeploy] WARN: AURORA_SECRET_ARN unset — SKIPPING (fail-closed)", file=sys.stderr)
        return {"skipped": "no-target-configured"}
    if not got:
        print(f"[secret-rotation-redeploy] WARN: rotated secret id not in event detail keys "
              f"{list((event.get('detail') or {}).keys())} — SKIPPING (fail-closed)", file=sys.stderr)
        return {"skipped": "unidentified-secret"}
    if not _matches_target(got, want):
        print(f"[secret-rotation-redeploy] ignoring rotation of {got} (not the Aurora master secret)")
        return {"skipped": got}
    ecs = boto3.client("ecs")
    redeployed = []
    failed = {}
    for svc in services:
        try:
            ecs.update_service(cluster=cluster, service=svc, forceNewDeployment=True)
            redeployed.append(svc)
        except Exception as e:  # noqa: BLE001 - one service's failure must not abort the rest
            failed[svc] = str(e)
            print(f"[secret-rotation-redeploy] WARN: update_service failed for {svc}: {e}", file=sys.stderr)
    print(f"[secret-rotation-redeploy] forced new deployment on: {redeployed} "
          f"(trigger: {event.get('detail', {}).get('eventName')})")
    result = {"redeployed": redeployed}
    if failed:
        result["failed"] = failed
    return result
