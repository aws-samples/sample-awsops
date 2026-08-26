import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def load_orchestrator():
    try:
        import rca_orchestrator
    except ModuleNotFoundError as exc:
        raise AssertionError("rca_orchestrator module is missing") from exc
    return rca_orchestrator


def test_handle_rca_disabled_by_default(monkeypatch):
    monkeypatch.delenv("RCA_ORCHESTRATOR_ENABLED", raising=False)
    o = load_orchestrator()

    assert o.handle_rca({"incident_id": "i1", "failing_entity": "ec2:x"}) == {"disabled": True}


def test_handle_rca_returns_result_when_enabled(monkeypatch):
    o = load_orchestrator()
    monkeypatch.setenv("RCA_ORCHESTRATOR_ENABLED", "true")
    monkeypatch.setattr(o, "_open_clients", lambda stack, keys: {})

    class FakeTools:
        def __init__(self, clients):
            self.clients = clients

        def topology_edges(self):
            return [{"source": "ec2:x", "target": "rds:db"}]

        def gather(self, node_id):
            return {"node": node_id}

    monkeypatch.setattr(o, "BoundedTools", FakeTools)
    monkeypatch.setattr(
        o,
        "label_node",
        lambda n, ev, inv: {
            "label": "cause" if n == "rds:db" else "symptom",
            "rationale": n,
        },
    )

    out = o.handle_rca({"incident_id": "i1", "failing_entity": "ec2:x"})

    assert out["incident_id"] == "i1"
    assert out["root_causes"] == ["rds:db"]
    assert "rca" in out
    assert not hasattr(o, "write_rca")
