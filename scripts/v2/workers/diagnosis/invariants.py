"""Deterministic intended-vs-actual evaluator. PURE — no LLM, no AWS. The LLM never calls this;
it only runs admin-promoted invariants against the Plan-1 'actual' collector output. A verdict
(passed True/False/None + observed string + severity) is the ONLY thing handed to the report LLM.

`actual` shape (assembled in report.generate from the Plan-1 collectors):
  {"service_map": {"edges": [{"from","to","calls","error_rate"}, ...]},
   "inventory": {"by_type": {...}, "unencrypted": {type: count}}}

Fixed predicate `kind` enum (§4.2-KB / §8R3). Adding a kind = one branch + tests. An unknown
kind or a malformed invariant yields passed=None (never crashes a report)."""


def _edges(actual):
    return (actual.get("service_map") or {}).get("edges", [])


def _verdict(v, passed, observed):
    return {"id": v.get("id"), "kind": v["kind"], "target": v.get("target"),
            "severity": v.get("severity", "warning"), "passed": passed, "observed": observed}


def _private_only(v, actual):
    # fail if the target is reachable directly from the internet (a public ingress edge exists)
    bad = [e for e in _edges(actual) if e.get("to") == v.get("target") and e.get("from") == "internet"]
    return _verdict(v, not bad,
                    f"internet→{v.get('target')} edges: {len(bad)}" if bad else "no internet ingress")


def _forbidden_edge(v, actual):
    f, t = v["params"].get("from"), v["params"].get("to")
    hit = [e for e in _edges(actual) if e.get("from") == f and e.get("to") == t]
    return _verdict(v, not hit,
                    f"forbidden edge {f}→{t} present" if hit else f"{f}→{t} absent (ok)")


def _expected_edge(v, actual):
    f, t = v["params"].get("from"), v["params"].get("to")
    hit = [e for e in _edges(actual) if e.get("from") == f and e.get("to") == t]
    return _verdict(v, bool(hit),
                    f"expected edge {f}→{t} present" if hit else f"MISSING expected edge {f}→{t}")


def _max_error_rate(v, actual):
    f, t = v["params"].get("from"), v["params"].get("to")
    thr = float(v["params"].get("threshold", 0.05))
    over = [e for e in _edges(actual)
            if e.get("from") == f and e.get("to") == t and (e.get("error_rate") or 0) > thr]
    return _verdict(v, not over,
                    f"{f}→{t} error_rate {over[0]['error_rate']} > {thr}" if over else f"under {thr}")


def _encryption_required(v, actual):
    # fail if any instance of the target resource_type is unencrypted (collector reports counts)
    unenc = ((actual.get("inventory") or {}).get("unencrypted") or {}).get(v.get("target"), 0)
    return _verdict(v, not unenc,
                    f"{unenc} unencrypted {v.get('target')}" if unenc else f"all {v.get('target')} encrypted")


_EVALUATORS = {
    "private_only": _private_only, "no_public_ingress": _private_only,
    "forbidden_edge": _forbidden_edge, "expected_edge": _expected_edge,
    "max_error_rate": _max_error_rate, "encryption_required": _encryption_required,
}

# The allowed predicate kinds (single source of truth shared with propose.py).
KINDS = tuple(_EVALUATORS.keys())


def evaluate_all(invariants, actual):
    out = []
    for v in invariants:
        fn = _EVALUATORS.get(v.get("kind"))
        if not fn:
            out.append(_verdict(v, None, f"unsupported kind: {v.get('kind')}"))
            continue
        try:
            out.append(fn(v, actual))
        except Exception as e:  # noqa: BLE001 — a bad invariant must not crash a report
            out.append(_verdict(v, None, f"eval error: {e}"))
    return out
