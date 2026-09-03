import importlib.util
import json
import sys
import types
from pathlib import Path
import pytest
from botocore.exceptions import ClientError


def load_sync_lambda():
    root = Path(__file__).resolve().parent
    sys.modules.setdefault("boto3", types.SimpleNamespace(client=lambda *a, **k: object()))
    sys.modules.setdefault("pg8000", types.SimpleNamespace(native=types.SimpleNamespace(Connection=object)))
    sys.modules.setdefault("pg8000.native", types.SimpleNamespace(Connection=object))
    sys.modules.setdefault("botocore", types.SimpleNamespace())
    sys.modules.setdefault("botocore.exceptions", types.SimpleNamespace(ClientError=Exception))
    spec = importlib.util.spec_from_file_location("sync_lambda_under_test", root / "sync_lambda.py")
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(mod)
    return mod


def test_ecs_service_query_registered_readonly():
    mod = load_sync_lambda()
    sql, id_col, region_col = mod.QUERIES["ecs_service"]
    assert "FROM aws_ecs_service" in sql
    assert "(cluster_arn || '/' || service_name) AS service_key" in sql
    assert id_col == "service_key"
    assert region_col == "region"
    for col in [
        "service_name", "cluster_arn", "status",
        "desired_count", "running_count", "pending_count",
        "launch_type", "scheduling_strategy", "task_definition", "created_at",
    ]:
        assert col in sql
    assert "service_arn" not in sql


# ── Task 9: multi-account scoping ──

def test_rec_account_maps_host_to_self_and_keeps_targets():
    mod = load_sync_lambda()
    mod._ACCOUNT_CACHE["id"] = "111111111111"  # host's real 12-digit id (bypass STS)
    assert mod._rec_account({"account_id": "210987654321"}) == "210987654321"  # target kept verbatim
    assert mod._rec_account({"account_id": "111111111111"}) == "self"          # host real id → 'self' sentinel
    assert mod._rec_account({"account_id": None}) == "self"                    # SDK / host rows w/o column
    assert mod._rec_account({}) == "self"


def test_ebs_snapshot_pushdown_is_multi_account_in_list():
    mod = load_sync_lambda()
    sql, id_col, region_col = mod.QUERIES["ebs_snapshot"]
    # no longer a single host literal; an OwnerIds IN-list rendered from enabled accounts
    assert "owner_id IN ({owner_ids})" in sql
    assert "= '{account_id}'" not in sql


def test_owner_ids_in_includes_host_and_targets_validated():
    mod = load_sync_lambda()
    mod._ACCOUNT_CACHE["id"] = "111111111111"  # bypass STS (host caller)

    class FakeAdb:
        def run(self, *a, **k):
            return [("210987654321",), ("310987654321",), ("self",), ("bad",)]

    clause = mod._owner_ids_in(FakeAdb())
    assert "'111111111111'" in clause   # host real id
    assert "'210987654321'" in clause and "'310987654321'" in clause
    assert "'self'" not in clause and "'bad'" not in clause   # non-12-digit excluded


def test_enabled_target_accounts_excludes_host_and_self():
    """M2: _enabled_target_accounts must return only real TARGET account ids (never 'self' or the
    host's own 12-digit id) — those are handled separately by phase-2's host probe. Also (M-7,
    round 8): the query must filter to accounts actually IN SCAN SCOPE (all_regions OR an enabled
    account_regions row) — not merely `enabled`, else a zero-region account (already swept by
    phase-1, with no rendered aws.spc connection to probe) would be probed every sync for nothing."""
    mod = load_sync_lambda()
    mod._ACCOUNT_CACHE["id"] = "111111111111"  # host caller id
    seen_sql = []

    class FakeAdb:
        def run(self, sql, **params):
            seen_sql.append(sql)
            assert params.get("host") == "111111111111"
            return [("210987654321",), ("310987654321",)]

    assert mod._enabled_target_accounts(FakeAdb()) == ["210987654321", "310987654321"]
    assert "a.all_regions = true" in seen_sql[0], "must accept all_regions accounts as in-scope"
    assert "EXISTS" in seen_sql[0] and "account_regions" in seen_sql[0], (
        "must filter to accounts with >=1 enabled account_regions row — a bare enabled=true "
        "check would probe zero-region accounts that already have no rendered connection (M-7)"
    )


def test_account_reachable_true_when_its_own_steampipe_connection_answers(monkeypatch):
    """M2 (round 5): _account_reachable must query the account's OWN Steampipe connection
    (aws_<account_id>.aws_caller_identity) — the SAME data path the aggregator uses — not an
    independent sts:AssumeRole (which only proves the IAM trust policy, not that Steampipe
    actually queried the account this run; see the round-5 rewrite comment on _account_reachable
    for the exact data-loss scenario that motivated this)."""
    mod = load_sync_lambda()
    queries = []

    class FakeConn:
        def run(self, sql):
            queries.append(sql)
            return [("210987654321",)]

        def close(self):
            pass

    monkeypatch.setattr(mod, "_steampipe", lambda: FakeConn())
    assert mod._account_reachable("210987654321") is True
    assert "aws_210987654321.aws_caller_identity" in queries[0]


def test_account_reachable_false_when_connection_query_fails(monkeypatch):
    """A failing per-connection query means the account is NOT reachable — its 0-row result this
    run must not be treated as genuinely empty, protecting last-good inventory."""
    mod = load_sync_lambda()

    class FakeConn:
        def run(self, sql):
            raise Exception("connection refused / plugin error")

        def close(self):
            pass

    monkeypatch.setattr(mod, "_steampipe", lambda: FakeConn())
    assert mod._account_reachable("999999999999") is False


def test_account_reachable_rejects_non_account_id_without_connecting(monkeypatch):
    """Defense in depth (mirrors _inject_account's validation): a non-12-digit value must never
    reach SQL string interpolation — reject before ever calling _steampipe()."""
    mod = load_sync_lambda()

    def _boom():
        raise AssertionError("must not connect for an invalid account id")

    monkeypatch.setattr(mod, "_steampipe", _boom)
    assert mod._account_reachable("'; DROP TABLE x--") is False


def test_account_reachable_closes_connection_even_on_failure(monkeypatch):
    """The probe connection must always be closed, success or failure."""
    mod = load_sync_lambda()
    closed = []

    class FakeConn:
        def run(self, sql):
            raise Exception("boom")

        def close(self):
            closed.append(True)

    monkeypatch.setattr(mod, "_steampipe", lambda: FakeConn())
    mod._account_reachable("210987654321")
    assert closed == [True]


def test_opensearch_query_carries_the_l153_detail_columns():
    """Gap L153: the 8 detail-panel columns must stay in the opensearch SELECT (all present in
    the pinned plugin aws@0.142.0; off_peak_window_options is NOT in 0.142.0 — excluded)."""
    mod = load_sync_lambda()
    sql = mod.QUERIES["opensearch"][0]
    for col in (
        "service_software_options", "log_publishing_options", "domain_endpoint_options",
        "auto_tune_options", "snapshot_options", "advanced_options", "access_policies",
        "upgrade_processing",
    ):
        assert col in sql, col
    assert "off_peak_window_options" not in sql


def test_log_is_structured_json(capsys):
    """Missing field-safe JSON formatting would make downstream log parsing unreliable."""
    mod = load_sync_lambda()

    mod._log("inventory_sync_complete", resource_type="ec2", row_count=3, elapsed_ms=12)

    record = json.loads(capsys.readouterr().out)
    assert record == {
        "event": "inventory_sync_complete",
        "resource_type": "ec2",
        "row_count": 3,
        "elapsed_ms": 12,
    }


def test_all_dispatch_reports_every_type_queued(capsys):
    """A fully queued fan-out must report dispatched with exact per-type outcomes."""
    mod = load_sync_lambda()
    mod.QUERIES = {"ec2": ("SELECT 1", "id", "region")}
    mod.SDK_SYNCS = {"s3": lambda: ([], "id", "region")}

    class FakeLambda:
        def invoke(self, **kwargs):
            return {"StatusCode": 202}

    class FakeContext:
        invoked_function_arn = "arn:aws:lambda:ap-northeast-2:123456789012:function:sync"

    mod._lambda = FakeLambda()
    result = mod.lambda_handler({"type": "all"}, FakeContext())

    records = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert result == {
        "status": "dispatched",
        "queued_count": 2,
        "failed_count": 0,
        "queued_types": ["ec2", "s3"],
        "failed_types": [],
    }
    assert records == [{
        "event": "inventory_sync_dispatch",
        "status": "dispatched",
        "type_count": 2,
        "queued_count": 2,
        "failed_count": 0,
        "queued_types": ["ec2", "s3"],
        "failed_types": [],
    }]


def test_all_dispatch_continues_after_one_failure_and_reports_partial_without_error_text(capsys):
    """One failed self-invoke must not block later types or expose the raw exception."""
    mod = load_sync_lambda()
    mod.QUERIES = {
        "ec2": ("SELECT 1", "id", "region"),
        "alb": ("SELECT 1", "id", "region"),
    }
    mod.SDK_SYNCS = {"s3": lambda: ([], "id", "region")}
    invoked = []

    class FakeLambda:
        def invoke(self, **kwargs):
            resource_type = json.loads(kwargs["Payload"].decode())["type"]
            invoked.append(resource_type)
            if resource_type == "alb":
                raise RuntimeError("credential=supersecret account=123456789012")
            return {"StatusCode": 202}

    class FakeContext:
        invoked_function_arn = "arn:aws:lambda:ap-northeast-2:123456789012:function:sync"

    mod._lambda = FakeLambda()
    result = mod.lambda_handler({"type": "all"}, FakeContext())

    output = capsys.readouterr().out
    records = [json.loads(line) for line in output.splitlines()]
    assert invoked == ["ec2", "alb", "s3"]
    assert result == {
        "status": "partial",
        "queued_count": 2,
        "failed_count": 1,
        "queued_types": ["ec2", "s3"],
        "failed_types": ["alb"],
    }
    assert records[0]["status"] == "partial"
    assert records[0]["queued_types"] == ["ec2", "s3"]
    assert records[0]["failed_types"] == ["alb"]
    assert "supersecret" not in output
    assert "123456789012" not in output
    assert "supersecret" not in json.dumps(result)


def test_all_dispatch_reports_failed_when_no_type_was_queued(capsys):
    """A fan-out with zero accepted async invokes must not claim dispatch success."""
    mod = load_sync_lambda()
    mod.QUERIES = {"ec2": ("SELECT 1", "id", "region")}
    mod.SDK_SYNCS = {"s3": lambda: ([], "id", "region")}

    class FakeLambda:
        def invoke(self, **kwargs):
            return {"StatusCode": 500}

    class FakeContext:
        invoked_function_arn = "arn:aws:lambda:ap-northeast-2:123456789012:function:sync"

    mod._lambda = FakeLambda()
    result = mod.lambda_handler({"type": "all"}, FakeContext())

    records = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert result == {
        "status": "failed",
        "queued_count": 0,
        "failed_count": 2,
        "queued_types": [],
        "failed_types": ["ec2", "s3"],
    }
    assert records[0]["status"] == "failed"
    assert records[0]["queued_count"] == 0
    assert records[0]["failed_count"] == 2


def test_new_run_token_is_opaque_uuid_hex():
    """A predictable or reused ownership token would not isolate stale finalizers."""
    mod = load_sync_lambda()

    first = mod._new_run_token()
    second = mod._new_run_token()

    assert first != second
    assert len(first) == 32
    assert len(second) == 32
    int(first, 16)
    int(second, 16)


@pytest.mark.parametrize("status", ["succeeded", "partial", "failed"])
def test_every_terminal_finalizer_uses_run_token_compare_and_set(
    monkeypatch, status
):
    """Removing the token predicate or RETURNING lets a stale invocation overwrite a newer run."""
    mod = load_sync_lambda()
    calls = []
    closed = []
    run_token = "a" * 32

    class FinalizerAurora:
        def run(self, sql, **kwargs):
            calls.append((sql, kwargs))
            return [(1,)]

        def close(self):
            closed.append(True)

    monkeypatch.setattr(mod, "_aurora", FinalizerAurora)

    updated = mod._finalize_sync_ledger(
        resource_type="ec2",
        run_token=run_token,
        status=status,
        row_count=3,
        error="safe failure",
    )

    assert updated is True
    assert closed == [True]
    assert len(calls) == 1
    sql, params = calls[0]
    normalized = " ".join(sql.split())
    assert (
        "WHERE resource_type=:t AND account_id='self' "
        "AND run_token=:run_token"
    ) in normalized
    assert normalized.endswith("RETURNING 1")
    assert params["run_token"] == run_token


def test_sync_success_logs_one_terminal_record_with_row_count(capsys, monkeypatch):
    """Omitting or duplicating a successful terminal log loses sync outcome observability."""
    mod = load_sync_lambda()
    connections = []

    class FakeAurora:
        def __init__(self):
            self.sql_log = []
            connections.append(self)

        def run(self, sql, **kwargs):
            self.sql_log.append((sql, kwargs))
            if "pg_try_advisory_lock" in sql:
                return [(True,)]
            if "SELECT account_id, region, resource_id" in sql:
                return [("self", "ap-northeast-2", "stale-r-0")]
            if "RETURNING 1" in sql:
                return [(1,)]
            return []

        def close(self):
            pass

    monkeypatch.setattr(mod, "_aurora", FakeAurora)
    monkeypatch.setattr(mod, "_rec_account", lambda rec: "self")
    monkeypatch.setattr(mod, "_self_count", lambda recs: len(recs))
    mod.SDK_SYNCS["log_test_success"] = lambda: (
        [{"id": "r-1", "region": "ap-northeast-2"}],
        "id",
        "region",
        {"failure_count": 0, "failure_types": []},
    )
    mod._ALLOWED.add("log_test_success")

    result = mod.sync("log_test_success")

    records = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    terminal = [record for record in records if record["event"].startswith("inventory_sync_") and
                record["event"] != "inventory_sync_dispatch"]
    assert result == {
        "status": "succeeded",
        "type": "log_test_success",
        "row_count": 1,
        "unknown_attribute_count": 0,
    }
    assert len(terminal) == 1
    assert terminal[0]["event"] == "inventory_sync_complete"
    assert terminal[0]["resource_type"] == "log_test_success"
    assert terminal[0]["row_count"] == 1
    assert terminal[0]["unknown_attribute_count"] == 0
    assert terminal[0]["degraded"] is False
    assert terminal[0]["throttled"] is False
    assert terminal[0]["freshness"] == "healthy"
    assert terminal[0]["age_minutes"] == 0
    assert isinstance(terminal[0]["elapsed_ms"], int)
    assert len(connections) == 2
    main_sql = [sql for sql, _ in connections[0].sql_log]
    finalizer_sql = [sql for sql, _ in connections[1].sql_log]
    assert mod.PHASE1_PRUNE_SQL in main_sql
    assert any(
        "DELETE FROM inventory_resources" in sql
        and params.get("id") == "stale-r-0"
        for sql, params in connections[0].sql_log
    )
    assert not any("SET status='succeeded'" in sql for sql in main_sql)
    assert any(
        "SET status='succeeded'" in sql
        and "last_success_at=now()" in sql
        and "last_success_row_count=:n" in sql
        and "unknown_attribute_count=:u" in sql
        and "run_token=:run_token" in sql
        and "RETURNING 1" in sql
        for sql in finalizer_sql
    )
    running = next(
        (sql, params) for sql, params in connections[0].sql_log
        if "INSERT INTO inventory_sync_runs" in sql
    )
    assert "run_token" in running[0]
    # a new run must not inherit the previous run's disclosed attribute blind spots
    assert "unknown_attribute_count=NULL" in running[0]
    assert running[1]["run_token"] == connections[1].sql_log[-1][1]["run_token"]


def test_sync_success_with_unknown_attrs_marks_degraded(capsys, monkeypatch):
    """A succeeded run with attribute blind spots must degrade BOTH the freshness and the
    'degraded' flag — a dashboard keying on either field must read the same story."""
    mod = load_sync_lambda()

    class MainAurora:
        def run(self, sql, **kwargs):
            if "pg_try_advisory_lock" in sql:
                return [(True,)]
            return []

        def close(self):
            pass

    class FinalizerAurora:
        def run(self, sql, **kwargs):
            return [(1,)]

        def close(self):
            pass

    connections = iter([MainAurora(), FinalizerAurora()])
    monkeypatch.setattr(mod, "_aurora", lambda: next(connections))
    monkeypatch.setattr(mod, "_rec_account", lambda rec: "self")
    monkeypatch.setattr(mod, "_self_count", lambda recs: len(recs))
    mod.SDK_SYNCS["sdk_unknown_attrs_test"] = lambda: (
        [{"id": "new-good", "region": "ap-northeast-2"}],
        "id",
        "region",
        {"failure_count": 0, "failure_types": [], "unknown_attribute_count": 2},
    )
    mod._ALLOWED.add("sdk_unknown_attrs_test")

    result = mod.sync("sdk_unknown_attrs_test")

    assert result["status"] == "succeeded"
    terminal = [
        json.loads(line) for line in capsys.readouterr().out.splitlines()
        if json.loads(line)["event"] == "inventory_sync_complete"
    ]
    assert len(terminal) == 1
    assert terminal[0]["unknown_attribute_count"] == 2
    assert terminal[0]["freshness"] == "degraded"
    assert terminal[0]["degraded"] is True
    assert terminal[0]["throttled"] is False


def test_sdk_partial_upserts_good_rows_without_pruning_or_advancing_last_success(
    capsys, monkeypatch
):
    """A swallowed SDK sub-call failure makes the run partial and preserves all prior rows."""
    mod = load_sync_lambda()
    main_calls = []
    finalizer_calls = []

    class MainAurora:
        def run(self, sql, **kwargs):
            main_calls.append((sql, kwargs))
            if "pg_try_advisory_lock" in sql:
                return [(True,)]
            if "SELECT account_id, region, resource_id" in sql:
                return [
                    ("self", "ap-northeast-2", "old-good"),
                    ("self", "ap-northeast-2", "old-missing-from-partial"),
                ]
            return []

        def close(self):
            pass

    class FinalizerAurora:
        def run(self, sql, **kwargs):
            finalizer_calls.append((sql, kwargs))
            return [(1,)]

        def close(self):
            pass

    connections = iter([MainAurora(), FinalizerAurora()])
    monkeypatch.setattr(mod, "_aurora", lambda: next(connections))
    monkeypatch.setattr(mod, "_rec_account", lambda rec: "self")
    monkeypatch.setattr(mod, "_self_count", lambda recs: len(recs))
    mod.SDK_SYNCS["sdk_partial_test"] = lambda: (
        [{"id": "new-good", "region": "ap-northeast-2"}],
        "id",
        "region",
        {
            "failure_count": 1,
            "failure_types": ["ClientError:AccessDenied"],
            "unknown_attribute_count": 2,
        },
    )
    mod._ALLOWED.add("sdk_partial_test")

    result = mod.sync("sdk_partial_test")

    assert result == {
        "status": "partial",
        "type": "sdk_partial_test",
        "row_count": 1,
        "failure_count": 1,
        "failure_types": ["ClientError:AccessDenied"],
        "unknown_attribute_count": 2,
    }
    assert any("INSERT INTO inventory_resources" in sql for sql, _ in main_calls)
    assert mod.PHASE1_PRUNE_SQL not in [sql for sql, _ in main_calls]
    assert not any("DELETE FROM inventory_resources" in sql for sql, _ in main_calls)
    assert not any("inventory_snapshots" in sql for sql, _ in main_calls)
    assert len(finalizer_calls) == 1
    assert "SET status='partial'" in finalizer_calls[0][0]
    assert "unknown_attribute_count=:u" in finalizer_calls[0][0]
    assert finalizer_calls[0][1]["u"] == 2
    assert "last_success_at" not in finalizer_calls[0][0]
    assert "last_success_row_count" not in finalizer_calls[0][0]

    output = capsys.readouterr().out
    terminal = [json.loads(line) for line in output.splitlines()]
    assert terminal == [{
        "event": "inventory_sync_complete",
        "resource_type": "sdk_partial_test",
        "row_count": 1,
        "failure_count": 1,
        "failure_types": ["ClientError:AccessDenied"],
        "unknown_attribute_count": 2,
        "degraded": True,
        "throttled": False,
        "freshness": "degraded",
        "age_minutes": None,
        "elapsed_ms": terminal[0]["elapsed_ms"],
    }]
    assert "supersecret" not in output
    assert "old-missing-from-partial" not in output


def test_failure_label_is_throttling_matches_structured_code_suffix():
    """Loose substring matching on a safe label would miss the structured throttle codes."""
    mod = load_sync_lambda()

    assert mod._failure_label_is_throttling("ClientError:TooManyRequestsException") is True
    assert mod._failure_label_is_throttling("ClientError:RequestLimitExceeded") is True
    assert mod._failure_label_is_throttling("ClientError:SlowDown") is True
    assert mod._failure_label_is_throttling("ClientError:AccessDenied") is False
    assert mod._failure_label_is_throttling("UnsupportedApi") is False


def test_sync_partial_marks_throttled_from_structured_failure_label(capsys, monkeypatch):
    """A throttle-coded SDK sub-call failure must set the partial run's throttled telemetry."""
    mod = load_sync_lambda()

    class MainAurora:
        def run(self, sql, **kwargs):
            if "pg_try_advisory_lock" in sql:
                return [(True,)]
            return []

        def close(self):
            pass

    class FinalizerAurora:
        def run(self, sql, **kwargs):
            return [(1,)]

        def close(self):
            pass

    connections = iter([MainAurora(), FinalizerAurora()])
    monkeypatch.setattr(mod, "_aurora", lambda: next(connections))
    monkeypatch.setattr(mod, "_rec_account", lambda rec: "self")
    monkeypatch.setattr(mod, "_self_count", lambda recs: len(recs))
    mod.SDK_SYNCS["sdk_partial_throttle_test"] = lambda: (
        [{"id": "new-good", "region": "ap-northeast-2"}],
        "id",
        "region",
        {
            "failure_count": 1,
            "failure_types": ["ClientError:TooManyRequestsException"],
            "unknown_attribute_count": 0,
        },
    )
    mod._ALLOWED.add("sdk_partial_throttle_test")

    mod.sync("sdk_partial_throttle_test")

    terminal = [
        json.loads(line) for line in capsys.readouterr().out.splitlines()
        if json.loads(line)["event"] == "inventory_sync_complete"
    ]
    assert len(terminal) == 1
    assert terminal[0]["failure_types"] == ["ClientError:TooManyRequestsException"]
    assert terminal[0]["throttled"] is True
    assert terminal[0]["degraded"] is True
    assert terminal[0]["freshness"] == "degraded"


def test_sync_partial_account_omission_preserves_last_good_and_logs_only_count(
    capsys, monkeypatch
):
    """An expected account that answers neither the aggregate query nor its own probe makes the
    run partial: preserve its old rows/last-success state and disclose only an unreachable count."""
    mod = load_sync_lambda()
    mod._ACCOUNT_CACHE["id"] = "111111111111"
    main_calls = []
    finalizer_calls = []

    class MainAurora:
        last_success_at = "prior-success"
        last_success_row_count = 7

        def run(self, sql, **kwargs):
            main_calls.append((sql, kwargs))
            if "pg_try_advisory_lock" in sql:
                return [(True,)]
            if "last_success_at=now()" in sql or "last_success_at=NULL" in sql:
                self.last_success_at = "overwritten"
            if "last_success_row_count=:n" in sql or "last_success_row_count=NULL" in sql:
                self.last_success_row_count = "overwritten"
            if "SELECT account_id, region, resource_id" in sql:
                return [
                    ("self", "ap-northeast-2", "old-host"),
                    ("222222222222", "ap-northeast-2", "last-good-target"),
                ]
            return []

        def close(self):
            pass

    class FinalizerAurora:
        def run(self, sql, **kwargs):
            finalizer_calls.append((sql, kwargs))
            return [(1,)]

        def close(self):
            pass

    class FakeSteampipe:
        columns = [
            {"name": "id"},
            {"name": "region"},
            {"name": "account_id"},
        ]

        def run(self, sql):
            return [("new-host", "ap-northeast-2", "111111111111")]

        def close(self):
            pass

    adb = MainAurora()
    connections = iter([adb, FinalizerAurora()])
    monkeypatch.setattr(mod, "_aurora", lambda: next(connections))
    monkeypatch.setattr(mod, "_steampipe", FakeSteampipe)
    monkeypatch.setattr(mod, "_enabled_target_accounts", lambda adb: ["222222222222"])
    monkeypatch.setattr(mod, "_account_reachable", lambda account_id: False)
    mod.QUERIES["partial_account_test"] = ("SELECT id, region, account_id", "id", "region")
    mod._ALLOWED.add("partial_account_test")

    result = mod.sync("partial_account_test")

    assert result == {
        "status": "partial",
        "type": "partial_account_test",
        "row_count": 1,
        "unreachable_account_count": 1,
    }
    partial_updates = [
        (sql, params) for sql, params in finalizer_calls
        if "UPDATE inventory_sync_runs SET status='partial'" in sql
    ]
    assert len(partial_updates) == 1
    assert "last_success_at" not in partial_updates[0][0]
    assert "last_success_row_count" not in partial_updates[0][0]
    assert not any(
        "SET status='partial'" in sql or "SET status='succeeded'" in sql
        for sql, _ in main_calls
    )
    assert adb.last_success_at == "prior-success"
    assert adb.last_success_row_count == 7
    assert not any(
        "DELETE FROM inventory_resources" in sql
        and params.get("acct") == "222222222222"
        for sql, params in main_calls
    )

    output = capsys.readouterr().out
    terminal = [
        json.loads(line) for line in output.splitlines()
        if json.loads(line)["event"] == "inventory_sync_complete"
    ]
    assert terminal == [{
        "event": "inventory_sync_complete",
        "resource_type": "partial_account_test",
        "row_count": 1,
        "unreachable_account_count": 1,
        "degraded": True,
        "throttled": False,
        "freshness": "degraded",
        "age_minutes": None,
        "elapsed_ms": terminal[0]["elapsed_ms"],
    }]
    assert "111111111111" not in output
    assert "222222222222" not in output


def test_zero_row_success_is_durable_across_later_failure(capsys, monkeypatch):
    """A genuine empty successful inventory must retain its success timestamp/count after a later
    running/failed overwrite, after every expected aggregator account proves reachable."""
    mod = load_sync_lambda()

    finalizer_calls = []

    class MainAurora:
        def __init__(self):
            self.sql_log = []

        def run(self, sql, **kwargs):
            self.sql_log.append((sql, kwargs))
            if "pg_try_advisory_lock" in sql:
                return [(True,)]
            if "SELECT account_id, region, resource_id" in sql:
                return []
            return []

        def close(self):
            pass

    class FinalizerAurora:
        def run(self, sql, **kwargs):
            finalizer_calls.append((sql, kwargs))
            return [(1,)]

        def close(self):
            pass

    first_main = MainAurora()
    first_finalizer = FinalizerAurora()
    second_main = MainAurora()
    second_finalizer = FinalizerAurora()
    connections = iter([first_main, first_finalizer, second_main, second_finalizer])
    monkeypatch.setattr(mod, "_aurora", lambda: next(connections))
    monkeypatch.setattr(mod, "_self_count", lambda recs: len(recs))
    monkeypatch.setattr(mod, "_enabled_target_accounts", lambda adb: ["222222222222"])
    reachable = []

    def account_reachable(account_id):
        reachable.append(account_id)
        return True

    monkeypatch.setattr(mod, "_account_reachable", account_reachable)
    aggregate_attempts = iter([[], RuntimeError("later collection failure")])

    class FakeSteampipe:
        columns = [
            {"name": "id"},
            {"name": "region"},
            {"name": "account_id"},
        ]

        def run(self, sql):
            value = next(aggregate_attempts)
            if isinstance(value, Exception):
                raise value
            return value

        def close(self):
            pass

    monkeypatch.setattr(mod, "_steampipe", FakeSteampipe)
    mod._ACCOUNT_CACHE["id"] = "111111111111"
    mod.QUERIES["zero_row_history_test"] = (
        "SELECT id, region, account_id",
        "id",
        "region",
    )
    mod._ALLOWED.add("zero_row_history_test")

    first = mod.sync("zero_row_history_test")
    second = mod.sync("zero_row_history_test")
    capsys.readouterr()

    assert first == {
        "status": "succeeded",
        "type": "zero_row_history_test",
        "row_count": 0,
        "unknown_attribute_count": 0,
    }
    assert second["status"] == "failed"
    assert reachable == ["111111111111", "222222222222"]
    assert not any(
        "SET status='succeeded'" in sql or "SET status='failed'" in sql
        for sql, _ in first_main.sql_log + second_main.sql_log
    )
    succeeded = [
        (sql, params) for sql, params in finalizer_calls
        if "SET status='succeeded'" in sql
    ]
    assert len(succeeded) == 1
    assert "last_success_at=now()" in succeeded[0][0]
    assert "last_success_row_count=:n" in succeeded[0][0]
    assert succeeded[0][1]["n"] == 0
    failed = [
        sql for sql, _ in finalizer_calls
        if "SET status='failed'" in sql
    ]
    assert len(failed) == 1
    assert "last_success_at" not in failed[0]
    assert "last_success_row_count" not in failed[0]


def test_sync_failure_logs_one_terminal_record_with_bounded_error(capsys, monkeypatch):
    """A raw work exception in logs, the Lambda result, or the ledger error column would
    expose sensitive query or credential text. All three sinks carry only the bounded
    category+type label."""
    mod = load_sync_lambda()

    ledger_writes = []

    class FakeAurora:
        def run(self, sql, **kwargs):
            if "status='failed'" in sql:
                ledger_writes.append(kwargs)
            if "pg_try_advisory_lock" in sql:
                return [(True,)]
            if "RETURNING 1" in sql:
                return [(1,)]
            return []

        def close(self):
            pass

    failure = "password=supersecret SELECT * FROM inventory_resources " + "x" * 400
    monkeypatch.setattr(mod, "_aurora", FakeAurora)
    mod.SDK_SYNCS["log_test_failure"] = lambda: (_ for _ in ()).throw(RuntimeError(failure))
    mod._ALLOWED.add("log_test_failure")

    result = mod.sync("log_test_failure")

    output = capsys.readouterr().out
    records = [json.loads(line) for line in output.splitlines()]
    terminal = [record for record in records if record["event"].startswith("inventory_sync_") and
                record["event"] != "inventory_sync_dispatch"]
    assert result == {
        "status": "failed",
        "type": "log_test_failure",
        "error": "sync failed: RuntimeError",
    }
    assert "supersecret" not in json.dumps(result)
    assert ledger_writes
    assert ledger_writes[-1]["e"] == "sync failed: RuntimeError"
    assert "supersecret" not in ledger_writes[-1]["e"]
    assert len(terminal) == 1
    assert terminal[0]["event"] == "inventory_sync_failed"
    assert terminal[0]["resource_type"] == "log_test_failure"
    assert terminal[0]["error_category"] == "sync"
    assert terminal[0]["error"] == "inventory sync failed"
    assert terminal[0]["error_type"] == "RuntimeError"
    assert terminal[0]["degraded"] is True
    assert terminal[0]["throttled"] is False
    assert isinstance(terminal[0]["elapsed_ms"], int)
    assert "supersecret" not in output


def test_sync_failure_marks_clienterror_throttling_without_logging_raw_error(capsys, monkeypatch):
    """Throttling state must come from structured exception metadata, never raw exception text."""
    mod = load_sync_lambda()

    class FakeAurora:
        def run(self, sql, **kwargs):
            if "pg_try_advisory_lock" in sql:
                return [(True,)]
            if "RETURNING 1" in sql:
                return [(1,)]
            return []

        def close(self):
            pass

    secret = "credential=supersecret"
    throttled = ClientError(
        {"Error": {"Code": "ThrottlingException", "Message": secret}},
        "DescribeInstances",
    )
    monkeypatch.setattr(mod, "_aurora", FakeAurora)
    mod.SDK_SYNCS["log_test_throttled"] = (
        lambda: (_ for _ in ()).throw(throttled)
    )
    mod._ALLOWED.add("log_test_throttled")

    mod.sync("log_test_throttled")

    output = capsys.readouterr().out
    terminal = [
        json.loads(line) for line in output.splitlines()
        if json.loads(line)["event"] == "inventory_sync_failed"
    ]
    assert len(terminal) == 1
    assert terminal[0]["degraded"] is True
    assert terminal[0]["throttled"] is True
    assert terminal[0]["error_type"] == "ClientError"
    assert secret not in output


def test_sync_busy_logs_one_terminal_record(capsys, monkeypatch):
    """A lock-contention return without a terminal log would conceal backpressure events."""
    mod = load_sync_lambda()

    class FakeAurora:
        def run(self, sql, **kwargs):
            if "pg_try_advisory_lock" in sql:
                return [(False,)]
            return []

        def close(self):
            pass

    monkeypatch.setattr(mod, "_aurora", FakeAurora)

    result = mod.sync("ec2")

    records = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert result == {"status": "busy", "type": "ec2"}
    assert records == [{
        "event": "inventory_sync_busy",
        "resource_type": "ec2",
        "degraded": True,
        "throttled": False,
        "elapsed_ms": records[0]["elapsed_ms"],
    }]
    assert isinstance(records[0]["elapsed_ms"], int)


def _terminal_records(capsys):
    records = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    return [
        record for record in records
        if record["event"] in {
            "inventory_sync_busy",
            "inventory_sync_complete",
            "inventory_sync_failed",
        }
    ]


def test_sync_logs_one_safe_failure_when_aurora_connection_fails(capsys, monkeypatch):
    """Moving _aurora outside the lifecycle catch would leave connection failures unlogged."""
    mod = load_sync_lambda()
    secret = "postgres://operator:supersecret@example.com:5432/awsops"

    def fail_connect():
        raise RuntimeError(f"connection refused {secret}")

    monkeypatch.setattr(mod, "_aurora", fail_connect)

    result = mod.sync("ec2")

    terminal = _terminal_records(capsys)
    assert result == {"status": "failed", "type": "ec2", "error": "inventory sync failed"}
    assert terminal == [{
        "event": "inventory_sync_failed",
        "resource_type": "ec2",
        "error_category": "lifecycle",
        "error": "inventory sync failed",
        "error_type": "RuntimeError",
        "degraded": True,
        "throttled": False,
        "elapsed_ms": terminal[0]["elapsed_ms"],
    }]
    assert isinstance(terminal[0]["elapsed_ms"], int)
    assert secret not in json.dumps(terminal)


def test_sync_logs_one_safe_failure_when_lock_acquisition_fails(capsys, monkeypatch):
    """An advisory-lock exception must not bypass the single terminal lifecycle record."""
    mod = load_sync_lambda()
    secret = "SELECT pg_try_advisory_lock(password='supersecret')"

    class FakeAurora:
        def run(self, sql, **kwargs):
            if "pg_try_advisory_lock" in sql:
                raise ValueError(secret)
            return []

        def close(self):
            pass

    monkeypatch.setattr(mod, "_aurora", FakeAurora)

    result = mod.sync("ec2")

    terminal = _terminal_records(capsys)
    assert result == {"status": "failed", "type": "ec2", "error": "inventory sync failed"}
    assert terminal[0]["event"] == "inventory_sync_failed"
    assert terminal[0]["error_category"] == "lifecycle"
    assert terminal[0]["error"] == "inventory sync failed"
    assert terminal[0]["error_type"] == "ValueError"
    assert terminal[0]["degraded"] is True
    assert terminal[0]["throttled"] is False
    assert len(terminal) == 1
    assert secret not in json.dumps(terminal)


def test_sync_logs_work_failure_when_failure_ledger_write_fails(capsys, monkeypatch):
    """A failed ledger update must not replace or suppress the original terminal failure."""
    mod = load_sync_lambda()
    work_secret = "work failure SELECT * FROM credentials WHERE token='supersecret'"
    ledger_secret = "ledger failure password=supersecret"

    connections = []

    class FakeAurora:
        def __init__(self):
            self.sql_log = []
            connections.append(self)

        def run(self, sql, **kwargs):
            self.sql_log.append((sql, kwargs))
            if "pg_try_advisory_lock" in sql:
                return [(True,)]
            if "SET status='failed'" in sql:
                raise RuntimeError(ledger_secret)
            return []

        def close(self):
            pass

    monkeypatch.setattr(mod, "_aurora", FakeAurora)
    mod.SDK_SYNCS["log_test_ledger_failure"] = (
        lambda: (_ for _ in ()).throw(ValueError(work_secret))
    )
    mod._ALLOWED.add("log_test_ledger_failure")

    result = mod.sync("log_test_ledger_failure")

    terminal = _terminal_records(capsys)
    assert result == {
        "status": "failed",
        "type": "log_test_ledger_failure",
        "error": "sync failed: ValueError",
    }
    assert terminal[0]["event"] == "inventory_sync_failed"
    assert terminal[0]["error_category"] == "sync"
    assert terminal[0]["error"] == "inventory sync failed"
    assert terminal[0]["error_type"] == "ValueError"
    assert terminal[0]["degraded"] is True
    assert terminal[0]["throttled"] is False
    assert len(terminal) == 1
    output = json.dumps(terminal)
    assert work_secret not in output
    assert ledger_secret not in output
    assert len(connections) == 2
    assert not any(
        "SET status='failed'" in sql
        for sql, _ in connections[0].sql_log
    )
    assert any(
        "SET status='failed'" in sql
        and "last_success_at" not in sql
        and "last_success_row_count" not in sql
        for sql, _ in connections[1].sql_log
    )


@pytest.mark.parametrize(
    ("cleanup", "error_type"),
    [("unlock", "RuntimeError"), ("close", "OSError")],
)
def test_sync_cleanup_failure_replaces_success_with_one_safe_terminal_failure(
    capsys, monkeypatch, cleanup, error_type
):
    """Logging complete before unlock/close would report success for an incomplete lifecycle."""
    mod = load_sync_lambda()
    secret = f"{cleanup} failure password=supersecret SELECT * FROM inventory_sync_runs"

    main_calls = []
    finalizer_calls = []

    class MainAurora:
        def run(self, sql, **kwargs):
            main_calls.append((sql, kwargs))
            if "pg_try_advisory_lock" in sql:
                return [(True,)]
            if cleanup == "unlock" and "pg_advisory_unlock" in sql:
                raise RuntimeError(secret)
            return []

        def close(self):
            if cleanup == "close":
                raise OSError(secret)

    class FinalizerAurora:
        def run(self, sql, **kwargs):
            finalizer_calls.append((sql, kwargs))
            return [(1,)]

        def close(self):
            pass

    connections = iter([MainAurora(), FinalizerAurora()])
    monkeypatch.setattr(mod, "_aurora", lambda: next(connections))
    monkeypatch.setattr(mod, "_rec_account", lambda rec: "self")
    monkeypatch.setattr(mod, "_self_count", lambda recs: len(recs))
    mod.SDK_SYNCS["log_test_cleanup_failure"] = (
        lambda: ([{"id": "r-1", "region": "ap-northeast-2"}], "id", "region")
    )
    mod._ALLOWED.add("log_test_cleanup_failure")

    result = mod.sync("log_test_cleanup_failure")

    terminal = _terminal_records(capsys)
    assert result == {
        "status": "failed",
        "type": "log_test_cleanup_failure",
        "error": "inventory sync cleanup failed",
    }
    assert terminal[0]["event"] == "inventory_sync_failed"
    assert terminal[0]["error_category"] == "cleanup"
    assert terminal[0]["error"] == "inventory sync cleanup failed"
    assert terminal[0]["error_type"] == error_type
    assert len(terminal) == 1
    assert secret not in json.dumps(terminal)
    assert not any(
        "SET status='succeeded'" in sql or "SET status='failed'" in sql
        for sql, _ in main_calls
    )
    failed_updates = [
        sql for sql, _ in finalizer_calls
        if "SET status='failed'" in sql
    ]
    assert len(failed_updates) == 1
    assert "last_success_at" not in failed_updates[0]
    assert "last_success_row_count" not in failed_updates[0]


def test_main_close_failure_uses_fresh_finalizer_after_connection_becomes_unusable(
    capsys, monkeypatch
):
    """A close failure can poison the work connection; success must never be issued there, and a
    separate connection must finalize failed without advancing durable last-success fields."""
    mod = load_sync_lambda()
    main_calls = []
    finalizer_calls = []
    ledger = {
        "status": "succeeded",
        "last_success_at": "prior-success",
        "last_success_row_count": 9,
    }

    class MainAurora:
        def __init__(self):
            self.usable = True
            self.close_attempted = False

        def run(self, sql, **kwargs):
            if not self.usable:
                raise RuntimeError("main connection is unusable")
            main_calls.append((sql, kwargs))
            if "pg_try_advisory_lock" in sql:
                return [(True,)]
            if "INSERT INTO inventory_sync_runs" in sql:
                ledger["status"] = "running"
            if "SELECT account_id, region, resource_id" in sql:
                return []
            return []

        def close(self):
            self.close_attempted = True
            self.usable = False
            raise OSError("close failed password=supersecret")

    class FinalizerAurora:
        def run(self, sql, **kwargs):
            finalizer_calls.append((sql, kwargs))
            if "SET status='failed'" in sql:
                ledger["status"] = "failed"
            return [(1,)]

        def close(self):
            pass

    main = MainAurora()
    connection_count = 0

    def aurora_factory():
        nonlocal connection_count
        connection_count += 1
        if connection_count == 1:
            return main
        assert main.close_attempted is True
        assert main.usable is False
        return FinalizerAurora()

    monkeypatch.setattr(mod, "_aurora", aurora_factory)
    monkeypatch.setattr(mod, "_rec_account", lambda rec: "self")
    monkeypatch.setattr(mod, "_self_count", lambda recs: len(recs))
    mod.SDK_SYNCS["close_finalizer_test"] = (
        lambda: ([{"id": "r-1", "region": "ap-northeast-2"}], "id", "region")
    )
    mod._ALLOWED.add("close_finalizer_test")

    result = mod.sync("close_finalizer_test")
    terminal = _terminal_records(capsys)

    assert result == {
        "status": "failed",
        "type": "close_finalizer_test",
        "error": "inventory sync cleanup failed",
    }
    assert main.usable is False
    assert ledger == {
        "status": "failed",
        "last_success_at": "prior-success",
        "last_success_row_count": 9,
    }
    assert not any(
        "SET status='succeeded'" in sql or "SET status='failed'" in sql
        for sql, _ in main_calls
    )
    assert len(finalizer_calls) == 1
    assert "SET status='failed'" in finalizer_calls[0][0]
    assert "last_success_at" not in finalizer_calls[0][0]
    assert "last_success_row_count" not in finalizer_calls[0][0]
    assert terminal[0]["event"] == "inventory_sync_failed"
    assert terminal[0]["error_category"] == "cleanup"
    assert "supersecret" not in json.dumps(terminal)


def test_finalizer_write_failure_leaves_running_without_false_success(capsys, monkeypatch):
    """If the fresh finalizer cannot write, the main connection must have issued no terminal update,
    so the durable row remains running with its previous last-success fields."""
    mod = load_sync_lambda()
    main_calls = []
    finalizer_calls = []
    ledger = {
        "status": "succeeded",
        "last_success_at": "prior-success",
        "last_success_row_count": 4,
    }

    class MainAurora:
        def run(self, sql, **kwargs):
            main_calls.append((sql, kwargs))
            if "pg_try_advisory_lock" in sql:
                return [(True,)]
            if "INSERT INTO inventory_sync_runs" in sql:
                ledger["status"] = "running"
            if "SELECT account_id, region, resource_id" in sql:
                return []
            return []

        def close(self):
            pass

    class FinalizerAurora:
        def run(self, sql, **kwargs):
            finalizer_calls.append((sql, kwargs))
            raise RuntimeError("finalizer password=supersecret")

        def close(self):
            pass

    connections = iter([MainAurora(), FinalizerAurora()])
    monkeypatch.setattr(mod, "_aurora", lambda: next(connections))
    monkeypatch.setattr(mod, "_rec_account", lambda rec: "self")
    monkeypatch.setattr(mod, "_self_count", lambda recs: len(recs))
    mod.SDK_SYNCS["finalizer_write_failure_test"] = (
        lambda: ([{"id": "r-1", "region": "ap-northeast-2"}], "id", "region")
    )
    mod._ALLOWED.add("finalizer_write_failure_test")

    result = mod.sync("finalizer_write_failure_test")
    terminal = _terminal_records(capsys)

    assert result["status"] == "failed"
    assert ledger == {
        "status": "running",
        "last_success_at": "prior-success",
        "last_success_row_count": 4,
    }
    assert not any(
        "SET status='succeeded'" in sql or "SET status='failed'" in sql
        for sql, _ in main_calls
    )
    assert len(finalizer_calls) == 1
    assert "SET status='succeeded'" in finalizer_calls[0][0]
    assert len(terminal) == 1
    assert terminal[0]["event"] == "inventory_sync_failed"
    assert "supersecret" not in json.dumps(terminal)


def test_stale_finalizer_cannot_overwrite_newer_run(capsys, monkeypatch):
    """Run B can acquire the released lock and finalize before run A opens its fresh finalizer;
    A's token must then lose the CAS without changing B's row or leaking ownership identifiers."""
    mod = load_sync_lambda()
    token_a = "a" * 32
    token_b = "b" * 32
    sensitive_account = "222222222222"
    tokens = iter([token_a, token_b])
    ledger = {
        "status": "succeeded",
        "run_token": "prior",
        "row_count": 9,
        "last_success_row_count": 9,
    }
    running_tokens = []
    finalizer_calls = []
    nested_result = {}
    lock_held = False
    triggered = False
    collection_count = 0

    monkeypatch.setattr(
        mod, "_new_run_token", lambda: next(tokens), raising=False
    )
    monkeypatch.setattr(mod, "_rec_account", lambda rec: "self")
    monkeypatch.setattr(mod, "_self_count", lambda recs: len(recs))

    def fetch_inventory():
        nonlocal collection_count
        collection_count += 1
        rows = [
            {
                "id": f"r-{collection_count}-{index}",
                "region": "ap-northeast-2",
                "account_id": sensitive_account,
            }
            for index in range(collection_count)
        ]
        return rows, "id", "region"

    mod.SDK_SYNCS["cas_interleaving_test"] = fetch_inventory
    mod._ALLOWED.add("cas_interleaving_test")

    class MainAurora:
        def __init__(self, trigger_b=False):
            self.trigger_b = trigger_b

        def run(self, sql, **kwargs):
            nonlocal lock_held
            if "pg_try_advisory_lock" in sql:
                assert lock_held is False
                lock_held = True
                return [(True,)]
            if "INSERT INTO inventory_sync_runs" in sql:
                ledger.update(
                    status="running",
                    run_token=kwargs.get("run_token"),
                    row_count=None,
                )
                running_tokens.append(kwargs.get("run_token"))
            if "SELECT account_id, region, resource_id" in sql:
                return []
            if "pg_advisory_unlock" in sql:
                assert lock_held is True
                lock_held = False
                return [(True,)]
            return []

        def close(self):
            nonlocal triggered
            if self.trigger_b and not triggered:
                triggered = True
                nested_result["value"] = mod.sync("cas_interleaving_test")

    class FinalizerAurora:
        def __init__(self, name):
            self.name = name

        def run(self, sql, **kwargs):
            finalizer_calls.append((self.name, sql, kwargs))
            has_cas = (
                "run_token=:run_token" in sql
                and "RETURNING 1" in sql
            )
            if has_cas and ledger["run_token"] != kwargs.get("run_token"):
                return []
            if "SET status='succeeded'" in sql:
                ledger.update(
                    status="succeeded",
                    row_count=kwargs["n"],
                    last_success_row_count=kwargs["n"],
                )
            elif "SET status='partial'" in sql:
                ledger.update(status="partial", row_count=kwargs["n"])
            elif "SET status='failed'" in sql:
                ledger.update(status="failed", row_count=kwargs["n"])
            return [(1,)]

        def close(self):
            pass

    connections = iter([
        MainAurora(trigger_b=True),
        MainAurora(),
        FinalizerAurora("B"),
        FinalizerAurora("A"),
    ])
    monkeypatch.setattr(mod, "_aurora", lambda: next(connections))

    result = mod.sync("cas_interleaving_test")
    records = _terminal_records(capsys)

    assert nested_result["value"] == {
        "status": "succeeded",
        "type": "cas_interleaving_test",
        "row_count": 2,
        "unknown_attribute_count": 0,
    }
    assert result == {
        "status": "failed",
        "type": "cas_interleaving_test",
        "error": "inventory sync superseded",
    }
    assert running_tokens == [token_a, token_b]
    assert ledger == {
        "status": "succeeded",
        "run_token": token_b,
        "row_count": 2,
        "last_success_row_count": 2,
    }
    assert [name for name, _, _ in finalizer_calls] == ["B", "A"]
    assert records[-1]["event"] == "inventory_sync_failed"
    assert records[-1]["error_category"] == "superseded"
    assert records[-1]["error"] == "inventory sync superseded"
    assert records[-1]["degraded"] is True
    assert records[-1]["throttled"] is False
    output = json.dumps(records)
    assert token_a not in output
    assert token_b not in output
    assert sensitive_account not in output


def test_finalizer_close_failure_does_not_downgrade_committed_success(capsys, monkeypatch):
    """Once the fresh connection commits the terminal update, its close is best-effort."""
    mod = load_sync_lambda()
    finalizer_calls = []

    class MainAurora:
        def run(self, sql, **kwargs):
            if "pg_try_advisory_lock" in sql:
                return [(True,)]
            if "SELECT account_id, region, resource_id" in sql:
                return []
            return []

        def close(self):
            pass

    class FinalizerAurora:
        def run(self, sql, **kwargs):
            finalizer_calls.append((sql, kwargs))
            return [(1,)]

        def close(self):
            raise OSError("best-effort close failed password=supersecret")

    connections = iter([MainAurora(), FinalizerAurora()])
    monkeypatch.setattr(mod, "_aurora", lambda: next(connections))
    monkeypatch.setattr(mod, "_rec_account", lambda rec: "self")
    monkeypatch.setattr(mod, "_self_count", lambda recs: len(recs))
    mod.SDK_SYNCS["finalizer_close_failure_test"] = (
        lambda: ([{"id": "r-1", "region": "ap-northeast-2"}], "id", "region")
    )
    mod._ALLOWED.add("finalizer_close_failure_test")

    result = mod.sync("finalizer_close_failure_test")
    terminal = _terminal_records(capsys)

    assert result == {
        "status": "succeeded",
        "type": "finalizer_close_failure_test",
        "row_count": 1,
        "unknown_attribute_count": 0,
    }
    assert len(finalizer_calls) == 1
    assert "SET status='succeeded'" in finalizer_calls[0][0]
    assert len(terminal) == 1
    assert terminal[0]["event"] == "inventory_sync_complete"
    assert "supersecret" not in json.dumps(terminal)


@pytest.mark.parametrize(
    "termination",
    [KeyboardInterrupt("stop"), SystemExit(73)],
)
def test_sync_reraises_base_exception_after_best_effort_cleanup_without_terminal_log(
    capsys, monkeypatch, termination
):
    """A BaseException must not be replaced by lifecycle logging or cleanup errors."""
    mod = load_sync_lambda()
    cleanup = []

    class FakeAurora:
        def run(self, sql, **kwargs):
            if "pg_try_advisory_lock" in sql:
                return [(True,)]
            if "pg_advisory_unlock" in sql:
                cleanup.append("unlock")
            return []

        def close(self):
            cleanup.append("close")

    def raise_termination():
        raise termination

    monkeypatch.setattr(mod, "_aurora", FakeAurora)
    mod.SDK_SYNCS["log_test_base_exception"] = raise_termination
    mod._ALLOWED.add("log_test_base_exception")

    with pytest.raises(type(termination)) as caught:
        mod.sync("log_test_base_exception")

    assert caught.value is termination
    assert cleanup == ["unlock", "close"]
    assert capsys.readouterr().out == ""
def test_cloudtrail_query_carries_the_l189_delivery_columns():
    """Gap L189: CW-Logs/digest delivery + stop_logging_time detail fields (all present in the
    pinned plugin aws@0.142.0)."""
    mod = load_sync_lambda()
    sql = mod.QUERIES["cloudtrail"][0]
    for col in (
        "cloudwatch_logs_role_arn", "latest_cloudwatch_logs_delivery_time",
        "latest_cloudwatch_logs_delivery_error", "latest_digest_delivery_time",
        "latest_digest_delivery_error", "stop_logging_time",
    ):
        assert col in sql, col
