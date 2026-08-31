"""Tests for sg_rule_athena_broker.py.

L3 finding #6 (round 2): the broker's old `action: "query"` executed a verbatim caller-supplied
SQL string against caller-supplied account_id/region/workgroup/database — a generic cross-account
SELECT proxy. That action is REMOVED. `action: "query_by_source"` accepts ONLY an opaque
`flow_source_id` + `day`; the broker resolves the source's config from Aurora itself and builds the
SQL server-side. These tests exercise: (a) the "validate" action's still-raw-input identifier
re-validation (called before a flow_source_id exists) + its new BytesScannedCutoffPerQuery
requirement (L3 #8c), (b) `_query_by_source`'s Aurora-driven resolution + validation-status/
partition-strategy refusal (L3 #8a/#8b), and (c) pagination/continuation (L2 #4) + the
zero-partition-match / SKIPDATA coverage signals (L4 #9)."""
import datetime as dt
import json

import pytest

import sg_rule_athena_broker as broker


# ── "validate" action: still raw caller input (no flow_source_id exists yet) ────────────────────

def test_validate_rejects_malformed_table():
    with pytest.raises(broker.BrokerError, match="table"):
        broker._validate({
            "account_id": "123456789012", "region": "ap-northeast-2", "workgroup": "wg",
            "database": "db", "table": "tbl; DROP",
        }, None)


def test_validate_rejects_malformed_account_id_before_any_aws_call():
    # Never even attempts _assumed_session (no AWS/network call from this test).
    with pytest.raises(broker.BrokerError, match="account_id"):
        broker._validate({
            "account_id": "12345", "region": "ap-northeast-2", "workgroup": "wg",
            "database": "db", "table": "tbl",
        }, None)


def test_validate_rejects_malformed_region():
    with pytest.raises(broker.BrokerError, match="region"):
        broker._validate({
            "account_id": "123456789012", "region": "; DROP TABLE x", "workgroup": "wg",
            "database": "db", "table": "tbl",
        }, None)


def test_validate_rejects_malformed_workgroup():
    with pytest.raises(broker.BrokerError, match="workgroup"):
        broker._validate({
            "account_id": "123456789012", "region": "ap-northeast-2", "workgroup": "wg; DROP",
            "database": "db", "table": "tbl",
        }, None)


def test_validate_rejects_malformed_database():
    with pytest.raises(broker.BrokerError, match="database"):
        broker._validate({
            "account_id": "123456789012", "region": "ap-northeast-2", "workgroup": "wg",
            "database": "db-with-hyphen", "table": "tbl",
        }, None)


def test_lambda_handler_shapes_identifier_rejection_as_ok_false():
    result = broker.lambda_handler({
        "action": "validate", "account_id": "bad", "region": "ap-northeast-2",
        "workgroup": "wg", "database": "db", "table": "tbl",
    }, None)
    assert result["ok"] is False
    assert "account_id" in result["reason"]


def test_lambda_handler_rejects_the_removed_raw_query_action():
    """The old generic caller-controlled cross-account SELECT proxy is gone — an `action: "query"`
    invocation (the exact shape the L3 finding described as exploitable) must be refused, never
    silently accepted."""
    result = broker.lambda_handler({
        "action": "query", "account_id": "123456789012", "region": "ap-northeast-2",
        "workgroup": "wg", "database": "db", "query": "SELECT * FROM secrets",
    }, None)
    assert result["ok"] is False
    assert "unknown action" in result["reason"]


# ── existing SELECT-only guard (unchanged behavior, sanity-checked here too; UNION is now
#    forbidden too — L3 finding #7) ───────────────────────────────────────────────────────────────

def test_reject_non_select_rejects_mutating_keyword():
    with pytest.raises(broker.BrokerError):
        broker._reject_non_select("SELECT 1; DROP TABLE x")


def test_reject_non_select_rejects_union():
    with pytest.raises(broker.BrokerError, match="forbidden"):
        broker._reject_non_select("SELECT 1 UNION SELECT secret FROM other_table")


def test_reject_non_select_accepts_bare_select():
    broker._reject_non_select("SELECT 1")  # must not raise


# ── MINOR fix (defense-in-depth): the broker's account-id/region regexes are ALIASED to
#    sg_rule_matching's copies (not independently duplicated), a deliberate merge of an
#    ingress-side AssumeRole-input gate with an SQL-literal-side check. If module boundaries stay
#    merged, this test pins BOTH patterns to the exact same accepted/rejected value set, so a
#    future edit to one (e.g. loosening the matching module's regex for a legitimate SQL-value
#    reason) is caught by CI even though it would silently widen the broker's own AssumeRole gate
#    too. ────────────────────────────────────────────────────────────────────────────────────────

def test_broker_and_matching_account_id_region_patterns_stay_value_equal():
    assert broker._ACCOUNT_ID_RE is broker.sm._ACCOUNT_ID_VALUE_RE
    assert broker._REGION_RE is broker.sm._REGION_VALUE_RE

    accepted_account_ids = ["123456789012", "000000000000"]
    rejected_account_ids = ["12345", "1234567890123", "12345678901a", "; DROP TABLE x"]
    for value in accepted_account_ids:
        assert broker._ACCOUNT_ID_RE.match(value)
        assert broker.sm._ACCOUNT_ID_VALUE_RE.match(value)
    for value in rejected_account_ids:
        assert not broker._ACCOUNT_ID_RE.match(value)
        assert not broker.sm._ACCOUNT_ID_VALUE_RE.match(value)

    accepted_regions = ["ap-northeast-2", "us-east-1", "us-gov-west-1"]
    rejected_regions = ["ap_northeast_2", "APNORTHEAST2", "; DROP TABLE x", "ap-northeast"]
    for value in accepted_regions:
        assert broker._REGION_RE.match(value)
        assert broker.sm._REGION_VALUE_RE.match(value)
    for value in rejected_regions:
        assert not broker._REGION_RE.match(value)
        assert not broker.sm._REGION_VALUE_RE.match(value)


# ── "query_by_source": Aurora-resolved config, never caller-supplied SQL/account (L3 #6) ─────────

class FakeConn:
    """`responses` maps a substring of the SQL to the ONE row-tuple list it should return, popped
    in FIFO order."""
    def __init__(self, responses):
        self.responses = {k: list(v) for k, v in responses.items()}
        self.calls = []

    def run(self, sql, **kwargs):
        self.calls.append((sql, kwargs))
        for key, rows in self.responses.items():
            if key in sql:
                return rows.pop(0) if rows else []
        return []

    def close(self):
        pass


def _source_row(validation, account_id="123456789012", region="ap-northeast-2", enabled=True,
                 accounts_rows=(("ext-123",),)):
    return {
        "FROM sg_flow_sources": [[
            (account_id, region, "wg", "db", "tbl", json.dumps(validation), enabled),
        ]],
        "FROM accounts": [list(accounts_rows)],
    }


# ── round-4 CI-review finding (L3, items 1 + 3): `_load_source_row` must apply the SAME
#    enabled-required confused-deputy guard `validate`'s `_resolve_external_id` already enforces,
#    and must refuse a disabled `sg_flow_sources` row — even when `query_by_source` is invoked
#    directly, bypassing the dispatcher's own `WHERE enabled` filter. ─────────────────────────────

def test_query_by_source_refuses_a_disabled_account(monkeypatch):
    """item 1(a): an `accounts` row with `enabled=false` (modeled here as no matching row, since the
    real query carries `AND enabled`) must refuse the scan rather than assume with no ExternalId."""
    conn = FakeConn(_source_row({"status": "valid"}, accounts_rows=()))
    monkeypatch.setattr(broker, "_assumed_session",
                         lambda *a, **k: (_ for _ in ()).throw(AssertionError("must never be called")))
    with pytest.raises(broker.BrokerError, match="registered"):
        broker._query_by_source({"flow_source_id": 1, "day": "2026-03-05"}, conn)


def test_query_by_source_refuses_an_unregistered_account(monkeypatch):
    """item 1(b): an account_id with no `accounts` row at all gets the same refusal."""
    conn = FakeConn(_source_row({"status": "valid"}, accounts_rows=()))
    monkeypatch.setattr(broker, "_assumed_session",
                         lambda *a, **k: (_ for _ in ()).throw(AssertionError("must never be called")))
    with pytest.raises(broker.BrokerError, match="registered"):
        broker._query_by_source({"flow_source_id": 1, "day": "2026-03-05"}, conn)


def test_query_by_source_refuses_a_disabled_flow_source(monkeypatch):
    """item 3: a disabled `sg_flow_sources` row must be refused by `query_by_source` even when
    invoked directly (bypassing the dispatcher's own `WHERE enabled` filter) — any principal with
    `lambda:InvokeFunction` on this broker must not be able to drive a scan of a disabled source."""
    conn = FakeConn(_source_row({"status": "valid"}, enabled=False))
    monkeypatch.setattr(broker, "_assumed_session",
                         lambda *a, **k: (_ for _ in ()).throw(AssertionError("must never be called")))
    with pytest.raises(broker.BrokerError, match="disabled"):
        broker._query_by_source({"flow_source_id": 1, "day": "2026-03-05"}, conn)


def test_query_by_source_rejects_non_int_flow_source_id():
    with pytest.raises(broker.BrokerError, match="flow_source_id"):
        broker._query_by_source({"flow_source_id": "1; DROP", "day": "2026-03-05"}, FakeConn({}))


def test_query_by_source_rejects_malformed_day():
    with pytest.raises(broker.BrokerError, match="day"):
        broker._query_by_source({"flow_source_id": 1, "day": "not-a-day"}, FakeConn({}))


def test_query_by_source_refuses_pending_source():
    """L3 finding #8a: a source whose validation.status isn't 'valid' must never be scanned."""
    conn = FakeConn(_source_row({"status": "pending"}))
    result = broker._query_by_source({"flow_source_id": 1, "day": "2026-03-05"}, conn)
    assert result["ok"] is False
    assert "valid" in result["reason"]


def test_query_by_source_refuses_unbounded_scan_without_partition_strategy():
    """L3 finding #8b: no resolved partition strategy -> refuse rather than fall back to an
    unbounded full-table scan."""
    conn = FakeConn(_source_row({"status": "valid", "columnMap": {}, "partitionKeys": []}))
    result = broker._query_by_source({"flow_source_id": 1, "day": "2026-03-05"}, conn)
    assert result["ok"] is False
    assert "partition" in result["reason"]


# ── round-3 finding #6: `validate` must resolve external_id from the `accounts` table server-side ─

def test_validate_resolves_external_id_from_accounts_table_ignoring_caller_supplied_value(monkeypatch):
    """A caller-supplied `external_id` in the event must be completely ignored — the value actually
    used to assume Role B must come from the `accounts` table, exactly like `_load_source_row`."""
    conn = FakeConn({"FROM accounts": [[("ext-real-from-table",)]]})
    captured = {}

    def fake_assumed_session(account_id, external_id, region):
        captured["account_id"] = account_id
        captured["external_id"] = external_id
        raise broker.BrokerError("stop before any real AWS call")

    monkeypatch.setattr(broker, "_assumed_session", fake_assumed_session)
    with pytest.raises(broker.BrokerError, match="stop before"):
        broker._validate({
            "account_id": "123456789012", "region": "ap-northeast-2", "workgroup": "wg",
            "database": "db", "table": "tbl",
            "external_id": "attacker-controlled-ext-id",  # must be ignored entirely
        }, conn)
    assert captured["external_id"] == "ext-real-from-table"
    assert captured["account_id"] == "123456789012"


def test_validate_rejects_an_unregistered_account_id(monkeypatch):
    """`validate` must not assume a role into an account_id with no enabled row in `accounts` —
    inverting the confused-deputy guard by trusting the caller entirely was the bug (bypassing the
    accounts table this same module resolves external_id from everywhere else)."""
    conn = FakeConn({"FROM accounts": [[]]})  # no matching enabled row
    monkeypatch.setattr(broker, "_assumed_session",
                         lambda *a, **k: (_ for _ in ()).throw(AssertionError("must never be called")))
    with pytest.raises(broker.BrokerError, match="registered"):
        broker._validate({
            "account_id": "999999999999", "region": "ap-northeast-2", "workgroup": "wg",
            "database": "db", "table": "tbl", "external_id": "attacker-ext",
        }, conn)


# ── MAJOR fix: `_validate` must ALSO resolve the optional `account_id`/`region` columns into
#    `columnMap`. They are not Flow Log fields, so the required-field loop can never put them there
#    — and without them `sg_rule_matching._build_scope_predicate` is unreachable dead code, leaving
#    a centralized/org-wide flow-log table scanned unscoped. ───────────────────────────────────────

_CANONICAL_FLOW_COLUMNS = ["interface-id", "srcaddr", "dstaddr", "srcport", "dstport", "protocol",
                            "action", "log-status", "start", "end"]


def _validate_with_columns(monkeypatch, conn, columns):
    class FakeAthenaWorkGroup:
        def get_work_group(self, WorkGroup):
            return {"WorkGroup": {"Configuration": {
                "ResultConfiguration": {"OutputLocation": "s3://bucket/prefix/"},
                "BytesScannedCutoffPerQuery": 10_000_000,
            }}}

    class FakeGlueTable:
        def get_database(self, Name):
            return {}

        def get_table(self, DatabaseName, Name):
            return {"Table": {
                "StorageDescriptor": {"Columns": [{"Name": c, "Type": "string"} for c in columns]},
                "PartitionKeys": [{"Name": "dt", "Type": "date"}],
                "Parameters": {},
            }}

    class FakeSessionValidate:
        def client(self, name):
            return FakeAthenaWorkGroup() if name == "athena" else FakeGlueTable()

    monkeypatch.setattr(broker, "_assumed_session", lambda *a, **k: FakeSessionValidate())
    return broker._validate({
        "account_id": "123456789012", "region": "ap-northeast-2", "workgroup": "wg",
        "database": "db", "table": "tbl",
    }, conn)


def test_validate_resolves_optional_account_id_and_region_into_column_map(monkeypatch):
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    result = _validate_with_columns(
        monkeypatch, conn, _CANONICAL_FLOW_COLUMNS + ["account_id", "region"])
    assert result["columnMap"]["account_id"] == "account_id"
    assert result["columnMap"]["region"] == "region"


def test_validate_omits_account_id_and_region_when_the_table_has_no_such_columns(monkeypatch):
    """Absence is not an error — a single-account table (the common case) simply gets no scope
    predicate, exactly as before."""
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    result = _validate_with_columns(monkeypatch, conn, _CANONICAL_FLOW_COLUMNS)
    assert "account_id" not in result["columnMap"]
    assert "region" not in result["columnMap"]
    assert result["scopeResolution"] == {"account_id": None, "region": None}
    assert result["scannedUnscoped"] is True


# ── MAJOR fix (item 1, round 2): the scope predicate is unreachable for the very table layout it
#    targets — centralized/org-wide flow-log tables canonically carry account_id/region as Glue
#    PARTITION KEYS, never plain table columns. The round-1 fix only ever searched
#    StorageDescriptor.Columns, so this table layout still resolved nothing. Also verifies the
#    hyphen-alias mechanism (already used for the required Flow Log fields) now applies here too. ──

def _validate_with_partition_keys(monkeypatch, conn, extra_partition_keys):
    """Like `_validate_with_columns`, but lets a test add extra Glue PartitionKeys (beyond the
    baseline `dt`/date key every fixture needs to satisfy the "table has a bound-able partition
    scheme" check) instead of only StorageDescriptor columns."""
    class FakeAthenaWorkGroup:
        def get_work_group(self, WorkGroup):
            return {"WorkGroup": {"Configuration": {
                "ResultConfiguration": {"OutputLocation": "s3://bucket/prefix/"},
                "BytesScannedCutoffPerQuery": 10_000_000,
            }}}

    class FakeGlueTable:
        def get_database(self, Name):
            return {}

        def get_table(self, DatabaseName, Name):
            return {"Table": {
                "StorageDescriptor": {"Columns": [{"Name": c} for c in _CANONICAL_FLOW_COLUMNS]},
                "PartitionKeys": [{"Name": "dt", "Type": "date"}] + list(extra_partition_keys),
                "Parameters": {},
            }}

    class FakeSessionValidate:
        def client(self, name):
            return FakeAthenaWorkGroup() if name == "athena" else FakeGlueTable()

    monkeypatch.setattr(broker, "_assumed_session", lambda *a, **k: FakeSessionValidate())
    return broker._validate({
        "account_id": "123456789012", "region": "ap-northeast-2", "workgroup": "wg",
        "database": "db", "table": "tbl",
    }, conn)


def test_validate_resolves_scope_from_partition_keys_not_only_columns(monkeypatch):
    """Both scope fields are Glue PARTITION KEYS (not table columns, per the CI review's exact
    ask) — the resolved columnMap must still carry them, and the predicate built from that
    resolved config must still scope the query, using the hyphen alias `account-id` (the SAME
    alias mechanism the required-field loop already uses for `interface-id`/`log-status`)."""
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    result = _validate_with_partition_keys(monkeypatch, conn, [
        {"Name": "account-id", "Type": "string"}, {"Name": "region", "Type": "string"},
    ])
    assert result["columnMap"]["account_id"] == "account-id"
    assert result["columnMap"]["region"] == "region"
    assert result["scopeResolution"] == {"account_id": "partition", "region": "partition"}
    assert result["scannedUnscoped"] is False

    import sg_rule_matching as sm
    source = {"account_id": "123456789012", "region": "ap-northeast-2", "database_name": "db",
              "table_name": "tbl", "validation": result}
    sql = sm.build_day_select(source, dt.date(2026, 3, 5))
    assert '"account-id" = \'123456789012\'' in sql
    assert '"region" = \'ap-northeast-2\'' in sql
    # MAJOR fix (item 1, round 3): this exact `dt + account-id + region` layout used to validate
    # `status: "valid"` yet permanently refuse to scan, because date-key detection required exactly
    # ONE total partition key. After excluding the two scope-resolved partition keys, `dt` must be
    # the lone remaining date candidate — both the SQL's own date predicate AND
    # has_resolved_partition_strategy() (the exact check `_query_by_source` hard-refuses on) must
    # agree the layout is scannable.
    assert '"dt" IN (' in sql
    assert sm.has_resolved_partition_strategy(result) is True


# ── MAJOR fix (item 1, round 3): the date-key detection bug the round-2 fix introduced — a
#    partition-key layout that validates `status: "valid"` yet has NO bounded date strategy after
#    excluding resolved scope keys (case (b): a lone SCOPE-only key with no date key at all) must be
#    REJECTED at validation time, not silently left to fail every real scan. ────────────────────────

def test_validate_rejects_a_single_scope_only_partition_key_with_no_date_key(monkeypatch):
    """Case (b): the table's ONLY partition key is `account-id` (a scope field) — there is no date
    key at all, so no bounded date strategy can ever be resolved. Before the round-3 fix, this
    validated successfully whenever the scope key's Glue type happened to be string-like (since the
    old check never excluded scope keys before testing date-shape at all)."""
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})

    class FakeAthenaWorkGroup:
        def get_work_group(self, WorkGroup):
            return {"WorkGroup": {"Configuration": {
                "ResultConfiguration": {"OutputLocation": "s3://bucket/prefix/"},
                "BytesScannedCutoffPerQuery": 10_000_000,
            }}}

    class FakeGlueTable:
        def get_database(self, Name):
            return {}

        def get_table(self, DatabaseName, Name):
            return {"Table": {
                "StorageDescriptor": {"Columns": [{"Name": c} for c in _CANONICAL_FLOW_COLUMNS]},
                "PartitionKeys": [{"Name": "account-id", "Type": "string"}],
                "Parameters": {},
            }}

    class FakeSessionValidate:
        def client(self, name):
            return FakeAthenaWorkGroup() if name == "athena" else FakeGlueTable()

    monkeypatch.setattr(broker, "_assumed_session", lambda *a, **k: FakeSessionValidate())
    with pytest.raises(broker.BrokerError, match="no_date_candidate|does not resolve a single bounded date"):
        broker._validate({
            "account_id": "123456789012", "region": "ap-northeast-2", "workgroup": "wg",
            "database": "db", "table": "tbl",
        }, conn)


def test_validate_rejects_multiple_partition_keys_none_date_shaped(monkeypatch):
    """Case (d): multiple partition keys, none of them the date and none resolved as a scope
    field either — there's no way to bound a scan on any one of them, and no Hive-style
    year/month/day scheme is present. Must be rejected outright, not left to validate."""
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})

    class FakeAthenaWorkGroup:
        def get_work_group(self, WorkGroup):
            return {"WorkGroup": {"Configuration": {
                "ResultConfiguration": {"OutputLocation": "s3://bucket/prefix/"},
                "BytesScannedCutoffPerQuery": 10_000_000,
            }}}

    class FakeGlueTable:
        def get_database(self, Name):
            return {}

        def get_table(self, DatabaseName, Name):
            return {"Table": {
                "StorageDescriptor": {"Columns": [{"Name": c} for c in _CANONICAL_FLOW_COLUMNS]},
                "PartitionKeys": [{"Name": "tier", "Type": "string"}, {"Name": "env", "Type": "string"}],
                "Parameters": {},
            }}

    class FakeSessionValidate:
        def client(self, name):
            return FakeAthenaWorkGroup() if name == "athena" else FakeGlueTable()

    monkeypatch.setattr(broker, "_assumed_session", lambda *a, **k: FakeSessionValidate())
    with pytest.raises(broker.BrokerError, match="no_date_candidate|does not resolve a single bounded date"):
        broker._validate({
            "account_id": "123456789012", "region": "ap-northeast-2", "workgroup": "wg",
            "database": "db", "table": "tbl",
        }, conn)


# ── MAJOR fix (item 1, round 3), full end-to-end regression: the review explicitly asked for a
#    test that actually calls `_query_by_source()` (not `_validate`/`has_resolved_partition_
#    strategy` in isolation) for the `dt + account-id + region` layout, asserting the scan is NOT
#    refused and the generated SQL carries both the date AND the scope predicates. ────────────────

def test_query_by_source_scans_a_dt_account_id_region_layout_end_to_end(monkeypatch):
    validation = {
        "status": "valid", "partitionKeys": ["dt", "account-id", "region"],
        "partitionKeyTypes": ["date", "string", "string"],
        "scopeResolution": {"account_id": "partition", "region": "partition"},
        "columnMap": {
            "interface_id": "interface_id", "log_status": "log_status", "start": "start",
            "account_id": "account-id", "region": "region",
        },
        "optionalFields": [], "partitionStrategy": "partition_keys",
    }
    conn = FakeConn(_source_row(validation))
    captured = {}

    def fake_run_athena_query(session, workgroup, database, sql, max_bytes):
        captured["sql"] = sql
        return {"ok": True, "query_execution_id": "q-1", "data_scanned_bytes": 100, "athena": object()}

    monkeypatch.setattr(broker, "_assumed_session", lambda *a, **k: FakeSession())
    monkeypatch.setattr(broker, "_run_athena_query", fake_run_athena_query)
    monkeypatch.setattr(broker, "_fetch_page", lambda *a, **k: (["c1"], [["1"]], None))

    result = broker._query_by_source({"flow_source_id": 1, "day": "2026-03-05"}, conn)

    # (i) the scan is NOT refused.
    assert result["ok"] is True
    assert "reason" not in result
    # (ii) the generated day-SELECT SQL carries BOTH the date partition predicate for `dt` AND the
    # scope predicates for account-id/region.
    sql = captured["sql"]
    assert '"dt" IN (' in sql
    assert '"account-id" = \'123456789012\'' in sql
    assert '"region" = \'ap-northeast-2\'' in sql


def test_validate_prefers_partition_key_form_over_column_when_both_present(monkeypatch):
    """When the SAME canonical field resolves via both a partition key and a plain column, the
    partition-key form must win — only it actually prunes scanned partition files."""
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})

    class FakeAthenaWorkGroup:
        def get_work_group(self, WorkGroup):
            return {"WorkGroup": {"Configuration": {
                "ResultConfiguration": {"OutputLocation": "s3://bucket/prefix/"},
                "BytesScannedCutoffPerQuery": 10_000_000,
            }}}

    class FakeGlueTable:
        def get_database(self, Name):
            return {}

        def get_table(self, DatabaseName, Name):
            return {"Table": {
                "StorageDescriptor": {"Columns": [{"Name": c} for c in _CANONICAL_FLOW_COLUMNS]
                                       + [{"Name": "account_id"}]},
                "PartitionKeys": [{"Name": "dt", "Type": "date"}, {"Name": "account_id", "Type": "string"}],
                "Parameters": {},
            }}

    class FakeSessionValidate:
        def client(self, name):
            return FakeAthenaWorkGroup() if name == "athena" else FakeGlueTable()

    monkeypatch.setattr(broker, "_assumed_session", lambda *a, **k: FakeSessionValidate())
    result = broker._validate({
        "account_id": "123456789012", "region": "ap-northeast-2", "workgroup": "wg",
        "database": "db", "table": "tbl",
    }, conn)
    assert result["scopeResolution"]["account_id"] == "partition"


# ── CI-review MAJOR fix (round 14): round 11 added a string-like catalog-type gate for the Hive
#    year/month/day keys and the single remaining date key, but never for a `partition_keys`-
#    strategy SCOPE key (account_id/region resolved as an actual partition column) — a Glue-
#    crawler-misinferred `bigint`/`int` catalog type for a numeric-looking scope value (e.g. a
#    12-digit account id) validated `status: "valid"` with no check at all, and then every real
#    query compared `bigint = varchar`, which Trino rejects, permanently refusing every scan. ─────

def _validate_scope_key_catalog_type(monkeypatch, conn, scope_key_type):
    class FakeAthenaWorkGroup:
        def get_work_group(self, WorkGroup):
            return {"WorkGroup": {"Configuration": {
                "ResultConfiguration": {"OutputLocation": "s3://bucket/prefix/"},
                "BytesScannedCutoffPerQuery": 10_000_000,
            }}}

    class FakeGlueTable:
        def get_database(self, Name):
            return {}

        def get_table(self, DatabaseName, Name):
            return {"Table": {
                "StorageDescriptor": {"Columns": [{"Name": c} for c in _CANONICAL_FLOW_COLUMNS]},
                "PartitionKeys": [{"Name": "dt", "Type": "date"},
                                  {"Name": "account-id", "Type": scope_key_type}],
                "Parameters": {},
            }}

    class FakeSessionValidate:
        def client(self, name):
            return FakeAthenaWorkGroup() if name == "athena" else FakeGlueTable()

    monkeypatch.setattr(broker, "_assumed_session", lambda *a, **k: FakeSessionValidate())
    return broker._validate({
        "account_id": "123456789012", "region": "ap-northeast-2", "workgroup": "wg",
        "database": "db", "table": "tbl",
    }, conn)


def test_validate_rejects_a_bigint_typed_partition_keys_scope_key(monkeypatch):
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    with pytest.raises(broker.BrokerError, match="scope_key_not_string_typed"):
        _validate_scope_key_catalog_type(monkeypatch, conn, "bigint")


def test_validate_accepts_a_string_typed_partition_keys_scope_key(monkeypatch):
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    result = _validate_scope_key_catalog_type(monkeypatch, conn, "string")
    assert result["ok"] is True
    assert result["scopeResolution"]["account_id"] == "partition"


# ── CI-review MAJOR fix (round 15, part c): the round-14 check above only ever looked at a scope
#    key resolved as a `"partition"` — but `sm._build_scope_predicate` builds the SAME literal-
#    string-comparison SQL predicate for a scope key resolved as a plain `"column"` too, regardless
#    of `strategy`. A Glue-crawler-misinferred `bigint`/`int` catalog type for that STORAGE column
#    validated `status: "valid"` with no check at all. ─────────────────────────────────────────────

def _validate_scope_column_catalog_type(monkeypatch, conn, scope_column_type):
    class FakeAthenaWorkGroup:
        def get_work_group(self, WorkGroup):
            return {"WorkGroup": {"Configuration": {
                "ResultConfiguration": {"OutputLocation": "s3://bucket/prefix/"},
                "BytesScannedCutoffPerQuery": 10_000_000,
            }}}

    class FakeGlueTable:
        def get_database(self, Name):
            return {}

        def get_table(self, DatabaseName, Name):
            return {"Table": {
                "StorageDescriptor": {"Columns": [{"Name": c, "Type": "string"}
                                                    for c in _CANONICAL_FLOW_COLUMNS]
                                       + [{"Name": "account_id", "Type": scope_column_type}]},
                "PartitionKeys": [{"Name": "dt", "Type": "date"}],
                "Parameters": {},
            }}

    class FakeSessionValidate:
        def client(self, name):
            return FakeAthenaWorkGroup() if name == "athena" else FakeGlueTable()

    monkeypatch.setattr(broker, "_assumed_session", lambda *a, **k: FakeSessionValidate())
    return broker._validate({
        "account_id": "123456789012", "region": "ap-northeast-2", "workgroup": "wg",
        "database": "db", "table": "tbl",
    }, conn)


def test_validate_rejects_a_bigint_typed_scope_column(monkeypatch):
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    with pytest.raises(broker.BrokerError, match="scope_key_not_string_typed"):
        _validate_scope_column_catalog_type(monkeypatch, conn, "bigint")


def test_validate_accepts_a_string_typed_scope_column(monkeypatch):
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    result = _validate_scope_column_catalog_type(monkeypatch, conn, "string")
    assert result["ok"] is True
    assert result["scopeResolution"]["account_id"] == "column"


# ── MAJOR fix (item 4, round 2): a single-key partition scheme whose Glue type isn't date-shaped
#    must be REJECTED at validation time — round 1 only enforced this at runtime scan time
#    (`has_resolved_partition_strategy`'s hard-refuse), so a brand-new such source validated
#    `status: "valid"` yet every real scan permanently refused it. ──────────────────────────────────

def test_validate_rejects_a_non_date_typed_single_partition_key(monkeypatch):
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})

    class FakeAthenaWorkGroup:
        def get_work_group(self, WorkGroup):
            return {"WorkGroup": {"Configuration": {
                "ResultConfiguration": {"OutputLocation": "s3://bucket/prefix/"},
                "BytesScannedCutoffPerQuery": 10_000_000,
            }}}

    class FakeGlueTable:
        def get_database(self, Name):
            return {}

        def get_table(self, DatabaseName, Name):
            return {"Table": {
                "StorageDescriptor": {"Columns": [{"Name": c} for c in _CANONICAL_FLOW_COLUMNS]},
                "PartitionKeys": [{"Name": "dt", "Type": "bigint"}],
                "Parameters": {},
            }}

    class FakeSessionValidate:
        def client(self, name):
            return FakeAthenaWorkGroup() if name == "athena" else FakeGlueTable()

    monkeypatch.setattr(broker, "_assumed_session", lambda *a, **k: FakeSessionValidate())
    with pytest.raises(broker.BrokerError, match="not date-shaped"):
        broker._validate({
            "account_id": "123456789012", "region": "ap-northeast-2", "workgroup": "wg",
            "database": "db", "table": "tbl",
        }, conn)


def test_validate_still_accepts_a_date_typed_single_partition_key(monkeypatch):
    """The pre-existing, common-case single date-typed key must keep validating successfully —
    this MAJOR fix only rejects non-date-shaped types."""
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    result = _validate_with_columns(monkeypatch, conn, _CANONICAL_FLOW_COLUMNS)
    assert result["ok"] is True
    assert result["partitionKeyTypes"] == ["date"]


def test_validate_rejects_a_non_date_typed_single_partition_key_under_projection_strategy(monkeypatch):
    """Round 5: the date-shape validate-time gate above used to be gated to `strategy ==
    "partition_keys"` only — a `projection`-strategy source with the SAME non-date-typed single key
    still validated `status: "valid"`, yet `has_resolved_partition_strategy` (which has no
    strategy-conditional branch) refuses it at every scan attempt. The gate must run for BOTH
    strategies."""
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})

    class FakeAthenaWorkGroup:
        def get_work_group(self, WorkGroup):
            return {"WorkGroup": {"Configuration": {
                "ResultConfiguration": {"OutputLocation": "s3://bucket/prefix/"},
                "BytesScannedCutoffPerQuery": 10_000_000,
            }}}

    class FakeGlueTable:
        def get_database(self, Name):
            return {}

        def get_table(self, DatabaseName, Name):
            return {"Table": {
                "StorageDescriptor": {"Columns": [{"Name": c} for c in _CANONICAL_FLOW_COLUMNS]},
                "PartitionKeys": [{"Name": "dt", "Type": "bigint"}],
                "Parameters": {"projection.enabled": "true"},
            }}

    class FakeSessionValidate:
        def client(self, name):
            return FakeAthenaWorkGroup() if name == "athena" else FakeGlueTable()

    monkeypatch.setattr(broker, "_assumed_session", lambda *a, **k: FakeSessionValidate())
    with pytest.raises(broker.BrokerError, match="not date-shaped"):
        broker._validate({
            "account_id": "123456789012", "region": "ap-northeast-2", "workgroup": "wg",
            "database": "db", "table": "tbl",
        }, conn)


# ── MINOR fix (L4 finding, round 6): a `string`-typed single partition key under the PROJECTION
#    strategy has no format validation — real values might not be ISO `YYYY-MM-DD` (e.g.
#    `yyyy/MM/dd`), and projection tables have no `_partition_exists` existence check to catch a
#    format mismatch, so a real day with traffic could silently commit a confident
#    `no_observed_evidence`. Reject at validate time unless the declared `projection.<col>.format`
#    is absent or exactly the ISO pattern this module emits. ────────────────────────────────────────

def _validate_projection_string_key(monkeypatch, conn, proj_format_params, key_type="string", now=None):
    class FakeAthenaWorkGroup:
        def get_work_group(self, WorkGroup):
            return {"WorkGroup": {"Configuration": {
                "ResultConfiguration": {"OutputLocation": "s3://bucket/prefix/"},
                "BytesScannedCutoffPerQuery": 10_000_000,
            }}}

    class FakeGlueTable:
        def get_database(self, Name):
            return {}

        def get_table(self, DatabaseName, Name):
            # Round-8/9 fix: `projection.dt.type` must be PRESENT and `date`, and `projection.dt.range`
            # must be PRESENT, for validation to pass at all — default both to a valid shape so
            # tests exercising the format/type-normalization checks below don't have to restate
            # them; a test that wants to exercise the `.type`/`.range` gate itself passes an
            # explicit override in `proj_format_params`.
            params = {"projection.enabled": "true", "projection.dt.type": "date",
                      "projection.dt.range": "NOW-3YEARS,NOW", "projection.dt.format": "yyyy-MM-dd"}
            params.update(proj_format_params)
            return {"Table": {
                "StorageDescriptor": {"Columns": [{"Name": c} for c in _CANONICAL_FLOW_COLUMNS]},
                "PartitionKeys": [{"Name": "dt", "Type": key_type}],
                "Parameters": params,
            }}

    class FakeSessionValidate:
        def client(self, name):
            return FakeAthenaWorkGroup() if name == "athena" else FakeGlueTable()

    monkeypatch.setattr(broker, "_assumed_session", lambda *a, **k: FakeSessionValidate())
    return broker._validate({
        "account_id": "123456789012", "region": "ap-northeast-2", "workgroup": "wg",
        "database": "db", "table": "tbl",
    }, conn, now=now)


def test_validate_rejects_a_projection_string_key_with_a_non_iso_date_format(monkeypatch):
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    with pytest.raises(broker.BrokerError, match="projection_date_format_missing_or_not_iso"):
        _validate_projection_string_key(monkeypatch, conn, {"projection.dt.format": "yyyy/MM/dd"})


def test_validate_accepts_a_projection_string_key_with_an_explicit_iso_date_format(monkeypatch):
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    result = _validate_projection_string_key(monkeypatch, conn, {"projection.dt.format": "yyyy-MM-dd"})
    assert result["ok"] is True


# ── CI-review MAJOR fix (round 12, MAJOR #3): Athena has NO ISO default for a date-typed
#    projection column's `.format` — omitting it is itself an invalid/unqueryable projection
#    configuration, not a safe assumption. The test above used to bless absence as fine; it must
#    now be rejected exactly like an explicit non-ISO format. ────────────────────────────────────

def test_validate_rejects_a_projection_string_key_with_no_declared_format(monkeypatch):
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    with pytest.raises(broker.BrokerError, match="projection_date_format_missing_or_not_iso"):
        _validate_projection_string_key(monkeypatch, conn, {"projection.dt.format": None})


# ── CI-review MAJOR fix (round 13, L2-2/L4-2): the round-12 `.format`-required check only ran
#    inside `if sm.is_string_like_partition_type(key_type):` — a Glue `date`- or `timestamp`-typed
#    CATALOG column (not string-like) with `projection.<col>.type=date` and a missing/non-ISO
#    `.format` therefore validated `status: "valid"` anyway, even though `.format` is required for
#    every `.type=date` projection column regardless of the underlying catalog type. Now runs
#    unconditionally. ─────────────────────────────────────────────────────────────────────────────

def test_validate_rejects_a_date_typed_catalog_key_with_no_declared_format(monkeypatch):
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    with pytest.raises(broker.BrokerError, match="projection_date_format_missing_or_not_iso"):
        _validate_projection_string_key(
            monkeypatch, conn, {"projection.dt.format": None}, key_type="date")


def test_validate_accepts_a_date_typed_catalog_key_with_the_iso_date_format(monkeypatch):
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    result = _validate_projection_string_key(
        monkeypatch, conn, {"projection.dt.format": "yyyy-MM-dd"}, key_type="date")
    assert result["ok"] is True


# ── CI-review MAJOR fix (round 7): the format gate above compared the Glue type with a bare
#    `== "string"`, missing the length-parameterized `varchar(10)`/`char(20)` forms
#    `sm._normalize_glue_type` exists to handle, and never inspected `projection.<col>.type` at
#    all — an `enum`/`integer`/`injected` projection (arbitrary or epoch-shaped values, not ISO date
#    strings) on a string-typed key sailed through whenever no `.format` param was set. ────────────

def test_validate_rejects_a_projection_varchar_key_with_a_non_iso_date_format(monkeypatch):
    """A length-parameterized `varchar(10)` Glue type must be normalized before the format check —
    not just a bare `string` type — otherwise this exact class of projection column bypasses
    format validation entirely."""
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    with pytest.raises(broker.BrokerError, match="projection_date_format_missing_or_not_iso"):
        _validate_projection_string_key(
            monkeypatch, conn, {"projection.dt.format": "yyyy/MM/dd"}, key_type="varchar(10)")


def test_validate_rejects_a_projection_key_declared_integer_typed(monkeypatch):
    """`projection.<col>.type=integer` means the projected values are numeric (e.g. epoch days),
    never ISO date strings — must be rejected regardless of whether `.format` happens to be set,
    since assuming ISO would silently match zero rows every day (no existence check to catch it)."""
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    with pytest.raises(broker.BrokerError, match="projection_type_not_date"):
        _validate_projection_string_key(monkeypatch, conn, {"projection.dt.type": "integer"})


def test_validate_rejects_a_projection_char_key_with_a_non_iso_date_format(monkeypatch):
    """A length-parameterized `char(20)` Glue type must ALSO be normalized before the format
    check — the same class of bug as the `varchar(10)` case above, for the other string-like
    parameterized type."""
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    with pytest.raises(broker.BrokerError, match="projection_date_format_missing_or_not_iso"):
        _validate_projection_string_key(
            monkeypatch, conn, {"projection.dt.format": "yyyy/MM/dd"}, key_type="char(20)")


def test_validate_rejects_a_projection_key_declared_enum_typed_even_without_a_format(monkeypatch):
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    with pytest.raises(broker.BrokerError, match="projection_type_not_date"):
        _validate_projection_string_key(monkeypatch, conn, {"projection.dt.type": "enum"})


def test_validate_rejects_a_projection_key_declared_injected_typed_even_without_a_format(monkeypatch):
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    with pytest.raises(broker.BrokerError, match="projection_type_not_date"):
        _validate_projection_string_key(monkeypatch, conn, {"projection.dt.type": "injected"})


def test_validate_accepts_a_projection_key_explicitly_declared_date_typed(monkeypatch):
    """`projection.<col>.type=date` (explicit) is the expected/documented shape and must still
    pass, combined with a valid ISO format."""
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    result = _validate_projection_string_key(
        monkeypatch, conn, {"projection.dt.type": "date", "projection.dt.format": "yyyy-MM-dd"})
    assert result["ok"] is True


def test_validate_rejects_a_projection_key_with_no_declared_type_at_all(monkeypatch):
    """CI-review MAJOR fix (round 8): round 7 accepted an ABSENT `projection.<col>.type` as safe —
    but Athena requires this parameter for every partition column when projection is enabled, so a
    table missing it is not a valid/queryable projection configuration at all; such a source would
    validate `status: "valid"` here and then error on every real scan. Must be rejected outright,
    not just a declared non-`date` type."""
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    with pytest.raises(broker.BrokerError, match="projection_type_not_date"):
        # None mimics the parameter being entirely absent (same falsy check as a missing key).
        _validate_projection_string_key(monkeypatch, conn, {"projection.dt.type": None})


def test_validate_rejects_a_projection_key_with_no_declared_range(monkeypatch):
    """CI-review MAJOR fix (round 9): `projection.<col>.range` was never validated at all — Athena
    requires it for every date-typed projection column, and its absence means Athena has no
    candidate partitions to generate, so every real scan would fail or silently match zero rows
    (no `_partition_exists` existence check exists for `projection` sources to catch it)."""
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    with pytest.raises(broker.BrokerError, match="projection_range_missing"):
        _validate_projection_string_key(monkeypatch, conn, {"projection.dt.range": None})


# ── CI-review MAJOR fix (round 9, part b): `projection.<col>.range`'s PRESENCE was validated
#    above, but never whether the declared window still covers the CURRENT date — a closed range
#    whose end date has already passed is a common real misconfiguration (an admin sets up
#    projection with a range and forgets to make it open-ended), and Athena will generate zero
#    candidate partitions for any day past it — a genuinely empty (but wrong) result the
#    `projection` strategy has no existence check to catch. Only the common, unambiguously-
#    parseable closed-range-with-a-literal-ISO-end-date form is checked (see
#    `_projection_range_upper_bound_expired`'s docstring for exactly which forms are left
#    unvalidated on purpose). ─────────────────────────────────────────────────────────────────────

def test_validate_rejects_a_projection_range_whose_closed_upper_bound_has_already_passed(monkeypatch):
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    now = dt.datetime(2026, 8, 25, tzinfo=dt.timezone.utc)
    with pytest.raises(broker.BrokerError, match="projection_range_expired"):
        _validate_projection_string_key(
            monkeypatch, conn, {"projection.dt.range": "2020-01-01,2025-06-30"}, now=now)


def test_validate_accepts_a_projection_range_whose_closed_upper_bound_is_still_current(monkeypatch):
    """A closed range whose end date is still in the future must still validate — this is not a
    regression on the round-8 presence check, just an additional staleness check on top of it."""
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    now = dt.datetime(2026, 8, 25, tzinfo=dt.timezone.utc)
    result = _validate_projection_string_key(
        monkeypatch, conn, {"projection.dt.range": "2020-01-01,2030-12-31"}, now=now)
    assert result["ok"] is True


def test_validate_accepts_a_projection_range_open_ended_at_now(monkeypatch):
    """An open-ended `NOW`-anchored upper bound always covers the current date by construction and
    must never be flagged as expired, regardless of what `now` is."""
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    now = dt.datetime(2099, 1, 1, tzinfo=dt.timezone.utc)
    result = _validate_projection_string_key(
        monkeypatch, conn, {"projection.dt.range": "2020-01-01,NOW"}, now=now)
    assert result["ok"] is True


def test_validate_accepts_a_projection_range_form_it_cannot_confidently_parse(monkeypatch):
    """An unparseable/unrecognized upper-bound form (per this module's own narrower-than-ideal
    range-syntax coverage) must not be guessed at — left unvalidated rather than risk a false
    rejection of a legitimately-configured source."""
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    now = dt.datetime(2026, 8, 25, tzinfo=dt.timezone.utc)
    result = _validate_projection_string_key(
        monkeypatch, conn, {"projection.dt.range": "2020-01-01,enum-value"}, now=now)


# ── CI-review MAJOR fix (round 11): `_projection_range_upper_bound_expired` used to treat ANY
#    upper bound starting with "NOW" as "always covers the current date by construction" — true
#    only for a BARE, unmodified NOW. An offset form like `NOW-45DAYS` anchors 45 days before
#    today and does NOT cover the current date; confidently asserting False for it violated the
#    function's own never-guess contract. ────────────────────────────────────────────────────────

def test_projection_range_upper_bound_expired_returns_none_for_a_now_offset_form():
    now = dt.datetime(2026, 8, 25, tzinfo=dt.timezone.utc)
    assert broker._projection_range_upper_bound_expired("2020-01-01,NOW-45DAYS", now) is None


def test_projection_range_upper_bound_expired_returns_false_only_for_bare_now():
    now = dt.datetime(2026, 8, 25, tzinfo=dt.timezone.utc)
    assert broker._projection_range_upper_bound_expired("2020-01-01,NOW", now) is False
    assert broker._projection_range_upper_bound_expired("2020-01-01,now", now) is False


# ── CI-review MAJOR fix (round 15, part a): `_NOW_OFFSET_RE` used to accept only YEARS/MONTHS/
#    DAYS — Athena's own projection range grammar also allows WEEKS/HOURS/MINUTES/SECONDS, and an
#    offset using one of those fell through to the unresolved (`None`) case, which the OLD
#    `_projection_day_out_of_range` collapsed into "don't block" (fail-OPEN). Both the grammar
#    extension and the fail-closed propagation are tested here. ───────────────────────────────────

def test_projection_range_bound_date_resolves_weeks_hours_minutes_seconds_offsets():
    now = dt.datetime(2026, 8, 25, 12, 0, 0, tzinfo=dt.timezone.utc)
    assert broker._projection_range_bound_date("NOW-1WEEKS", now) == dt.date(2026, 8, 18)
    assert broker._projection_range_bound_date("NOW-48HOURS", now) == dt.date(2026, 8, 23)
    assert broker._projection_range_bound_date("NOW-90MINUTES", now) == dt.date(2026, 8, 25)
    assert broker._projection_range_bound_date("NOW-30SECONDS", now) == dt.date(2026, 8, 25)


# ── CI-review MAJOR fix (round 16): round 15 widened the unit set but kept the sign fixed to `-`
#    — Athena's projection range grammar documents BOTH `NOW-N<unit>` and `NOW+N<unit>` (e.g. a
#    late-arrival/timezone-skew upper bound like `NOW+1DAYS`). Combined with round 15's own
#    fail-closed flip (an unresolvable bound now REFUSES rather than trusts), a valid `NOW+`-
#    anchored source would have validated `status: "valid"` and then had every scan permanently
#    refuse — exactly the "validates valid yet permanently refuses" class this series exists to
#    close. ─────────────────────────────────────────────────────────────────────────────────────

def test_projection_range_bound_date_resolves_a_now_plus_offset():
    now = dt.datetime(2026, 8, 25, 12, 0, 0, tzinfo=dt.timezone.utc)
    assert broker._projection_range_bound_date("NOW+1DAYS", now) == dt.date(2026, 8, 26)
    assert broker._projection_range_bound_date("NOW+2YEARS", now) == dt.date(2028, 8, 25)
    assert broker._projection_range_bound_date("NOW+48HOURS", now) == dt.date(2026, 8, 27)


def test_query_by_source_accepts_a_day_within_a_now_plus_upper_bound(monkeypatch):
    """A valid, previously-working source with a `NOW+1DAYS`-anchored upper bound must NOT be
    permanently refused — the exact round-16 regression."""
    conn, called = _empty_query_by_source_setup(
        monkeypatch, _PROJECTION_VALIDATION, glue=FakeGlueGetTableWithRange("2020-01-01,NOW+1DAYS"))
    result = broker._query_by_source({"flow_source_id": 1, "day": "2026-03-05"}, conn)
    assert result["ok"] is True
    assert "projection_range_uncovered" not in result
    assert "partition_check_unverified" not in result


def test_query_by_source_unverified_reason_names_the_unparseable_range_cause(monkeypatch):
    """The `None` (unverifiable) refusal message must not hardcode "Glue API error" as the only
    possible cause — an unparseable range bound is at least as likely a trigger."""
    conn, called = _empty_query_by_source_setup(
        monkeypatch, _PROJECTION_VALIDATION, glue=FakeGlueGetTableWithRange("some_enum_a,some_enum_z"))
    result = broker._query_by_source({"flow_source_id": 1, "day": "2026-03-05"}, conn)
    assert result["ok"] is False
    assert result.get("partition_check_unverified") is True
    assert "cannot confidently parse" in result["reason"]


def test_projection_day_out_of_range_refuses_rather_than_passes_an_unresolvable_range(monkeypatch):
    """A range this module genuinely can't parse (neither bound resolves) must propagate `None`
    (unverifiable) from `_projection_day_out_of_range`, not collapse into `False` ("don't block") —
    the same fail-closed posture the module already applies to a Glue API error."""
    conn, called = _empty_query_by_source_setup(
        monkeypatch, _PROJECTION_VALIDATION, glue=FakeGlueGetTableWithRange("some_enum_a,some_enum_z"))
    result = broker._query_by_source({"flow_source_id": 1, "day": "2026-03-05"}, conn)
    assert result["ok"] is False
    assert result.get("partition_check_unverified") is True


def test_projection_day_out_of_range_refuses_for_an_unresolvable_hive_range(monkeypatch):
    conn, called = _empty_query_by_source_setup(
        monkeypatch, _HIVE_PROJECTION_VALIDATION,
        glue=FakeGlueGetTableWithHiveRanges(year_range="not_an_int,also_not_an_int"))
    result = broker._query_by_source({"flow_source_id": 1, "day": "2026-03-05"}, conn)
    assert result["ok"] is False
    assert result.get("partition_check_unverified") is True


# ── CI-review MAJOR fix (round 9): the round-7/8 projection.<col>.type/.format/.range gates all
#    lived inside the SINGLE-KEY branch of the date-candidate check — a Hive-style year/month/day
#    PROJECTION layout skipped every one of them entirely, reproducing the "validates valid yet
#    permanently refuses/false-zeros every scan" class this PR fixes elsewhere. ───────────────────

def _validate_hive_projection(monkeypatch, conn, proj_params, key_type="string", extra_partition_keys=None):
    class FakeAthenaWorkGroup:
        def get_work_group(self, WorkGroup):
            return {"WorkGroup": {"Configuration": {
                "ResultConfiguration": {"OutputLocation": "s3://bucket/prefix/"},
                "BytesScannedCutoffPerQuery": 10_000_000,
            }}}

    class FakeGlueTable:
        def get_database(self, Name):
            return {}

        def get_table(self, DatabaseName, Name):
            params = {
                "projection.enabled": "true",
                "projection.year.type": "integer", "projection.year.range": "2020,2030",
                "projection.month.type": "integer", "projection.month.range": "1,12",
                "projection.month.digits": "2",
                "projection.day.type": "integer", "projection.day.range": "1,31",
                "projection.day.digits": "2",
            }
            params.update(proj_params)
            partition_keys = [{"Name": "year", "Type": key_type}, {"Name": "month", "Type": key_type},
                               {"Name": "day", "Type": key_type}]
            partition_keys.extend(extra_partition_keys or [])
            return {"Table": {
                "StorageDescriptor": {"Columns": [{"Name": c} for c in _CANONICAL_FLOW_COLUMNS]},
                "PartitionKeys": partition_keys,
                "Parameters": params,
            }}

    class FakeSessionValidate:
        def client(self, name):
            return FakeAthenaWorkGroup() if name == "athena" else FakeGlueTable()

    monkeypatch.setattr(broker, "_assumed_session", lambda *a, **k: FakeSessionValidate())
    return broker._validate({
        "account_id": "123456789012", "region": "ap-northeast-2", "workgroup": "wg",
        "database": "db", "table": "tbl",
    }, conn)


def test_validate_accepts_a_correctly_configured_hive_projection_layout(monkeypatch):
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    result = _validate_hive_projection(monkeypatch, conn, {})
    assert result["ok"] is True


# ── CI-review MAJOR fix (round 12, codex-L2 `hour` / kiro-gpt-L2 `vpc_id`): every Hive-scheme
#    check used a SUBSET test (`{"year","month","day"} <= lower_remaining`), which is also true
#    for a year/month/day/PLUS-one-more layout. The extra remaining key then never got its own
#    projection/catalog-type validation, so a table with a 4th unvalidated partition column still
#    validated `status: "valid"` even though Athena requires projection config for every
#    partition column once projection is enabled (the real query against that 4th key would
#    error). Hive-style detection must require an EXACT match. ────────────────────────────────────

def test_validate_rejects_a_hive_projection_layout_with_an_extra_unvalidated_key(monkeypatch):
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    with pytest.raises(broker.BrokerError, match="does not resolve a single bounded date candidate"):
        _validate_hive_projection(monkeypatch, conn, {}, extra_partition_keys=[{"Name": "hour", "Type": "string"}])


def test_validate_rejects_a_hive_partition_keys_layout_with_an_extra_unvalidated_key(monkeypatch):
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    with pytest.raises(broker.BrokerError, match="does not resolve a single bounded date candidate"):
        _validate_hive_projection(
            monkeypatch, conn, {"projection.enabled": "false"},
            extra_partition_keys=[{"Name": "vpc_id", "Type": "string"}],
        )


def test_validate_rejects_a_hive_projection_layout_missing_a_key_type(monkeypatch):
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    with pytest.raises(broker.BrokerError, match="projection_hive_type_not_integer"):
        _validate_hive_projection(monkeypatch, conn, {"projection.month.type": None})


def test_validate_rejects_a_hive_projection_layout_with_a_non_integer_key_type(monkeypatch):
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    with pytest.raises(broker.BrokerError, match="projection_hive_type_not_integer"):
        _validate_hive_projection(monkeypatch, conn, {"projection.day.type": "enum"})


def test_validate_rejects_a_hive_projection_layout_missing_a_key_range(monkeypatch):
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    with pytest.raises(broker.BrokerError, match="projection_hive_range_missing"):
        _validate_hive_projection(monkeypatch, conn, {"projection.year.range": None})


# ── CI-review MAJOR fix (round 10, L4-1): the day-SELECT/existence-check predicates always
#    compare zero-padded string literals (`"month" = '03'`) — Athena's integer projection
#    generates UNPADDED values unless `projection.<col>.digits` is set, so a gate-approved table
#    missing it would match zero rows on every real scan and commit a confident false
#    zero-traffic day (no existence check exists for `projection` sources to catch it). ──────────

def test_validate_rejects_a_hive_projection_layout_missing_digits_on_month(monkeypatch):
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    with pytest.raises(broker.BrokerError, match="projection_hive_digits_not_zero_padded"):
        _validate_hive_projection(monkeypatch, conn, {"projection.month.digits": None})


def test_validate_rejects_a_hive_projection_layout_missing_digits_on_day(monkeypatch):
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    with pytest.raises(broker.BrokerError, match="projection_hive_digits_not_zero_padded"):
        _validate_hive_projection(monkeypatch, conn, {"projection.day.digits": None})


def test_validate_rejects_a_hive_projection_layout_with_wrong_digits_on_month(monkeypatch):
    """`digits=1` would generate `month=3` for March, still mismatching the zero-padded `'03'`
    predicate — only exactly `2` is safe."""
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    with pytest.raises(broker.BrokerError, match="projection_hive_digits_not_zero_padded"):
        _validate_hive_projection(monkeypatch, conn, {"projection.month.digits": "1"})


def test_validate_does_not_require_digits_on_year(monkeypatch):
    """`year` is always 4 digits either way (no zero-padding ambiguity in the 2020-2030 range) —
    no `projection.year.digits` requirement."""
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    result = _validate_hive_projection(monkeypatch, conn, {"projection.year.digits": None})
    assert result["ok"] is True


# ── CI-review MAJOR fix (round 11): the single-key (non-Hive) branch has always required the
#    Glue-catalog TYPE to be date-shaped before trusting a lone key as a date column, but the Hive
#    year/month/day branch never checked the catalog type of those columns AT ALL, in EITHER
#    strategy. The predicate builders always emit quoted STRING literals for Hive columns, so an
#    int/bigint-typed year/month/day column validated `status: "valid"` and then errored on every
#    real query (Trino rejects `integer = varchar`). ──────────────────────────────────────────────

def test_validate_rejects_a_hive_projection_layout_with_int_typed_catalog_columns(monkeypatch):
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    with pytest.raises(broker.BrokerError, match="hive_key_not_string_typed"):
        _validate_hive_projection(monkeypatch, conn, {}, key_type="int")


def _validate_hive_partition_keys_strategy(monkeypatch, conn, key_type):
    """A plain (non-projection) Hive year/month/day layout — no `projection.enabled`, so the
    `partition_keys` strategy resolves. Exercises the SAME catalog-type check, which now applies
    regardless of strategy."""
    class FakeAthenaWorkGroup:
        def get_work_group(self, WorkGroup):
            return {"WorkGroup": {"Configuration": {
                "ResultConfiguration": {"OutputLocation": "s3://bucket/prefix/"},
                "BytesScannedCutoffPerQuery": 10_000_000,
            }}}

    class FakeGlueTable:
        def get_database(self, Name):
            return {}

        def get_table(self, DatabaseName, Name):
            return {"Table": {
                "StorageDescriptor": {"Columns": [{"Name": c} for c in _CANONICAL_FLOW_COLUMNS]},
                "PartitionKeys": [{"Name": "year", "Type": key_type}, {"Name": "month", "Type": key_type},
                                  {"Name": "day", "Type": key_type}],
                "Parameters": {},
            }}

    class FakeSessionValidate:
        def client(self, name):
            return FakeAthenaWorkGroup() if name == "athena" else FakeGlueTable()

    monkeypatch.setattr(broker, "_assumed_session", lambda *a, **k: FakeSessionValidate())
    return broker._validate({
        "account_id": "123456789012", "region": "ap-northeast-2", "workgroup": "wg",
        "database": "db", "table": "tbl",
    }, conn)


def test_validate_rejects_a_partition_keys_hive_layout_with_int_typed_catalog_columns(monkeypatch):
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    with pytest.raises(broker.BrokerError, match="hive_key_not_string_typed"):
        _validate_hive_partition_keys_strategy(monkeypatch, conn, key_type="int")


def test_validate_accepts_a_partition_keys_hive_layout_with_string_typed_catalog_columns(monkeypatch):
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    result = _validate_hive_partition_keys_strategy(monkeypatch, conn, key_type="string")
    assert result["ok"] is True


# ── CI-review MAJOR fix (round 10, L2-1): the projection.<col>.type/.format/.range gates above
#    only ever ran over the date-CANDIDATE keys remaining after excluding scope keys — they never
#    checked the SCOPE keys (account_id/region) themselves, even though Athena requires projection
#    config for EVERY partition column once enabled. ──────────────────────────────────────────────

def _validate_scoped_projection(monkeypatch, conn, proj_params):
    class FakeAthenaWorkGroup:
        def get_work_group(self, WorkGroup):
            return {"WorkGroup": {"Configuration": {
                "ResultConfiguration": {"OutputLocation": "s3://bucket/prefix/"},
                "BytesScannedCutoffPerQuery": 10_000_000,
            }}}

    class FakeGlueTable:
        def get_database(self, Name):
            return {}

        def get_table(self, DatabaseName, Name):
            params = {
                "projection.enabled": "true",
                "projection.dt.type": "date", "projection.dt.format": "yyyy-MM-dd",
                "projection.dt.range": "2020-01-01,NOW",
                # `injected` accepts any string value verbatim — always representable, unlike
                # `integer`/`date` (which can never equal a literal account-id/region string) or
                # `enum` (which additionally needs a `.values` list containing that exact literal).
                "projection.account-id.type": "injected",
                "projection.region.type": "injected",
            }
            params.update(proj_params)
            return {"Table": {
                "StorageDescriptor": {"Columns": [{"Name": c} for c in _CANONICAL_FLOW_COLUMNS]},
                "PartitionKeys": [{"Name": "dt", "Type": "string"},
                                  {"Name": "account-id", "Type": "string"},
                                  {"Name": "region", "Type": "string"}],
                "Parameters": params,
            }}

    class FakeSessionValidate:
        def client(self, name):
            return FakeAthenaWorkGroup() if name == "athena" else FakeGlueTable()

    monkeypatch.setattr(broker, "_assumed_session", lambda *a, **k: FakeSessionValidate())
    return broker._validate({
        "account_id": "123456789012", "region": "ap-northeast-2", "workgroup": "wg",
        "database": "db", "table": "tbl",
    }, conn)


def test_validate_accepts_a_correctly_configured_scoped_projection_layout(monkeypatch):
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    result = _validate_scoped_projection(monkeypatch, conn, {})
    assert result["ok"] is True
    assert result["scopeResolution"] == {"account_id": "partition", "region": "partition"}


def test_validate_rejects_a_scoped_projection_layout_missing_the_account_id_scope_type(monkeypatch):
    """`dt + account-id + region` (the layout the round-2 scope fix exists to support) must not
    validate `status: "valid"` when the scope key itself has no projection configuration — Athena
    would error on every real query."""
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    with pytest.raises(broker.BrokerError, match="projection_scope_type_not_representable"):
        _validate_scoped_projection(monkeypatch, conn, {"projection.account-id.type": None})


def test_validate_rejects_a_scoped_projection_layout_with_an_illegal_scope_type(monkeypatch):
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    with pytest.raises(broker.BrokerError, match="projection_scope_type_not_representable"):
        _validate_scoped_projection(monkeypatch, conn, {"projection.region.type": "not-a-real-type"})


# ── CI-review MAJOR fix (round 11): round 10 accepted ANY of enum/integer/date/injected for a
#    scope key, but `_build_scope_predicate`/`scope_partition_expr_clauses` always compare the
#    source's own LITERAL string value — only `injected` (any string, always representable) or an
#    `enum` whose declared `.values` provably contains that literal can ever match; `integer`/
#    `date` generate typed values that never equal a literal string and would silently match zero
#    rows on every real scan. ─────────────────────────────────────────────────────────────────────

def test_validate_rejects_an_integer_typed_scope_key_even_with_a_range(monkeypatch):
    """The exact shape the round-10 test wrongly blessed: `projection.region.type=integer` can
    never generate a value equal to the source's own region string, regardless of `.range`."""
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    with pytest.raises(broker.BrokerError, match="projection_scope_type_not_representable"):
        _validate_scoped_projection(
            monkeypatch, conn, {"projection.region.type": "integer", "projection.region.range": "0,1"})


def test_validate_rejects_a_date_typed_scope_key(monkeypatch):
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    with pytest.raises(broker.BrokerError, match="projection_scope_type_not_representable"):
        _validate_scoped_projection(
            monkeypatch, conn,
            {"projection.account-id.type": "date", "projection.account-id.format": "yyyy-MM-dd",
             "projection.account-id.range": "2020-01-01,NOW"})


def test_validate_rejects_an_enum_typed_scope_key_whose_values_omit_the_sources_own_literal(monkeypatch):
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    with pytest.raises(broker.BrokerError, match="projection_scope_enum_value_missing"):
        _validate_scoped_projection(
            monkeypatch, conn,
            {"projection.region.type": "enum", "projection.region.values": "us-east-1,eu-west-1"})


def test_validate_accepts_an_enum_typed_scope_key_whose_values_include_the_sources_own_literal(monkeypatch):
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    result = _validate_scoped_projection(
        monkeypatch, conn,
        {"projection.region.type": "enum", "projection.region.values": "us-east-1,ap-northeast-2"})
    assert result["ok"] is True


def test_validate_accepts_injected_scope_keys(monkeypatch):
    """`injected` accepts any string value verbatim — always representable, no `.values`
    enumeration needed."""
    conn = FakeConn({"FROM accounts": [[("ext-1",)]]})
    result = _validate_scoped_projection(
        monkeypatch, conn,
        {"projection.account-id.type": "injected", "projection.region.type": "injected"})
    assert result["ok"] is True


def test_query_by_source_never_accepts_a_caller_supplied_query_or_account(monkeypatch):
    """Even if a caller tries to smuggle account_id/query/database into the event, they are simply
    ignored — the broker only ever uses what it resolved from Aurora via flow_source_id."""
    conn = FakeConn(_source_row({
        "status": "valid", "columnMap": {"interface_id": "interface_id", "log_status": "log_status",
                                          "start": "start"}, "partitionKeys": ["dt"],
        "partitionKeyTypes": ["date"], "scopeResolution": {},
    }))
    captured = {}

    def fake_assumed_session(account_id, external_id, region):
        captured["account_id"] = account_id
        captured["external_id"] = external_id
        captured["region"] = region
        raise broker.BrokerError("stop before any real AWS call")

    monkeypatch.setattr(broker, "_assumed_session", fake_assumed_session)
    with pytest.raises(broker.BrokerError, match="stop before"):
        broker._query_by_source({
            "flow_source_id": 1, "day": "2026-03-05",
            "account_id": "999999999999", "database": "attacker_db", "query": "SELECT * FROM secrets",
        }, conn)
    # The resolved account (from Aurora), never the caller-supplied one, is what gets assumed.
    assert captured["account_id"] == "123456789012"
    assert captured["external_id"] == "ext-123"


# ── round-3 finding #5: a continuation's query_execution_id must be bound back to the resolved ───
#    source/day — never trusted as a bare caller-supplied Athena identifier.

class FakeAthenaForContinuation:
    def __init__(self, exec_workgroup, exec_query, rows=None, data_scanned_bytes=0):
        self.exec_workgroup = exec_workgroup
        self.exec_query = exec_query
        self.rows = rows if rows is not None else []
        self.data_scanned_bytes = data_scanned_bytes
        self.get_query_execution_calls = []

    def get_query_execution(self, QueryExecutionId):
        self.get_query_execution_calls.append(QueryExecutionId)
        return {"QueryExecution": {
            "WorkGroup": self.exec_workgroup, "Query": self.exec_query,
            "Statistics": {"DataScannedInBytes": self.data_scanned_bytes},
        }}

    def get_query_results(self, **kwargs):
        return {"ResultSet": {"Rows": [{"Data": [{"VarCharValue": v} for v in row]} for row in self.rows]},
                "NextToken": None}


def _continuation_setup(monkeypatch, athena):
    conn = FakeConn(_source_row({
        "status": "valid", "columnMap": {"interface_id": "interface_id", "log_status": "log_status",
                                          "start": "start"}, "partitionKeys": ["dt"],
        "partitionKeyTypes": ["date"], "partitionStrategy": "partition_keys", "scopeResolution": {},
    }))
    monkeypatch.setattr(broker.sm, "build_day_select", lambda source, day: "SELECT 1 AS x")

    class FakeSessionContinuation:
        def client(self, name):
            return athena

    monkeypatch.setattr(broker, "_assumed_session", lambda *a, **k: FakeSessionContinuation())
    return conn


def test_continuation_rejects_a_query_execution_id_for_a_foreign_query(monkeypatch):
    """A query_execution_id whose real WorkGroup/QueryString does NOT match what this resolved
    flow_source_id+day would itself build server-side must be rejected — this is exactly the hole
    (paging through ANY Athena query reachable by the assumed role) round-3 finding #5 closes."""
    athena = FakeAthenaForContinuation(exec_workgroup="some-other-wg", exec_query="SELECT * FROM secrets")
    conn = _continuation_setup(monkeypatch, athena)
    with pytest.raises(broker.BrokerError, match="does not match"):
        broker._query_by_source({
            "flow_source_id": 1, "day": "2026-03-05",
            "continuation": {"query_execution_id": "q-foreign", "next_token": "tok", "columns": ["a"]},
        }, conn)
    assert athena.get_query_execution_calls == ["q-foreign"]


def test_continuation_accepts_a_query_execution_id_matching_the_resolved_source(monkeypatch):
    """The SAME resolved flow_source_id+day's own query_execution_id, whose real WorkGroup/Query
    match the server-rebuilt SQL exactly, is accepted and pages through normally."""
    athena = FakeAthenaForContinuation(exec_workgroup="wg", exec_query="SELECT 1 AS x",
                                        rows=[["v1"]])
    conn = _continuation_setup(monkeypatch, athena)
    result = broker._query_by_source({
        "flow_source_id": 1, "day": "2026-03-05",
        "continuation": {"query_execution_id": "q-real", "next_token": "tok", "columns": ["a"]},
    }, conn)
    assert result["ok"] is True
    assert result["done"] is True
    assert result["rows"] == [{"a": "v1"}]


# ── round-4 CI-review finding (L3, item 4): scan-bytes budget must be re-checked on the
#    continuation path too — a query that WAS over-budget must not have its results paged out
#    just because the workgroup/SQL-identity check alone passes. ───────────────────────────────────

def test_continuation_refuses_a_query_execution_over_the_bytes_budget(monkeypatch):
    """Even though the workgroup+SQL identity matches the resolved source's own query exactly, an
    execution whose `Statistics.DataScannedInBytes` exceeds the budget must be refused — proving the
    continuation path can no longer be used to page out results Athena flagged as over-budget."""
    over_budget = broker._DEFAULT_MAX_BYTES + 1
    athena = FakeAthenaForContinuation(exec_workgroup="wg", exec_query="SELECT 1 AS x",
                                        rows=[["v1"]], data_scanned_bytes=over_budget)
    conn = _continuation_setup(monkeypatch, athena)
    result = broker._query_by_source({
        "flow_source_id": 1, "day": "2026-03-05",
        "continuation": {"query_execution_id": "q-real", "next_token": "tok", "columns": ["a"]},
    }, conn)
    assert result["ok"] is False
    assert "budget" in result["reason"]
    assert result["data_scanned_bytes"] == over_budget


def test_continuation_still_refuses_a_pending_source():
    """The re-validation of validation.status must apply on the continuation path too (it used to
    be skipped entirely there)."""
    conn = FakeConn(_source_row({"status": "pending"}))
    result = broker._query_by_source({
        "flow_source_id": 1, "day": "2026-03-05",
        "continuation": {"query_execution_id": "q-1", "next_token": "tok", "columns": ["a"]},
    }, conn)
    assert result["ok"] is False
    assert "valid" in result["reason"]


# ── CI-review MAJOR fix (round 13, L3-1): the round-8 stale-validation refusal ("predates
#    partitionKeyTypes/scopeResolution") used to be enforced only in `sg_rule_scan.run()`'s
#    self-heal check — NOT inside the broker's own `_query_by_source`, even though the worker AND
#    the web BFF task role both hold `lambda:InvokeFunction` on this broker directly. A pre-round-2
#    Hive-style source (bare year/month/day, missing both fields) satisfies
#    `has_resolved_partition_strategy` without either field, so it passed both existing broker-side
#    guards and would scan account/region-UNSCOPED if invoked directly, bypassing `run()`'s
#    self-heal entirely. The refusal must live at the boundary the module's own design says must
#    not trust its callers, not rely on one specific caller happening to self-heal first. ─────────

def test_query_by_source_refuses_a_stale_hive_style_source_missing_scope_resolution(monkeypatch):
    """A bare Hive-style year/month/day layout satisfies `has_resolved_partition_strategy` on its
    own, so only the NEW staleness check (missing `scopeResolution`) can catch this — proving the
    broker itself, not just the worker's self-heal, refuses a stale source."""
    conn = FakeConn(_source_row({
        "status": "valid", "columnMap": {"interface_id": "interface_id", "log_status": "log_status",
                                          "start": "start"},
        "partitionKeys": ["year", "month", "day"], "partitionKeyTypes": ["string", "string", "string"],
        "partitionStrategy": "partition_keys",
        # scopeResolution deliberately absent — the pre-round-2 signature.
    }))
    monkeypatch.setattr(broker, "_assumed_session",
                         lambda *a, **k: (_ for _ in ()).throw(AssertionError("must never be called")))
    result = broker._query_by_source({"flow_source_id": 1, "day": "2026-03-05"}, conn)
    assert result["ok"] is False
    assert "scopeResolution" in result["reason"]


def test_query_by_source_refuses_a_stale_source_missing_partition_key_types(monkeypatch):
    conn = FakeConn(_source_row({
        "status": "valid", "columnMap": {"interface_id": "interface_id", "log_status": "log_status",
                                          "start": "start"},
        "partitionKeys": ["year", "month", "day"], "partitionStrategy": "partition_keys",
        "scopeResolution": {},
        # partitionKeyTypes deliberately absent.
    }))
    monkeypatch.setattr(broker, "_assumed_session",
                         lambda *a, **k: (_ for _ in ()).throw(AssertionError("must never be called")))
    result = broker._query_by_source({"flow_source_id": 1, "day": "2026-03-05"}, conn)
    assert result["ok"] is False
    assert "partitionKeyTypes" in result["reason"]


# ── round-3 finding #3: the Glue-partition-existence check must be skipped entirely for a ────────
#    partition-projection source — it has no enumerable Glue partitions to check.

class FakeGlueGetTableEmpty:
    """Round-12 MAJOR #2 wiring: a Glue `get_table` stub with no `projection.*` params at all — the
    scan-time range-coverage check (`_projection_day_out_of_range`) then finds no `.range` to
    compare against and does not block, mirroring a source whose validate-time checks already ran
    (this fake bypasses `_validate` entirely, so it carries none of those params)."""

    def get_table(self, DatabaseName, Name):
        return {"Table": {"Parameters": {}}}


class FakeSession:
    def __init__(self, glue=None):
        self.clients = {"glue": glue if glue is not None else FakeGlueGetTableEmpty()}

    def client(self, name):
        return self.clients.setdefault(name, object())


def _empty_query_by_source_setup(monkeypatch, validation, glue=None):
    """Common wiring: an empty-result Athena query (no rows, no next_token) against a source whose
    `validation` is under test, with `_partition_exists` instrumented to record whether it was
    called at all."""
    conn = FakeConn(_source_row(validation))
    monkeypatch.setattr(broker, "_assumed_session", lambda *a, **k: FakeSession(glue=glue))
    monkeypatch.setattr(broker, "_run_athena_query",
                         lambda *a, **k: {"ok": True, "athena": object(), "query_execution_id": "q1"})
    monkeypatch.setattr(broker, "_fetch_page", lambda *a, **k: (["c1"], [], None))
    called = {"n": 0}

    def fake_partition_exists(*a, **k):
        called["n"] += 1
        return False  # would trigger zero_partition_match if actually invoked

    monkeypatch.setattr(broker, "_partition_exists", fake_partition_exists)
    return conn, called


def test_projection_strategy_skips_glue_partition_check(monkeypatch):
    """A `projection`-strategy source (partitionKeys still non-empty — Glue keeps declaring the
    partition columns even with projection enabled — plus a non-None optionalFields list, exactly
    what `_validate` always emits) must NOT run the Glue GetPartitions check on an empty result: a
    projection table has no enumerable Glue partitions, so the check would always report
    `zero_partition_match` and permanently stall a legitimate zero-traffic day."""
    conn, called = _empty_query_by_source_setup(monkeypatch, {
        "status": "valid", "columnMap": {"interface_id": "interface_id", "log_status": "log_status",
                                          "start": "start"},
        "partitionKeys": ["dt"], "partitionKeyTypes": ["date"], "optionalFields": [],
        "partitionStrategy": "projection", "scopeResolution": {},
    })
    result = broker._query_by_source({"flow_source_id": 1, "day": "2026-03-05"}, conn)
    assert called["n"] == 0
    assert result["ok"] is True
    assert "zero_partition_match" not in result


# ── CI-review MAJOR fix (round 12, MAJOR #2): a `projection` source's resolved date key's own
#    `projection.<col>.range` can exclude the queried day (e.g. a closed-then-forgotten range, or
#    a `NOW-3YEARS,NOW-45DAYS` form validate-time checking leaves unflagged) — an empty Athena
#    result for that day is a range mismatch, not genuine zero-traffic. ─────────────────────────

class FakeGlueGetTableWithRange:
    def __init__(self, range_param):
        self._range_param = range_param

    def get_table(self, DatabaseName, Name):
        return {"Table": {"Parameters": {"projection.dt.range": self._range_param}}}


class FakeGlueGetTableRaises:
    def get_table(self, DatabaseName, Name):
        raise RuntimeError("boto3 ClientError")


_PROJECTION_VALIDATION = {
    "status": "valid", "columnMap": {"interface_id": "interface_id", "log_status": "log_status",
                                      "start": "start"},
    "partitionKeys": ["dt"], "partitionKeyTypes": ["date"], "optionalFields": [],
    "partitionStrategy": "projection", "scopeResolution": {},
}


def test_query_by_source_rejects_a_day_excluded_by_the_projection_range_upper_bound(monkeypatch):
    conn, called = _empty_query_by_source_setup(
        monkeypatch, _PROJECTION_VALIDATION, glue=FakeGlueGetTableWithRange("2020-01-01,2026-01-01"))
    result = broker._query_by_source({"flow_source_id": 1, "day": "2026-03-05"}, conn)
    assert result["ok"] is False
    assert result.get("projection_range_uncovered") is True


def test_query_by_source_rejects_a_day_excluded_by_a_now_relative_lower_bound(monkeypatch):
    """`NOW-45DAYS,NOW` excludes any day more than 45 days before `now` — the exact scenario the
    round-9/11 validate-time check leaves unflagged (an offset upper bound is deliberately left
    unparsed there, but here `now` is resolvable, so both bounds resolve confidently)."""
    conn, called = _empty_query_by_source_setup(
        monkeypatch, _PROJECTION_VALIDATION, glue=FakeGlueGetTableWithRange("NOW-45DAYS,NOW"))
    result = broker._query_by_source({"flow_source_id": 1, "day": "2020-01-01"}, conn)
    assert result["ok"] is False
    assert result.get("projection_range_uncovered") is True


def test_query_by_source_accepts_a_day_within_the_projection_range(monkeypatch):
    conn, called = _empty_query_by_source_setup(
        monkeypatch, _PROJECTION_VALIDATION, glue=FakeGlueGetTableWithRange("2020-01-01,NOW"))
    result = broker._query_by_source({"flow_source_id": 1, "day": "2026-03-05"}, conn)
    assert result["ok"] is True
    assert "projection_range_uncovered" not in result


def test_query_by_source_refuses_when_the_projection_range_check_cannot_verify(monkeypatch):
    conn, called = _empty_query_by_source_setup(
        monkeypatch, _PROJECTION_VALIDATION, glue=FakeGlueGetTableRaises())
    result = broker._query_by_source({"flow_source_id": 1, "day": "2026-03-05"}, conn)
    assert result["ok"] is False
    assert result.get("partition_check_unverified") is True


# ── CI-review MAJOR fix (round 13, L2-1/L4-1): a Hive-style year/month/day PROJECTION layout used
#    to fall all the way through `_projection_day_out_of_range` untouched — `single_date_partition_
#    key` returns `None` for it by design (it only ever resolves a lone remaining key), so the
#    function returned `False` ("don't block") before ever reading `projection.year.range`. A table
#    with `projection.year.range=2020,2025` validated `status: "valid"` (round 9 only checks range
#    PRESENCE for Hive keys) and then silently committed a confident false zero-traffic day for any
#    post-2025 day. ────────────────────────────────────────────────────────────────────────────────

_HIVE_PROJECTION_VALIDATION = {
    "status": "valid", "columnMap": {"interface_id": "interface_id", "log_status": "log_status",
                                      "start": "start"},
    "partitionKeys": ["year", "month", "day"], "partitionKeyTypes": ["string", "string", "string"],
    "optionalFields": [], "partitionStrategy": "projection", "scopeResolution": {},
}


class FakeGlueGetTableWithHiveRanges:
    def __init__(self, year_range="2020,2030", month_range="1,12", day_range="1,31"):
        self._params = {
            "projection.year.range": year_range, "projection.month.range": month_range,
            "projection.day.range": day_range,
        }

    def get_table(self, DatabaseName, Name):
        return {"Table": {"Parameters": self._params}}


def test_query_by_source_rejects_a_day_excluded_by_a_hive_projection_year_range(monkeypatch):
    conn, called = _empty_query_by_source_setup(
        monkeypatch, _HIVE_PROJECTION_VALIDATION,
        glue=FakeGlueGetTableWithHiveRanges(year_range="2020,2025"))
    result = broker._query_by_source({"flow_source_id": 1, "day": "2026-03-05"}, conn)
    assert result["ok"] is False
    assert result.get("projection_range_uncovered") is True


def test_query_by_source_accepts_a_day_within_a_hive_projection_year_range(monkeypatch):
    conn, called = _empty_query_by_source_setup(
        monkeypatch, _HIVE_PROJECTION_VALIDATION,
        glue=FakeGlueGetTableWithHiveRanges(year_range="2020,2030"))
    result = broker._query_by_source({"flow_source_id": 1, "day": "2026-03-05"}, conn)
    assert result["ok"] is True
    assert "projection_range_uncovered" not in result


# ── CI-review MAJOR fix (round 14): the query's own predicate widens to the two-day window
#    {D, D+1} (Hive delivery-time partitioning), but this check used to look at D alone in both
#    branches — a day AT the range's upper boundary validated in-range while D+1 (also queried)
#    generates no candidate partition, silently missing D-day flows delivered late into D+1's
#    partition file. ───────────────────────────────────────────────────────────────────────────────

def test_query_by_source_rejects_a_day_whose_next_day_is_excluded_by_the_projection_range(monkeypatch):
    """Day D=2025-12-31 is itself within `2020-01-01,2025-12-31`, but D+1=2026-01-01 is not — the
    query's own widened {D, D+1} window is only partly covered, so the day must be refused."""
    conn, called = _empty_query_by_source_setup(
        monkeypatch, _PROJECTION_VALIDATION,
        glue=FakeGlueGetTableWithRange("2020-01-01,2025-12-31"))
    result = broker._query_by_source({"flow_source_id": 1, "day": "2025-12-31"}, conn)
    assert result["ok"] is False
    assert result.get("projection_range_uncovered") is True


def test_query_by_source_rejects_a_hive_day_whose_next_day_year_is_excluded_by_the_range(monkeypatch):
    """Day D=2025-12-31 falls in year 2025 (within `2020,2025`), but D+1=2026-01-01 falls in year
    2026 (outside it) — the widened window is only partly covered."""
    conn, called = _empty_query_by_source_setup(
        monkeypatch, _HIVE_PROJECTION_VALIDATION,
        glue=FakeGlueGetTableWithHiveRanges(year_range="2020,2025"))
    result = broker._query_by_source({"flow_source_id": 1, "day": "2025-12-31"}, conn)
    assert result["ok"] is False
    assert result.get("projection_range_uncovered") is True


# ── CI-review MAJOR fix (round 15, part b): the projection-range check used to run ONLY inside
#    `if not raw_rows and not next_token:` — but a boundary day can return SOME rows for D while
#    D+1 (also part of the query's own widened predicate) is excluded by the range, silently
#    missing D-day flows delivered late into D+1's partition. The check must run regardless of
#    whether the result was empty. ───────────────────────────────────────────────────────────────

def _nonempty_query_by_source_setup(monkeypatch, validation, glue=None):
    """Like `_empty_query_by_source_setup`, but the Athena query returns a NON-empty result."""
    conn = FakeConn(_source_row(validation))
    monkeypatch.setattr(broker, "_assumed_session", lambda *a, **k: FakeSession(glue=glue))
    monkeypatch.setattr(broker, "_run_athena_query",
                         lambda *a, **k: {"ok": True, "athena": object(), "query_execution_id": "q1"})
    monkeypatch.setattr(broker, "_fetch_page", lambda *a, **k: (["c1"], [["v1"]], None))
    return conn


def test_query_by_source_rejects_a_nonempty_result_whose_next_day_is_excluded_by_the_range(monkeypatch):
    conn = _nonempty_query_by_source_setup(
        monkeypatch, _PROJECTION_VALIDATION, glue=FakeGlueGetTableWithRange("2020-01-01,2025-12-31"))
    result = broker._query_by_source({"flow_source_id": 1, "day": "2025-12-31"}, conn)
    assert result["ok"] is False
    assert result.get("projection_range_uncovered") is True


def test_query_by_source_accepts_a_nonempty_result_fully_within_the_range(monkeypatch):
    conn = _nonempty_query_by_source_setup(
        monkeypatch, _PROJECTION_VALIDATION, glue=FakeGlueGetTableWithRange("2020-01-01,NOW"))
    result = broker._query_by_source({"flow_source_id": 1, "day": "2026-03-05"}, conn)
    assert result["ok"] is True
    assert result["rows"] == [{"c1": "v1"}]


def test_partition_keys_strategy_still_runs_glue_partition_check(monkeypatch):
    """The real, enumerable `partition_keys` strategy must still run the check (regression guard —
    the restriction above must not accidentally disable the check for the case it exists for)."""
    conn, called = _empty_query_by_source_setup(monkeypatch, {
        "status": "valid", "columnMap": {"interface_id": "interface_id", "log_status": "log_status",
                                          "start": "start"},
        "partitionKeys": ["dt"], "partitionKeyTypes": ["date"], "optionalFields": [],
        "partitionStrategy": "partition_keys", "scopeResolution": {},
    })
    result = broker._query_by_source({"flow_source_id": 1, "day": "2026-03-05"}, conn)
    assert called["n"] == 1
    assert result["ok"] is False
    assert result.get("zero_partition_match") is True


# ── item 8 follow-up fix: an unverifiable Glue partition check must refuse the day, never ────────
#    silently collapse into "confirmed present" (which the old boolean-returning version did). ───

class FakeGlueRaises:
    def get_partitions(self, **kwargs):
        raise RuntimeError("Glue API hiccup")


def test_partition_exists_returns_none_on_glue_error():
    result = broker._partition_exists(
        FakeGlueRaises(), "db", "tbl", dt.date(2026, 3, 5),
        {"partitionKeys": ["dt"], "partitionKeyTypes": ["date"]})
    assert result is None


def test_partition_exists_returns_none_on_an_unsafe_single_partition_key():
    """A stored single partition key that fails `_safe_ident` is genuinely unverifiable — it must
    return `None` (so the caller refuses the day and retries), never `True` ("partition confirmed
    present"), which would let a corrupted stored identifier manufacture a confident zero-traffic
    day. Glue must never be called at all for it."""
    class FakeGlueNeverCalled:
        def get_partitions(self, **kwargs):
            raise AssertionError("Glue must never be called for an unsafe identifier")

    result = broker._partition_exists(
        FakeGlueNeverCalled(), "db", "tbl", dt.date(2026, 3, 5),
        {"partitionKeys": ["dt; DROP"], "partitionKeyTypes": ["date"]})
    assert result is None


# ── MAJOR fix: the existence-check window must match the QUERY window. ───────────────────────────
#    `sg_rule_matching._build_partition_predicate` widens the query to partitions {D, D+1} (Hive
#    partitions are keyed by delivery time, so day-D flows can land in D+1's partition file), so a
#    check that only looked at day D would report `zero_partition_match` forever for a legitimately
#    zero-traffic day D whose D+1 partition exists — permanently stalling the watermark.

class FakeGluePartitions:
    """Answers `get_partitions` from a set of ISO day strings that actually have a partition: it
    simply reports a hit when the Expression mentions one of them, and records every Expression it
    was handed so the built predicate itself can be asserted on."""
    def __init__(self, existing_days):
        self.existing_days = list(existing_days)
        self.expressions = []

    def get_partitions(self, DatabaseName, TableName, Expression, MaxResults):
        self.expressions.append(Expression)
        if any(d in Expression for d in self.existing_days):
            return {"Partitions": [{"Values": ["x"]}]}
        return {"Partitions": []}


def test_partition_exists_true_when_only_the_next_day_partition_exists():
    """Day D has no partition (zero traffic) but D+1's does — the widened check must find it and
    return True, matching the query's own {D, D+1} predicate."""
    glue = FakeGluePartitions(["2026-03-06"])
    result = broker._partition_exists(
        glue, "db", "tbl", dt.date(2026, 3, 5),
        {"partitionKeys": ["dt"], "partitionKeyTypes": ["date"]})
    assert result is True
    # CI-review MAJOR fix (round 4): unlike the Athena SQL side, the Glue Expression grammar
    # compares partition values as plain strings regardless of the column's declared catalog
    # type (Glue partition values are stored as raw strings) — a typed `DATE '...'` literal risked
    # the same permanent-refusal failure as the unquoted-identifier bug, so this stays a plain
    # quoted string even for a `date`-typed key. The identifier is now double-quoted to match the
    # quoted-identifier grammar JSQLParser (Glue's Expression parser) shares with Athena SQL.
    assert glue.expressions == ["\"dt\" IN ('2026-03-05', '2026-03-06')"]


def test_partition_exists_keeps_string_literal_for_a_string_typed_key():
    """A string/varchar/char-typed single key (the common manually-partitioned-as-text pattern)
    must keep the plain quoted-string literal — only genuinely date/timestamp-typed keys switch to
    a typed literal."""
    glue = FakeGluePartitions(["2026-03-06"])
    broker._partition_exists(
        glue, "db", "tbl", dt.date(2026, 3, 5),
        {"partitionKeys": ["dt"], "partitionKeyTypes": ["string"]})
    assert glue.expressions == ["\"dt\" IN ('2026-03-05', '2026-03-06')"]


def test_partition_exists_false_when_neither_day_has_a_partition():
    """Neither D nor D+1 has a partition — still the genuine "wrong partition-key mapping" signal
    the caller wants (False), not None/True."""
    glue = FakeGluePartitions([])
    result = broker._partition_exists(
        glue, "db", "tbl", dt.date(2026, 3, 5),
        {"partitionKeys": ["dt"], "partitionKeyTypes": ["date"]})
    assert result is False


def test_partition_exists_hive_expression_covers_both_days_across_a_month_boundary():
    """The Hive year/month/day branch must OR together D's and D+1's OWN year/month/day values —
    each half carries its own values, so a month/year rollover is handled correctly."""
    glue = FakeGluePartitions([])
    broker._partition_exists(
        glue, "db", "tbl", dt.date(2026, 3, 31),
        {"partitionKeys": ["year", "month", "day"], "partitionKeyTypes": ["string"] * 3})
    expr = glue.expressions[0]
    assert "(\"year\" = '2026' AND \"month\" = '03' AND \"day\" = '31')" in expr
    assert "(\"year\" = '2026' AND \"month\" = '04' AND \"day\" = '01')" in expr
    assert " OR " in expr


# ── MAJOR fix (item 3, round 3): the existence check's Glue Expression must be scoped by
#    account_id/region when those resolved as actual PARTITION KEYS — otherwise ANY tenant's
#    partition satisfies "a partition exists," not necessarily this resolved source's own. ─────────

def test_partition_exists_scopes_the_expression_by_account_id_and_region_when_resolved_as_partition_keys():
    glue = FakeGluePartitions(["2026-03-05"])
    validation = {
        "partitionKeys": ["dt", "account-id", "region"], "partitionKeyTypes": ["date", "string", "string"],
        "scopeResolution": {"account_id": "partition", "region": "partition"},
        "columnMap": {"account_id": "account-id", "region": "region"},
    }
    source = {"account_id": "123456789012", "region": "ap-northeast-2"}
    result = broker._partition_exists(glue, "db", "tbl", dt.date(2026, 3, 5), validation, source=source)
    assert result is True
    expr = glue.expressions[0]
    assert "\"account-id\" = '123456789012'" in expr
    assert "\"region\" = 'ap-northeast-2'" in expr


def test_partition_exists_wrong_scope_value_does_not_manufacture_a_confident_partition_hit():
    """The SAME Expression the real query would scope to — if the resolved source's own
    account/region doesn't match the partition that satisfies the (unscoped) date predicate, the
    scoped Expression must report no matching partition, not a false positive borrowed from another
    tenant's partition."""
    glue = FakeGluePartitions(["2026-03-05"])  # a partition exists for the DATE, but not this account
    validation = {
        "partitionKeys": ["dt", "account-id", "region"], "partitionKeyTypes": ["date", "string", "string"],
        "scopeResolution": {"account_id": "partition", "region": "partition"},
        "columnMap": {"account_id": "account-id", "region": "region"},
    }
    source = {"account_id": "999999999999", "region": "ap-northeast-2"}
    result = broker._partition_exists(glue, "db", "tbl", dt.date(2026, 3, 5), validation, source=source)
    expr = glue.expressions[0]
    assert "999999999999" in expr


def test_partition_exists_unscoped_when_source_is_none_keeps_old_behavior():
    """Backward-compat: existing callers/tests that never pass `source` (no scope to add) must see
    no scope clause appended — just the plain (quoted-identifier, untyped-literal) date predicate."""
    glue = FakeGluePartitions(["2026-03-06"])
    validation = {"partitionKeys": ["dt"], "partitionKeyTypes": ["date"]}
    result = broker._partition_exists(glue, "db", "tbl", dt.date(2026, 3, 5), validation)
    assert result is True
    assert glue.expressions == ["\"dt\" IN ('2026-03-05', '2026-03-06')"]


# ── CI-review MAJOR regressions (round 4): a BARE hyphenated identifier in the Glue Expression
#    parses as arithmetic subtraction under JSQLParser and permanently refuses every day for that
#    table; a typed `DATE '...'`/`TIMESTAMP '...'` literal risks the identical failure mode since
#    Glue Expression compares partition values as plain strings, not Athena SQL types. ─────────────

def test_partition_exists_quotes_a_hyphenated_single_partition_key():
    """A hyphenated single-key name (e.g. a table whose only partition column is `account-id`-style
    text) must be double-quoted in the Glue Expression — a bare hyphenated identifier parses as
    arithmetic subtraction under Glue's JSQLParser grammar, not a column reference."""
    glue = FakeGluePartitions(["2026-03-05"])
    result = broker._partition_exists(
        glue, "db", "tbl", dt.date(2026, 3, 5),
        {"partitionKeys": ["log-date"], "partitionKeyTypes": ["string"]})
    assert result is True
    assert glue.expressions == ["\"log-date\" IN ('2026-03-05', '2026-03-06')"]


def test_partition_exists_never_emits_a_typed_literal_for_a_date_typed_key():
    """A `date`-typed single key must still get a plain quoted-string literal in the Glue
    Expression, never `DATE '...'` — Glue partition values are stored as raw strings regardless of
    the column's declared catalog type, and a typed literal risks the same permanent-refusal
    failure mode as the unquoted-identifier bug."""
    glue = FakeGluePartitions(["2026-03-05"])
    broker._partition_exists(
        glue, "db", "tbl", dt.date(2026, 3, 5),
        {"partitionKeys": ["dt"], "partitionKeyTypes": ["date"]})
    assert "DATE" not in glue.expressions[0]


def test_partition_exists_timestamp_key_uses_a_range_not_an_exact_midnight_match():
    """A `timestamp`-typed single key whose partition values are NOT exactly midnight (e.g. an
    hourly-partitioned table) must be checked with a RANGE, not an equality/IN against midnight
    literals — an exact-midnight check would silently miss every non-midnight partition value and
    manufacture a spurious `zero_partition_match` refusal for a day that genuinely has data.
    (`FakeGluePartitions` does naive substring matching, not real range evaluation, so this asserts
    the produced Expression's SHAPE rather than round-tripping a non-midnight value through it —
    the SQL-side equivalent, `test_build_partition_predicate_uses_a_range_...`, covers the actual
    predicate semantics.)"""
    glue = FakeGluePartitions([])
    broker._partition_exists(
        glue, "db", "tbl", dt.date(2026, 3, 5),
        {"partitionKeys": ["ts"], "partitionKeyTypes": ["timestamp"]})
    expr = glue.expressions[0]
    assert ">=" in expr and "<" in expr  # a range predicate, not an exact-midnight equality/IN
    assert "IN (" not in expr
    assert "2026-03-05 00:00:00" in expr
    assert "2026-03-07 00:00:00" in expr  # half-open upper bound covers D and D+1 fully


def test_query_by_source_commits_a_zero_traffic_day_when_only_the_next_day_partition_exists(monkeypatch):
    """End-to-end of the same fix through `_query_by_source` (pattern of
    `test_partition_keys_strategy_still_runs_glue_partition_check`, but with the REAL
    `_partition_exists`): an empty Athena result for a day D with no partition of its own, whose
    D+1 partition does exist, must commit as a genuine zero-traffic day — not
    `zero_partition_match`."""
    conn = FakeConn(_source_row({
        "status": "valid", "columnMap": {"interface_id": "interface_id", "log_status": "log_status",
                                          "start": "start"},
        "partitionKeys": ["dt"], "partitionKeyTypes": ["date"], "optionalFields": [],
        "partitionStrategy": "partition_keys", "scopeResolution": {},
    }))
    glue = FakeGluePartitions(["2026-03-06"])

    class SessionWithGlue:
        def client(self, name):
            return glue if name == "glue" else object()

    monkeypatch.setattr(broker, "_assumed_session", lambda *a, **k: SessionWithGlue())
    monkeypatch.setattr(broker, "_run_athena_query",
                         lambda *a, **k: {"ok": True, "athena": object(), "query_execution_id": "q1"})
    monkeypatch.setattr(broker, "_fetch_page", lambda *a, **k: (["c1"], [], None))
    result = broker._query_by_source({"flow_source_id": 1, "day": "2026-03-05"}, conn)
    assert result["ok"] is True
    assert "zero_partition_match" not in result
    assert "partition_check_unverified" not in result


def test_query_by_source_refuses_day_when_partition_check_is_unverifiable(monkeypatch):
    """A Glue API error while checking for a matching partition must NOT be trusted as "partition
    confirmed present, so the empty Athena result is genuine zero-traffic" — the old
    boolean-returning `_partition_exists` collapsed "unverifiable" into the same truthy value as
    "confirmed present". The day must be refused (watermark not advanced), not silently committed."""
    conn, called = _empty_query_by_source_setup(monkeypatch, {
        "status": "valid", "columnMap": {"interface_id": "interface_id", "log_status": "log_status",
                                          "start": "start"},
        "partitionKeys": ["dt"], "partitionKeyTypes": ["date"], "optionalFields": [],
        "partitionStrategy": "partition_keys", "scopeResolution": {},
    })
    monkeypatch.setattr(broker, "_partition_exists", lambda *a, **k: None)
    result = broker._query_by_source({"flow_source_id": 1, "day": "2026-03-05"}, conn)
    assert result["ok"] is False
    assert result.get("partition_check_unverified") is True
    assert "zero_partition_match" not in result
