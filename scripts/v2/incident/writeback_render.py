"""AWSops v2 ADR-034 — RCA write-back PURE helpers (no AWS, no DB).

Renders the recommendation-only body, sanity-checks the (attacker-influenced) RCA before any
write-back, and decides the OpsCenter-vs-Incident-Manager route. The model is NOT re-invoked here;
034 consumes the ADR-032 RCA already persisted in incidents.rca.

SAFETY: recommendation-only labelling (never 'confirmed root cause'); the RCA markdown is defanged
+ length-bounded before embedding; a fallback/garbage RCA is DROPPED (returns ok=False)."""
import hashlib
import re

RCA_VERSION = "rca-2026-06-10"          # bumped when the RCA prompt/parser changes (provenance)
_VALID_CATEGORY = ("deployment", "capacity", "configuration", "dependency",
                   "security", "infrastructure", "unknown")
_VALID_CONFIDENCE = ("high", "medium", "low")
_DESC_CAP = 4000                        # OpsItem Description hard cap (SSM limit is higher; stay conservative)
_FALLBACK_PREFIX = "analysis unavailable"   # rootcause.py writes this when the model call failed

# feedback-loop breaker stamp — MUST match incident-normalize.bearsSelfWritebackMarker (web side).
MARKER_KEY = "CreatedBy"
MARKER_VALUE = "AWSops-AIOps"


def defang(s, cap):
    """Strip markup/control chars + neutralize instruction phrasing; mirror incident-normalize.defang."""
    t = s if isinstance(s, str) else str(s or "")
    t = re.sub(r"[<>]", " ", t)
    t = re.sub(r"[\x00-\x1f]", " ", t)
    t = re.sub(r"ignore (all|any|previous|the above)[^.\n]*", "[redacted-instruction]", t, flags=re.I)
    t = re.sub(r"\b(system|assistant|developer)\s*:", "[role] ", t, flags=re.I)
    t = re.sub(r"\s+", " ", t).strip()
    return t[:cap]


def dedup_key(incident_id):
    """Idempotency #6: exactly one write-back per incident (the UNIQUE key on incident_writeback)."""
    return hashlib.sha256(f"{incident_id}:writeback".encode("utf-8")).hexdigest()


def sanitize_writeback_body(rca):
    """Output sanity-check (ADR-034 prompt-injection-into-content control). Returns (ok, reason).
    Drops the write if: rca missing, the model fallback ('analysis unavailable'), or invalid enums."""
    if not isinstance(rca, dict):
        return False, "rca-missing"
    root = (rca.get("root_cause") or "").strip()
    if not root or root.lower().startswith(_FALLBACK_PREFIX):
        return False, "rca-fallback"     # do NOT write back an unusable analysis
    if rca.get("category") not in _VALID_CATEGORY:
        return False, "bad-category"
    if rca.get("confidence") not in _VALID_CONFIDENCE:
        return False, "bad-confidence"
    return True, None


def build_recommendation_body(incident, rca, evidence_url, finding_count, data_sources):
    """Build the OpsItem/timeline body. RECOMMENDATION-ONLY labelling (BINDING): never an
    unqualified 'confirmed root cause'. Returns {title, description} (defanged, length-bounded)."""
    confidence = rca["confidence"]
    category = rca["category"]
    root = defang(rca["root_cause"], 512)
    md = defang(rca.get("markdown", ""), _DESC_CAP - 600)   # leave room for the labelled header
    title = defang(f"AWSops recommendation: {root}", 1000)
    description = "\n".join([
        "AWSops recommendation (NOT a confirmed root cause).",
        f"Confidence: {confidence}   Category: {category}",
        f"Evidence: {evidence_url}  (findings: {finding_count})",
        f"Data sources: {', '.join(sorted(set(data_sources)))[:512]}",
        f"RCA version: {RCA_VERSION}   Agent space: {defang(incident.get('agent_space_version') or 'n/a', 64)}",
        f"Generated: {incident.get('last_event_at') or ''}",
        "",
        "--- analysis (recommendation only) ---",
        md,
    ])[:_DESC_CAP]
    return {"title": title, "description": description}


def route_decision(matched_response_plan_arn):
    """Resolve the ADR-034 'or': a matched Incident Manager response plan => enrich that incident;
    otherwise => create an OpsCenter OpsItem. Pure given the lookup result."""
    return "incident_manager" if matched_response_plan_arn else "opscenter"
