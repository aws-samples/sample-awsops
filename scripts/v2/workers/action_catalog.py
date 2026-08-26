"""ADR-029+036 — resolve a catalog action by name into an executor binding, and gate it.
Gating layers (ALL must pass before any mutation): (1) REMEDIATION_ENABLED env (the TF flag,
surfaced to the Lambda), (2) the SSM kill-switch /ops/awsops-v2/mutating-actions/enabled == true,
(3) the catalog row's enabled flag. Read-only here; execution lives in remediation_executor.py
and the SSM runbook. Reuses scripts/v2/workers/db.py for the pg8000 connection."""
import json
import os
import boto3
import db  # scripts/v2/workers/db.py (shipped in the same artifact)

_ssm = boto3.client("ssm", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))
_KILL_SWITCH = os.environ.get("MUTATING_ACTIONS_SSM", "/ops/awsops-v2/mutating-actions/enabled")
# ADR-040/041 §4 — the external DATA-write plane has its OWN kill-switch, fully independent of the
# (frozen) AWS-resource mutating-actions switch. Operating an external write never touches the AWS one.
_INTEGRATIONS_WRITE_SSM = os.environ.get("INTEGRATIONS_WRITE_SSM", "/ops/awsops-v2/integrations-write/enabled")

_COLS = ["name", "executor_type", "target_resource_type", "assume_role_ref",
         "required_inputs", "dry_run_contract", "rollback_ref", "approval_mode",
         "conditions", "enabled"]


def load_action(conn, name):
    rows = conn.run(
        f"SELECT {','.join(_COLS)} FROM action_catalog WHERE name=:n", n=name)
    if not rows:
        return None
    d = dict(zip(_COLS, rows[0]))
    for j in ("required_inputs", "dry_run_contract", "conditions"):
        if isinstance(d[j], str):
            d[j] = json.loads(d[j])
    return d


def _is_external(a):
    # ADR-040/041: an 'external:' target_resource_type marks a DATA-write (Slack/Notion/...), NOT an
    # AWS-resource mutation → it is gated by the integrations-write control plane.
    return (a.get("target_resource_type") or "").startswith("external:")


def flag_enabled(is_external=False):
    # The TF flag is surfaced as an env on every remediation Lambda; default OFF. External DATA-writes
    # read their OWN flag so enabling them can NEVER enable AWS-resource mutation (ADR-040/041 §4).
    env = "INTEGRATIONS_WRITE_ENABLED" if is_external else "REMEDIATION_ENABLED"
    return os.environ.get(env, "false").lower() == "true"


def killswitch_on(is_external=False):
    name = _INTEGRATIONS_WRITE_SSM if is_external else _KILL_SWITCH
    try:
        return _ssm.get_parameter(Name=name)["Parameter"]["Value"].lower() == "true"
    except Exception:
        return False  # fail-closed: cannot confirm the switch is on → treat as off


def gate(conn, name):
    """Return (action_dict, reason). reason is None iff the action may execute. ADR-040/041 §4: load the
    action FIRST, then branch the flag + kill-switch by its target_resource_type — an external: DATA-write
    is gated by the integrations-write plane, an AWS-resource action by the (frozen) remediation plane."""
    a = load_action(conn, name)
    if a is None:
        return None, "unknown_action"
    ext = _is_external(a)
    if not flag_enabled(ext):
        return None, "flag_off"
    if not killswitch_on(ext):
        return None, "killswitch_off"
    if not a["enabled"]:
        return None, "action_disabled"
    return a, None
