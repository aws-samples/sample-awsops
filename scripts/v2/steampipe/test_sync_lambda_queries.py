import importlib.util
import sys
import types
from pathlib import Path


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
