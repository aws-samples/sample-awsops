"""Tests for diagnosis source collectors — inventory detail + cw_metrics instance lookup.
Worker uses pg8000 conn.run(sql, **named_params) → list of row tuples. No live AWS/DB."""
import json
import os
import sys
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import sources as src  # noqa: E402


class FakeConn:
    """Routes by SQL substring → rows (list or callable(kw)->list). Records queries for assertions."""
    def __init__(self, routes=None, raise_on=None):
        self.routes = routes or {}
        self.raise_on = raise_on
        self.queries = []

    def run(self, sql, **kw):
        self.queries.append((sql, kw))
        if self.raise_on and self.raise_on in sql:
            raise RuntimeError("boom")
        for sub, rows in self.routes.items():
            if sub in sql:
                return rows(kw) if callable(rows) else rows
        return []

    def sqls(self):
        return " || ".join(q[0] for q in self.queries)


class _FakeCW:
    def __init__(self):
        self.last = None

    def get_metric_data(self, **kw):
        self.last = kw
        # one Average value per requested cpu{i}
        return {"MetricDataResults": [{"Id": q["Id"], "Values": [12.5]} for q in kw["MetricDataQueries"]]}


# ── Task 1: collect_cw_metrics instance lookup ──────────────────────────────────
class TestCwMetrics:
    def test_finds_ec2_instances_and_queries_metrics(self):
        conn = FakeConn(routes={"resource_id FROM inventory_resources": [["i-aaa"], ["i-bbb"]]})
        cw = _FakeCW()
        with mock.patch.object(src, "_cw_client", return_value=cw):
            out = src.collect_cw_metrics(conn)
        # the lookup must scope to the REAL synced type 'ec2' (not the never-matching 'ec2_instance')
        assert "resource_type = 'ec2'" in conn.sqls()
        assert "account_id = 'self'" in conn.sqls()
        assert out["ok"] and "i-aaa" in out["data"]["by_instance"]
        assert out["data"]["avg_cpu"] == 12.5

    def test_no_ec2_degrades_to_empty(self):
        conn = FakeConn(routes={})  # no rows
        out = src.collect_cw_metrics(conn)
        assert out["data"] == {"by_instance": {}, "avg_cpu": None}
        assert "no ec2 instance ids" in out["notes"]

    def test_never_raises_on_db_error(self):
        conn = FakeConn(routes={}, raise_on="resource_id FROM inventory_resources")
        out = src.collect_cw_metrics(conn)  # must not raise
        assert out["data"]["by_instance"] == {}


# ── Task 2: collect_inventory returns bounded, secret-filtered resource detail ──
def _inv_conn(detail, counts=None, raise_on=None):
    counts = counts or [["ec2", 2], ["lambda", 1]]
    return FakeConn(routes={
        "count(*) FROM inventory_resources": counts,
        "resource_id, region, data FROM inventory_resources": lambda kw: detail.get(kw.get("rtype"), []),
    }, raise_on=raise_on)


class TestInventoryDetail:
    def test_returns_resource_detail_not_only_counts(self):
        detail = {
            "ec2": [["i-1", "ap-northeast-2", {"instance_state": "running", "instance_type": "t3.micro"}]],
            "lambda": [["fn-1", "ap-northeast-2", {"runtime": "python3.12"}]],
        }
        out = src.collect_inventory(_inv_conn(detail))
        d = out["data"]
        assert d["by_type"] == {"ec2": 2, "lambda": 1}
        assert d["resources"]["ec2"][0]["resource_id"] == "i-1"
        assert d["resources"]["ec2"][0]["data"]["instance_state"] == "running"

    def test_scopes_account_self_and_named_param(self):
        conn = _inv_conn({"ec2": [["i-1", "r", {}]]})
        src.collect_inventory(conn)
        s = conn.sqls()
        # Scope is parameterized (:scope, default 'self') so member accounts reuse the same SQL.
        assert "account_id = :scope" in s

    def test_strips_sensitive_fields_and_truncates_long_strings(self):
        detail = {"lambda": [["fn-1", "r", {
            "runtime": "python3.12",
            "environment": {"DB_PASSWORD": "supersecret"},   # secrets — must be dropped
            "secret_arn": "arn:...:secret:x",                # *secret* key — dropped
            "description": "x" * 700,                         # long — truncated
        }]]}
        out = src.collect_inventory(_inv_conn(detail, counts=[["lambda", 1]]))
        data = out["data"]["resources"]["lambda"][0]["data"]
        assert "environment" not in data
        assert "secret_arn" not in data
        assert data["runtime"] == "python3.12"
        assert len(data["description"]) < 700 and "truncated" in data["description"]

    def test_parses_json_string_data(self):
        detail = {"ec2": [["i-1", "r", json.dumps({"instance_state": "stopped"})]]}  # pg may hand back text
        out = src.collect_inventory(_inv_conn(detail, counts=[["ec2", 1]]))
        assert out["data"]["resources"]["ec2"][0]["data"]["instance_state"] == "stopped"

    def test_byte_cap_truncates(self, monkeypatch):
        monkeypatch.setattr(src, "DIAG_INV_MAX_BYTES", 200)
        big = {"blob": "y" * 480}  # each entry > cap
        detail = {"ec2": [["i-1", "r", dict(big)], ["i-2", "r", dict(big)], ["i-3", "r", dict(big)]]}
        out = src.collect_inventory(_inv_conn(detail, counts=[["ec2", 3]]))
        assert out["data"]["truncated"] is True

    def test_per_type_limit_in_query(self):
        conn = _inv_conn({"ec2": [["i-1", "r", {}]]})
        src.collect_inventory(conn)
        assert f"LIMIT {src.DIAG_INV_PER_TYPE}" in conn.sqls()

    def test_count_query_error_degrades(self):
        out = src.collect_inventory(FakeConn(routes={}, raise_on="count(*) FROM inventory_resources"))
        assert out["degraded"] is True  # _classify path, never raises

    def test_detail_query_error_keeps_counts(self):
        # by_type ok, but detail query raises → that type skipped, by_type preserved, no raise
        conn = FakeConn(routes={"count(*) FROM inventory_resources": [["ec2", 5]]},
                        raise_on="resource_id, region, data FROM inventory_resources")
        out = src.collect_inventory(conn)
        assert out["data"]["by_type"] == {"ec2": 5}
        assert out["data"]["resources"] == {}

    def test_strips_camelcase_and_varied_secret_keys(self):
        # P4 hardening: case/separator-insensitive + broader secret patterns
        detail = {"ec2": [["i-1", "r", {
            "Environment": {"X": "y"}, "UserData": "#!/bin/bash\nexport TOKEN=abc",
            "db_pass": "p1", "adminPwd": "p2", "apiKey": "k", "AccessKey": "ak",
            "sessionToken": "t", "instance_state": "running",  # benign — kept
        }]]}
        out = src.collect_inventory(_inv_conn(detail, counts=[["ec2", 1]]))
        data = out["data"]["resources"]["ec2"][0]["data"]
        for leaked in ("Environment", "UserData", "db_pass", "adminPwd", "apiKey", "AccessKey", "sessionToken"):
            assert leaked not in data, f"{leaked} not stripped"
        assert data["instance_state"] == "running"  # benign field preserved
