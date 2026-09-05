"""Tests for the datasource_diag_signals helpers in db.py (pg8000 conn.run pattern).

A FakeConn records (sql, params) and returns canned rows so the helpers are exercised without Aurora.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import db  # noqa: E402


class FakeConn:
    def __init__(self, returns=None):
        self.calls = []
        self._returns = returns or []
    def run(self, sql, **params):
        self.calls.append((sql, params))
        return self._returns.pop(0) if self._returns else []


class TestInsertJob:
    """requested_by (round-2 pentest fix): defaults to NULL for internal-only enqueues, but a
    caller acting on behalf of a specific user (schedule_dispatcher.py) must be able to pass it
    through so GET /api/jobs[/id]'s ownership filter doesn't hide the row from its own owner."""

    def test_defaults_requested_by_to_none(self):
        c = FakeConn()
        db.insert_job(c, "j1", "noop", {"a": 1})
        sql, p = c.calls[0]
        assert "requested_by" in sql and p["rb"] is None

    def test_forwards_requested_by(self):
        c = FakeConn()
        db.insert_job(c, "j2", "report", {"a": 1}, requested_by="owner@x.io")
        _sql, p = c.calls[0]
        assert p["rb"] == "owner@x.io"


READY = {"signal_key": "oom_kills", "title": "OOM Kill", "status": "ready",
         "query": {"tool": "prometheus_query", "queries": [{"label": "x", "expr": "up"}]},
         "missing_metrics": None, "meta": {"pillar": "reliability", "threshold": 0}}
UNAVAIL = {"signal_key": "node_disk_usage", "title": "노드 디스크", "status": "unavailable",
           "query": None, "missing_metrics": ["node_filesystem_avail_bytes"],
           "meta": {"pillar": "reliability"}}


class TestUpsert:
    def test_upsert_binds_params_and_jsonb_casts(self):
        c = FakeConn()
        db.upsert_diag_signals(c, 42, [READY, UNAVAIL], "abc123")
        assert len(c.calls) == 2
        for sql, p in c.calls:
            assert "INSERT INTO datasource_diag_signals" in sql
            assert "::jsonb" in sql                       # query/missing_metrics/meta cast
            assert p["iid"] == 42 and p["sv"] == "abc123"
            assert p["sk"] in ("oom_kills", "node_disk_usage")
            # user/structured fields are bound, never inlined
            assert "oom_kills" not in sql and "node_disk_usage" not in sql
        # jsonb payloads are json-encoded strings
        ready_call = next(p for _, p in c.calls if p["sk"] == "oom_kills")
        assert json.loads(ready_call["q"])["tool"] == "prometheus_query"

    def test_upsert_empty_rows_records_a_version_sentinel(self):
        # NOT a no-op: with no row at all there is no schema_version, so read_signal_schema_version()
        # returns None forever and datasource_index rebuilds every run — re-invoking Bedrock daily where
        # the fallback flag is on (review MAJOR). The sentinel remembers "this schema yields nothing".
        c = FakeConn()
        written = db.upsert_diag_signals(c, 1, [], "v")
        assert written == [db.SCHEMA_VERSION_SENTINEL_KEY]
        assert len(c.calls) == 1
        params = c.calls[0][1]
        assert params["sk"] == db.SCHEMA_VERSION_SENTINEL_KEY
        assert params["sv"] == "v"          # the whole point: the version IS recorded
        assert params["st"] == "unavailable"
        assert params["q"] is None          # no query: it is bookkeeping, not a signal

    def test_upsert_returns_written_keys_so_the_sweep_keeps_the_sentinel(self):
        # Sweeping the caller's own rows would delete the sentinel in the same transaction.
        c = FakeConn()
        assert db.upsert_diag_signals(c, 1, [READY], "v") == [READY["signal_key"]]


class TestReadSchemaVersion:
    def test_returns_value_when_rows_present(self):
        c = FakeConn(returns=[[[1, "abc123"]]])
        assert db.read_signal_schema_version(c, 7) == "abc123"
        sql, p = c.calls[0]
        assert "COUNT(DISTINCT schema_version)" in sql and p["iid"] == 7

    def test_does_not_exclude_the_generated_row(self):
        # A version-blind exclusion of the generated row was tried and reverted: for a kind whose
        # deterministic catalog is ALWAYS empty (clickhouse), the generated row can be the ONLY row in the
        # table, and excluding it left zero rows to check — reading as no version forever and regenerating
        # on every single call (review, this round). Staleness after a sweep-spared read failure is instead
        # resolved by touch_generated_signal_version(), which brings the row back into agreement without
        # needing to read or preserve its content.
        c = FakeConn(returns=[[[1, "abc123"]]])
        db.read_signal_schema_version(c, 7)
        sql, _ = c.calls[0]
        assert "generated_signal" not in sql

class TestTouchGeneratedSignalVersion:
    def test_updates_only_the_version_column_for_the_fixed_key(self):
        # Exists so a sweep-spared (unverified) generated row's version can be brought back into agreement
        # with the rest of the table WITHOUT touching content we never read — the version-blind EXCLUSION
        # approach tried first broke the opposite way: excluding the generated key left a clickhouse-only
        # (deterministic catalog always empty) build with zero rows to check, reading as no version forever
        # and regenerating on every single call (review, this round).
        c = FakeConn()
        db.touch_generated_signal_version(c, 7, "newversion")
        sql, p = c.calls[0]
        assert sql.strip().startswith("UPDATE datasource_diag_signals")
        assert "signal_key='generated_signal'" in sql
        assert p == {"iid": 7, "sv": "newversion"}


class TestDiagSignalBudget:
    """The weekly-retry marker used to share a column with the content rows' schema_version. Every fix
    that protected the budget's own identity (a preserved stale marker, an excluded key) ended up tagging
    fresh CONTENT with a version that didn't describe it — so a schema that later rolled back to whatever
    that stale tag actually named made the agreement check see a false match and skip, serving newer,
    mistagged content as the old schema's real signals (review, this round). Storing the marker in a
    dedicated row's `meta` field, never in any row's `schema_version`, means content is always free to
    carry the truth; read_diag_signal_budget() reads it back independent of schema_version entirely."""

    def test_read_returns_none_when_the_row_is_absent(self):
        c = FakeConn(returns=[[]])
        assert db.read_diag_signal_budget(c, 7) is None

    def test_read_extracts_the_budget_field_from_meta(self):
        c = FakeConn(returns=[[[json.dumps({"budget": "hash:pend1w202601"})]]])
        assert db.read_diag_signal_budget(c, 7) == "hash:pend1w202601"

    def test_read_queries_the_fixed_bookkeeping_key_only(self):
        c = FakeConn(returns=[[]])
        db.read_diag_signal_budget(c, 7)
        sql, p = c.calls[0]
        assert "signal_key" in sql and p == {"iid": 7, "sk": db.BUDGET_KEY}

    def test_the_budget_key_is_not_a_real_schema_hash(self):
        # It must never collide with an actual content row's key, and must be excluded from the BFF read
        # path the same way __schema_version__ is (it is bookkeeping, not a signal).
        assert db.BUDGET_KEY != db.SCHEMA_VERSION_SENTINEL_KEY
        assert db.BUDGET_KEY.startswith("__") and db.BUDGET_KEY.endswith("__")

    def test_returns_none_when_absent(self):
        c = FakeConn(returns=[[[0, None]]])
        assert db.read_signal_schema_version(c, 7) is None

    def test_returns_none_when_versions_are_mixed(self):
        c = FakeConn(returns=[[[2, "newest"]]])
        assert db.read_signal_schema_version(c, 7) is None


class TestDiagSignalAttemptReservation:
    """Charging the weekly budget used to be read → call Bedrock → write, a read-modify-write with a
    multi-second gap in the middle: two workers racing on one integration both read the same attempts
    count, both called Bedrock, and both wrote back the same incremented value, so real usage was
    undercounted against a HARD per-week cap (review MAJOR). The charge is now a RESERVATION — one
    INSERT ... ON CONFLICT DO UPDATE ... RETURNING statement, committed before the model call — and no
    mock-driven test can execute the SQL, so these assert the statement's SHAPE (the semantics were
    verified against a real PostgreSQL 17)."""

    def test_reserve_returns_the_new_attempt_count(self):
        c = FakeConn(returns=[[[2]]])
        assert db.reserve_diag_signal_attempt(c, 7, "202632", 3, "v1") == 2

    def test_reserve_returns_none_when_the_week_is_already_spent(self):
        c = FakeConn(returns=[[]])          # the cap guard in the WHERE clause matched no row
        assert db.reserve_diag_signal_attempt(c, 7, "202632", 3, "v1") is None

    def test_reserve_is_one_atomic_returning_statement(self):
        c = FakeConn(returns=[[[1]]])
        db.reserve_diag_signal_attempt(c, 7, "202632", 3, "v1", known_attempts=2)
        assert len(c.calls) == 1            # not read-then-write: one statement, one row lock
        sql, p = c.calls[0]
        assert "ON CONFLICT" in sql and "RETURNING" in sql
        assert "'{attempts}'" in sql and "+ 1" in sql        # incremented in SQL, never in Python
        assert p == {"iid": 7, "sk": db.BUDGET_KEY, "ti": db.BUDGET_TITLE, "st": "unavailable",
                     "wk": "202632", "sv": "v1", "cap": 3, "known": 2}

    def test_reserve_refuses_at_the_cap_inside_the_statement(self):
        c = FakeConn(returns=[[[1]]])
        db.reserve_diag_signal_attempt(c, 7, "202632", 3, "v1")
        sql, _p = c.calls[0]
        assert "< :cap" in sql              # the DB enforces the cap, not the caller's stale read
        assert "GREATEST" in sql            # …and never below what the caller already knows was spent

    def test_release_is_scoped_to_its_own_week_and_floored(self):
        c = FakeConn()
        db.release_diag_signal_attempt(c, 7, "202632")
        sql, p = c.calls[0]
        assert "GREATEST" in sql and "meta->>'week' = :wk" in sql
        assert p == {"iid": 7, "sk": db.BUDGET_KEY, "wk": "202632"}

    def test_the_marker_write_never_clobbers_the_reservation_counter(self):
        # upsert_diag_signals' `meta = EXCLUDED.meta` would replace the whole object and drop a count a
        # concurrent worker had already charged — which is why the budget row has its own writer.
        c = FakeConn()
        db.write_diag_signal_budget(c, 7, "v1:pend1w202632", "v1")
        sql, p = c.calls[0]
        assert "jsonb_set" in sql and "'{budget}'" in sql
        assert "'{attempts}'" not in sql and "'{week}'" not in sql
        assert p["bg"] == "v1:pend1w202632" and p["sv"] == "v1" and p["st"] == "unavailable"

    def test_live_marker_re_derives_the_whole_marker_at_write_time(self):
        # review MAJOR-1: the caller decides attempts AND state AND streak BEFORE the multi-second
        # Bedrock call, so everything it proposes can be stale by the time it writes. live_marker moves
        # all three into the UPDATE itself, read live from the row, never from the caller's snapshot.
        c = FakeConn()
        db.write_diag_signal_budget(c, 7, "v1:pend1w202632", "v1",
                                     live_marker=("v1", "pend", 0, "202632", 1))
        sql, p = c.calls[0]
        assert "GREATEST" in sql and "meta->>'week' = :wk" in sql
        assert p["ver"] == "v1" and p["wk"] == "202632" and p["floor"] == 1 and p["strk"] == 0
        assert p["rank"] == db._MARKER_STATE_RANK["pend"]
        # Round 3: the STATE and STREAK are re-derived too, not just the attempts digit — the marker is
        # composed in SQL from the more advanced of (proposed, live), so all three pieces are present.
        assert "'conc'" in sql and "'done'" in sql and "'pend'" in sql   # the rank→state mapping
        assert "s([0-9]+)$" in sql                                      # the live streak is parsed back
        # the marker string passed in is NOT what gets stored verbatim on this path — the live
        # expression is what's embedded, so the byte-for-byte `marker` arg is not asserted here.

    def test_the_live_marker_sql_never_looks_like_a_param_inside_a_string_literal(self):
        # pg8000's named paramstyle scans the SQL for `:name`, so a colon FOLLOWED BY AN IDENTIFIER
        # inside a string literal would be eaten as a bogus parameter. That is why the marker-parsing
        # regexes are written colon-free — no `:(pend|done|conc)`, no non-capturing `(?:s[0-9]+)` — even
        # though a bare `':'` separator (colon then a quote) is harmless and is used deliberately.
        c = FakeConn()
        db.write_diag_signal_budget(c, 7, "v1:pend1w202632", "v1",
                                     live_marker=("v1", "conc", 2, "202632", 3))
        sql, _p = c.calls[0]
        for literal in re.findall(r"'([^']*)'", sql):
            assert not re.search(r":[A-Za-z_]", literal), \
                f"{literal!r} looks like a bound parameter to pg8000 — rewrite it colon-free"

    def test_omitting_live_marker_stores_the_marker_byte_for_byte(self):
        # The one caller that must NOT re-derive: a marker preserved for a DIFFERENT schema than the
        # current live counter describes (a capped-schema identity that must not drift — see
        # datasource_index.py's byte-for-byte preservation branch).
        c = FakeConn()
        db.write_diag_signal_budget(c, 7, "otherhash:done3w202601", "v1")
        sql, p = c.calls[0]
        assert "GREATEST" not in sql
        assert p["bg"] == "otherhash:done3w202601"


class TestList:
    def test_list_returns_parsed_rows(self):
        c = FakeConn(returns=[[
            ["oom_kills", "OOM Kill", "ready",
             json.dumps({"tool": "prometheus_query", "queries": [{"label": "x", "expr": "up"}]}),
             None, json.dumps({"pillar": "reliability", "threshold": 0})],
            ["node_disk_usage", "노드 디스크", "unavailable",
             None, json.dumps(["node_filesystem_avail_bytes"]), json.dumps({"pillar": "reliability"})],
        ]])
        rows = db.list_diag_signals(c, 9)
        by = {r["signal_key"]: r for r in rows}
        assert by["oom_kills"]["status"] == "ready"
        assert by["oom_kills"]["query"]["tool"] == "prometheus_query"
        assert by["node_disk_usage"]["missing_metrics"] == ["node_filesystem_avail_bytes"]
        assert "WHERE account_id" in c.calls[0][0] and c.calls[0][1]["iid"] == 9


class TestSweep:
    def test_sweep_deletes_keys_not_kept_bound(self):
        c = FakeConn()
        db.sweep_diag_signals(c, 5, ["oom_kills", "cpu_saturation"])
        sql, p = c.calls[0]
        assert "DELETE FROM datasource_diag_signals" in sql
        assert p["iid"] == 5 and p["keep"] == ["oom_kills", "cpu_saturation"]
        assert "oom_kills" not in sql  # bound, not inlined

    def test_sweep_empty_keep_deletes_all_for_instance(self):
        c = FakeConn()
        db.sweep_diag_signals(c, 5, [])
        sql, p = c.calls[0]
        assert "DELETE FROM datasource_diag_signals" in sql and p["iid"] == 5


# ── datasource_graph_queries (pre-built topology-graph queries) ─────────────────────────────────
GQ_READY = {"query_key": "trace_spans", "status": "ready",
            "query": {"tool": "clickhouse_query", "mapper": "otel_v1", "args_template": {"sql": "SELECT 1"}},
            "missing": None, "meta": {"kind": "clickhouse", "provenance": "catalog"}}
GQ_UNAVAIL = {"query_key": "servicegraph_calls", "status": "unavailable", "query": None,
              "missing": ["istio_requests_total"], "meta": {"kind": "prometheus", "provenance": "catalog"}}


class TestUpsertGraphQueries:
    def test_upsert_binds_params_and_jsonb_casts(self):
        c = FakeConn()
        db.upsert_graph_queries(c, 42, [GQ_READY, GQ_UNAVAIL], "abc123")
        assert len(c.calls) == 2
        for sql, p in c.calls:
            assert "INSERT INTO datasource_graph_queries" in sql
            assert "::jsonb" in sql
            assert p["iid"] == 42 and p["sv"] == "abc123"
            assert p["qk"] in ("trace_spans", "servicegraph_calls")
            assert "trace_spans" not in sql and "servicegraph_calls" not in sql  # bound, not inlined
        ready_call = next(p for _, p in c.calls if p["qk"] == "trace_spans")
        assert json.loads(ready_call["q"])["mapper"] == "otel_v1"

    def test_upsert_empty_rows_is_noop(self):
        c = FakeConn()
        db.upsert_graph_queries(c, 1, [], "v")
        assert c.calls == []


class TestReadGraphSchemaVersion:
    def test_returns_value_when_rows_present(self):
        c = FakeConn(returns=[[[1, "abc123"]]])
        assert db.read_graph_schema_version(c, 7) == "abc123"
        sql, p = c.calls[0]
        assert "COUNT(DISTINCT schema_version)" in sql and "datasource_graph_queries" in sql
        assert p["iid"] == 7

    def test_returns_none_when_absent(self):
        c = FakeConn(returns=[[[0, None]]])
        assert db.read_graph_schema_version(c, 7) is None

    def test_returns_none_when_versions_are_mixed(self):
        c = FakeConn(returns=[[[2, "newest"]]])
        assert db.read_graph_schema_version(c, 7) is None


class TestSweepGraphQueries:
    def test_sweep_deletes_keys_not_kept_bound(self):
        c = FakeConn()
        db.sweep_graph_queries(c, 5, ["trace_spans"])
        sql, p = c.calls[0]
        assert "DELETE FROM datasource_graph_queries" in sql
        assert p["iid"] == 5 and p["keep"] == ["trace_spans"]

    def test_sweep_empty_keep_deletes_all_for_instance(self):
        c = FakeConn()
        db.sweep_graph_queries(c, 5, [])
        sql, p = c.calls[0]
        assert "DELETE FROM datasource_graph_queries" in sql and p["iid"] == 5


class TestUpsertDatasourceSchema:
    """Write-back of a freshly re-introspected schema (drift refresh) — python-worker side mirror
    of the BFF's upsertSchema (web/lib/datasource-schema.ts), used only by datasource_index.py."""
    def test_upsert_binds_params_and_jsonb_casts(self):
        c = FakeConn()
        db.upsert_datasource_schema(c, "self", 42, "clickhouse", {"version": "1.2", "tables": []})
        assert len(c.calls) == 1
        sql, p = c.calls[0]
        assert "INSERT INTO datasource_schemas" in sql and "::jsonb" in sql
        assert p["acct"] == "self" and p["iid"] == 42 and p["k"] == "clickhouse"
        assert json.loads(p["s"]) == {"version": "1.2", "tables": []}

    def test_oversized_metric_schema_is_stored_bounded_and_truncated(self):
        c = FakeConn()
        big = {"metrics": [f"very_long_metric_name_{'x' * 80}_{i}" for i in range(3000)], "truncated": False}
        db.upsert_datasource_schema(c, "self", 42, "prometheus", big)
        assert len(c.calls) == 1
        stored = json.loads(c.calls[0][1]["s"])
        assert len(c.calls[0][1]["s"].encode("utf-8")) <= db._MAX_SCHEMA_BYTES
        assert stored["truncated"] is True and 0 < len(stored["metrics"]) < 3000
        assert stored["metrics"][0] == big["metrics"][0]

    def test_metric_trim_keeps_probed_present_names_and_marks_trimmed(self):
        metrics = [f"very_long_metric_name_{'x' * 80}_{i}" for i in range(3000)]
        out = db._trim_schema_for_cache({"metrics": metrics, "probed": [metrics[1], metrics[1501], "absent"], "truncated": False})
        assert out["trimmed"] is True and out["truncated"] is True
        assert metrics[1] in out["metrics"] and metrics[1501] in out["metrics"]
        assert "absent" not in out["metrics"]
        assert out["probed"] == [metrics[1], metrics[1501], "absent"]
        assert len(json.dumps(out).encode("utf-8")) <= db._MAX_SCHEMA_BYTES

    def test_oversized_untrimmable_schema_still_raises(self):
        c = FakeConn()
        try:
            db.upsert_datasource_schema(c, "self", 42, "clickhouse", {"blob": "x" * 300_000})
            raise AssertionError("expected ValueError")
        except ValueError:
            pass
        assert c.calls == []


# ── datasource_dashboard_cards (pre-built dashboard cards) ───────────────────────────────────────
CARD_READY = {"card_key": "up_targets", "title": "정상 타깃 수", "viz": "stat", "unit": "",
              "status": "ready",
              "query": {"tool": "prometheus_query", "expr": "count(up == 1)", "range": None},
              "missing": []}
CARD_UNAVAIL = {"card_key": "memory_available", "title": "가용 메모리", "viz": "timeseries", "unit": "bytes",
                "status": "unavailable", "query": None, "missing": ["node_memory_MemAvailable_bytes"]}


class TestUpsertDashboardCards:
    def test_upsert_binds_params_and_jsonb_casts(self):
        c = FakeConn()
        written = db.upsert_dashboard_cards(c, 42, [CARD_READY, CARD_UNAVAIL], "abc123")
        assert written == ["up_targets", "memory_available"]
        assert len(c.calls) == 2
        for sql, p in c.calls:
            assert "INSERT INTO datasource_dashboard_cards" in sql
            assert "::jsonb" in sql
            assert p["iid"] == 42 and p["sv"] == "abc123"
            assert "up_targets" not in sql  # bound, not inlined
        ready_call = next(p for _, p in c.calls if p["ck"] == "up_targets")
        assert json.loads(ready_call["q"])["tool"] == "prometheus_query"

    def test_upsert_empty_rows_writes_version_sentinel(self):
        c = FakeConn()
        written = db.upsert_dashboard_cards(c, 1, [], "v9")
        assert written == [db.SCHEMA_VERSION_SENTINEL_KEY]
        sql, p = c.calls[0]
        assert "datasource_dashboard_cards" in sql and p["sv"] == "v9"


class TestReadCardSchemaVersion:
    def test_returns_value_when_rows_agree(self):
        c = FakeConn(returns=[[[1, "abc123"]]])
        assert db.read_card_schema_version(c, 7) == "abc123"
        sql, p = c.calls[0]
        assert "datasource_dashboard_cards" in sql and p["iid"] == 7

    def test_returns_none_when_absent_or_mixed(self):
        assert db.read_card_schema_version(FakeConn(returns=[[[0, None]]]), 7) is None
        assert db.read_card_schema_version(FakeConn(returns=[[[2, "newest"]]]), 7) is None


class TestSweepDashboardCards:
    def test_sweep_deletes_keys_not_kept_bound(self):
        c = FakeConn()
        db.sweep_dashboard_cards(c, 5, ["up_targets"])
        sql, p = c.calls[0]
        assert "DELETE FROM datasource_dashboard_cards" in sql
        assert p["iid"] == 5 and p["keep"] == ["up_targets"]
