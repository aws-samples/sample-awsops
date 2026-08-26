"""AWSops v2 ADR-032 — correlation engine (Python core).

PORTED from src/lib/alert-correlation.ts `findCorrelatedIncident` (v1, in-memory Map) into a
STATELESS Aurora query: the active set is the look-back window read live from `incidents`, so
there is no in-process state to lose on a Lambda cold start / retry. The v1 rules are preserved:

  Rule 1 (strongest): shared RESOURCE  -> Linked
  Rule 2:             shared SERVICE within the look-back window -> Linked
  Rule 3:             shared NAMESPACE within the window         -> Linked
  else                                                           -> New

A below-min-severity event is Skipped before any look-back (storm control #7). The dedup-race
UNIQUE winner is decided by web/lib/incident.ts INSERT … ON CONFLICT — `classify` only advises
the orchestrator; it performs NO writes.

`find_similar` is the lexical Jaccard scorer ported from src/lib/alert-knowledge.ts. It is the
SINGLE swappable pgvector seam (ADR-032 plan): when pgvector lands, replace this one function with
an embedding nearest-neighbour query and nothing else changes.

SAFETY: this module is read-only over `incidents`; it never executes a mutation and never reads or
returns any tool-permission / sub-agent-roster / approval surface — only descriptive correlation.
"""
import datetime

# Active set = incidents still open within the look-back window. Mirrors the plan's query exactly.
_ACTIVE_SQL = (
    "SELECT id, correlation_key, services, resources, first_event_at, severity "
    "FROM incidents "
    "WHERE status IN ('triaged','investigating') "
    "AND last_event_at > now() - (:window || ' minutes')::interval "
    "ORDER BY last_event_at DESC"
)

_SEVERITY_RANK = {"critical": 3, "warning": 2, "info": 1}


def _rank(sev):
    return _SEVERITY_RANK.get((sev or "").lower(), 1)


def _namespace_tokens(event):
    """Namespace signal from the event labels (Rule 3). incident-normalize folds namespace into
    services as `Namespace` / `namespace/app`, so we treat the bare namespace as a service token."""
    labels = event.get("labels") or {}
    out = set()
    for k in ("namespace", "Namespace"):
        v = labels.get(k)
        if v:
            out.add(v)
    return out


def _active_set(conn, window_min):
    rows = conn.run(_ACTIVE_SQL, window=str(int(window_min)))
    out = []
    for r in rows:
        out.append({
            "id": r[0],
            "correlation_key": r[1],
            "services": list(r[2] or []),
            "resources": list(r[3] or []),
            "first_event_at": r[4],
            "severity": r[5],
        })
    return out


def classify(conn, event, window_min, min_severity="warning"):
    """Return (decision, matched_incident_id) where decision ∈ {New, Linked, Skipped}.

    Stateless: the active set is read fresh from Aurora each call (no in-memory incidents Map).
    Applies the v1 rules in priority order over that set. `min_severity` is the storm-control
    gate (#7); the orchestrator passes the SSM-configured value (NOT a hardcoded constant).
    """
    if _rank(event.get("severity")) < _rank(min_severity):
        return ("Skipped", None)

    ev_services = set(event.get("services") or []) | _namespace_tokens(event)
    ev_resources = set(event.get("resources") or [])

    active = _active_set(conn, window_min)

    # Rule 1: shared resource — strongest signal. (v1 returned immediately on any resource overlap.)
    for inc in active:
        if ev_resources & set(inc["resources"]):
            return ("Linked", inc["id"])

    # Rule 2/3: shared service OR namespace within the look-back window. The window is already
    # applied by the active-set SELECT (last_event_at > now() - window), so any overlap links.
    for inc in active:
        if ev_services & set(inc["services"]):
            return ("Linked", inc["id"])

    return ("New", None)


# ---------------------------------------------------------------------------
# find_similar — lexical Jaccard scorer (the swappable pgvector seam).
# Ported from src/lib/alert-knowledge.ts service/label overlap scoring, reduced to a pure
# token-bag Jaccard so it has no external store dependency.
# ---------------------------------------------------------------------------

def _jaccard(a, b):
    a, b = set(a), set(b)
    if not a and not b:
        return 0.0
    union = a | b
    if not union:
        return 0.0
    return len(a & b) / len(union)


def _tokens(services, resources, name=None):
    bag = set()
    for s in services or []:
        bag.add(str(s).lower())
    for r in resources or []:
        bag.add(str(r).lower())
    if name:
        bag.add(str(name).lower())
    return bag


def find_similar(conn, event, limit=3, window_min=20):
    """Rank active incidents by lexical similarity to `event`. Returns
    [{id, correlation_key, score}] sorted desc, capped at `limit`. Score > 0 only.

    This is the ONE function to replace when pgvector lands (embedding cosine NN); the call site
    (the Lead/Triage) stays unchanged. Read-only.
    """
    active = _active_set(conn, window_min)
    ev_bag = _tokens(event.get("services"), event.get("resources"), event.get("alertName"))
    scored = []
    for inc in active:
        bag = _tokens(inc["services"], inc["resources"])
        score = _jaccard(ev_bag, bag)
        if score > 0.0:
            scored.append({"id": inc["id"], "correlation_key": inc["correlation_key"], "score": score})
    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored[: int(limit)]
