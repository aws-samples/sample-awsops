"""1-hop neighbor derivation over a resource/service edge list (ADR: EoG bounded-neighborhood)."""

def neighbors(entity_id, edges):
    out = set()
    for e in edges:
        s, t = e.get("source"), e.get("target")
        if s == entity_id and t:
            out.add(t)
        elif t == entity_id and s:
            out.add(s)
    out.discard(entity_id)
    return sorted(out)
