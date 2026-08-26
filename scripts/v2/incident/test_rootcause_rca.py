import hashlib
import json
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "workers"))

import agent_bridge  # noqa: E402
import rootcause  # noqa: E402


class FakeConn:
    def __init__(self, incident):
        self.incident = incident
        self.calls = []
        self.closed = False
        self.findings = []
        self.stages = []
        self._stage_seq = 0

    def run(self, sql, **params):
        self.calls.append((sql, params))
        normalized = " ".join(sql.split()).lower()
        if normalized.startswith("select id, services, resources from incidents"):
            return [[self.incident["id"], self.incident.get("services"), self.incident.get("resources")]]
        if normalized.startswith("select rca from incidents"):
            return [[self.incident.get("rca")]]
        if normalized.startswith("insert into incident_stages"):
            for stage in self.stages:
                if stage["incident_id"] == params["iid"] and stage["idem"] == params["ik"]:
                    return []
            self._stage_seq += 1
            self.stages.append({
                "id": self._stage_seq,
                "incident_id": params["iid"],
                "idem": params["ik"],
            })
            return [[self._stage_seq]]
        if normalized.startswith("insert into incident_findings"):
            self.findings.append({
                "incident_id": params["iid"],
                "sub_agent": "rca-orchestrator",
                "findings": json.loads(params["f"]),
            })
            return []
        if normalized.startswith("update incidents set rca"):
            self.incident["rca"] = json.loads(params["rca"])
            self.incident["status"] = "root_cause"
            return [[params["iid"]]]
        return []

    def close(self):
        self.closed = True


def _sql(conn):
    return "\n".join(" ".join(sql.split()).lower() for sql, _ in conn.calls)


def test_rca_orchestrator_branch_invokes_agent_and_persists(monkeypatch):
    conn = FakeConn({"id": "i1", "services": ["ec2:x"], "resources": []})
    monkeypatch.setenv("RCA_ORCHESTRATOR_ENABLED", "true")
    monkeypatch.setattr(rootcause.db, "connect", lambda: conn)

    invocations = []

    def fake_invoke(*args, **kwargs):
        invocations.append({"args": args, "kwargs": kwargs})
        return json.dumps({
            "incident_id": "i1",
            "rca": {
                "failing_entity": "ec2:x",
                "nodes": [{"node": "rds:db", "label": "cause", "rationale": "r"}],
                "root_causes": ["rds:db"],
            },
        })

    monkeypatch.setattr(agent_bridge, "invoke", fake_invoke)

    out = rootcause.lambda_handler({"job_id": "j1", "incident_id": "i1"}, None)

    assert out == {
        "incident_id": "i1",
        "rca": {
            "failing_entity": "ec2:x",
            "nodes": [{"node": "rds:db", "label": "cause", "rationale": "r"}],
            "root_causes": ["rds:db"],
        },
    }
    assert invocations[0]["kwargs"]["mode"] == "rca"
    assert invocations[0]["kwargs"]["incident_id"] == "i1"
    assert invocations[0]["kwargs"]["failing_entity"] == "ec2:x"

    executed = _sql(conn)
    assert "insert into incident_findings" in executed
    assert "sub_agent" in executed
    assert "rca-orchestrator" in json.dumps([params for _, params in conn.calls])
    assert "update incidents set rca" in executed
    assert "status='root_cause'" in executed or "status = 'root_cause'" in executed
    assert "insert into incident_stages" in executed
    assert "stage_idempotency_key" in executed
    assert "on conflict (incident_id, stage_idempotency_key) do nothing" in executed
    assert hashlib.sha256(b"i1:rca").hexdigest() in json.dumps([params for _, params in conn.calls])
    assert conn.closed


def test_rca_orchestrator_retry_does_not_duplicate_findings(monkeypatch):
    conn = FakeConn({"id": "i1", "services": ["ec2:x"], "resources": []})
    rca = {
        "failing_entity": "ec2:x",
        "nodes": [{"node": "rds:db", "label": "cause", "rationale": "r"}],
        "root_causes": ["rds:db"],
    }

    monkeypatch.setattr(agent_bridge, "invoke", lambda *args, **kwargs: json.dumps({"rca": rca}))

    first = rootcause._run_orchestrator(conn, {"job_id": "j1"}, "i1")
    second = rootcause._run_orchestrator(conn, {"job_id": "j1"}, "i1")

    assert first == {"incident_id": "i1", "rca": rca}
    assert second == {"incident_id": "i1", "rca": rca}
    assert len(conn.findings) == 1


def test_rca_orchestrator_failed_invoke_writes_no_idempotency_rows(monkeypatch):
    conn = FakeConn({"id": "i1", "services": ["ec2:x"], "resources": []})

    def fail_invoke(*args, **kwargs):
        raise RuntimeError("transient")

    monkeypatch.setattr(agent_bridge, "invoke", fail_invoke)

    with pytest.raises(RuntimeError, match="transient"):
        rootcause._run_orchestrator(conn, {"job_id": "j1"}, "i1")

    assert conn.stages == []
    assert conn.findings == []
