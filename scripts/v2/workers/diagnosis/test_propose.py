import json

from diagnosis import propose


# --- validate_candidate (anti-fabrication boundary) ----------------------

def test_validate_drops_unknown_kind():
    assert propose.validate_candidate({"kind": "rm -rf", "params": {}}) is None


def test_validate_keeps_wellformed():
    c = propose.validate_candidate(
        {"kind": "expected_edge", "params": {"from": "api", "to": "rds"}, "severity": "warning"})
    assert c["kind"] == "expected_edge"
    assert c["params"]["from"] == "api"


def test_validate_drops_edge_kind_missing_params():
    assert propose.validate_candidate({"kind": "forbidden_edge", "params": {"from": "api"}}) is None
    assert propose.validate_candidate({"kind": "expected_edge", "params": {}}) is None
    assert propose.validate_candidate({"kind": "max_error_rate", "params": {"from": "a"}}) is None


def test_validate_drops_target_kind_missing_target():
    assert propose.validate_candidate({"kind": "private_only", "params": {}}) is None
    assert propose.validate_candidate({"kind": "encryption_required", "params": {}}) is None


def test_validate_keeps_target_kind_with_target():
    c = propose.validate_candidate({"kind": "private_only", "target": "rds-prod", "params": {}})
    assert c is not None and c["target"] == "rds-prod"


def test_validate_defaults_severity_and_rejects_bad_severity():
    c = propose.validate_candidate({"kind": "private_only", "target": "x", "params": {}})
    assert c["severity"] == "warning"
    assert propose.validate_candidate(
        {"kind": "private_only", "target": "x", "params": {}, "severity": "boom"}) is None


# --- flag_heuristic_risk -------------------------------------------------

def test_heuristic_risk_on_current_misconfig():
    actual = {"service_map": {"edges": [{"from": "internet", "to": "rds", "error_rate": 0}]}}
    c = {"kind": "private_only", "target": "rds", "params": {}}
    assert propose.flag_heuristic_risk(c, actual) is True


def test_heuristic_risk_false_when_currently_compliant():
    actual = {"service_map": {"edges": [{"from": "api", "to": "rds", "error_rate": 0}]}}
    c = {"kind": "private_only", "target": "rds", "params": {}}
    assert propose.flag_heuristic_risk(c, actual) is False


# --- propose (LLM proposes, never activates) -----------------------------

def test_propose_validates_drops_and_decorates(monkeypatch):
    actual = {"service_map": {"edges": [
                  {"from": "internet", "to": "rds", "error_rate": 0},
                  {"from": "api", "to": "rds", "error_rate": 0}]},
              "inventory": {"by_type": {"rds": 1}}}
    llm_out = json.dumps([
        {"kind": "private_only", "target": "rds", "params": {}},      # valid + currently violated
        {"kind": "expected_edge", "params": {"from": "api", "to": "rds"}},  # valid
        {"kind": "DROP TABLE", "params": {}},                          # invalid → dropped
        {"kind": "forbidden_edge", "params": {"from": "a"}},          # missing param → dropped
    ])
    monkeypatch.setattr(propose, "_bedrock_render", lambda prompt, ctx: llm_out)
    out = propose.propose(actual, model="x")
    assert len(out) == 2
    by_kind = {c["kind"]: c for c in out}
    assert by_kind["private_only"]["heuristic_risk"] is True
    assert by_kind["expected_edge"]["heuristic_risk"] is False
    for c in out:
        assert c["provenance"] == "ai_proposed"
        assert c["status"] == "draft"


def test_propose_tolerates_non_json_llm_output(monkeypatch):
    monkeypatch.setattr(propose, "_bedrock_render", lambda prompt, ctx: "sorry I cannot")
    assert propose.propose({"service_map": {"edges": []}}, model="x") == []


def test_propose_extracts_json_array_from_prose(monkeypatch):
    wrapped = 'Here are the candidates:\n[{"kind":"private_only","target":"rds","params":{}}]\nDone.'
    monkeypatch.setattr(propose, "_bedrock_render", lambda prompt, ctx: wrapped)
    out = propose.propose({"service_map": {"edges": []}}, model="x")
    assert len(out) == 1 and out[0]["kind"] == "private_only"


def test_propose_never_sets_active(monkeypatch):
    llm_out = json.dumps([{"kind": "private_only", "target": "rds", "params": {}, "status": "active"}])
    monkeypatch.setattr(propose, "_bedrock_render", lambda prompt, ctx: llm_out)
    out = propose.propose({"service_map": {"edges": []}}, model="x")
    assert out[0]["status"] == "draft"  # LLM cannot smuggle in an active status
