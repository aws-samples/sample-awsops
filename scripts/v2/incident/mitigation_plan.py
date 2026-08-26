"""AWSops v2 ADR-032 — Mitigation-Plan stage Lambda (RECOMMENDATION-ONLY — SAFETY-CRITICAL).

From the RCA this stage builds a PLAN of catalog action references — a list of
{action: <action_catalog.name>, inputs: {...}, rationale} — and persists it into
incidents.mitigation_plan. It is RECOMMENDATION-ONLY (Addendum #5, BINDING):

  - It NEVER calls /api/actions (no create-plan, no execute), NEVER invokes SSM Automation /
    Change Manager, NEVER assumes a per-action role, NEVER touches the remediation executor.
  - It only references catalog action NAMES + suggested inputs; it does NOT even read the
    kill-switch (no execution decision is made here). action_catalog rows ship disabled regardless.
  - The only write is a single bounded UPDATE of incidents.mitigation_plan (descriptive JSON).

THE SEAM (documented, intentional human gate): a human reviews incidents.mitigation_plan in the UI
and, if they choose, separately initiates POST /api/actions to create an action_plan — which then
runs through the FULL ADR-029/036 six-control gate (flag + kill-switch + Change-Manager 4-eyes +
per-action role + dry-run + rollback). This Lambda performs NONE of that; it stops at the plan.
"""
import json
import os

import db

PROJECT = os.environ.get("PROJECT", "awsops-v2")

# RCA category -> suggested catalog action names. These are ADVISORY references into action_catalog;
# nothing here executes. A category with no mapping yields an empty plan (still recommendation-only).
_CATEGORY_HINTS = {
    "configuration": ["app-feature-flag-set"],
    "deployment": ["app-feature-flag-set"],
    "capacity": [],
    "dependency": [],
    "security": [],
    "infrastructure": ["ec2-create-tags"],
    "unknown": [],
}


def _load_rca(conn, incident_id):
    rows = conn.run("SELECT rca FROM incidents WHERE id = :iid", iid=incident_id)
    if not rows:
        return None
    rca = rows[0][0]
    if isinstance(rca, str):
        try:
            rca = json.loads(rca)
        except (ValueError, TypeError):
            rca = None
    return rca


def _known_action_names(conn):
    """Read the catalog action NAMES only (no executor binding, no gate). Reference, not execution."""
    rows = conn.run("SELECT name FROM action_catalog ORDER BY name")
    return {r[0] for r in rows}


def build_plan(rca, known_actions):
    """Map the RCA category to catalog action references. Returns a recommendation-only plan dict.
    Each item is {action, inputs, rationale}; only actions present in the catalog are referenced.
    NO execution, NO /api/actions call, NO mutation — pure data."""
    category = (rca or {}).get("category", "unknown")
    root_cause = (rca or {}).get("root_cause", "")
    actions = []
    for name in _CATEGORY_HINTS.get(category, []):
        if name not in known_actions:
            continue  # never reference an action the catalog doesn't define
        actions.append({
            "action": name,                      # action_catalog.name — a REFERENCE, never invoked here
            "inputs": {},                        # human fills/edits before any /api/actions create-plan
            "rationale": f"Recommended for category '{category}': {root_cause}"[:512],
        })
    return {
        "recommendation_only": True,             # explicit, machine-checkable: this plan is NOT executed
        "category": category,
        "actions": actions,
        "seam": "human reviews this plan, then separately POSTs /api/actions to create an action_plan "
                "(full ADR-029/036 six-control gate). This stage performs NO mutation.",
    }


def lambda_handler(event, _ctx):
    """SM MitigationPlan Task. Input: {job_id, incident_id}. Writes incidents.mitigation_plan and
    advances incidents.status='mitigation_planned'. Returns {incident_id, plan}. NO MUTATION."""
    incident_id = event["incident_id"]
    conn = db.connect()
    try:
        rca = _load_rca(conn, incident_id)
        known = _known_action_names(conn)
        plan = build_plan(rca, known)
        conn.run(
            "UPDATE incidents SET mitigation_plan = :p::jsonb, status = 'mitigation_planned' "
            "WHERE id = :iid AND status NOT IN ('resolved','stalled','skipped')",
            p=json.dumps(plan), iid=incident_id)
        return {"incident_id": incident_id, "plan": plan}
    finally:
        conn.close()
