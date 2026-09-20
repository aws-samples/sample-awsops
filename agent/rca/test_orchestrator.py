import sys
from pathlib import Path

import pytest

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


@pytest.mark.parametrize("requested", ["ec2:x", "x"])
def test_handle_rca_returns_result_when_enabled(monkeypatch, requested):
    o = load_orchestrator()
    monkeypatch.setenv("RCA_ORCHESTRATOR_ENABLED", "true")
    monkeypatch.setattr(o, "_open_clients", lambda stack, keys: {})

    class FakeTools:
        def __init__(self, clients):
            self.clients = clients

        def topology_edges(self, resource_id):
            assert resource_id == requested
            return {"edges": [{"source": "ec2:x", "target": "rds:db"}],
                    "selection": {"status": "resolved", "requested_id": requested, "resolved_id": "ec2:x"},
                    "truncation": {"nodes": False, "edges": True}, "warning": "bounded graph"}

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

    out = o.handle_rca({"incident_id": "i1", "failing_entity": requested})

    assert out["incident_id"] == "i1"
    assert out["root_causes"] == ["rds:db"]
    assert "rca" in out
    assert out["rca"]["failing_entity"] == "ec2:x"
    assert out["topology"]["selection"]["requested_id"] == requested
    assert out["topology"]["truncation"]["edges"] is True
    assert out["topology"]["warning"] == "bounded graph"
    assert not hasattr(o, "write_rca")
