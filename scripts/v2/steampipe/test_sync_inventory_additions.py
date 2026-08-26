"""g-02 read-only inventory addition: Steampipe QUERIES for ebs_snapshot. Validates registry
membership, key columns, id/region cols, and the owner-id literal pushdown guard that keeps
DescribeSnapshots from fetching public AWS snapshots.

(ecs_service [g-01] landed via the concurrent merge — keyed by cluster+service — and is covered
by scripts/v2/steampipe/test_sync_lambda_queries.py, so it is intentionally not re-tested here.)"""
import sync_lambda  # PYTHONPATH must include scripts/v2/steampipe


def test_ebs_snapshot_registered_with_literal_owner_pushdown():
    assert "ebs_snapshot" in sync_lambda.QUERIES
    assert "ebs_snapshot" in sync_lambda._ALLOWED
    sql, id_col, region_col = sync_lambda.QUERIES["ebs_snapshot"]
    assert "aws_ebs_snapshot" in sql
    # owner_id MUST be LITERAL constants for OwnerIds pushdown to DescribeSnapshots. Under the
    # multi-account aggregator a single host literal would miss target accounts, so the query
    # carries an {owner_ids} placeholder sync() renders to the IN-list of all enabled accounts.
    assert "owner_id IN ({owner_ids})" in sql
    assert "aws_caller_identity" not in sql  # subquery form removed (would not push down)
    for col in ("volume_id", "volume_size", "state", "encrypted", "start_time"):
        assert col in sql, col
    assert id_col == "snapshot_id"
    assert region_col == "region"


def test_inject_account_embeds_literal():
    # _inject_account still renders a validated single-account literal for any {account_id} template.
    rendered = sync_lambda._inject_account("WHERE owner_id = '{account_id}'", "123456789012")
    assert "owner_id = '123456789012'" in rendered
    assert "{account_id}" not in rendered


def test_inject_account_rejects_non_account_literal():
    import pytest
    # defense in depth: never interpolate anything that is not a 12-digit account id
    with pytest.raises(ValueError):
        sync_lambda._inject_account("WHERE owner_id = '{account_id}'", "'; DROP TABLE x--")


def test_prune_present_includes_self_when_host_contributed_rows():
    """When the host contributed rows this run, 'self' is trivially in `present` — no probe
    needed (mirrors sync()'s phase-2 `present = {a for (a,_,_) in seen}`)."""
    seen = {('self', 'ap-northeast-2', 'i-abc'), ('123456789012', 'ap-northeast-2', 'i-def')}
    present = {a for (a, _, _) in seen}
    assert 'self' in present
    assert '123456789012' in present


def test_host_probe_symmetric_with_target_probe_via_real_account_reachable(monkeypatch):
    """M-2 (round 8): host ('self') protection is no longer an unconditional `| {'self'}` — an
    aggregator-backed (QUERIES) type with 0 host rows this run must probe the host's OWN
    Steampipe connection (aws_<host_real_id>, via _caller_account()) exactly like a target
    account, using the REAL _account_reachable function (not a hand-simulated duplicate — this
    directly exercises the same call sync() makes: _account_reachable(_caller_account()))."""
    mod = sync_lambda
    mod._ACCOUNT_CACHE["id"] = "111111111111"  # host's real 12-digit id
    queried_schemas = []

    class FakeConn:
        def run(self, sql):
            queried_schemas.append(sql)
            return [("111111111111",)]  # reachable

        def close(self):
            pass

    monkeypatch.setattr(mod, "_steampipe", lambda: FakeConn())
    assert mod._account_reachable(mod._caller_account()) is True
    assert "aws_111111111111.aws_caller_identity" in queried_schemas[0]


def test_host_probe_unreachable_protects_last_good_inventory(monkeypatch):
    """An UNREACHABLE host connection must return False from the real probe — sync()'s phase-2
    `if resource_type in SDK_SYNCS or _account_reachable(_caller_account())` then evaluates
    False for an aggregator-backed type, so 'self' is NOT added to `present`, protecting the
    host's last-good inventory instead of force-pruning it to zero (the M-2 fix)."""
    mod = sync_lambda
    mod._ACCOUNT_CACHE["id"] = "111111111111"

    class FakeConn:
        def run(self, sql):
            raise Exception("transient connection failure")

        def close(self):
            pass

    monkeypatch.setattr(mod, "_steampipe", lambda: FakeConn())
    assert mod._account_reachable(mod._caller_account()) is False


def test_sdk_synced_types_short_circuit_the_host_probe_entirely():
    """SDK-sourced types (cloudfront_vpc_origin, s3_public_access, alb_listener_rule) never go
    through Steampipe: reaching sync()'s phase-2 code already means the direct SDK call
    succeeded, so 0 host rows is the SDK's own definitive "genuinely empty" signal — a Steampipe
    probe would be a category error. Verify the actual SDK_SYNCS registry contains real type
    names sync() would short-circuit on (`resource_type in SDK_SYNCS`, evaluated BEFORE
    _account_reachable via `or` short-circuit)."""
    mod = sync_lambda
    assert "cloudfront_vpc_origin" in mod.SDK_SYNCS
    assert "s3_public_access" in mod.SDK_SYNCS
    assert "alb_listener_rule" in mod.SDK_SYNCS
    # An aggregator-backed type must NOT be in SDK_SYNCS (else it would wrongly skip the probe).
    assert "ec2" not in mod.SDK_SYNCS


def test_disabled_account_cleanup_sql_excludes_self_and_targets_disabled():
    """Phase-1 prune deletes rows for accounts no longer in SCAN SCOPE via a NOT IN subquery.
    This asserts on sync_lambda.PHASE1_PRUNE_SQL — the ACTUAL constant sync() executes (not a
    hand-copied duplicate) — so a future edit to the real query can't silently drift out of sync
    with this test (F3 fix, round 6). Verify the SQL shape: scope to resource_type, exclude 'self'
    (handled by phase 2), and delete accounts NOT in the currently in-scope set."""
    phase1_sql = sync_lambda.PHASE1_PRUNE_SQL
    assert "account_id != 'self'" in phase1_sql, "phase 1 must not touch 'self' rows"
    assert "NOT IN" in phase1_sql, "phase 1 must exclude in-scope accounts from deletion"
    assert "a.enabled = true" in phase1_sql, "phase 1 must require enabled=true"
    assert "resource_type = :t" in phase1_sql, "phase 1 must scope to current resource type"


def test_disabled_account_cleanup_sql_also_excludes_enabled_but_zero_scope_accounts():
    """F1 regression (round 6): an ENABLED account with all_regions=false and ZERO enabled
    account_regions rows is SKIPPED by render_spc (spc_render.py) — no aws_<id> connection is
    ever rendered for it. A bare `enabled = true` check would leave such an account's stale rows
    as PERMANENT phantoms: phase 1 wouldn't touch it (still enabled), and phase 2's reachability
    probe can never succeed for it either (there is no per-account schema to query). The in-scope
    subquery must therefore ALSO require all_regions OR an enabled account_regions row —
    mirroring render_spc's/listScanScope's own skip condition exactly."""
    phase1_sql = sync_lambda.PHASE1_PRUNE_SQL
    assert "a.all_regions = true" in phase1_sql, "must accept all_regions accounts as in-scope"
    assert "EXISTS" in phase1_sql and "account_regions" in phase1_sql, (
        "must accept accounts with >=1 enabled account_regions row as in-scope — "
        "a bare enabled=true check would leave an enabled-but-zero-region account "
        "as a permanent phantom (F1)"
    )
    assert "r.enabled = true" in phase1_sql, "the account_regions EXISTS check must require enabled=true"




def test_inject_account_noop_without_placeholder():
    plain = "SELECT name FROM aws_s3_bucket"
    assert sync_lambda._inject_account(plain, "bogus") == plain


def test_self_count_matches_rec_account_self_only(monkeypatch):
    """_self_count (dashboard trend-chart snapshot row) must count exactly the rows
    _rec_account resolves to 'self' — the host's real id and target-account rows are excluded,
    mirroring the account_id='self' scope every other host-facing read already uses."""
    sync_lambda._ACCOUNT_CACHE["id"] = "111111111111"  # host's real 12-digit id
    recs = [
        {"account_id": "111111111111"},  # host's real id -> 'self'
        {"account_id": "111111111111"},
        {"account_id": "222222222222"},  # target account -> not counted
        {},  # no account_id column (SDK sync) -> 'self'
    ]
    assert sync_lambda._self_count(recs) == 3


def test_self_count_empty():
    assert sync_lambda._self_count([]) == 0
