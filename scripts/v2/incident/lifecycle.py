"""AWSops v2 ADR-032 — lifecycle helpers (Python core).

Stage idempotency + checkpoint + storm-cap reader, used by the incident stage Lambdas (Task 5).
These ride the P2 backbone (worker_jobs / SQS / Step Functions); they do NOT add a parallel queue.

Binding semantics (ADR-032 Addenda):
  (b) per-stage CHECKPOINT — `incident_stages.last_checkpoint_at` is the watchdog anchor.
  (c) at-least-once + IDEMPOTENCY — `stage_idempotency_key` is deterministic, so a retried stage
      resumes from its row and never spawns duplicate sub-agents.
  #4 configurable windows — `read_caps` reads FIVE SSM params; NO hardcoded operational constant
      (defaults live in the SSM param values + the safe code fallbacks below). The suffixes match
      web/lib/incident.ts byte-for-byte so web + python read the SAME knobs.
  #7 alert-storm controls — max_concurrent / fanout_max / min_severity all come from read_caps.

SAFETY: read-only over config + a single bounded UPDATE to advance a checkpoint timestamp. No
mutation of AWS resources, no tool-permission / roster / approval surface ever read or written.
"""
import hashlib
import os

PROJECT = os.environ.get("PROJECT", "awsops-v2")

# SSM param suffix -> (read_caps key, default, kind). Kept identical to web/lib/incident.ts.
_CAP_PARAMS = {
    "correlation-window-minutes": ("window_min", 20, "int"),
    "stage-timeout-seconds": ("stage_timeout_s", 600, "int"),
    "max-concurrent-investigations": ("max_concurrent", 5, "int"),
    "subagent-fanout-max": ("fanout_max", 4, "int"),
    "min-severity": ("min_severity", "warning", "severity"),
}

_SEVERITY_RANK = {"critical": 3, "warning": 2, "info": 1}
_VALID_SEVERITY = ("critical", "warning", "info")


def severity_rank(sev):
    """info < warning < critical. Unknown -> info (the most permissive floor, matches v1)."""
    return _SEVERITY_RANK.get((sev or "").lower(), 1)


def stage_idempotency_key(incident_id, stage, attempt):
    """Deterministic per (incident, stage, attempt). A retried stage produces the SAME key, so the
    (incident_id, stage_idempotency_key) UNIQUE constraint (migration v5) makes the stage write
    idempotent — no duplicate sub-agent fan-out on at-least-once redelivery (Addendum (c))."""
    return hashlib.sha256(f"{incident_id}:{stage}:{attempt}".encode("utf-8")).hexdigest()


def _ssm_param_path(suffix):
    return f"/ops/{PROJECT}/incident/{suffix}"


def read_caps(ssm):
    """Read the five storm-cap / window knobs from SSM via the given boto3 ssm client (or stub).

    Returns {max_concurrent, fanout_max, window_min, stage_timeout_s, min_severity}. Degrade-safe:
    a missing/invalid param falls back to its default — the lifecycle stays bounded even with no
    SSM params present (flag-off / first-run). Mirrors web/lib/incident.ts read* fallbacks.
    """
    caps = {}
    for suffix, (key, default, kind) in _CAP_PARAMS.items():
        raw = None
        try:
            resp = ssm.get_parameter(Name=_ssm_param_path(suffix))
            raw = (resp.get("Parameter") or {}).get("Value")
        except Exception:
            raw = None  # ParameterNotFound / client error -> default
        if raw is None:
            caps[key] = default
            continue
        if kind == "int":
            try:
                caps[key] = int(str(raw).strip())
            except (ValueError, TypeError):
                caps[key] = default
        elif kind == "severity":
            v = str(raw).strip().lower()
            caps[key] = v if v in _VALID_SEVERITY else default
        else:
            caps[key] = raw
    return caps


def checkpoint(conn, stage_id):
    """Advance incident_stages.last_checkpoint_at = now() for a RUNNING stage (Addendum (b)).

    Bounded single-row UPDATE; only touches a 'running' stage (a terminal stage is immutable, so a
    late checkpoint cannot resurrect it). Returns rows affected (1 = advanced, 0 = not running)."""
    rows = conn.run(
        "UPDATE incident_stages SET last_checkpoint_at = now() "
        "WHERE id = :sid AND status = 'running' RETURNING id",
        sid=stage_id,
    )
    return len(rows)


def transition_stage(conn, stage_id, status):
    """Set a stage's terminal/intermediate status (running->succeeded|failed|stalled), immutable once
    terminal — a watchdog 'stalled' or a Catch 'failed' cannot overwrite a worker's 'succeeded'.
    Returns rows affected. Used by the stage Lambdas / watchdog (Task 5)."""
    assert status in ("running", "succeeded", "failed", "stalled")
    rows = conn.run(
        "UPDATE incident_stages SET status = :s "
        "WHERE id = :sid AND status NOT IN ('succeeded','failed','stalled') RETURNING id",
        s=status, sid=stage_id,
    )
    return len(rows)
