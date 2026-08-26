"""Schema-bound invariant proposal (§8R3 anti-fabrication). The LLM is asked to emit ONLY
candidates whose `kind` is in the fixed enum; `propose()` validates each against the predicate
schema and DROPS non-conforming ones. The LLM never writes to the DB and never sets
status='active' — every candidate is stamped status='draft', provenance='ai_proposed'.

`heuristic_risk` flags a candidate that the live state ALREADY violates: confirming it would
codify a current misconfig as 'intended'. The admin must review such candidates deliberately."""
import json
import re

from . import invariants as inv
from .report import _bedrock_render, _redact

_SEVERITIES = ("info", "warning", "critical")

# Per-kind required keys. Edge kinds need from+to in params; target kinds need a `target`.
_EDGE_KINDS = ("forbidden_edge", "expected_edge", "max_error_rate")
_TARGET_KINDS = ("private_only", "no_public_ingress", "encryption_required")


def validate_candidate(c):
    """Return a normalized candidate dict if it is schema-valid, else None. Pure, no side effects."""
    if not isinstance(c, dict):
        return None
    kind = c.get("kind")
    if kind not in inv.KINDS:
        return None
    params = c.get("params") or {}
    if not isinstance(params, dict):
        return None
    if kind in _EDGE_KINDS and not (params.get("from") and params.get("to")):
        return None
    target = c.get("target")
    if kind in _TARGET_KINDS and not target:
        return None
    severity = c.get("severity", "warning")
    if severity not in _SEVERITIES:
        return None
    return {"kind": kind, "target": target, "params": params, "severity": severity}


def flag_heuristic_risk(c, actual):
    """True when the candidate would FAIL against the live state right now — i.e. confirming it
    would codify a CURRENT misconfig. Re-uses the pure deterministic evaluator."""
    verdict = inv.evaluate_all([c], actual)[0]
    return verdict.get("passed") is False


def _extract_json_array(text):
    """Best-effort: parse a JSON array, tolerating LLM prose around it."""
    text = (text or "").strip()
    try:
        v = json.loads(text)
        return v if isinstance(v, list) else []
    except (ValueError, TypeError):
        pass
    m = re.search(r"\[.*\]", text, re.DOTALL)
    if m:
        try:
            v = json.loads(m.group(0))
            return v if isinstance(v, list) else []
        except (ValueError, TypeError):
            return []
    return []


_PROPOSE_PROMPT = (
    "아래 자동 토폴로지(서비스맵 엣지/인벤토리)를 보고 운영자가 '의도한 불변식(invariant)' 후보를 제안하라. "
    "오직 JSON 배열만 출력하라 — 설명/마크다운 금지. 각 원소는 다음 kind 중 하나여야 한다: "
    f"{', '.join(inv.KINDS)}. "
    "edge 계열(forbidden_edge/expected_edge/max_error_rate)은 params={{from,to(,threshold)}}, "
    "target 계열(private_only/no_public_ingress/encryption_required)은 target=resource_type 를 포함하라. "
    "severity ∈ {info,warning,critical}. 새 불변식을 활성화하지 마라 — 너는 후보만 제안한다."
)


def propose(actual, model=None):
    """Ask Bedrock for candidate invariants, then validate+drop invalid, attach heuristic_risk,
    provenance='ai_proposed', status='draft'. The LLM never activates anything."""
    ctx_json = _redact(json.dumps(actual, ensure_ascii=False, default=str))
    raw = _bedrock_render(_PROPOSE_PROMPT, ctx_json)
    out = []
    for c in _extract_json_array(raw):
        valid = validate_candidate(c)
        if valid is None:
            continue
        valid["heuristic_risk"] = flag_heuristic_risk(valid, actual)
        valid["provenance"] = "ai_proposed"
        valid["status"] = "draft"  # LLM can never smuggle in 'active'
        out.append(valid)
    return out
