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
    v = {"id": 13, "kind": "forbidden_edge", "params": {"from": "x", "to": "y"}}
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
    actual = {"inventory": {"unencrypted": {}}}
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
