"""AI Insights worker job — collect (K8s/CloudWatch/cost) → synthesize → store latest in ai_insights.

Runtime-gated on AI_INSIGHTS_ENABLED (set on the worker by terraform local.aii) so the always-registered
REGISTRY entry + the BFF enqueue path are a strict no-op when the feature is off. Read-only; never raises
(per-collector failure is isolated; all-failed → status 'failed' row; a store error is surfaced).
"""
import logging
import os

from insight import cost_anomalies, cw_anomalies, generate, k8s_events


def run(payload, conn):
    """Return a small result dict. Never raises."""
    if os.environ.get("AI_INSIGHTS_ENABLED") != "true":
        return {"disabled": True}
    import db as wdb
    fns = [k8s_events.collect_k8s_events, cw_anomalies.collect_cw_anomalies, cost_anomalies.collect_cost_anomalies]
    signals, failures = [], 0
    for fn in fns:
        try:
            sig = fn()
        except Exception as e:  # noqa: BLE001 — collectors are defensive; this guards stubs/regressions
            logging.warning("[insight.job] collector %s raised: %s", getattr(fn, "__name__", fn), e)
            failures += 1
            continue
        signals.append(sig)
        # M2: a collector that never-raised but reported its own failure (ok=False) is a REAL failure —
        # otherwise an all-graceful-skip run would store a false "특이사항 없음 / succeeded".
        if not sig.get("ok", True):
            failures += 1

    # M1: store/synthesize failures must RAISE so the worker backbone (worker_lambda.finish_job) marks
    # the job 'failed' — never let a swallowed exception leave a 'succeeded' ledger row with no insert.
    if failures == len(fns):
        wdb.insert_insight(conn, "failed", [], {}, model=None, error="all insight collectors failed")
        return {"status": "failed"}
    result = generate.synthesize(signals)
    # M2: if any collector failed (ok=False) the synthesis ran on partial data → never report 'succeeded'.
    status = "partial" if (failures > 0 and result["status"] == "succeeded") else result["status"]
    sources_used = {s.get("source"): len(s.get("items") or []) for s in signals}
    wdb.insert_insight(conn, status, result["insights"], sources_used, model=result.get("model"))
    return {"status": status, "count": len(result["insights"])}
