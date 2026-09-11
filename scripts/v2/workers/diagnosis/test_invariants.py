import pytest

from diagnosis import invariants as inv

ACTUAL = {
    "service_map": {"edges": [
        {"from": "internet", "to": "rds-prod", "calls": 5, "error_rate": 0.0},
        {"from": "api", "to": "rds-prod", "calls": 900, "error_rate": 0.12},
    ]},
    "inventory": {"by_type": {"rds": 2, "s3": 5}},
}


def test_private_only_fails_on_internet_edge():
    v = {"id": 1, "kind": "private_only", "target": "rds-prod", "params": {}, "severity": "critical"}
    out = inv.evaluate_all([v], ACTUAL)
    assert out[0]["passed"] is False and out[0]["severity"] == "critical"
    assert "internet" in out[0]["observed"]


def test_private_only_passes_without_internet_edge():
    v = {"id": 10, "kind": "private_only", "target": "rds-prod", "params": {}, "severity": "critical"}
    out = inv.evaluate_all([v], {"service_map": {"edges": [
        {"from": "api", "to": "rds-prod", "calls": 1, "error_rate": 0.0}]}})
    assert out[0]["passed"] is True


def test_no_public_ingress_alias_of_private_only():
    v = {"id": 11, "kind": "no_public_ingress", "target": "rds-prod", "params": {}}
    out = inv.evaluate_all([v], ACTUAL)
    assert out[0]["passed"] is False


def test_forbidden_edge_fails_when_present():
    v = {"id": 12, "kind": "forbidden_edge", "params": {"from": "internet", "to": "rds-prod"}}
    out = inv.evaluate_all([v], ACTUAL)
    assert out[0]["passed"] is False


def test_forbidden_edge_passes_when_absent():
    v = {"id": 13, "kind": "forbidden_edge", "params": {"from": "api", "to": "internet"}}
    out = inv.evaluate_all([v], ACTUAL)
    assert out[0]["passed"] is True


def test_expected_edge_fails_when_absent():
    v = {"id": 14, "kind": "expected_edge", "params": {"from": "api", "to": "cache"}}
    out = inv.evaluate_all([v], ACTUAL)
    assert out[0]["passed"] is False and "MISSING" in out[0]["observed"]


def test_expected_edge_passes_when_present():
    v = {"id": 15, "kind": "expected_edge", "params": {"from": "api", "to": "rds-prod"}}
    out = inv.evaluate_all([v], ACTUAL)
    assert out[0]["passed"] is True


def test_max_error_rate_trips():
    v = {"id": 2, "kind": "max_error_rate", "params": {"from": "api", "to": "rds-prod", "threshold": 0.05}, "severity": "warning"}
    out = inv.evaluate_all([v], ACTUAL)
    assert out[0]["passed"] is False


def test_max_error_rate_under_threshold_passes():
    v = {"id": 16, "kind": "max_error_rate", "params": {"from": "internet", "to": "rds-prod", "threshold": 0.05}}
    out = inv.evaluate_all([v], ACTUAL)
    assert out[0]["passed"] is True


def test_encryption_required_fails_on_unencrypted():
    actual = {"inventory": {"unencrypted": {"rds": 2}}}
    v = {"id": 17, "kind": "encryption_required", "target": "rds", "params": {}}
    out = inv.evaluate_all([v], actual)
    assert out[0]["passed"] is False


def test_encryption_required_passes_when_none_unencrypted():
    actual = {"inventory": {"unencrypted": {"rds": 0}}}
    v = {"id": 18, "kind": "encryption_required", "target": "rds", "params": {}}
    out = inv.evaluate_all([v], actual)
    assert out[0]["passed"] is True


def test_unknown_kind_is_skipped_not_crash():
    out = inv.evaluate_all([{"id": 3, "kind": "bogus", "params": {}}], ACTUAL)
    assert out[0]["passed"] is None and "unsupported" in out[0]["observed"].lower()


def test_bad_invariant_does_not_crash():
    # missing params for an edge kind → caught, verdict passed=None
    out = inv.evaluate_all([{"id": 4, "kind": "forbidden_edge"}], ACTUAL)
    assert out[0]["passed"] is None


def test_verdict_shape_is_stable():
    out = inv.evaluate_all([{"id": 5, "kind": "private_only", "target": "rds-prod"}], ACTUAL)
    assert set(out[0]) == {"id", "kind", "target", "severity", "passed", "observed"}


def _rule(kind):
    return {"id": 20, "kind": kind, "target": "rds",
            "params": {"from": "api", "to": "rds", "threshold": 0.05}}


@pytest.mark.parametrize("kind", inv.KINDS)
@pytest.mark.parametrize("actual", [{}, {"service_map": {}, "inventory": {}},
                                   {"service_map": {"edges": []},
                                    "inventory": {"unencrypted": {}}}])
def test_missing_or_empty_evidence_is_unknown(kind, actual):
    verdict = inv.evaluate_all([_rule(kind)], actual)[0]
    assert verdict["passed"] is None
    assert "unknown" in verdict["observed"].lower()


@pytest.mark.parametrize("kind", inv.KINDS)
@pytest.mark.parametrize("status", [
    {"ok": False}, {"degraded": True}, {"partial": True}, {"stale": True},
    {"status": "partial"}, {"freshness": "stale"}, {"truncated": True},
])
def test_incomplete_source_never_passes(kind, status):
    # The edge is present/healthy and the encryption count explicitly zero,
    # but incomplete coverage cannot support a healthy verdict.
    actual = {"service_map": {"edges": [{"from": "api", "to": "rds", "calls": 4, "error_rate": 0}]},
              "inventory": {"unencrypted": {"rds": 0}},
              "_sources": {key: {"ok": True, "degraded": False, **status}
                           for key in ("service_map", "inventory")}}
    rule = _rule(kind)
    if kind == "forbidden_edge":
        rule["params"] = {"from": "rds", "to": "api"}
    assert inv.evaluate_all([rule], actual)[0]["passed"] is None


@pytest.mark.parametrize("kind", ["private_only", "no_public_ingress", "forbidden_edge",
                                 "max_error_rate", "encryption_required"])
def test_observed_violation_survives_partial_coverage(kind):
    actual = {"service_map": {"edges": [None, {"from": "internet", "to": "rds"},
                                        {"from": "api", "to": "rds", "calls": 10, "error_rate": 0.2}]},
              "inventory": {"unencrypted": {"rds": 2}, "truncated": True},
              "_sources": {"service_map": {"ok": True, "degraded": True, "notes": "partial"}}}
    assert inv.evaluate_all([_rule(kind)], actual)[0]["passed"] is False


@pytest.mark.parametrize("rate", [None, "", "0", True, -0.1, 1.1, float("nan"), float("inf")])
def test_malformed_rate_is_not_observed_zero(rate):
    actual = {"service_map": {"edges": [{"from": "api", "to": "rds", "calls": 4, "error_rate": rate}]}}
    assert inv.evaluate_all([_rule("max_error_rate")], actual)[0]["passed"] is None


@pytest.mark.parametrize("calls", [None, 0, -1, True, "4", float("nan")])
def test_zero_rate_requires_observed_calls(calls):
    actual = {"service_map": {"edges": [{"from": "api", "to": "rds", "calls": calls, "error_rate": 0}]}}
    assert inv.evaluate_all([_rule("max_error_rate")], actual)[0]["passed"] is None


def test_missing_rate_is_unknown_but_observed_zero_passes():
    edge = {"from": "api", "to": "rds", "calls": 10}
    actual = {"service_map": {"edges": [edge]}}
    assert inv.evaluate_all([_rule("max_error_rate")], actual)[0]["passed"] is None
    edge["error_rate"] = 0.0
    assert inv.evaluate_all([_rule("max_error_rate")], actual)[0]["passed"] is True


@pytest.mark.parametrize("kind", inv.KINDS)
def test_malformed_invariant_is_unknown(kind):
    assert inv.evaluate_all([{"kind": kind, "params": {}}], ACTUAL)[0]["passed"] is None


def test_missing_kind_is_unknown_not_exception():
    assert inv.evaluate_all([{"params": {}}], ACTUAL)[0]["passed"] is None


@pytest.mark.parametrize("rule", [None, [], {"kind": []}, {"kind": {}}])
def test_malformed_rule_does_not_abort_other_verdicts(rule):
    verdicts = inv.evaluate_all([rule, _rule("max_error_rate")], {})
    assert len(verdicts) == 2 and all(v["passed"] is None for v in verdicts)


@pytest.mark.parametrize("threshold", [None, True, -1, 2, "NaN", "Infinity"])
def test_invalid_threshold_is_unknown(threshold):
    rule = _rule("max_error_rate")
    rule["params"]["threshold"] = threshold
    actual = {"service_map": {"edges": [{"from": "api", "to": "rds", "calls": 4, "error_rate": 0}]}}
    assert inv.evaluate_all([rule], actual)[0]["passed"] is None


@pytest.mark.parametrize("kind", ["private_only", "no_public_ingress", "forbidden_edge",
                                 "expected_edge", "max_error_rate"])
@pytest.mark.parametrize("edges", [None, {}, [None], [{"from": "api", "to_ref": 1, "calls": 4, "error_rate": 0}],
                                  [{"from": "api", "to": "rds", "calls": 4, "error_rate": 0}, {}]])
def test_malformed_or_unresolved_graph_is_unknown(kind, edges):
    # Current X-Ray collector emits to_ref, not a resolved destination name.
    actual = {"service_map": {"edges": edges}}
    rule = _rule(kind)
    if kind == "forbidden_edge":
        rule["params"] = {"from": "rds", "to": "api"}
    assert inv.evaluate_all([rule], actual)[0]["passed"] is None


@pytest.mark.parametrize("kind", ["private_only", "no_public_ingress", "forbidden_edge", "max_error_rate"])
def test_unobserved_target_is_unknown(kind):
    assert inv.evaluate_all([_rule(kind)], ACTUAL)[0]["passed"] is None


@pytest.mark.parametrize("count", [None, -1, "0", True, float("nan"), 0.5])
def test_malformed_encryption_count_is_unknown(count):
    actual = {"inventory": {"unencrypted": {"rds": count}}}
    assert inv.evaluate_all([_rule("encryption_required")], actual)[0]["passed"] is None


def test_inventory_sample_is_not_an_encryption_aggregate():
    actual = {"inventory": {"by_type": {"rds": 20}, "resources": {
        "rds": [{"resource_id": "db", "region": "test", "data": {"storage_encrypted": True}}]},
        "truncated": False}}
    assert inv.evaluate_all([_rule("encryption_required")], actual)[0]["passed"] is None


@pytest.mark.parametrize("marker", [{"_failed": True}, {"truncated": True}, {"_truncated": True},
                                  {"stale": True}, {"freshness": "degraded"}])
def test_payload_quality_markers_prevent_healthy_verdict(marker):
    actual = {"inventory": {"unencrypted": {"rds": 0}, **marker}}
    assert inv.evaluate_all([_rule("encryption_required")], actual)[0]["passed"] is None
