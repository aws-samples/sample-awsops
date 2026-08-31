"""Pipeline-level tests for sg_rule_scan.py — the design spec's "Pipeline" test list.
Uses a lightweight FakeConn (pg8000.native.Connection-shaped `.run(sql, **kwargs)`) instead of a
real Postgres — these test the ORCHESTRATION logic (idempotent delete-then-insert, watermark
advance, one-query-per-day, rescan window, transaction rollback), not SQL correctness itself."""
import datetime as dt
import json

import pytest

import sg_rule_scan as scan
import sg_rule_matching as sm


class FakeConn:
    """Records every `.run()` call; BEGIN/COMMIT/ROLLBACK are tracked, not executed against a real
    DB. `responses` is a dict of substring -> list of rows (popped in FIFO order per substring) for
    SELECT-shaped calls; INSERT/UPDATE/DELETE calls just get recorded and return []."""

    def __init__(self, responses=None):
        self.calls = []
        self.responses = {k: list(v) for k, v in (responses or {}).items()}
        self.in_txn = False
        self.committed = 0
        self.rolled_back = 0

    def run(self, sql, **kwargs):
        self.calls.append((sql, kwargs))
        if sql.strip() == "BEGIN":
            self.in_txn = True
            return []
        if sql.strip() == "COMMIT":
            self.in_txn = False
            self.committed += 1
            return []
        if sql.strip() == "ROLLBACK":
            self.in_txn = False
            self.rolled_back += 1
            return []
        for key, rows in self.responses.items():
            if key in sql:
                return rows.pop(0) if rows else []
        return []

    def sql_calls(self, substring):
        return [c for c in self.calls if substring in c[0]]


def utc(y, mo, d, h=0):
    return dt.datetime(y, mo, d, h, tzinfo=dt.timezone.utc)


# ── source validation ────────────────────────────────────────────────────────────────────────────

def test_load_source_raises_when_not_configured():
    conn = FakeConn({"FROM sg_flow_sources": [[]]})
    with pytest.raises(scan.SourceNotConfigured):
        scan.load_source(conn, "123456789012", "ap-northeast-2")


def test_load_source_raises_when_disabled():
    conn = FakeConn({"FROM sg_flow_sources": [[
        (1, "123456789012", "ap-northeast-2", "wg", "db", "tbl", False, "{}", utc(2026, 1, 1)),
    ]]})
    with pytest.raises(scan.SourceNotConfigured):
        scan.load_source(conn, "123456789012", "ap-northeast-2")


def test_load_source_raises_when_validation_invalid():
    conn = FakeConn({"FROM sg_flow_sources": [[
        (1, "123456789012", "ap-northeast-2", "wg", "db", "tbl", True, json.dumps({"status": "invalid"}), utc(2026, 1, 1)),
    ]]})
    with pytest.raises(scan.SourceInvalid):
        scan.load_source(conn, "123456789012", "ap-northeast-2")


def test_load_source_ok_when_pending_or_valid():
    conn = FakeConn({"FROM sg_flow_sources": [[
        (1, "123456789012", "ap-northeast-2", "wg", "db", "tbl", True, json.dumps({"status": "valid"}), utc(2026, 1, 1)),
    ]]})
    row = scan.load_source(conn, "123456789012", "ap-northeast-2")
    assert row["id"] == 1
    assert row["workgroup"] == "wg"


# ── round-4 CI-review finding (L3, item 2): `account_external_id` (Role A / AWSopsReadOnlyRole
#    assume) must apply the SAME confused-deputy/enabled guard as the Athena broker's
#    `_resolve_external_id` — a disabled or unregistered account must be refused outright, never
#    silently assumed with no ExternalId. ──────────────────────────────────────────────────────────

def test_account_external_id_refuses_a_disabled_account():
    conn = FakeConn({"FROM accounts": [[]]})  # `AND enabled` predicate means a disabled row -> no match
    with pytest.raises(scan.AccountNotRegistered, match="registered"):
        scan.account_external_id(conn, "999999999999")


def test_account_external_id_refuses_an_unregistered_account():
    conn = FakeConn({"FROM accounts": [[]]})  # no row at all
    with pytest.raises(scan.AccountNotRegistered, match="registered"):
        scan.account_external_id(conn, "888888888888")


def test_account_external_id_returns_value_for_a_registered_enabled_account():
    conn = FakeConn({"FROM accounts": [[("ext-abc",)]]})
    assert scan.account_external_id(conn, "123456789012") == "ext-abc"


def test_run_refuses_disabled_account_before_any_assume_role(monkeypatch):
    """A disabled/unregistered target account must never reach `_assumed_session` — `run()` must
    propagate `AccountNotRegistered` rather than falling through to a guard-less AssumeRole with no
    ExternalId."""
    monkeypatch.setenv("SG_RULE_ATHENA_BROKER_ARN", "arn:aws:lambda:ap-northeast-2:123456789012:function:broker")
    conn = FakeConn({
        "FROM sg_flow_sources": [[
            (1, "123456789012", "ap-northeast-2", "wg", "db", "tbl", True, json.dumps({"status": "valid"}), utc(2020, 1, 1)),
        ]],
        "FROM accounts": [[]],  # disabled/unregistered — no enabled row
    })

    def must_never_be_called(*a, **k):
        raise AssertionError("must never assume a role for a disabled/unregistered account")

    monkeypatch.setattr(scan, "readonly_ec2_client", must_never_be_called)
    with pytest.raises(scan.AccountNotRegistered):
        scan.run({"account_id": "123456789012", "region": "ap-northeast-2"}, conn)


# ── watermark ─────────────────────────────────────────────────────────────────────────────────────

def test_last_committed_day_none_when_no_succeeded_runs():
    conn = FakeConn({"FROM sg_rule_scan_runs": [[(None,)]]})
    assert scan.last_committed_day(conn, 1) is None


def test_last_committed_day_returns_max_succeeded_partition():
    import datetime
    conn = FakeConn({"FROM sg_rule_scan_runs": [[(datetime.date(2026, 3, 5),)]]})
    assert scan.last_committed_day(conn, 1) == datetime.date(2026, 3, 5)


# ── item 2 follow-up fix (round 2): previous_successful_scan_gap must derive the REAL elapsed gap
#    to the previous successful scan, not assume a fixed nominal cadence — this is what lets
#    sm.day_coverage() correctly widen its uncertainty window after a multi-day scan outage. ────────

def test_previous_successful_scan_gap_none_when_no_prior_successful_run():
    conn = FakeConn({"FROM sg_rule_scan_runs": [[(None,)]]})
    assert scan.previous_successful_scan_gap(conn, 1, utc(2026, 3, 9)) is None


def test_previous_successful_scan_gap_returns_the_real_elapsed_gap():
    """The previous successful run was 4 days before `before` (a multi-day scan outage) — the
    returned gap must reflect that REAL elapsed time, not a fixed nominal cadence."""
    conn = FakeConn({"FROM sg_rule_scan_runs": [[(utc(2026, 3, 5),)]]})
    gap = scan.previous_successful_scan_gap(conn, 1, utc(2026, 3, 9))
    assert gap == dt.timedelta(days=4)


def test_previous_successful_scan_gap_queries_only_succeeded_runs_before_the_given_instant():
    conn = FakeConn({"FROM sg_rule_scan_runs": [[(utc(2026, 3, 5),)]]})
    scan.previous_successful_scan_gap(conn, 1, utc(2026, 3, 9))
    call = [c for c in conn.calls if "FROM sg_rule_scan_runs" in c[0]][0]
    assert "succeeded" in call[0]
    assert call[1]["fid"] == 1
    assert call[1]["before"] == utc(2026, 3, 9)


# ── L2 finding #2: IPv6 ENI addresses must be captured too ───────────────────────────────────────

class FakeEc2Eni:
    def __init__(self, enis, truncate=False):
        self._enis = enis
        self._truncate = truncate

    def describe_network_interfaces(self, **kwargs):
        if self._truncate:
            return {"NetworkInterfaces": self._enis, "NextToken": "more"}
        return {"NetworkInterfaces": self._enis}


def test_snapshot_eni_membership_captures_ipv6_addresses():
    ec2 = FakeEc2Eni([{
        "VpcId": "vpc-1", "NetworkInterfaceId": "eni-1",
        "Groups": [{"GroupId": "sg-1"}],
        "PrivateIpAddresses": [{"PrivateIpAddress": "10.0.0.5"}],
        "Ipv6Addresses": [{"Ipv6Address": "2001:db8::1"}],
    }])
    memberships, truncated = scan.snapshot_eni_membership_via_describe(ec2)
    assert truncated is False
    assert memberships[0]["private_ips"] == ["10.0.0.5", "2001:db8::1"]


def test_snapshot_eni_membership_ipv6_only_eni_still_captured():
    ec2 = FakeEc2Eni([{
        "VpcId": "vpc-1", "NetworkInterfaceId": "eni-2",
        "Groups": [{"GroupId": "sg-1"}],
        "PrivateIpAddresses": [],
        "Ipv6Addresses": [{"Ipv6Address": "2001:db8::2"}],
    }])
    memberships, _ = scan.snapshot_eni_membership_via_describe(ec2)
    assert memberships[0]["private_ips"] == ["2001:db8::2"]


def test_snapshot_eni_membership_marks_truncated_at_cap(monkeypatch):
    """L4 finding #9: the silent 20,000-ENI describe cap must surface a coverage marker instead of
    being indistinguishable from a genuinely-complete snapshot."""
    enis = [{"VpcId": "vpc-1", "NetworkInterfaceId": f"eni-{i}", "Groups": [], "PrivateIpAddresses": []}
            for i in range(1000)]

    class CappingEc2:
        def __init__(self):
            self.calls = 0

        def describe_network_interfaces(self, **kwargs):
            self.calls += 1
            # 20 pages of 1000 = 20,000, hitting the cap; always claim more remain.
            return {"NetworkInterfaces": enis, "NextToken": "more"}

    memberships, truncated = scan.snapshot_eni_membership_via_describe(CappingEc2())
    assert truncated is True
    assert len(memberships) == 20000


def test_snapshot_eni_membership_not_truncated_when_pages_exhaust_before_cap():
    ec2 = FakeEc2Eni([{"VpcId": "vpc-1", "NetworkInterfaceId": "eni-1", "Groups": [],
                        "PrivateIpAddresses": [{"PrivateIpAddress": "10.0.0.1"}]}], truncate=False)
    _, truncated = scan.snapshot_eni_membership_via_describe(ec2)
    assert truncated is False


# ── gap-5: VPC id derived from the ENI-membership snapshot, wired through the upsert ────────────

def test_group_vpc_map_from_memberships_maps_group_id_to_vpc_id():
    memberships = [
        {"vpc_id": "vpc-aaa", "eni_id": "eni-1", "group_ids": ["sg-1", "sg-2"], "private_ips": ["10.0.0.1"]},
        {"vpc_id": "vpc-bbb", "eni_id": "eni-2", "group_ids": ["sg-3"], "private_ips": ["10.0.1.1"]},
    ]
    out = scan.group_vpc_map_from_memberships(memberships)
    assert out == {"sg-1": "vpc-aaa", "sg-2": "vpc-aaa", "sg-3": "vpc-bbb"}


def test_group_vpc_map_from_memberships_skips_enis_with_no_vpc():
    memberships = [{"vpc_id": "", "eni_id": "eni-1", "group_ids": ["sg-1"], "private_ips": []}]
    assert scan.group_vpc_map_from_memberships(memberships) == {}


def test_group_vpc_map_from_memberships_empty_input():
    assert scan.group_vpc_map_from_memberships([]) == {}


def test_upsert_inventory_populates_vpc_id_from_group_vpc_map():
    conn = FakeConn({"sg_rule_inventory_versions": [[]]})
    rules = [{"rule_id": "sgr-1", "group_id": "sg-1", "is_egress": False, "protocol": "tcp",
              "from_port": 443, "to_port": 443, "peer_kind": "cidr", "peer_value": "10.0.0.0/8",
              "description": None}]
    scan.upsert_inventory_and_versions(conn, "123456789012", "ap-northeast-2", rules, utc(2026, 3, 5),
                                        group_vpc_map={"sg-1": "vpc-aaa"})
    inserts = [c for c in conn.calls if c[0].startswith("INSERT INTO sg_rule_inventory ")]
    assert len(inserts) == 1
    assert inserts[0][1]["vpc"] == "vpc-aaa"
    assert "vpc_id=COALESCE(EXCLUDED.vpc_id, sg_rule_inventory.vpc_id)" in inserts[0][0]


def test_upsert_inventory_vpc_id_none_when_group_not_in_map():
    conn = FakeConn({"sg_rule_inventory_versions": [[]]})
    rules = [{"rule_id": "sgr-1", "group_id": "sg-unattached", "is_egress": False, "protocol": "tcp",
              "from_port": 443, "to_port": 443, "peer_kind": "cidr", "peer_value": "10.0.0.0/8",
              "description": None}]
    scan.upsert_inventory_and_versions(conn, "123456789012", "ap-northeast-2", rules, utc(2026, 3, 5),
                                        group_vpc_map={"sg-1": "vpc-aaa"})
    inserts = [c for c in conn.calls if c[0].startswith("INSERT INTO sg_rule_inventory ")]
    assert inserts[0][1]["vpc"] is None


def test_upsert_inventory_defaults_to_no_vpc_map_when_omitted():
    conn = FakeConn({"sg_rule_inventory_versions": [[]]})
    rules = [{"rule_id": "sgr-1", "group_id": "sg-1", "is_egress": False, "protocol": "tcp",
              "from_port": 443, "to_port": 443, "peer_kind": "cidr", "peer_value": "10.0.0.0/8",
              "description": None}]
    scan.upsert_inventory_and_versions(conn, "123456789012", "ap-northeast-2", rules, utc(2026, 3, 5))
    inserts = [c for c in conn.calls if c[0].startswith("INSERT INTO sg_rule_inventory ")]
    assert inserts[0][1]["vpc"] is None


# ── inventory versioning (upsert_inventory_and_versions) ────────────────────────────────────────

def test_upsert_inventory_opens_first_version_when_none_open():
    conn = FakeConn({"sg_rule_inventory_versions": [[]]})  # no open version
    rules = [{"rule_id": "sgr-1", "group_id": "sg-1", "is_egress": False, "protocol": "tcp",
              "from_port": 443, "to_port": 443, "peer_kind": "cidr", "peer_value": "10.0.0.0/8",
              "description": None}]
    scan.upsert_inventory_and_versions(conn, "123456789012", "ap-northeast-2", rules, utc(2026, 3, 5))
    inserts = [c for c in conn.calls if "INSERT INTO sg_rule_inventory_versions" in c[0]]
    assert len(inserts) == 1
    # No fingerprint-change close for the one rule that's present (it's a fresh first version).
    fp_closes = [c for c in conn.calls if "UPDATE sg_rule_inventory_versions" in c[0] and "rule_id=:rid" in c[0]]
    assert len(fp_closes) == 0
    # The disappeared-rules sweep still always runs (MAJOR fix, see below) — harmless here since
    # sgr-1 is in `seen`, so it closes nothing in a real DB, but the statement is always issued.
    sweep_closes = [c for c in conn.calls if "rule_id <> ALL(:seen)" in c[0] and "sg_rule_inventory_versions" in c[0]]
    assert len(sweep_closes) == 1


def test_upsert_inventory_closes_and_opens_new_version_on_fingerprint_change():
    old_fp = sm.rule_fingerprint({"group_id": "sg-1", "is_egress": False, "protocol": "tcp",
                                   "from_port": 80, "to_port": 80, "peer_kind": "cidr", "peer_value": "10.0.0.0/8"})
    conn = FakeConn({"sg_rule_inventory_versions": [[(old_fp,)]]})  # currently-open version has the OLD fingerprint
    rules = [{"rule_id": "sgr-1", "group_id": "sg-1", "is_egress": False, "protocol": "tcp",
              "from_port": 443, "to_port": 443, "peer_kind": "cidr", "peer_value": "10.0.0.0/8",
              "description": None}]  # NEW shape (443, not 80)
    scan.upsert_inventory_and_versions(conn, "123456789012", "ap-northeast-2", rules, utc(2026, 3, 5))
    fp_closes = [c for c in conn.calls if "UPDATE sg_rule_inventory_versions" in c[0] and "rule_id=:rid" in c[0]]
    opens = [c for c in conn.calls if "INSERT INTO sg_rule_inventory_versions" in c[0]]
    assert len(fp_closes) == 1
    assert len(opens) == 1


def test_upsert_inventory_no_new_version_when_fingerprint_unchanged():
    fp = sm.rule_fingerprint({"group_id": "sg-1", "is_egress": False, "protocol": "tcp",
                               "from_port": 443, "to_port": 443, "peer_kind": "cidr", "peer_value": "10.0.0.0/8"})
    conn = FakeConn({"sg_rule_inventory_versions": [[(fp,)]]})
    rules = [{"rule_id": "sgr-1", "group_id": "sg-1", "is_egress": False, "protocol": "tcp",
              "from_port": 443, "to_port": 443, "peer_kind": "cidr", "peer_value": "10.0.0.0/8",
              "description": None}]  # SAME shape
    scan.upsert_inventory_and_versions(conn, "123456789012", "ap-northeast-2", rules, utc(2026, 3, 5))
    fp_closes = [c for c in conn.calls if "UPDATE sg_rule_inventory_versions" in c[0] and "rule_id=:rid" in c[0]]
    opens = [c for c in conn.calls if "INSERT INTO sg_rule_inventory_versions" in c[0]]
    assert len(fp_closes) == 0
    assert len(opens) == 0


# ── disappeared-rule sweep (MAJOR fix: open version rows must close when a rule disappears, even
#    on an empty snapshot — the old `if seen_ids:` guard skipped the sweep entirely when empty) ──

def test_disappeared_rule_marks_inactive_and_closes_open_version():
    conn = FakeConn()
    scan.upsert_inventory_and_versions(conn, "123456789012", "ap-northeast-2", [], utc(2026, 3, 5))
    inactive = [c for c in conn.calls if c[0].startswith("UPDATE sg_rule_inventory SET active=false")]
    assert len(inactive) == 1
    assert inactive[0][1]["seen"] == []
    sweep_closes = [c for c in conn.calls if "rule_id <> ALL(:seen)" in c[0] and "sg_rule_inventory_versions" in c[0]]
    assert len(sweep_closes) == 1
    assert sweep_closes[0][1]["seen"] == []


def test_empty_snapshot_still_sweeps_all_disappeared_rules():
    """An empty snapshot for a source that previously had rules means ALL of them disappeared —
    the sweep must still run (not be skipped as 'nothing to update')."""
    conn = FakeConn()
    scan.upsert_inventory_and_versions(conn, "123456789012", "ap-northeast-2", [], utc(2026, 3, 5))
    # Both statements were issued even though `rules` was empty.
    assert any(c[0].startswith("UPDATE sg_rule_inventory SET active=false") for c in conn.calls)
    assert any("rule_id <> ALL(:seen)" in c[0] and "sg_rule_inventory_versions" in c[0] for c in conn.calls)


# ── build_day_select: uses validation's resolved column map / optional fields / partition keys ──

def _source(validation=None, **overrides):
    base = {"id": 1, "account_id": "123456789012", "region": "ap-northeast-2", "workgroup": "primary",
            "database_name": "flowlogsdb", "table_name": "flow_logs", "validation": validation or {}}
    base.update(overrides)
    return base


def test_build_day_select_uses_hyphenated_column_map():
    source = _source(validation={
        "columnMap": {"interface_id": "interface-id", "log_status": "log-status", "start": "start"},
        "optionalFields": ["bytes"],
    })
    sql = scan.build_day_select(source, dt.date(2026, 3, 5))
    assert '"interface-id"' in sql
    assert '"log-status"' in sql
    assert sql.count("SELECT") == 1


def test_build_day_select_omits_bytes_when_not_optional_present():
    source = _source(validation={
        "columnMap": {"interface_id": "interface_id", "log_status": "log_status", "start": "start"},
        "optionalFields": [],  # validated, and bytes was NOT found on this table
    })
    sql = scan.build_day_select(source, dt.date(2026, 3, 5))
    assert "sum(\"bytes\")" not in sql
    assert '"bytes"' not in sql.split("FROM")[0]


def test_build_day_select_includes_bytes_when_optional_present():
    source = _source(validation={
        "columnMap": {"interface_id": "interface_id", "log_status": "log_status", "start": "start"},
        "optionalFields": ["bytes", "packets"],
    })
    sql = scan.build_day_select(source, dt.date(2026, 3, 5))
    assert 'sum("bytes") as bytes' in sql


def test_build_day_select_adds_hive_style_partition_predicate():
    source = _source(validation={
        "columnMap": {"interface_id": "interface_id", "log_status": "log_status", "start": "start"},
        "optionalFields": ["bytes"],
        "partitionKeys": ["year", "month", "day"],
    })
    sql = scan.build_day_select(source, dt.date(2026, 3, 5))
    assert "\"year\" = '2026'" in sql
    assert "\"month\" = '03'" in sql
    assert "\"day\" = '05'" in sql


def test_build_day_select_adds_single_date_partition_predicate():
    source = _source(validation={
        "columnMap": {"interface_id": "interface_id", "log_status": "log_status", "start": "start"},
        "optionalFields": ["bytes"],
        "partitionKeys": ["dt"], "partitionKeyTypes": ["date"],
    })
    sql = scan.build_day_select(source, dt.date(2026, 3, 5))
    # item 5 follow-up fix: delivery lag only ever pushes a flow's partition file FORWARD, never
    # backward, so the predicate widens to an adjacent 2-day window rather than the single day.
    # Item 3 follow-up fix (round 2): a genuinely `date`-typed key gets a typed `DATE '...'`
    # literal, not a bare string (Athena/Trino rejects comparing a `date` column to a string).
    assert "\"dt\" IN (DATE '2026-03-05', DATE '2026-03-06')" in sql


def test_build_day_select_skips_single_key_predicate_when_type_not_confirmed_date_like():
    # item 7 follow-up fix: a lone partition key without a confirmed date-like Glue type (or
    # missing partitionKeyTypes entirely) must not have a date-string predicate built for it.
    source = _source(validation={
        "columnMap": {"interface_id": "interface_id", "log_status": "log_status", "start": "start"},
        "optionalFields": ["bytes"],
        "partitionKeys": ["dt"], "partitionKeyTypes": ["bigint"],
    })
    sql = scan.build_day_select(source, dt.date(2026, 3, 5))
    assert "\"dt\"" not in sql


def test_build_day_select_falls_back_to_underscore_names_when_no_column_map():
    """Pending (not-yet-validated) sources have no columnMap yet — must not crash, and must
    preserve the pre-existing underscore-name assumption as the fallback."""
    source = _source(validation={"status": "pending"})
    sql = scan.build_day_select(source, dt.date(2026, 3, 5))
    assert '"interface_id"' in sql
    assert '"log_status"' in sql


# ── MINOR fix: invoke_broker_query must surface a FunctionError/malformed-body Lambda crash ──────

class FakeLambdaRaw:
    """Like FakeLambda in the run() section below, but lets the test control FunctionError/body."""
    def __init__(self, payload_bytes, function_error=None):
        self.payload_bytes = payload_bytes
        self.function_error = function_error

    def invoke(self, FunctionName, Payload):
        resp = {"Payload": type("R", (), {"read": lambda self: self._b})()}
        resp["Payload"]._b = self.payload_bytes
        if self.function_error:
            resp["FunctionError"] = self.function_error
        return resp


def test_invoke_broker_query_surfaces_function_error():
    lam = FakeLambdaRaw(b'{"errorMessage": "boom"}', function_error="Unhandled")
    body = scan.invoke_broker_query(
        lam, "arn:aws:lambda:ap-northeast-2:123456789012:function:broker", 1, dt.date(2026, 3, 5))
    assert body["ok"] is False
    assert "FunctionError" in body["reason"]


def test_invoke_broker_query_surfaces_malformed_body_without_ok_key():
    lam = FakeLambdaRaw(b'{"unexpected": "shape"}')
    body = scan.invoke_broker_query(
        lam, "arn:aws:lambda:ap-northeast-2:123456789012:function:broker", 1, dt.date(2026, 3, 5))
    assert body["ok"] is False


# ── invoke_broker_validate (CI-review MAJOR fix, round 5): self-heals a stale validation that
#    predates partitionKeyTypes/scopeResolution by re-running the broker's own "validate" action —
#    never requires a manual admin no-op re-save before a source can scan again. ─────────────────

def test_invoke_broker_validate_sends_the_sources_own_resolved_config():
    """The broker's `validate` action takes raw account_id/region/workgroup/database/table (unlike
    `query_by_source`'s opaque flow_source_id) — this is the SAME action the web BFF's PUT route
    already calls, just re-run here against the source's own persisted config."""
    calls = []

    class RecordingLambda:
        def invoke(self, FunctionName, Payload):
            calls.append(json.loads(Payload))
            return {"Payload": type("R", (), {"read": lambda self: b'{"ok": true, "status": "valid"}'})()}

    source = {"id": 7, "account_id": "123456789012", "region": "ap-northeast-2",
              "workgroup": "wg", "database_name": "db", "table_name": "tbl"}
    body = scan.invoke_broker_validate(RecordingLambda(), "arn:...:function:broker", source)
    assert body == {"ok": True, "status": "valid"}
    assert calls[0] == {"action": "validate", "account_id": "123456789012", "region": "ap-northeast-2",
                         "workgroup": "wg", "database": "db", "table": "tbl"}


def test_invoke_broker_validate_surfaces_function_error():
    lam = FakeLambdaRaw(b'{"errorMessage": "boom"}', function_error="Unhandled")
    source = {"id": 7, "account_id": "123456789012", "region": "ap-northeast-2",
              "workgroup": "wg", "database_name": "db", "table_name": "tbl"}
    body = scan.invoke_broker_validate(lam, "arn:...:function:broker", source)
    assert body["ok"] is False
    assert "FunctionError" in body["reason"]


# ── invoke_broker_query: L3 finding #6 (opaque flow_source_id + day, never raw SQL/account) ──────

def test_invoke_broker_query_sends_only_flow_source_id_and_day():
    """The caller must never send account_id/region/workgroup/database/query text — only the
    opaque flow_source_id + day (the broker resolves everything else from Aurora itself)."""
    lam = FakeLambdaRaw(json.dumps({"ok": True, "rows": [], "done": True}).encode("utf-8"))
    scan.invoke_broker_query(lam, "arn:...:function:broker", 42, dt.date(2026, 3, 5))
    # FakeLambdaRaw doesn't record invocations; use FakeLambda (below) instead for that assertion.


def test_invoke_broker_query_loops_pagination_until_done():
    """L2 finding #4: the broker returns ONE bounded page + a continuation token; the caller must
    loop, accumulating rows, until the broker reports `done`."""
    calls = []

    class PagingLambda:
        def invoke(self, FunctionName, Payload):
            evt = json.loads(Payload)
            calls.append(evt)
            if "continuation" not in evt:
                body = {"ok": True, "rows": [{"n": 1}], "query_execution_id": "q1",
                         "next_token": "tok1", "done": False, "columns": ["n"]}
            else:
                body = {"ok": True, "rows": [{"n": 2}], "next_token": None, "done": True}
            payload = type("P", (), {"read": lambda self: json.dumps(body).encode("utf-8")})()
            return {"Payload": payload}

    lam = PagingLambda()
    result = scan.invoke_broker_query(lam, "arn:...:function:broker", 7, dt.date(2026, 3, 5))
    assert result["ok"] is True
    assert [r["n"] for r in result["rows"]] == [1, 2]
    assert len(calls) == 2
    assert calls[0]["flow_source_id"] == 7
    assert calls[0]["day"] == "2026-03-05"
    assert "account_id" not in calls[0] and "query" not in calls[0]
    assert calls[1]["continuation"]["query_execution_id"] == "q1"


def test_invoke_broker_query_marks_truncated_when_accumulation_cap_hit(monkeypatch):
    """L4 finding #9(i): if accumulated rows reach ROW_LIMIT before the broker reports `done`, the
    day must be marked truncated rather than trusted as a complete result."""
    monkeypatch.setattr(sm, "ROW_LIMIT", 2)

    class NeverDoneLambda:
        def invoke(self, FunctionName, Payload):
            body = {"ok": True, "rows": [{"n": 1}, {"n": 2}], "query_execution_id": "q1",
                    "next_token": "tok", "done": False, "columns": ["n"]}
            payload = type("P", (), {"read": lambda self: json.dumps(body).encode("utf-8")})()
            return {"Payload": payload}

    result = scan.invoke_broker_query(NeverDoneLambda(), "arn:...:function:broker", 1, dt.date(2026, 3, 5))
    assert result["ok"] is True
    assert result["truncated"] is True


# ── round-3 finding #7: skipdata_count must actually be propagated through this wrapper ──────────

def test_invoke_broker_query_propagates_skipdata_count():
    """The broker's `skipdata_count` (L4 finding #9(iv)) was computed correctly server-side but this
    wrapper's return dict never carried it, so `run()`'s `coverage_flags["skipdata_count"]` was
    always None. A single-page response with `skipdata_count` must surface it unchanged."""
    lam = FakeLambdaRaw(json.dumps(
        {"ok": True, "rows": [], "done": True, "skipdata_count": 42}).encode("utf-8"))
    result = scan.invoke_broker_query(
        lam, "arn:aws:lambda:ap-northeast-2:123456789012:function:broker", 1, dt.date(2026, 3, 5))
    assert result["skipdata_count"] == 42


def test_invoke_broker_query_propagates_skipdata_count_across_pagination():
    """`skipdata_count` is only computed on the FIRST page (describes the whole day) — a later
    continuation page's body naturally omits the key, and the wrapper must still carry the
    first-page value through to the final return, not reset it to None."""
    class PagingLambda:
        def __init__(self):
            self.n = 0

        def invoke(self, FunctionName, Payload):
            evt = json.loads(Payload)
            if "continuation" not in evt:
                body = {"ok": True, "rows": [{"n": 1}], "query_execution_id": "q1",
                         "next_token": "tok1", "done": False, "columns": ["n"], "skipdata_count": 7}
            else:
                body = {"ok": True, "rows": [{"n": 2}], "next_token": None, "done": True}
            payload = type("P", (), {"read": lambda self: json.dumps(body).encode("utf-8")})()
            return {"Payload": payload}

    result = scan.invoke_broker_query(PagingLambda(), "arn:...:function:broker", 7, dt.date(2026, 3, 5))
    assert result["ok"] is True
    assert result["skipdata_count"] == 7


def test_invoke_broker_query_truncated_return_also_carries_skipdata_count(monkeypatch):
    """The accumulation-cap `truncated` early-return path must also carry `skipdata_count` — not
    just the normal `done` path."""
    monkeypatch.setattr(sm, "ROW_LIMIT", 2)

    class NeverDoneLambda:
        def invoke(self, FunctionName, Payload):
            body = {"ok": True, "rows": [{"n": 1}, {"n": 2}], "query_execution_id": "q1",
                    "next_token": "tok", "done": False, "columns": ["n"], "skipdata_count": 3}
            payload = type("P", (), {"read": lambda self: json.dumps(body).encode("utf-8")})()
            return {"Payload": payload}

    result = scan.invoke_broker_query(NeverDoneLambda(), "arn:...:function:broker", 1, dt.date(2026, 3, 5))
    assert result["truncated"] is True
    assert result["skipdata_count"] == 3


def test_invoke_broker_query_skipdata_count_defaults_to_none_when_absent():
    """Regression guard: a broker body that never sets skipdata_count at all must not crash and
    must surface None (not some stale/garbage value)."""
    lam = FakeLambdaRaw(json.dumps({"ok": True, "rows": [], "done": True}).encode("utf-8"))
    result = scan.invoke_broker_query(
        lam, "arn:aws:lambda:ap-northeast-2:123456789012:function:broker", 1, dt.date(2026, 3, 5))
    assert result.get("skipdata_count") is None


# ── process_day: idempotent delete-then-insert, transaction, one row per rule/day ────────────────

def _versions(rule_id="sgr-1", **overrides):
    base = {"rule_id": rule_id, "fingerprint": "fp1", "group_id": "sg-1", "is_egress": False,
            "protocol": "tcp", "from_port": 443, "to_port": 443, "peer_kind": "cidr",
            "peer_value": "10.0.0.0/8", "valid_from": utc(2026, 1, 1), "valid_to": None}
    base.update(overrides)
    return {rule_id: [base]}


def _membership(vpc_id="vpc-1", eni_id="eni-1", group_ids=("sg-1",), private_ips=("10.2.2.2",)):
    """The ENI carries `sg-1` and owns `10.2.2.2` — the flow fixtures below (dstaddr=10.2.2.2) log
    an INGRESS flow to this ENI, matching `_versions()`'s default ingress cidr rule on sg-1."""
    return {vpc_id: [{"eni_id": eni_id, "group_ids": list(group_ids), "private_ips": list(private_ips)}]}


def test_process_day_deletes_before_inserting_that_day_rows():
    conn = FakeConn()
    scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                      dt.date(2026, 3, 5), [], _versions(), {}, None)
    deletes = [c for c in conn.calls if c[0].startswith("DELETE FROM sg_rule_activity_daily")]
    inserts = [c for c in conn.calls if c[0].startswith("INSERT INTO sg_rule_activity_daily")]
    assert len(deletes) == 1
    assert len(inserts) == 1  # one row for the one rule
    assert conn.committed == 1
    assert conn.rolled_back == 0


def test_process_day_is_idempotent_on_reprocessing_the_same_day():
    """Calling process_day twice for the same day must not accumulate counts — each call
    delete-then-inserts, so the second call's row replaces (not adds to) the first's."""
    conn = FakeConn()
    scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                      dt.date(2026, 3, 5), [
                          {"interface_id": "eni-1", "srcaddr": "10.1.1.1", "dstaddr": "10.2.2.2",
                           "dstport": "443", "protocol": "6", "bytes": "100", "cnt": "1"},
                      ], _versions(), _membership(), None)
    conn2_calls_first = len(conn.calls)
    scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                      dt.date(2026, 3, 5), [
                          {"interface_id": "eni-1", "srcaddr": "10.1.1.1", "dstaddr": "10.2.2.2",
                           "dstport": "443", "protocol": "6", "bytes": "100", "cnt": "1"},
                      ], _versions(), _membership(), None)
    deletes = [c for c in conn.calls if c[0].startswith("DELETE FROM sg_rule_activity_daily")]
    assert len(deletes) == 2  # one delete per call — never skipped on a re-run
    assert conn.committed == 2


def test_process_day_rolls_back_on_failure():
    class ExplodingConn(FakeConn):
        def run(self, sql, **kwargs):
            if sql.startswith("INSERT INTO sg_rule_activity_daily"):
                raise RuntimeError("boom")
            return super().run(sql, **kwargs)
    conn = ExplodingConn()
    with pytest.raises(RuntimeError):
        scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                          dt.date(2026, 3, 5), [], _versions(), {}, None)
    assert conn.rolled_back == 1
    assert conn.committed == 0


def test_process_day_crossing_day_downgrades_to_unassessable_and_no_lower_bound():
    versions = {
        "sgr-1": [
            {"rule_id": "sgr-1", "fingerprint": "fp1", "group_id": "sg-1", "is_egress": False,
             "protocol": "tcp", "from_port": 443, "to_port": 443, "peer_kind": "cidr",
             "peer_value": "10.0.0.0/8", "valid_from": utc(2026, 3, 5, 14), "valid_to": None},
        ],
    }
    conn = FakeConn()
    res = scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                            dt.date(2026, 3, 5), [
                                {"srcaddr": "10.1.1.1", "dstaddr": "10.2.2.2", "dstport": "443",
                                 "protocol": "6", "bytes": "999", "cnt": "5"},
                            ], versions, {}, None)
    assert res["any_crossing"] is True
    insert_call = [c for c in conn.calls if c[0].startswith("INSERT INTO sg_rule_activity_daily")][0]
    assert insert_call[1]["cm"] == 0  # no flows counted against an unassessable rule/day


# ── item 2 follow-up fix (round 2): process_day must thread a caller-resolved observation_lag
#    (the REAL gap to the previous successful scan) into sm.day_coverage(), rather than a fixed
#    nominal cadence, and must treat `None` (unresolvable gap) as unassessable too. ─────────────────

def test_process_day_defaults_observation_lag_to_unknown_and_marks_closed_version_unassessable():
    """No `observation_lag` passed at all (the default) — a CLOSED version's day must never be
    confidently resolved without a real, caller-supplied gap."""
    versions = {
        "sgr-1": [
            {"rule_id": "sgr-1", "fingerprint": "fp1", "group_id": "sg-1", "is_egress": False,
             "protocol": "tcp", "from_port": 443, "to_port": 443, "peer_kind": "cidr",
             "peer_value": "10.0.0.0/8", "valid_from": utc(2026, 1, 1), "valid_to": utc(2026, 3, 8)},
        ],
    }
    conn = FakeConn()
    res = scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                            dt.date(2026, 3, 5), [], versions, {}, None)
    assert res["any_crossing"] is True
    coverage = json.loads(
        [c for c in conn.calls if c[0].startswith("INSERT INTO sg_rule_activity_daily")][0][1]["cov"])
    assert coverage["fingerprint_epoch_crossing"] is True


def test_process_day_multi_day_scan_gap_widens_the_uncertainty_window():
    """A REAL ~4-day gap (simulating a multi-day scan outage) to the previous successful scan must
    widen the uncertainty window enough to mark day 3/5 unassessable — the FIXED-24h behavior this
    item replaces would have confidently resolved this exact valid_to (3 days after the scanned
    day) as not-crossing (see the equivalent sg_rule_matching-level test)."""
    versions = {
        "sgr-1": [
            {"rule_id": "sgr-1", "fingerprint": "fp1", "group_id": "sg-1", "is_egress": False,
             "protocol": "tcp", "from_port": 443, "to_port": 443, "peer_kind": "cidr",
             "peer_value": "10.0.0.0/8", "valid_from": utc(2026, 1, 1), "valid_to": utc(2026, 3, 8)},
        ],
    }
    conn = FakeConn()
    res = scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                            dt.date(2026, 3, 5), [], versions, {}, None,
                            observation_lag=dt.timedelta(days=4))
    assert res["any_crossing"] is True


def test_process_day_real_observation_lag_confidently_resolves_when_outside_the_window():
    """A real (caller-resolved), short observation_lag that does NOT overlap the scanned day must
    still allow a confident (non-crossing) result — this fix must not make EVERY closed version
    unassessable, only ones whose real gap is unknown or wide enough to overlap."""
    versions = {
        "sgr-1": [
            {"rule_id": "sgr-1", "fingerprint": "fp1", "group_id": "sg-1", "is_egress": False,
             "protocol": "tcp", "from_port": 443, "to_port": 443, "peer_kind": "cidr",
             "peer_value": "10.0.0.0/8", "valid_from": utc(2026, 1, 1), "valid_to": utc(2026, 3, 8)},
        ],
    }
    conn = FakeConn()
    res = scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                            dt.date(2026, 3, 5), [], versions, {}, None,
                            observation_lag=dt.timedelta(hours=1))
    assert res["any_crossing"] is False


# ── CI-review MAJOR fix (round 5): sg_rule_scan_runs.started_at must record the run-wide
#    observation instant `run()` used to close/open rule-inventory versions, not the wall-clock
#    time this transaction happens to commit at — otherwise a later run's
#    `previous_successful_scan_gap()` under-estimates the real gap. ──────────────────────────────

def test_process_day_stamps_started_at_from_the_passed_observed_at_not_wall_clock():
    conn = FakeConn()
    observed_at = utc(2026, 3, 6, 2)  # the run-wide `now` captured by run(), NOT commit time
    scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                      dt.date(2026, 3, 5), [], _versions(), {}, None, observed_at=observed_at)
    insert_call = [c for c in conn.calls if c[0].startswith("INSERT INTO sg_rule_scan_runs")][0]
    assert insert_call[1]["started_at"] == observed_at


def test_process_day_defaults_observed_at_to_wall_clock_when_not_passed():
    """Standalone/test callers with no run-wide observation instant to pass still get a sane
    default (current wall-clock time) rather than an error."""
    conn = FakeConn()
    before = dt.datetime.now(dt.timezone.utc)
    scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                      dt.date(2026, 3, 5), [], _versions(), {}, None)
    after = dt.datetime.now(dt.timezone.utc)
    insert_call = [c for c in conn.calls if c[0].startswith("INSERT INTO sg_rule_scan_runs")][0]
    assert before <= insert_call[1]["started_at"] <= after


def test_process_day_matches_compatible_flow():
    conn = FakeConn()
    res = scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                            dt.date(2026, 3, 5), [
                                {"interface_id": "eni-1", "srcaddr": "10.1.1.1", "dstaddr": "10.2.2.2",
                                 "dstport": "443", "protocol": "6", "bytes": "500", "cnt": "3"},
                            ], _versions(), _membership(), None)
    insert_call = [c for c in conn.calls if c[0].startswith("INSERT INTO sg_rule_activity_daily")][0]
    assert insert_call[1]["cm"] == 3
    assert insert_call[1]["cb"] == 500
    assert insert_call[1]["ue"] == 1  # one ENI (interface_id), not one destination-IP string


# ── CRITICAL fix: ENI -> SG membership check (a flow on an ENI NOT in the rule's SG must NOT
#    classify that rule observed_compatible — this is the fabricated-usage-attribution bug) ──────

def test_flow_on_eni_not_in_rules_sg_is_not_credited():
    """Same flow/rule shape as test_process_day_matches_compatible_flow, but the ENI that actually
    carries the traffic (eni-2) is NOT a member of sg-1 — it must NOT be credited as compatible."""
    conn = FakeConn()
    membership = {"vpc-1": [{"eni_id": "eni-2", "group_ids": ["sg-OTHER"], "private_ips": ["10.2.2.2"]}]}
    res = scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                            dt.date(2026, 3, 5), [
                                {"interface_id": "eni-2", "srcaddr": "10.1.1.1", "dstaddr": "10.2.2.2",
                                 "dstport": "443", "protocol": "6", "bytes": "500", "cnt": "3"},
                            ], _versions(), membership, None)
    insert_call = [c for c in conn.calls if c[0].startswith("INSERT INTO sg_rule_activity_daily")][0]
    assert insert_call[1]["cm"] == 0
    assert insert_call[1]["cb"] == 0


def test_flow_with_unresolvable_eni_membership_is_not_credited():
    """The flow's own interface_id has no membership snapshot at all — never fabricate membership;
    the rule stays at zero evidence rather than being guessed into observed_compatible."""
    conn = FakeConn()
    res = scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                            dt.date(2026, 3, 5), [
                                {"interface_id": "eni-unknown", "srcaddr": "10.1.1.1", "dstaddr": "10.2.2.2",
                                 "dstport": "443", "protocol": "6", "bytes": "500", "cnt": "3"},
                            ], _versions(), _membership(), None)
    insert_call = [c for c in conn.calls if c[0].startswith("INSERT INTO sg_rule_activity_daily")][0]
    assert insert_call[1]["cm"] == 0


# ── MAJOR fix: direction must be derived from which side of the flow is the local ENI, not
#    hardcoded "ingress" — an egress rule must be matchable ─────────────────────────────────────

def test_egress_rule_is_matchable():
    """The local ENI (eni-1) is the SOURCE of this flow (srcaddr matches its own private_ips) ->
    egress. An egress-only rule must now be able to match (previously always no_observed_evidence
    because direction was hardcoded to 'ingress')."""
    conn = FakeConn()
    egress_versions = _versions(is_egress=True)
    membership = {"vpc-1": [{"eni_id": "eni-1", "group_ids": ["sg-1"], "private_ips": ["10.1.1.1"]}]}
    res = scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                            dt.date(2026, 3, 5), [
                                {"interface_id": "eni-1", "srcaddr": "10.1.1.1", "dstaddr": "10.2.2.2",
                                 "dstport": "443", "protocol": "6", "bytes": "500", "cnt": "3"},
                            ], egress_versions, membership, None)
    insert_call = [c for c in conn.calls if c[0].startswith("INSERT INTO sg_rule_activity_daily")][0]
    assert insert_call[1]["cm"] == 3


def test_ingress_rule_not_matched_by_egress_flow_on_same_eni():
    """Same ENI/traffic as the egress test above, but the rule is ingress-only — direction mismatch
    must produce no_observed_evidence, proving direction is genuinely being checked both ways."""
    conn = FakeConn()
    ingress_versions = _versions(is_egress=False)
    membership = {"vpc-1": [{"eni_id": "eni-1", "group_ids": ["sg-1"], "private_ips": ["10.1.1.1"]}]}
    scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                      dt.date(2026, 3, 5), [
                          {"interface_id": "eni-1", "srcaddr": "10.1.1.1", "dstaddr": "10.2.2.2",
                           "dstport": "443", "protocol": "6", "bytes": "500", "cnt": "3"},
                      ], ingress_versions, membership, None)
    insert_call = [c for c in conn.calls if c[0].startswith("INSERT INTO sg_rule_activity_daily")][0]
    assert insert_call[1]["cm"] == 0


# ── L2 finding #1: overlap counter must actually increment when a flow matches >1 eligible rule ──

def test_flow_matching_two_rules_increments_overlap_for_the_second():
    """Two rules on the same SG, both allowing the exact same peer/protocol/port — a single flow
    that satisfies both must credit BOTH rules as `compatible` (each one genuinely had a compatible
    flow) AND both as `overlap` (round-3 finding #4: the overlap signal applies to the whole matched
    set, not just "everyone but an arbitrary first pick" — the pre-fix behavior credited only the
    first-iterated rule as compatible and only the rest as overlap, undercounting the first rule's
    compatible traffic and making the "first" pick non-deterministic)."""
    conn = FakeConn()
    versions = {
        "sgr-1": [{"rule_id": "sgr-1", "fingerprint": "fp1", "group_id": "sg-1", "is_egress": False,
                    "protocol": "tcp", "from_port": 443, "to_port": 443, "peer_kind": "cidr",
                    "peer_value": "10.0.0.0/8", "valid_from": utc(2026, 1, 1), "valid_to": None}],
        "sgr-2": [{"rule_id": "sgr-2", "fingerprint": "fp2", "group_id": "sg-1", "is_egress": False,
                    "protocol": "tcp", "from_port": 1, "to_port": 65535, "peer_kind": "cidr",
                    "peer_value": "10.0.0.0/8", "valid_from": utc(2026, 1, 1), "valid_to": None}],
    }
    scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                      dt.date(2026, 3, 5), [
                          {"interface_id": "eni-1", "srcaddr": "10.1.1.1", "dstaddr": "10.2.2.2",
                           "dstport": "443", "protocol": "6", "bytes": "500", "cnt": "3"},
                      ], versions, _membership(), None)
    inserts = {c[1]["rid"]: c[1] for c in conn.calls if c[0].startswith("INSERT INTO sg_rule_activity_daily")}
    # BOTH rules get their own compatible credit AND their own overlap credit — neither is treated
    # as "the first, unaffected pick."
    assert inserts["sgr-1"]["cm"] == 3
    assert inserts["sgr-1"]["om"] == 3
    assert inserts["sgr-2"]["cm"] == 3
    assert inserts["sgr-2"]["om"] == 3
    cov1 = json.loads(inserts["sgr-1"]["cov"])
    cov2 = json.loads(inserts["sgr-2"]["cov"])
    assert cov1["status"] == "overlapping"
    assert cov2["status"] == "overlapping"


def test_flow_matching_three_rules_credits_all_three_deterministically():
    """N>2 matched rules: every rule gets its own compatible AND overlap credit, and the crediting
    result must not depend on dict iteration order (regression guard for the `sorted(matched_rule_ids)`
    determinism fix)."""
    conn = FakeConn()
    versions = {
        rid: [{"rule_id": rid, "fingerprint": f"fp-{rid}", "group_id": "sg-1", "is_egress": False,
               "protocol": "tcp", "from_port": 1, "to_port": 65535, "peer_kind": "cidr",
               "peer_value": "10.0.0.0/8", "valid_from": utc(2026, 1, 1), "valid_to": None}]
        for rid in ("sgr-c", "sgr-a", "sgr-b")  # deliberately out-of-lexical-order insertion
    }
    scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                      dt.date(2026, 3, 5), [
                          {"interface_id": "eni-1", "srcaddr": "10.1.1.1", "dstaddr": "10.2.2.2",
                           "dstport": "443", "protocol": "6", "bytes": "900", "cnt": "5"},
                      ], versions, _membership(), None)
    inserts = {c[1]["rid"]: c[1] for c in conn.calls if c[0].startswith("INSERT INTO sg_rule_activity_daily")}
    for rid in ("sgr-a", "sgr-b", "sgr-c"):
        assert inserts[rid]["cm"] == 5
        assert inserts[rid]["om"] == 5
        assert inserts[rid]["cb"] == 900


def test_flow_matching_one_rule_leaves_overlap_at_zero():
    """Sanity check: a flow matching exactly one rule must not spuriously credit overlap anywhere."""
    conn = FakeConn()
    res = scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                            dt.date(2026, 3, 5), [
                                {"interface_id": "eni-1", "srcaddr": "10.1.1.1", "dstaddr": "10.2.2.2",
                                 "dstport": "443", "protocol": "6", "bytes": "500", "cnt": "3"},
                            ], _versions(), _membership(), None)
    insert_call = [c for c in conn.calls if c[0].startswith("INSERT INTO sg_rule_activity_daily")][0]
    assert insert_call[1]["om"] == 0


# ── round-3 finding #8: unresolved/unorientable flows must be counted, never vanish silently ─────

def test_unresolved_eni_flow_downgrades_zero_match_rule_to_unassessable():
    """A flow whose ENI isn't in ANY membership snapshot must not just vanish — it must be counted
    (`unresolved_flow_count`) and the day's zero-match rule must be downgraded from a confident
    `no_observed_evidence` to `unassessable` (a real, unattributable flow existed)."""
    conn = FakeConn()
    scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                      dt.date(2026, 3, 5), [
                          {"interface_id": "eni-UNKNOWN", "srcaddr": "10.1.1.1", "dstaddr": "10.2.2.2",
                           "dstport": "443", "protocol": "6", "bytes": "500", "cnt": "3"},
                      ], _versions(), _membership(), None)
    insert_call = [c for c in conn.calls if c[0].startswith("INSERT INTO sg_rule_activity_daily")][0]
    coverage = json.loads(insert_call[1]["cov"])
    assert coverage["unresolved_flow_count"] == 1
    assert coverage["status"] == "unassessable"
    assert coverage["unassessable"] is True
    run_insert = [c for c in conn.calls if c[0].startswith("INSERT INTO sg_rule_scan_runs")][0]
    run_cov = json.loads(run_insert[1]["cov"])
    assert run_cov["unresolved_flow_count"] == 1


def test_unorientable_flow_is_counted_and_downgrades_zero_match_rule():
    """A flow whose tuple endpoints match NEITHER of the ENI's known private IPs (direction can't be
    inferred) must also be counted as unresolved and downgrade the day's zero-match rule."""
    conn = FakeConn()
    scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                      dt.date(2026, 3, 5), [
                          {"interface_id": "eni-1", "srcaddr": "192.0.2.1", "dstaddr": "198.51.100.1",
                           "dstport": "443", "protocol": "6", "bytes": "500", "cnt": "3"},
                      ], _versions(), _membership(), None)
    insert_call = [c for c in conn.calls if c[0].startswith("INSERT INTO sg_rule_activity_daily")][0]
    coverage = json.loads(insert_call[1]["cov"])
    assert coverage["unresolved_flow_count"] == 1
    assert coverage["status"] == "unassessable"


def test_zero_unresolved_flows_stays_a_genuinely_confident_zero():
    """Sanity/regression guard: when every flow resolves cleanly and none match, the day's zero
    stays a confident `no_observed_evidence` — the new counter must not falsely trigger."""
    conn = FakeConn()
    versions = _versions(peer_value="10.9.0.0/16")  # a CIDR the fixture flow's peer never matches
    scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                      dt.date(2026, 3, 5), [
                          {"interface_id": "eni-1", "srcaddr": "10.1.1.1", "dstaddr": "10.2.2.2",
                           "dstport": "443", "protocol": "6", "bytes": "500", "cnt": "3"},
                      ], versions, _membership(), None)
    insert_call = [c for c in conn.calls if c[0].startswith("INSERT INTO sg_rule_activity_daily")][0]
    coverage = json.loads(insert_call[1]["cov"])
    assert coverage["unresolved_flow_count"] == 0
    assert coverage["status"] == "no_observed_evidence"


# ── round-3 finding #9: SG-reference resolution must scope to the flow's VPC + peered/RAM-shared ─

def test_sg_reference_hit_in_an_unscoped_other_vpc_is_unassessable_not_no_match():
    """An SG-reference rule whose referenced group_id is carried by an ENI in a DIFFERENT vpc that
    is NOT in the known peered/RAM-shared scope must resolve `unassessable` — not a confident
    `no_observed_evidence` (the pre-fix behavior: the resolver only ever looked inside the flow's
    own VPC, so a genuinely cross-VPC-referenced SG always looked unused)."""
    conn = FakeConn()
    versions = {
        "sgr-1": [{"rule_id": "sgr-1", "fingerprint": "fp1", "group_id": "sg-1", "is_egress": False,
                    "protocol": "tcp", "from_port": 443, "to_port": 443, "peer_kind": "sg",
                    "peer_value": "sg-peer", "valid_from": utc(2026, 1, 1), "valid_to": None}],
    }
    memberships = {
        "vpc-1": [{"eni_id": "eni-1", "group_ids": ["sg-1"], "private_ips": ["10.2.2.2"]}],
        "vpc-OTHER": [{"eni_id": "eni-2", "group_ids": ["sg-peer"], "private_ips": ["10.1.1.1"]}],
    }
    scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                      dt.date(2026, 3, 5), [
                          {"interface_id": "eni-1", "srcaddr": "10.1.1.1", "dstaddr": "10.2.2.2",
                           "dstport": "443", "protocol": "6", "bytes": "500", "cnt": "3"},
                      ], versions, memberships, None)
    insert_call = [c for c in conn.calls if c[0].startswith("INSERT INTO sg_rule_activity_daily")][0]
    coverage = json.loads(insert_call[1]["cov"])
    assert coverage["status"] == "unassessable"
    assert coverage["match_unassessable"] is True


def test_sg_reference_hit_in_a_known_peered_vpc_is_a_confident_match():
    """The SAME cross-VPC SG-reference scenario, but with the peering relationship supplied via
    `peered_or_shared_vpc_ids_by_vpc` — the match must now resolve confidently, not unassessable."""
    conn = FakeConn()
    versions = {
        "sgr-1": [{"rule_id": "sgr-1", "fingerprint": "fp1", "group_id": "sg-1", "is_egress": False,
                    "protocol": "tcp", "from_port": 443, "to_port": 443, "peer_kind": "sg",
                    "peer_value": "sg-peer", "valid_from": utc(2026, 1, 1), "valid_to": None}],
    }
    memberships = {
        "vpc-1": [{"eni_id": "eni-1", "group_ids": ["sg-1"], "private_ips": ["10.2.2.2"]}],
        "vpc-OTHER": [{"eni_id": "eni-2", "group_ids": ["sg-peer"], "private_ips": ["10.1.1.1"]}],
    }
    scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                      dt.date(2026, 3, 5), [
                          {"interface_id": "eni-1", "srcaddr": "10.1.1.1", "dstaddr": "10.2.2.2",
                           "dstport": "443", "protocol": "6", "bytes": "500", "cnt": "3"},
                      ], versions, memberships, None,
                      peered_or_shared_vpc_ids_by_vpc={"vpc-1": {"vpc-OTHER"}})
    insert_call = [c for c in conn.calls if c[0].startswith("INSERT INTO sg_rule_activity_daily")][0]
    coverage = json.loads(insert_call[1]["cov"])
    assert coverage["status"] == "observed_compatible"
    assert insert_call[1]["cm"] == 3


def test_sg_reference_same_vpc_match_unaffected_by_new_scoping_logic():
    """Regression guard: the common same-VPC SG-reference case must be unaffected by the new
    cross-VPC scoping logic."""
    conn = FakeConn()
    versions = {
        "sgr-1": [{"rule_id": "sgr-1", "fingerprint": "fp1", "group_id": "sg-1", "is_egress": False,
                    "protocol": "tcp", "from_port": 443, "to_port": 443, "peer_kind": "sg",
                    "peer_value": "sg-peer", "valid_from": utc(2026, 1, 1), "valid_to": None}],
    }
    memberships = {
        "vpc-1": [
            {"eni_id": "eni-1", "group_ids": ["sg-1"], "private_ips": ["10.2.2.2"]},
            {"eni_id": "eni-2", "group_ids": ["sg-peer"], "private_ips": ["10.1.1.1"]},
        ],
    }
    scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                      dt.date(2026, 3, 5), [
                          {"interface_id": "eni-1", "srcaddr": "10.1.1.1", "dstaddr": "10.2.2.2",
                           "dstport": "443", "protocol": "6", "bytes": "500", "cnt": "3"},
                      ], versions, memberships, None)
    insert_call = [c for c in conn.calls if c[0].startswith("INSERT INTO sg_rule_activity_daily")][0]
    coverage = json.loads(insert_call[1]["cov"])
    assert coverage["status"] == "observed_compatible"


def test_sg_reference_not_found_anywhere_in_snapshot_is_unassessable_not_no_match():
    """Follow-up fix (item 6): a referenced group_id that is not carried by ANY ENI in this
    account/region's own membership snapshot (neither in-scope nor a known out-of-scope VPC) can be
    a LEGALLY cross-account or cross-region SG reference (AWS supports this via VPC peering) that
    this account/region's data structurally cannot verify. Before this fix, `_resolve` fell through
    to an empty set (not None) for this case, which `match_peer` treats as a confident, resolved
    answer -> NO_MATCH -> a false `no_observed_evidence`. Must be `unassessable` instead."""
    conn = FakeConn()
    versions = {
        "sgr-1": [{"rule_id": "sgr-1", "fingerprint": "fp1", "group_id": "sg-1", "is_egress": False,
                    "protocol": "tcp", "from_port": 443, "to_port": 443, "peer_kind": "sg",
                    "peer_value": "sg-cross-account-peer", "valid_from": utc(2026, 1, 1), "valid_to": None}],
    }
    # Note: "sg-cross-account-peer" appears in NO membership row at all — not in vpc-1, not
    # anywhere else in this account/region's own snapshot data.
    memberships = {
        "vpc-1": [{"eni_id": "eni-1", "group_ids": ["sg-1"], "private_ips": ["10.2.2.2"]}],
    }
    scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                      dt.date(2026, 3, 5), [
                          {"interface_id": "eni-1", "srcaddr": "10.1.1.1", "dstaddr": "10.2.2.2",
                           "dstport": "443", "protocol": "6", "bytes": "500", "cnt": "3"},
                      ], versions, memberships, None)
    insert_call = [c for c in conn.calls if c[0].startswith("INSERT INTO sg_rule_activity_daily")][0]
    coverage = json.loads(insert_call[1]["cov"])
    assert coverage["status"] == "unassessable"
    assert coverage["match_unassessable"] is True


# ── L4 finding #11: a `stale` membership snapshot must downgrade matches to unassessable ─────────

def test_stale_membership_snapshot_downgrades_match_to_unassessable():
    conn = FakeConn()
    res = scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                            dt.date(2026, 3, 5), [
                                {"interface_id": "eni-1", "srcaddr": "10.1.1.1", "dstaddr": "10.2.2.2",
                                 "dstport": "443", "protocol": "6", "bytes": "500", "cnt": "3"},
                            ], _versions(), _membership(), None, stale_vpcs={"vpc-1"})
    insert_call = [c for c in conn.calls if c[0].startswith("INSERT INTO sg_rule_activity_daily")][0]
    assert insert_call[1]["cm"] == 0  # never credited as confident evidence
    coverage = json.loads(insert_call[1]["cov"])
    assert coverage["status"] == "unassessable"
    assert coverage["match_unassessable"] is True


def test_non_stale_vpc_unaffected_by_stale_vpcs_set():
    conn = FakeConn()
    res = scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                            dt.date(2026, 3, 5), [
                                {"interface_id": "eni-1", "srcaddr": "10.1.1.1", "dstaddr": "10.2.2.2",
                                 "dstport": "443", "protocol": "6", "bytes": "500", "cnt": "3"},
                            ], _versions(), _membership(), None, stale_vpcs={"vpc-OTHER"})
    insert_call = [c for c in conn.calls if c[0].startswith("INSERT INTO sg_rule_activity_daily")][0]
    assert insert_call[1]["cm"] == 3


# ── L4 finding #9: a truncated day must never settle on a confident `no_observed_evidence` ───────

def test_truncated_day_downgrades_no_observed_evidence_to_unassessable():
    conn = FakeConn()
    scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                      dt.date(2026, 3, 5), [], _versions(), {}, None,
                      coverage_flags={"flow_result_truncated": True})
    insert_call = [c for c in conn.calls if c[0].startswith("INSERT INTO sg_rule_activity_daily")][0]
    coverage = json.loads(insert_call[1]["cov"])
    assert coverage["status"] == "unassessable"
    assert coverage["flow_result_truncated"] is True


def test_truncated_day_does_not_downgrade_a_real_compatible_match():
    """Truncation must not invalidate GENUINE evidence a rule already has — only the ambiguous
    zero-match case is downgraded."""
    conn = FakeConn()
    scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                      dt.date(2026, 3, 5), [
                          {"interface_id": "eni-1", "srcaddr": "10.1.1.1", "dstaddr": "10.2.2.2",
                           "dstport": "443", "protocol": "6", "bytes": "500", "cnt": "3"},
                      ], _versions(), _membership(), None,
                      coverage_flags={"eni_snapshot_truncated": True})
    insert_call = [c for c in conn.calls if c[0].startswith("INSERT INTO sg_rule_activity_daily")][0]
    coverage = json.loads(insert_call[1]["cov"])
    assert coverage["status"] == "observed_compatible"
    assert insert_call[1]["cm"] == 3


# ── MAJOR fix: UNASSESSABLE (e.g. prefix-list peer) must downgrade to `unassessable`, never be
#    silently treated as `no_observed_evidence` ──────────────────────────────────────────────────

def test_prefix_list_rule_with_no_resolver_is_unassessable_not_no_evidence():
    conn = FakeConn()
    pl_versions = _versions(peer_kind="pl", peer_value="pl-12345")
    res = scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                            dt.date(2026, 3, 5), [
                                {"interface_id": "eni-1", "srcaddr": "10.1.1.1", "dstaddr": "10.2.2.2",
                                 "dstport": "443", "protocol": "6", "bytes": "500", "cnt": "3"},
                            ], pl_versions, _membership(), None)
    insert_call = [c for c in conn.calls if c[0].startswith("INSERT INTO sg_rule_activity_daily")][0]
    coverage = json.loads(insert_call[1]["cov"])
    assert coverage["status"] == "unassessable"
    assert coverage["match_unassessable"] is True
    assert insert_call[1]["cm"] == 0


# ── MAJOR fix: the persisted fingerprint must be the version covering the scanned day, not
#    whichever version happens to be last in the list ────────────────────────────────────────────

def test_persisted_fingerprint_is_the_day_covering_version_not_the_latest():
    versions = {
        "sgr-1": [
            {"rule_id": "sgr-1", "fingerprint": "fp-old", "group_id": "sg-1", "is_egress": False,
             "protocol": "tcp", "from_port": 443, "to_port": 443, "peer_kind": "cidr",
             "peer_value": "10.0.0.0/8", "valid_from": utc(2026, 1, 1), "valid_to": utc(2026, 3, 4)},
            {"rule_id": "sgr-1", "fingerprint": "fp-new", "group_id": "sg-1", "is_egress": False,
             "protocol": "tcp", "from_port": 22, "to_port": 22, "peer_kind": "cidr",
             "peer_value": "10.0.0.0/8", "valid_from": utc(2026, 4, 1), "valid_to": None},
        ],
    }
    conn = FakeConn()
    # The scanned day (2026-03-05) is covered by neither version cleanly at its very end (fp-old
    # closes 2026-03-04, before the scanned day even starts) — so this day resolves to NO version
    # at all -> epoch-crossing/unassessable, and the fallback fingerprint must be the LATEST known
    # version ("fp-new"), never a version that happens to cover some earlier day.
    res = scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                            dt.date(2026, 3, 5), [], versions, {}, None)
    insert_call = [c for c in conn.calls if c[0].startswith("INSERT INTO sg_rule_activity_daily")][0]
    assert insert_call[1]["fp"] == "fp-new"
    coverage = json.loads(insert_call[1]["cov"])
    assert coverage["fingerprint_epoch_crossing"] is True


def test_persisted_fingerprint_is_the_exact_version_covering_the_day():
    versions = {
        "sgr-1": [
            {"rule_id": "sgr-1", "fingerprint": "fp-old", "group_id": "sg-1", "is_egress": False,
             "protocol": "tcp", "from_port": 443, "to_port": 443, "peer_kind": "cidr",
             "peer_value": "10.0.0.0/8", "valid_from": utc(2026, 1, 1), "valid_to": utc(2026, 2, 1)},
            {"rule_id": "sgr-1", "fingerprint": "fp-covers-day", "group_id": "sg-1", "is_egress": False,
             "protocol": "tcp", "from_port": 22, "to_port": 22, "peer_kind": "cidr",
             "peer_value": "10.0.0.0/8", "valid_from": utc(2026, 2, 1), "valid_to": None},
        ],
    }
    conn = FakeConn()
    res = scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                            dt.date(2026, 3, 5), [], versions, {}, None)
    insert_call = [c for c in conn.calls if c[0].startswith("INSERT INTO sg_rule_activity_daily")][0]
    assert insert_call[1]["fp"] == "fp-covers-day"
    coverage = json.loads(insert_call[1]["cov"])
    assert coverage["fingerprint_epoch_crossing"] is False


def test_process_day_no_uniqueness_conflict_on_concurrent_retry():
    """Two process_day calls for the SAME partition must both succeed (no unique index on
    sg_rule_scan_runs beyond the primary key `id`, which is a fresh uuid every call)."""
    conn = FakeConn()
    scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                      dt.date(2026, 3, 5), [], _versions(), {}, None)
    scan.process_day(conn, {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1},
                      dt.date(2026, 3, 5), [], _versions(), {}, None)
    runs = [c for c in conn.calls if c[0].startswith("INSERT INTO sg_rule_scan_runs")]
    assert len(runs) == 2
    assert runs[0][1]["id"] != runs[1][1]["id"]  # distinct run ids, no conflict


# ── load_membership_by_vpc: L4 finding #11 — outcome must actually be used, earliest_snapshot_at
#    must be threaded through (not discarded/None) ────────────────────────────────────────────────

class FakeMembershipConn:
    def __init__(self, rows):
        self._rows = rows

    def run(self, sql, **kwargs):
        if "FROM sg_eni_membership_snapshots" in sql:
            return self._rows
        return []


def test_load_membership_by_vpc_flags_stale_vpc():
    conn = FakeMembershipConn([
        ("vpc-1", utc(2026, 1, 1), "eni-1", json.dumps(["sg-1"]), json.dumps(["10.0.0.1"])),
    ])
    # Day is FAR beyond the staleness window (staleness_days=3) from the only snapshot's observed_at.
    resolved, stale_vpcs = scan.load_membership_by_vpc(
        conn, "123456789012", "ap-northeast-2", dt.date(2026, 6, 1), staleness_days=3)
    assert "vpc-1" in stale_vpcs
    assert "vpc-1" in resolved  # still resolved (credited, but downgraded downstream by process_day)


def test_load_membership_by_vpc_in_window_is_not_flagged_stale():
    conn = FakeMembershipConn([
        ("vpc-1", utc(2026, 3, 4), "eni-1", json.dumps(["sg-1"]), json.dumps(["10.0.0.1"])),
    ])
    resolved, stale_vpcs = scan.load_membership_by_vpc(
        conn, "123456789012", "ap-northeast-2", dt.date(2026, 3, 5), staleness_days=3)
    assert stale_vpcs == set()
    assert "vpc-1" in resolved


def test_load_membership_by_vpc_pins_to_global_earliest_across_all_vpcs():
    """L4 finding #11: earliest_snapshot_at must be computed ONCE across every vpc for this
    source, and threaded into EVERY vpc's resolution — not left as `None` (which would defeat the
    pre-snapshotting-backfill pinning rule for a vpc whose own snapshots all postdate another
    vpc's earlier one)."""
    conn = FakeMembershipConn([
        ("vpc-1", utc(2026, 1, 1), "eni-1", json.dumps(["sg-1"]), json.dumps(["10.0.0.1"])),
        ("vpc-2", utc(2026, 5, 1), "eni-2", json.dumps(["sg-2"]), json.dumps(["10.0.0.2"])),
    ])
    # A day BEFORE vpc-2's own earliest snapshot (2026-05-01) but AFTER the GLOBAL earliest
    # (vpc-1's 2026-01-01) must resolve via vpc-2's own nearest-prior logic, not
    # pre_snapshotting_backfill (which only applies when the day predates the GLOBAL earliest).
    resolved, stale_vpcs = scan.load_membership_by_vpc(
        conn, "123456789012", "ap-northeast-2", dt.date(2026, 3, 1), staleness_days=400)
    # vpc-2 has no snapshot at or before 2026-03-01 at all -> no_snapshot -> not resolved.
    assert "vpc-2" not in resolved
    assert "vpc-1" in resolved


# ── run() orchestration: one query per account/region/day, rescan window wiring ─────────────────

class FakeLambda:
    def __init__(self, response):
        self.response = response
        self.invocations = []

    def invoke(self, FunctionName, Payload):
        self.invocations.append(json.loads(Payload))
        class R:
            def __init__(self, body):
                self._body = body
            def get(self, k, default=None):
                return self if k == "Payload" else default
            def read(self):
                return json.dumps(self.response_body).encode("utf-8")
        r = R(None)
        r.response_body = self.response
        return {"Payload": r}


class FakeEc2:
    def describe_security_group_rules(self, **kwargs):
        return {"SecurityGroupRules": []}

    def describe_network_interfaces(self, **kwargs):
        return {"NetworkInterfaces": []}


def test_run_one_broker_invoke_for_the_eligible_day(monkeypatch):
    monkeypatch.setenv("SG_RULE_ATHENA_BROKER_ARN", "arn:aws:lambda:ap-northeast-2:123456789012:function:broker")
    conn = FakeConn({
        "FROM sg_flow_sources": [[
            # A Hive-style year/month/day layout that ALSO carries `scopeResolution` (round-7 fix:
            # its absence alone — not just `partitionKeyTypes`'s — now triggers self-heal, since a
            # Hive layout can satisfy `has_resolved_partition_strategy` without either field) — this
            # fixture represents a source already fully re-validated under the current schema, so it
            # never triggers the stale-validation self-heal path below.
            (1, "123456789012", "ap-northeast-2", "wg", "db", "tbl", True,
             json.dumps({"status": "valid", "partitionKeys": ["year", "month", "day"],
                         "partitionKeyTypes": ["string", "string", "string"],
                         "scopeResolution": {"account_id": None, "region": None}}), utc(2020, 1, 1)),
        ]],
        "FROM accounts": [[("ext-abc",)]],
        "FROM sg_rule_scan_runs": [[(None,)]],  # no watermark yet -> first run starts at source created day
        "sg_rule_inventory_versions": [[]],
        "FROM sg_eni_membership_snapshots": [[]],
    })
    fake_lambda = FakeLambda({"ok": True, "rows": []})
    monkeypatch.setattr(scan.dt, "datetime", scan.dt.datetime)  # no-op, keeps real clock behavior visible
    # Force "now" far enough past the source's created day that the delivery-lag grace period has cleared.
    result = scan.run(
        {"account_id": "123456789012", "region": "ap-northeast-2"}, conn,
        ec2_client_factory=lambda *a, **k: FakeEc2(),
        lambda_client_factory=lambda: fake_lambda,
    )
    assert result["status"] == "ok"
    assert len(fake_lambda.invocations) >= 1
    # L3 finding #6: the caller sends ONLY an opaque flow_source_id + day — never raw SQL/account.
    assert fake_lambda.invocations[0]["action"] == "query_by_source"
    assert fake_lambda.invocations[0]["flow_source_id"] == 1
    assert "query" not in fake_lambda.invocations[0]
    assert "account_id" not in fake_lambda.invocations[0]


class DispatchingFakeLambda:
    """Returns a different canned response depending on the invoked action — needed to test
    `run()`'s self-heal path, which invokes BOTH `validate` (once, only when validation is stale)
    and `query_by_source` (per eligible day) in the same call."""
    def __init__(self, responses_by_action):
        self.responses_by_action = responses_by_action
        self.invocations = []

    def invoke(self, FunctionName, Payload):
        evt = json.loads(Payload)
        self.invocations.append(evt)
        body = self.responses_by_action[evt["action"]]
        return {"Payload": type("R", (), {"read": lambda self: json.dumps(body).encode("utf-8")})()}


def test_run_self_heals_a_stale_validation_missing_partition_key_types(monkeypatch):
    """CI-review MAJOR fix (round 5): a source persisted BEFORE `partitionKeyTypes` existed reads
    `status: "valid"` yet `has_resolved_partition_strategy` (no grandfathering branch) refuses it —
    `run()` must re-run the broker's own `validate` action and persist the fresh result, rather than
    requiring a manual admin re-save before this source can ever scan again."""
    monkeypatch.setenv("SG_RULE_ATHENA_BROKER_ARN", "arn:aws:lambda:ap-northeast-2:123456789012:function:broker")
    stale_validation = {"status": "valid", "partitionKeys": ["dt"]}  # no partitionKeyTypes at all
    conn = FakeConn({
        "FROM sg_flow_sources": [[
            (1, "123456789012", "ap-northeast-2", "wg", "db", "tbl", True, json.dumps(stale_validation), utc(2020, 1, 1)),
        ]],
        "FROM accounts": [[("ext-abc",)]],
        "FROM sg_rule_scan_runs": [[(None,)]],
        "sg_rule_inventory_versions": [[]],
        "FROM sg_eni_membership_snapshots": [[]],
    })
    # CI-review MAJOR fix (round 6): the REAL broker `_validate` response (`sg_rule_athena_broker.
    # py`'s `_validate`) never carries a `status` key at all — that wrapper is added only by the web
    # BFF (`web/lib/sg-rules.ts`) at PUT-time. A fake that hand-writes `status: "valid"` here would
    # mask exactly the bug this test exists to catch (the self-heal path persisting the broker's raw,
    # `status`-less shape and permanently bricking the source on the very next run).
    fresh_validation = {"ok": True, "partitionKeys": ["dt"], "partitionKeyTypes": ["date"],
                         "columnMap": {}, "scopeResolution": {"account_id": None, "region": None}}
    fake_lambda = DispatchingFakeLambda({
        "validate": fresh_validation,
        "query_by_source": {"ok": True, "rows": []},
    })
    scan.run(
        {"account_id": "123456789012", "region": "ap-northeast-2"}, conn,
        ec2_client_factory=lambda *a, **k: FakeEc2(),
        lambda_client_factory=lambda: fake_lambda,
    )
    validate_calls = [i for i in fake_lambda.invocations if i["action"] == "validate"]
    assert len(validate_calls) == 1
    assert validate_calls[0] == {"action": "validate", "account_id": "123456789012",
                                  "region": "ap-northeast-2", "workgroup": "wg",
                                  "database": "db", "table": "tbl"}
    update_calls = [c for c in conn.calls if c[0].strip().startswith("UPDATE sg_flow_sources")]
    assert len(update_calls) == 1
    persisted = json.loads(update_calls[0][1]["v"])
    # The persisted blob must be wrapped with `status: "valid"` — the raw broker response alone
    # would make this source unscannable in the very next run (see the two guards this exercises
    # below), which is the exact regression this test guards against.
    assert persisted["status"] == "valid"
    assert persisted["ok"] is True
    assert persisted["partitionKeys"] == ["dt"]
    assert persisted["partitionKeyTypes"] == ["date"]
    assert "checkedAt" in persisted
    # The scan itself proceeded using the freshly-resolved (now scannable) strategy — i.e. the SAME
    # run's own `query_by_source` guard (`sg_rule_athena_broker.py`'s `_query_by_source`, which
    # checks `validation.status != 'valid'`) did NOT refuse the just-self-healed row.
    query_calls = [i for i in fake_lambda.invocations if i["action"] == "query_by_source"]
    assert len(query_calls) >= 1
    # A SUBSEQUENT run must also see the healed, valid-shaped validation — not fall back into
    # `run()`'s own `validation.status != 'valid'` guard (which would exit with
    # `awaiting_validation` before even reaching the self-heal block again).
    second_run_lambda = DispatchingFakeLambda({
        "validate": fresh_validation,  # must NOT be invoked again
        "query_by_source": {"ok": True, "rows": []},
    })
    conn2 = FakeConn({
        "FROM sg_flow_sources": [[
            (1, "123456789012", "ap-northeast-2", "wg", "db", "tbl", True, json.dumps(persisted), utc(2020, 1, 1)),
        ]],
        "FROM accounts": [[("ext-abc",)]],
        "FROM sg_rule_scan_runs": [[(None,)]],
        "sg_rule_inventory_versions": [[]],
        "FROM sg_eni_membership_snapshots": [[]],
    })
    result2 = scan.run(
        {"account_id": "123456789012", "region": "ap-northeast-2"}, conn2,
        ec2_client_factory=lambda *a, **k: FakeEc2(),
        lambda_client_factory=lambda: second_run_lambda,
    )
    assert result2.get("status") != "awaiting_validation"
    assert not [i for i in second_run_lambda.invocations if i["action"] == "validate"]
    assert [i for i in second_run_lambda.invocations if i["action"] == "query_by_source"]


def test_run_self_heals_a_legacy_hive_style_source_missing_scope_resolution(monkeypatch):
    """CI-review MAJOR fix (round 7): the round-5 self-heal condition gated on
    `not sm.has_resolved_partition_strategy(validation)` — but a Hive-style year/month/day layout
    satisfies that check WITHOUT needing `partitionKeyTypes` OR `scopeResolution` at all (that
    function never looks at scope metadata). A pre-round-2 Hive-style source on a centralized/
    org-wide table therefore never re-validated under the round-5 condition, permanently missing
    `scopeResolution`/`scannedUnscoped` and the account/region scope predicate — exactly the
    'scanned entirely unscoped, which used to be silent' defect the round-2 fix exists to close.
    `run()` must self-heal on `scopeResolution` being absent too, not just `partitionKeyTypes`."""
    monkeypatch.setenv("SG_RULE_ATHENA_BROKER_ARN", "arn:aws:lambda:ap-northeast-2:123456789012:function:broker")
    # A pre-round-2 Hive-style validation: has_resolved_partition_strategy(this) is already True,
    # so the OLD self-heal condition would skip it entirely.
    legacy_hive_validation = {"status": "valid", "partitionKeys": ["year", "month", "day"]}
    conn = FakeConn({
        "FROM sg_flow_sources": [[
            (1, "123456789012", "ap-northeast-2", "wg", "db", "tbl", True,
             json.dumps(legacy_hive_validation), utc(2020, 1, 1)),
        ]],
        "FROM accounts": [[("ext-abc",)]],
        "FROM sg_rule_scan_runs": [[(None,)]],
        "sg_rule_inventory_versions": [[]],
        "FROM sg_eni_membership_snapshots": [[]],
    })
    fresh_validation = {"ok": True, "partitionKeys": ["year", "month", "day"],
                         "partitionKeyTypes": ["string", "string", "string"],
                         "columnMap": {"account_id": "account_id", "region": "region"},
                         "scopeResolution": {"account_id": "column", "region": "column"}}
    fake_lambda = DispatchingFakeLambda({
        "validate": fresh_validation,
        "query_by_source": {"ok": True, "rows": []},
    })
    scan.run(
        {"account_id": "123456789012", "region": "ap-northeast-2"}, conn,
        ec2_client_factory=lambda *a, **k: FakeEc2(),
        lambda_client_factory=lambda: fake_lambda,
    )
    validate_calls = [i for i in fake_lambda.invocations if i["action"] == "validate"]
    assert len(validate_calls) == 1
    update_calls = [c for c in conn.calls if c[0].strip().startswith("UPDATE sg_flow_sources")]
    assert len(update_calls) == 1
    persisted = json.loads(update_calls[0][1]["v"])
    assert persisted["scopeResolution"] == {"account_id": "column", "region": "column"}


def test_run_self_heals_a_stale_hive_layout_source_missing_scope_resolution(monkeypatch):
    """CI-review MAJOR fix (round 7): a Hive-style year/month/day source persisted BEFORE round-2's
    scope-resolution work satisfies `has_resolved_partition_strategy` WITHOUT needing
    `partitionKeyTypes` or `scopeResolution` at all — so the original round-5 condition (`not
    sm.has_resolved_partition_strategy(validation)`) never re-validated it, permanently stranding it
    unscoped (no `account_id`/`region` predicate, no `scopeResolution`/`scannedUnscoped` markers) on
    every run, exactly the pre-round-2 defect. `run()` must trigger self-heal for ANY source whose
    persisted validation lacks `scopeResolution` — regardless of whether its partition strategy
    already happens to resolve — and the healed validation must carry `scopeResolution` afterward."""
    monkeypatch.setenv("SG_RULE_ATHENA_BROKER_ARN", "arn:aws:lambda:ap-northeast-2:123456789012:function:broker")
    # A real pre-PR-231 legacy row: Hive layout, `status: "valid"`, no `partitionKeyTypes` and no
    # `scopeResolution` — `has_resolved_partition_strategy` returns True for this shape today.
    legacy_hive_validation = {"status": "valid", "partitionKeys": ["year", "month", "day"]}
    conn = FakeConn({
        "FROM sg_flow_sources": [[
            (1, "123456789012", "ap-northeast-2", "wg", "db", "tbl", True,
             json.dumps(legacy_hive_validation), utc(2020, 1, 1)),
        ]],
        "FROM accounts": [[("ext-abc",)]],
        "FROM sg_rule_scan_runs": [[(None,)]],
        "sg_rule_inventory_versions": [[]],
        "FROM sg_eni_membership_snapshots": [[]],
    })
    fresh_validation = {
        "ok": True, "partitionKeys": ["year", "month", "day"],
        "partitionKeyTypes": ["string", "string", "string"], "columnMap": {},
        "scopeResolution": {"account_id": "partition", "region": "partition"},
    }
    fake_lambda = DispatchingFakeLambda({
        "validate": fresh_validation,
        "query_by_source": {"ok": True, "rows": []},
    })
    scan.run(
        {"account_id": "123456789012", "region": "ap-northeast-2"}, conn,
        ec2_client_factory=lambda *a, **k: FakeEc2(),
        lambda_client_factory=lambda: fake_lambda,
    )
    # The self-heal must have fired even though `has_resolved_partition_strategy` would already
    # accept the pre-heal Hive layout — the trigger is `scopeResolution`'s absence, not whether the
    # partition strategy is resolved.
    validate_calls = [i for i in fake_lambda.invocations if i["action"] == "validate"]
    assert len(validate_calls) == 1
    update_calls = [c for c in conn.calls if c[0].strip().startswith("UPDATE sg_flow_sources")]
    assert len(update_calls) == 1
    persisted = json.loads(update_calls[0][1]["v"])
    assert persisted["status"] == "valid"
    assert persisted["scopeResolution"] == {"account_id": "partition", "region": "partition"}


def test_run_refuses_the_scan_when_self_heal_re_validation_fails_for_a_hive_source(monkeypatch):
    """CI-review MAJOR fix (round 8): when the staleness trigger fires and `invoke_broker_validate`
    does NOT return `ok: true` (a transient Lambda/Glue error, or a table that now genuinely fails
    the current gate), `run()` used to fall through and scan on the STALE validation, on the theory
    that `has_resolved_partition_strategy` would refuse it downstream anyway — false for a
    Hive-style year/month/day layout, which satisfies that check without `scopeResolution` at all.
    Falling through therefore let a pre-round-2 Hive-style source on a centralized table scan
    UNSCOPED on every run where re-validation happens to fail — reopening exactly the
    'silently keep scanning unscoped forever' defect the round-2/6 fixes exist to close. A stale,
    unconfirmed validation must refuse the run instead of being trusted."""
    monkeypatch.setenv("SG_RULE_ATHENA_BROKER_ARN", "arn:aws:lambda:ap-northeast-2:123456789012:function:broker")
    legacy_hive_validation = {"status": "valid", "partitionKeys": ["year", "month", "day"]}
    conn = FakeConn({
        "FROM sg_flow_sources": [[
            (1, "123456789012", "ap-northeast-2", "wg", "db", "tbl", True,
             json.dumps(legacy_hive_validation), utc(2020, 1, 1)),
        ]],
        "FROM accounts": [[("ext-abc",)]],
        "FROM sg_rule_scan_runs": [[(None,)]],
        "sg_rule_inventory_versions": [[]],
        "FROM sg_eni_membership_snapshots": [[]],
    })
    fake_lambda = DispatchingFakeLambda({
        "validate": {"ok": False, "reason": "transient Glue API error"},
        "query_by_source": {"ok": True, "rows": []},  # must NEVER be reached
    })
    result = scan.run(
        {"account_id": "123456789012", "region": "ap-northeast-2"}, conn,
        ec2_client_factory=lambda *a, **k: FakeEc2(),
        lambda_client_factory=lambda: fake_lambda,
    )
    assert result["status"] == "awaiting_validation"
    assert not [i for i in fake_lambda.invocations if i["action"] == "query_by_source"]
    assert not [c for c in conn.calls if c[0].strip().startswith("UPDATE sg_flow_sources")]


def test_run_does_not_revalidate_a_source_that_was_genuinely_checked_and_rejected(monkeypatch):
    """A validation that DOES carry `partitionKeyTypes` AND `scopeResolution` (it was fully checked
    under the current schema, and the type genuinely isn't date-shaped) must never be silently
    re-tried on every single run — both fields' presence is what distinguishes 'stale, never
    re-checked under the current schema' from 'confirmed, permanently unscannable'. (Round-7 CI
    review fix: `scopeResolution`, not just `partitionKeyTypes`, must be present — a Hive-style
    source can pass `has_resolved_partition_strategy` without either field, so gating self-heal on
    that check being satisfied let legacy Hive sources skip re-validation forever and keep scanning
    a centralized table unscoped.)"""
    monkeypatch.setenv("SG_RULE_ATHENA_BROKER_ARN", "arn:aws:lambda:ap-northeast-2:123456789012:function:broker")
    checked_and_rejected = {"status": "valid", "partitionKeys": ["dt"], "partitionKeyTypes": ["bigint"],
                             "scopeResolution": {"account_id": None, "region": None}}
    conn = FakeConn({
        "FROM sg_flow_sources": [[
            (1, "123456789012", "ap-northeast-2", "wg", "db", "tbl", True, json.dumps(checked_and_rejected), utc(2020, 1, 1)),
        ]],
        "FROM accounts": [[("ext-abc",)]],
        "FROM sg_rule_scan_runs": [[(None,)]],
        "sg_rule_inventory_versions": [[]],
        "FROM sg_eni_membership_snapshots": [[]],
    })
    fake_lambda = DispatchingFakeLambda({"validate": {"ok": True}, "query_by_source": {"ok": True, "rows": []}})
    scan.run(
        {"account_id": "123456789012", "region": "ap-northeast-2"}, conn,
        ec2_client_factory=lambda *a, **k: FakeEc2(),
        lambda_client_factory=lambda: fake_lambda,
    )
    assert not [i for i in fake_lambda.invocations if i["action"] == "validate"]
    assert not [c for c in conn.calls if c[0].strip().startswith("UPDATE sg_flow_sources")]


def test_run_threads_a_per_boundary_lag_resolver_callable_into_process_day(monkeypatch):
    """Item 2 follow-up fix (round 3): `run()` must pass a per-boundary lag RESOLVER (a callable,
    `sm.day_coverage`'s new callable-`observation_lag` contract) into `process_day` — never a single
    scalar computed against THIS run's own `now`, which would apply that run's gap uniformly to
    every historical version boundary a rescan-window day might resolve to (see
    `test_rescan_window_does_not_flip_an_unassessable_day_confident_after_a_later_short_gap_run`
    below for the concrete failure this replaces)."""
    monkeypatch.setenv("SG_RULE_ATHENA_BROKER_ARN", "arn:aws:lambda:ap-northeast-2:123456789012:function:broker")
    conn = FakeConn({
        "FROM sg_flow_sources": [[
            (1, "123456789012", "ap-northeast-2", "wg", "db", "tbl", True, json.dumps({"status": "valid"}), utc(2020, 1, 1)),
        ]],
        "FROM accounts": [[("ext-abc",)]],
        "FROM sg_rule_scan_runs": [
            [(None,)],  # last_committed_day's own query — the resolver itself queries lazily,
                        # only when day_coverage actually needs a lag for a CLOSED version.
        ],
        "sg_rule_inventory_versions": [[]],
        "FROM sg_eni_membership_snapshots": [[]],
    })
    fake_lambda = FakeLambda({"ok": True, "rows": []})
    captured = {}
    real_process_day = scan.process_day

    def fake_process_day(*a, **k):
        captured["observation_lag"] = k.get("observation_lag")
        return real_process_day(*a, **k)

    monkeypatch.setattr(scan, "process_day", fake_process_day)
    scan.run(
        {"account_id": "123456789012", "region": "ap-northeast-2"}, conn,
        ec2_client_factory=lambda *a, **k: FakeEc2(),
        lambda_client_factory=lambda: fake_lambda,
    )
    assert callable(captured["observation_lag"])
    # Invoking the resolver for an arbitrary boundary queries sg_rule_scan_runs lazily, on demand.
    conn.responses["FROM sg_rule_scan_runs"] = [[(utc(2026, 3, 1),)]]
    gap = captured["observation_lag"](utc(2026, 3, 9))
    assert gap == utc(2026, 3, 9) - utc(2026, 3, 1)


class _ScanRunsHistoryConn:
    """Item 2 follow-up fix (round 3) regression-test harness: tracks a real, growing
    `sg_rule_scan_runs` history across MULTIPLE `process_day()` calls (simulating separate daily
    scan runs, unlike the fixed canned-response-queue `FakeConn` above) — so
    `scan.boundary_lag_resolver`/`scan.previous_successful_scan_gap` see the actual accumulated
    history a real rescan-window re-run would see, instead of a scripted response list. `clock`
    controls the `started_at` this fake assigns to the next `INSERT INTO sg_rule_scan_runs` row
    (mirroring that statement's own `now()` SQL literal, which a fake can't evaluate for real) —
    the test advances it to simulate the passage of time between successive runs."""

    def __init__(self):
        self.scan_runs = []  # list of (started_at, status)
        self.activity_daily = []  # captured INSERT INTO sg_rule_activity_daily kwargs, in order
        self.clock = None
        self.in_txn = False

    def run(self, sql, **kwargs):
        s = sql.strip()
        if s == "BEGIN":
            self.in_txn = True
            return []
        if s in ("COMMIT", "ROLLBACK"):
            self.in_txn = False
            return []
        if "SELECT max(started_at) FROM sg_rule_scan_runs" in sql:
            before = kwargs["before"]
            candidates = [t for t, status in self.scan_runs if status == "succeeded" and t < before]
            return [(max(candidates),)] if candidates else [(None,)]
        if "INSERT INTO sg_rule_scan_runs" in sql:
            self.scan_runs.append((self.clock, "succeeded"))
            return []
        if "INSERT INTO sg_rule_activity_daily" in sql:
            self.activity_daily.append(kwargs)
            return []
        return []  # DELETE FROM sg_rule_activity_daily, etc. — not needed by this test.


def test_rescan_window_does_not_flip_an_unassessable_day_confident_after_a_later_short_gap_run():
    """Item 2 follow-up fix (round 3) regression test — the EXACT scenario the CI review described:
    a multi-day scan outage means the run that finally closes an old rule-inventory version (on
    day D_close) correctly sees a wide gap and marks the affected day `unassessable`. A day or two
    LATER, the next run's OWN gap (relative to D_close) is short — but its trailing rescan window
    idempotently re-processes that SAME already-`unassessable` day. Before this fix, `run()` would
    have threaded THAT run's own short gap into `sm.day_coverage()` for every boundary, silently
    overwriting the earlier correct `unassessable` with a confident (wrong) attribution. This test
    exercises the REAL `process_day` + `boundary_lag_resolver` + `previous_successful_scan_gap`
    wiring against a real (if fake) growing `sg_rule_scan_runs` history — not `sm.day_coverage` in
    isolation with a hand-fed scalar."""
    conn = _ScanRunsHistoryConn()
    source = {"account_id": "123456789012", "region": "ap-northeast-2", "id": 1}
    day = dt.date(2026, 3, 5)

    t0 = utc(2026, 3, 1)       # last successful run BEFORE the outage
    t_close = utc(2026, 3, 9)  # the outage-closing run: an 8-day gap since t0, correctly wide
    t_next = utc(2026, 3, 10)  # the NEXT run: only a 1-day gap since t_close

    rule_versions = {
        "sgr-1": [
            {"valid_from": utc(2026, 1, 1), "valid_to": t_close, "fingerprint": "fp-old",
             "group_id": "sg-1", "is_egress": False, "protocol": "tcp", "from_port": 443,
             "to_port": 443, "peer_kind": "cidr", "peer_value": "10.0.0.0/8"},
            {"valid_from": t_close, "valid_to": None, "fingerprint": "fp-new",
             "group_id": "sg-1", "is_egress": False, "protocol": "tcp", "from_port": 443,
             "to_port": 443, "peer_kind": "cidr", "peer_value": "10.0.0.0/8"},
        ],
    }

    # Seed history with the pre-outage successful run, then run process_day exactly as the
    # outage-closing run itself would (its own scan_runs row is written with started_at=t_close).
    conn.scan_runs.append((t0, "succeeded"))
    conn.clock = t_close
    resolver_1 = scan.boundary_lag_resolver(conn, source["id"])
    scan.process_day(conn, source, day, [], rule_versions, {}, None, observation_lag=resolver_1)
    status_1 = json.loads(conn.activity_daily[-1]["cov"])["status"]
    assert status_1 == "unassessable"  # the wide (8-day) gap correctly marks this crossing.

    # A LATER run — only a short gap after the outage-closing run — re-processes the SAME day via
    # the idempotent rescan window. It builds its OWN fresh resolver (exactly like a real run()
    # call would), against the SAME (now-grown) history.
    conn.clock = t_next
    resolver_2 = scan.boundary_lag_resolver(conn, source["id"])
    scan.process_day(conn, source, day, [], rule_versions, {}, None, observation_lag=resolver_2)
    status_2 = json.loads(conn.activity_daily[-1]["cov"])["status"]
    # The version boundary's own valid_to (t_close) never changed — the resolver must anchor to the
    # gap that preceded t_close (8 days, still wide), NOT the short 1-day gap before t_next. The day
    # must stay unassessable, never flip to a confident attribution.
    assert status_2 == "unassessable"


def test_run_returns_inventory_only_when_broker_not_configured(monkeypatch):
    monkeypatch.delenv("SG_RULE_ATHENA_BROKER_ARN", raising=False)
    conn = FakeConn({
        "FROM sg_flow_sources": [[
            (1, "123456789012", "ap-northeast-2", "wg", "db", "tbl", True, json.dumps({"status": "valid"}), utc(2020, 1, 1)),
        ]],
        "FROM accounts": [[("ext-abc",)]],
        "sg_rule_inventory_versions": [[]],
    })
    result = scan.run(
        {"account_id": "123456789012", "region": "ap-northeast-2"}, conn,
        ec2_client_factory=lambda *a, **k: FakeEc2(),
    )
    assert result["status"] == "inventory_only"


# ── L3 finding #8a: a 'pending' source must never reach the broker at all ────────────────────────

def test_run_short_circuits_pending_source_without_invoking_broker(monkeypatch):
    monkeypatch.setenv("SG_RULE_ATHENA_BROKER_ARN", "arn:aws:lambda:ap-northeast-2:123456789012:function:broker")
    conn = FakeConn({
        "FROM sg_flow_sources": [[
            (1, "123456789012", "ap-northeast-2", "wg", "db", "tbl", True, json.dumps({"status": "pending"}), utc(2020, 1, 1)),
        ]],
        "FROM accounts": [[("ext-abc",)]],
        "sg_rule_inventory_versions": [[]],
    })
    fake_lambda = FakeLambda({"ok": True, "rows": []})
    result = scan.run(
        {"account_id": "123456789012", "region": "ap-northeast-2"}, conn,
        ec2_client_factory=lambda *a, **k: FakeEc2(),
        lambda_client_factory=lambda: fake_lambda,
    )
    assert result["status"] == "awaiting_validation"
    assert fake_lambda.invocations == []


# ── MAJOR fix: failure invisibility — a failed Athena day must write a real, terminal `failed`
#    sg_rule_scan_runs row, not just an in-memory note that run()'s "status": "ok" return discards ─

def test_run_writes_failed_run_row_on_athena_query_failure(monkeypatch):
    monkeypatch.setenv("SG_RULE_ATHENA_BROKER_ARN", "arn:aws:lambda:ap-northeast-2:123456789012:function:broker")
    conn = FakeConn({
        "FROM sg_flow_sources": [[
            # Validation already carries partitionKeyTypes/scopeResolution (fully re-validated under
            # the current schema) so this test exercises the Athena query failure path, not the
            # unrelated self-heal-re-validation-failure path (round 8) — the single-response
            # `FakeLambda` below returns `ok: False` for EVERY action including `validate`, which
            # would otherwise make `run()` short-circuit with `awaiting_validation` before ever
            # reaching `invoke_broker_query`.
            (1, "123456789012", "ap-northeast-2", "wg", "db", "tbl", True,
             json.dumps({"status": "valid", "partitionKeys": ["dt"], "partitionKeyTypes": ["date"],
                         "scopeResolution": {"account_id": None, "region": None}}), utc(2020, 1, 1)),
        ]],
        "FROM accounts": [[("ext-abc",)]],
        "FROM sg_rule_scan_runs": [[(None,)]],
        "sg_rule_inventory_versions": [[]],
        "FROM sg_eni_membership_snapshots": [[]],
    })
    fake_lambda = FakeLambda({"ok": False, "reason": "workgroup budget exceeded"})
    result = scan.run(
        {"account_id": "123456789012", "region": "ap-northeast-2"}, conn,
        ec2_client_factory=lambda *a, **k: FakeEc2(),
        lambda_client_factory=lambda: fake_lambda,
    )
    assert result["status"] == "ok"
    failed_runs = [c for c in conn.calls
                   if c[0].startswith("INSERT INTO sg_rule_scan_runs") and c[1].get("id") is not None
                   and "'failed'" in c[0]]
    assert len(failed_runs) >= 1
    assert failed_runs[0][1]["ec"] == "athena_query_failed"


def test_run_writes_failed_run_row_on_process_day_exception(monkeypatch):
    monkeypatch.setenv("SG_RULE_ATHENA_BROKER_ARN", "arn:aws:lambda:ap-northeast-2:123456789012:function:broker")
    conn = FakeConn({
        "FROM sg_flow_sources": [[
            (1, "123456789012", "ap-northeast-2", "wg", "db", "tbl", True, json.dumps({"status": "valid"}), utc(2020, 1, 1)),
        ]],
        "FROM accounts": [[("ext-abc",)]],
        "FROM sg_rule_scan_runs": [[(None,)]],
        "sg_rule_inventory_versions": [[]],
        "FROM sg_eni_membership_snapshots": [[]],
    })

    def boom(*a, **k):
        raise RuntimeError("db exploded")
    monkeypatch.setattr(scan, "process_day", boom)
    fake_lambda = FakeLambda({"ok": True, "rows": []})
    result = scan.run(
        {"account_id": "123456789012", "region": "ap-northeast-2"}, conn,
        ec2_client_factory=lambda *a, **k: FakeEc2(),
        lambda_client_factory=lambda: fake_lambda,
    )
    assert result["status"] == "ok"  # run() itself must not crash — one day's failure is isolated
    failed_runs = [c for c in conn.calls
                   if c[0].startswith("INSERT INTO sg_rule_scan_runs") and "'failed'" in c[0]]
    assert len(failed_runs) >= 1
    assert failed_runs[0][1]["ec"] == "process_day_failed"
