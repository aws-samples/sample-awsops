"""Deterministic intended-vs-actual evaluator. PURE — no LLM, no AWS. The LLM never calls this;
it only runs admin-promoted invariants against the Plan-1 'actual' collector output. A verdict
(passed True/False/None + observed string + severity) is the ONLY thing handed to the report LLM.

`actual` shape (assembled in report.generate from the Plan-1 collectors):
  {"service_map": {"edges": [{"from","to","calls","error_rate"}, ...]},
   "inventory": {"by_type": {...}, "unencrypted": {type: count}},
   "_sources": {collector_key: {ok, degraded, notes, ...}}}

Only complete, usable evidence can pass. Observed violations can fail even with partial coverage.
Unresolved X-Ray `to_ref` edges and inventory samples without encryption aggregates are unknown.

Fixed predicate `kind` enum (§4.2-KB / §8R3). Adding a kind = one branch + tests. An unknown
kind or a malformed invariant yields passed=None (never crashes a report)."""
import math


def _data(actual, key):
    data = actual.get(key)
    return data if isinstance(data, dict) else {}


def _complete(actual, key):
    """Honor collector and payload quality markers; missing metadata is not success.

    Direct callers may still supply the original data-only shape. The report always supplies
    _sources, where an absent/malformed collector or missing ok flag must fail closed.
    """
    data = _data(actual, key)
    if not data:
        return False
    quality = [data]
    if "_sources" in actual:
        sources = actual["_sources"]
        source = sources.get(key) if isinstance(sources, dict) else None
        if not isinstance(source, dict) or source.get("ok") is not True:
            return False
        quality.append(source)
    for item in quality:
        if "ok" in item and item["ok"] is not True:
            return False
        if any(flag in item and item[flag] is not False
               for flag in ("degraded", "partial", "stale", "truncated", "_truncated", "_failed")):
            return False
        if "status" in item and item["status"] not in ("ok", "healthy", "succeeded"):
            return False
        if "freshness" in item and item["freshness"] != "healthy":
            return False
    return True


def _name(value):
    return isinstance(value, str) and bool(value.strip())


def _edges(actual):
    raw = _data(actual, "service_map").get("edges")
    if not isinstance(raw, list):
        return [], False
    edges = [e for e in raw if isinstance(e, dict) and _name(e.get("from")) and _name(e.get("to"))]
    return edges, bool(edges) and len(edges) == len(raw) and _complete(actual, "service_map")


def _unknown(v, reason):
    return _verdict(v, None, f"unknown: {reason}")


def _verdict(v, passed, observed):
    return {"id": v.get("id"), "kind": v.get("kind"), "target": v.get("target"),
            "severity": v.get("severity", "warning"), "passed": passed, "observed": observed}


def _private_only(v, actual):
    # fail if the target is reachable directly from the internet (a public ingress edge exists)
    edges, complete = _edges(actual)
    bad = [e for e in edges if e["to"] == v["target"] and e["from"] == "internet"]
    if not bad and (not complete or not any(e["to"] == v["target"] for e in edges)):
        return _unknown(v, "complete ingress evidence for target unavailable")
    return _verdict(v, not bad,
                    f"internet→{v.get('target')} edges: {len(bad)}" if bad else "no internet ingress")


def _forbidden_edge(v, actual):
    f, t = v["params"].get("from"), v["params"].get("to")
    edges, complete = _edges(actual)
    hit = [e for e in edges if e["from"] == f and e["to"] == t]
    names = {e[k] for e in edges for k in ("from", "to")}
    if not hit and (not complete or f not in names or t not in names):
        return _unknown(v, "complete edge evidence for endpoints unavailable")
    return _verdict(v, not hit,
                    f"forbidden edge {f}→{t} present" if hit else f"{f}→{t} absent (ok)")


def _expected_edge(v, actual):
    f, t = v["params"].get("from"), v["params"].get("to")
    edges, complete = _edges(actual)
    if not complete:
        return _unknown(v, "complete service map unavailable")
    hit = [e for e in edges if e["from"] == f and e["to"] == t]
    return _verdict(v, bool(hit),
                    f"expected edge {f}→{t} present" if hit else f"MISSING expected edge {f}→{t}")


def _max_error_rate(v, actual):
    f, t = v["params"].get("from"), v["params"].get("to")
    thr = v["params"].get("threshold", 0.05)
    if not _number(thr) or not 0 <= thr <= 1:
        return _unknown(v, "invalid error-rate threshold")
    edges, complete = _edges(actual)
    matched = [e for e in edges if e["from"] == f and e["to"] == t]
    measured = [e for e in matched if _number(e.get("error_rate")) and 0 <= e["error_rate"] <= 1
                and _number(e.get("calls")) and e["calls"] > 0]
    over = [e for e in measured if e["error_rate"] > thr]
    if not over and (not complete or not measured or len(measured) != len(matched)):
        return _unknown(v, "complete error-rate observations unavailable")
    return _verdict(v, not over,
                    f"{f}→{t} error_rate {over[0]['error_rate']} > {thr}" if over else f"under {thr}")


def _number(value):
    return type(value) in (int, float) and math.isfinite(value)


def _encryption_required(v, actual):
    # fail if any instance of the target resource_type is unencrypted (collector reports counts)
    counts = _data(actual, "inventory").get("unencrypted")
    unenc = counts.get(v["target"]) if isinstance(counts, dict) else None
    if type(unenc) is not int or unenc < 0:
        return _unknown(v, "explicit encryption aggregate for target unavailable")
    if unenc == 0 and not _complete(actual, "inventory"):
        return _unknown(v, "complete encryption evidence unavailable")
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
        if not isinstance(v, dict):
            out.append(_unknown({}, "malformed invariant"))
            continue
        kind = v.get("kind")
        fn = _EVALUATORS.get(kind) if isinstance(kind, str) else None
        if not fn:
            out.append(_verdict(v, None, f"unsupported kind: {v.get('kind')}"))
            continue
        try:
            if v["kind"] in ("private_only", "no_public_ingress", "encryption_required"):
                if not _name(v.get("target")):
                    out.append(_unknown(v, "missing target"))
                    continue
            elif not all(_name(v["params"].get(k)) for k in ("from", "to")):
                out.append(_unknown(v, "missing edge endpoints"))
                continue
            out.append(fn(v, actual))
        except Exception as e:  # noqa: BLE001 — a bad invariant must not crash a report
            out.append(_unknown(v, f"eval error: {e}"))
    return out
