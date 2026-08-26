"""AWSops v2 ADR-032 Phase 4 — cross-incident proactive-prevention feedback loop.

Periodic (gated EventBridge) Lambda. Reads recent incident/RCA history, detects RECURRING
patterns (rca.category x primary service over a window, recurrence >= threshold), and UPSERTs
one prevention_insight per recurring pattern (idempotent on dedup_key). Recommend-only: it
emits recommendations, NEVER any AWS/k8s/SSM/SFN mutation. Inert when the lifecycle is off
(no incidents => no insights). Optional bounded Haiku narration enriches each insight.
"""
import hashlib
import json
import os

import db

PROJECT = os.environ.get("PROJECT", "awsops-v2")
DEFAULT_WINDOW_DAYS = int(os.environ.get("PREVENTION_WINDOW_DAYS", "30"))
DEFAULT_THRESHOLD = int(os.environ.get("PREVENTION_RECURRENCE_THRESHOLD", "2"))
_ssm = None  # lazy SSM client (see _tunable)

# rca.category -> (prevention category, base recommendation template). Mirrors prevention.py.
_MAP = {
    "deployment": ("testing", "Recurring deployment-related incidents on {svc}: add a pre-deploy canary + automatic rollback gate."),
    "capacity": ("infra", "Recurring capacity incidents on {svc}: add a proactive scaling alarm / headroom buffer."),
    "configuration": ("code", "Recurring configuration incidents on {svc}: add config-validation to CI for the changed parameters."),
    "dependency": ("observability", "Recurring dependency incidents on {svc}: add a dependency health probe + alert for the upstream."),
    "security": ("observability", "Recurring security signals on {svc}: add a detective control / alert."),
    "infrastructure": ("infra", "Recurring infrastructure incidents on {svc}: add a health alarm for the affected component."),
    "unknown": ("observability", "Recurring incidents on {svc} with missing triage signals: add observability for the gap."),
}


def _scope_ref(category, svc):
    return f"{category or 'unknown'}::{svc or 'unknown'}"


def _dedup_key(scope_ref):
    return hashlib.sha256(scope_ref.encode()).hexdigest()[:40]


def aggregate(incidents, threshold=DEFAULT_THRESHOLD, window_days=DEFAULT_WINDOW_DAYS):
    """Pure: group incidents by (rca.category, primary service) and return one insight dict per
    group whose recurrence >= threshold. No I/O. source_incident_ids is the evidence."""
    groups = {}
    for inc in incidents:
        cat = (inc.get("rca") or {}).get("category") or "unknown"
        svcs = inc.get("services") or []
        svc = svcs[0] if svcs else "unknown"
        key = _scope_ref(cat, svc)
        g = groups.setdefault(key, {"rca_cat": cat, "svc": svc, "ids": [], "severities": set(), "services": set()})
        g["ids"].append(inc["id"])
        if inc.get("severity"):
            g["severities"].add(inc["severity"])
        for s in svcs:
            g["services"].add(s)
    out = []
    for scope_ref, g in groups.items():
        if len(g["ids"]) < threshold:
            continue
        prev_cat, tmpl = _MAP.get(g["rca_cat"], _MAP["unknown"])
        out.append({
            "dedup_key": _dedup_key(scope_ref),
            "category": prev_cat,
            "scope_ref": scope_ref,
            "recommendation": tmpl.format(svc=g["svc"]),
            "recurrence_count": len(g["ids"]),
            "source_incident_ids": sorted(g["ids"]),
            "evidence": {"services": sorted(g["services"]), "severities": sorted(g["severities"]), "window_days": window_days},
        })
    return out


def _upsert(conn, ins):
    """Idempotent UPSERT on dedup_key: re-runs update recurrence/evidence/last_seen, no duplicate."""
    conn.run(
        "INSERT INTO prevention_insights (dedup_key, category, scope_ref, recommendation, "
        "recurrence_count, source_incident_ids, evidence) "
        "VALUES (:k,:c,:s,:r,:n,CAST(:ids AS JSONB),CAST(:ev AS JSONB)) "
        "ON CONFLICT (dedup_key) DO UPDATE SET "
        "recurrence_count = EXCLUDED.recurrence_count, source_incident_ids = EXCLUDED.source_incident_ids, "
        "evidence = EXCLUDED.evidence, recommendation = EXCLUDED.recommendation, last_seen_at = now()",
        k=ins["dedup_key"], c=ins["category"], s=ins["scope_ref"], r=ins["recommendation"],
        n=ins["recurrence_count"], ids=json.dumps(ins["source_incident_ids"]), ev=json.dumps(ins["evidence"]))


def _tunable(param_env: str, default: int) -> int:
    """Live-read an operator-tunable SSM param whose NAME arrives via env `param_env`.

    TF sets ignore_changes on the SSM values so operators can tune from the console —
    but the env-baked PREVENTION_* copies go stale until the next apply (PR #36 review).
    Reading SSM per run makes the tunability real. Missing env/param/permission or a
    non-integer value falls back to the baked default — a tuning knob must never break
    the sweep (read-only GetParameter; no mutation surface added).
    """
    name = os.environ.get(param_env, "")
    if not name:
        return default
    try:
        global _ssm
        if _ssm is None:  # lazy module-level client — warm invocations reuse it (PR #36 r3)
            import boto3
            _ssm = boto3.client("ssm")
        value = _ssm.get_parameter(Name=name)["Parameter"]["Value"]
        return int(value)
    except Exception as e:  # noqa: BLE001 — a tuning knob must never break the sweep
        # PR #36 review: don't swallow silently — leave a CloudWatch trace of the fallback.
        print(json.dumps({"evt": "tunable_fallback", "param": param_env, "default": default,
                          "err": str(e)[:200]}))
        return default


def lambda_handler(_event, _ctx):
    """Gated EventBridge target. Reads recent incidents w/ RCA, aggregates, UPSERTs insights.
    Recommend-only. Inert when no incidents. Never raises into the schedule (best-effort)."""
    window = _tunable("PREVENTION_WINDOW_DAYS_PARAM", DEFAULT_WINDOW_DAYS)
    threshold = _tunable("PREVENTION_THRESHOLD_PARAM", DEFAULT_THRESHOLD)
    conn = db.connect()
    try:
        rows = conn.run(
            # make_interval(days => int) — no string-concat interval (PR #36 r4: the window now
            # arrives from SSM at runtime; int-typed param removes the injection-shaped pattern).
            "SELECT id::text, rca, services, severity FROM incidents "
            "WHERE rca IS NOT NULL AND last_event_at > now() - make_interval(days => :w)", w=int(window))
        incidents = [
            {"id": r[0], "rca": (r[1] if isinstance(r[1], dict) else (json.loads(r[1]) if r[1] else {})),
             "services": list(r[2] or []), "severity": r[3]}
            for r in (rows or [])
        ]
        insights = aggregate(incidents, threshold=threshold, window_days=window)
        for ins in insights:
            _upsert(conn, ins)
        return {"analyzed": len(incidents), "insights_upserted": len(insights)}
    finally:
        conn.close()
