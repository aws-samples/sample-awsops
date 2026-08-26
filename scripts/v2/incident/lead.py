"""AWSops v2 ADR-032 — Lead stage Lambda (the Incident Commander).

The Lead is a DELEGATOR ONLY. It resolves the sub-agent roster for the fan-out and hands the SM
Map a bounded list — it NEVER invokes a mutating gateway/tool and NEVER calls agent_bridge.invoke
itself (Addendum #5 — BINDING). All actual investigation happens in the Sub-agents (subagent.py),
each read-only. Mitigation is recommendation-only and lives in mitigation_plan.py.

ROSTER RESOLUTION (ports web/lib/agent-resolver.ts pickCustomAgent to Python):
  - read ENABLED `agents` rows (ADR-031 catalog); for each, if any routing keyword appears in the
    incident's signal text → include its gateway. Built-in gateways are the fallback fleet
    (logs/metrics/code-change/deploy-history) when no custom agent matches.
  - de-dup gateways, cap at `fanout_max` (storm control #7). The cap is the Map MaxConcurrency too.

SAFETY: read-only over `agents` + `incidents`; the roster carries NO permission/approval surface —
only a gateway name + a read-only persona hint + the section's signal slice. The attacker-controlled
alert text can influence ONLY which read-only section is consulted, never any permission decision.
"""
import os

import db
import lifecycle

PROJECT = os.environ.get("PROJECT", "awsops-v2")

# Fallback fleet: read-only built-in section gateways consulted when no custom agent matches.
# These mirror the section gateways (network/container/...); they are descriptive-only.
_FALLBACK_FLEET = ["monitoring", "container", "iac", "data"]

_INCIDENT_COLS = ["id", "severity", "services", "resources", "trigger_source"]


def _load_incident(conn, incident_id):
    rows = conn.run(
        "SELECT id, severity, services, resources, trigger_source "
        "FROM incidents WHERE id = :iid", iid=incident_id)
    if not rows:
        return None
    return dict(zip(_INCIDENT_COLS, rows[0]))


def _signal_text(incident):
    """Build the lowercased keyword-match text from the incident's descriptive signals only."""
    parts = []
    parts.extend(str(s) for s in (incident.get("services") or []))
    parts.extend(str(r) for r in (incident.get("resources") or []))
    parts.append(str(incident.get("trigger_source") or ""))
    return " ".join(parts).lower()


def _enabled_agents(conn):
    """ENABLED catalog agents (ADR-031). routing_keywords is JSONB; pg8000 returns it parsed."""
    rows = conn.run(
        "SELECT name, gateway, persona, routing_keywords, tier, version "
        "FROM agents WHERE enabled = true ORDER BY id")
    out = []
    for r in rows:
        kws = r[3]
        if isinstance(kws, str):
            import json
            try:
                kws = json.loads(kws)
            except (ValueError, TypeError):
                kws = []
        out.append({"name": r[0], "gateway": r[1], "persona": r[2] or "",
                    "routing_keywords": list(kws or []), "tier": r[4], "version": r[5]})
    return out


def resolve_roster(conn, incident, fanout_max):
    """Port of pickCustomAgent: a gateway is rostered when any of its agent's routing keywords
    appears in the incident signal text. Custom matches first, then the fallback fleet pads up to
    fanout_max. De-duped on gateway, capped at fanout_max. Returns a list of roster dicts
    (delegation targets) — NO mutation, NO tool execution here."""
    text = _signal_text(incident)
    roster, seen = [], set()

    def _add(name, gateway, persona, version=None):
        if gateway in seen:
            return
        seen.add(gateway)
        roster.append({"sub_agent": name, "gateway": gateway,
                       "persona": persona, "agent_version": version})

    for a in _enabled_agents(conn):
        if a["tier"] == "custom" and any(k and str(k).lower() in text for k in a["routing_keywords"]):
            _add(a["name"], a["gateway"], a["persona"], a["version"])
        if len(roster) >= fanout_max:
            return roster[:fanout_max]

    # fallback fleet — read-only section gateways, padded up to the cap
    for gw in _FALLBACK_FLEET:
        if len(roster) >= fanout_max:
            break
        _add(gw, gw, "")
    return roster[:fanout_max]


def lambda_handler(event, _ctx):
    """SM Lead Task. Input: {job_id, incident_id, decision, ...}. Returns
    {incident_id, roster:[...], maxConcurrency} for the Investigation Map state.

    The Lead DELEGATES ONLY — it emits no agent_bridge.invoke and no mutating tool call. The roster
    items each name a read-only gateway + a defanged-context persona hint for the Sub-agents."""
    incident_id = event["incident_id"]
    ssm = _ssm_client()
    caps = lifecycle.read_caps(ssm)
    fanout_max = caps["fanout_max"]

    conn = db.connect()
    try:
        incident = _load_incident(conn, incident_id)
        if incident is None:
            return {"job_id": event.get("job_id"), "incident_id": incident_id,
                    "roster": [], "maxConcurrency": 1}
        roster = resolve_roster(conn, incident, fanout_max)
        # carry compacted, descriptive-only signal context for each Sub-agent.
        for item in roster:
            item["incident_id"] = incident_id
            item["signals"] = {
                "severity": incident.get("severity"),
                "services": list(incident.get("services") or []),
                "resources": list(incident.get("resources") or []),
            }
        return {"job_id": event.get("job_id"), "incident_id": incident_id,
                "roster": roster, "maxConcurrency": max(1, len(roster))}
    finally:
        conn.close()


def _ssm_client():
    import boto3
    return boto3.client("ssm", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))
