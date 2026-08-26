from rca.controller import run_rca

def test_run_rca_visits_entity_plus_neighbors_once_deterministic():
    edges = [{"source": "alb:a", "target": "ec2:x"}, {"source": "ec2:x", "target": "rds:db"}]
    visited = []
    def gather(n):
        visited.append(n)
        return {"node": n}
    def label(n, ev):
        return {"label": "cause" if n == "rds:db" else "symptom", "rationale": n}
    out = run_rca("ec2:x", edges, gather, label)
    assert visited == ["ec2:x", "alb:a", "rds:db"]      # entity first, then sorted neighbors, once each
    assert out["root_causes"] == ["rds:db"]
    assert [n["node"] for n in out["nodes"]] == ["ec2:x", "alb:a", "rds:db"]
