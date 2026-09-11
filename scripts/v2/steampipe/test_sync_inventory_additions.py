"""g-02 read-only inventory addition: Steampipe QUERIES for ebs_snapshot. Validates registry
membership, key columns, id/region cols, and the owner-id literal pushdown guard that keeps
DescribeSnapshots from fetching public AWS snapshots.

(ecs_service [g-01] landed via the concurrent merge — keyed by cluster+service — and is covered
by scripts/v2/steampipe/test_sync_lambda_queries.py, so it is intentionally not re-tested here.)"""
import pytest

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

    monkeypatch.setattr(mod, "_steampipe", lambda *_a: FakeConn())
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

    monkeypatch.setattr(mod, "_steampipe", lambda *_a: FakeConn())
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


def test_account_counts_buckets_by_rec_account(monkeypatch):
    """_account_counts (dashboard trend-chart snapshot rows, gap L124) must bucket rows by
    _rec_account: the host's real id folds into 'self' (rows without the column too), target
    accounts keep their own 12-digit key — one snapshot row per account."""
    sync_lambda._ACCOUNT_CACHE["id"] = "111111111111"  # host's real 12-digit id
    recs = [
        {"account_id": "111111111111"},  # host's real id -> 'self'
        {"account_id": "111111111111"},
        {"account_id": "222222222222"},  # target account -> its own bucket
        {},  # no account_id column (SDK sync) -> 'self'
    ]
    assert sync_lambda._account_counts(recs) == {"self": 3, "222222222222": 1}


def test_account_counts_empty():
    assert sync_lambda._account_counts([]) == {}


class _FakeS3PolicyStatus:
    """Minimal boto3-s3 stand-in for _fetch_s3_security (gap L240: bucket_policy_is_public
    lands on the bucket row itself so the page's Private/Public flag bars can chart it)."""

    def __init__(self, policy_status_by_bucket):
        self._ps = policy_status_by_bucket

    def list_buckets(self):
        return {"Buckets": [{"Name": n} for n in self._ps]}

    def get_bucket_location(self, Bucket):
        return {"LocationConstraint": "ap-northeast-2"}

    def get_bucket_versioning(self, Bucket):
        return {"Status": "Enabled"}

    def get_bucket_encryption(self, Bucket):
        return {"ServerSideEncryptionConfiguration": {"Rules": []}}

    def get_bucket_logging(self, Bucket):
        return {}

    def get_bucket_policy_status(self, Bucket):
        out = self._ps[Bucket]
        if isinstance(out, Exception):
            raise out
        return {"PolicyStatus": {"IsPublic": out}}

    def get_bucket_tagging(self, Bucket):
        out = self._tags.get(Bucket) if hasattr(self, "_tags") else None
        if isinstance(out, Exception):
            raise out
        if out is None:
            from botocore.exceptions import ClientError as _CE

            raise _CE({"Error": {"Code": "NoSuchTagSet"}}, "GetBucketTagging")
        return {"TagSet": out}


def _client_error(code):
    from botocore.exceptions import ClientError

    return ClientError({"Error": {"Code": code}}, "GetBucketPolicyStatus")


def test_s3_security_rows_carry_bucket_policy_is_public():
    fake = _FakeS3PolicyStatus({
        "pub": True,
        "priv": False,
        "denied": _client_error("AccessDenied"),
        "nopolicy": _client_error("NoSuchBucketPolicy"),
    })
    rows, id_col, region_col, _meta = sync_lambda._fetch_s3_security(s3=fake)
    by_name = {r["name"]: r for r in rows}
    assert by_name["pub"]["bucket_policy_is_public"] is True
    assert by_name["priv"]["bucket_policy_is_public"] is False
    # denial => unknown (None), never a fabricated verdict
    assert by_name["denied"]["bucket_policy_is_public"] is None
    # NO bucket policy at all is a DEFINITIVE "not public via policy" (the majority case) —
    # None here would zero the Policy Private bar on a typical fleet.
    assert by_name["nopolicy"]["bucket_policy_is_public"] is False
    assert id_col == "name" and region_col == "region"


def test_s3_security_rows_fold_tags_to_a_dict():
    """gap L243: TagSet list -> {Key: Value} dict; NoSuchTagSet -> {} (definitive 'no tags');
    denial -> key absent (unknown, never a fabricated empty list)."""
    fake = _FakeS3PolicyStatus({"tagged": False, "bare": False, "denied": False})
    fake._tags = {
        "tagged": [{"Key": "env", "Value": "prod"}, {"Key": "team", "Value": "infra"}],
        "denied": _client_error("AccessDenied"),
        # "bare" absent -> NoSuchTagSet
    }
    rows, _id, _rg, _meta = sync_lambda._fetch_s3_security(s3=fake)
    by = {r["name"]: r for r in rows}
    assert by["tagged"]["tags"] == {"env": "prod", "team": "infra"}
    assert by["bare"]["tags"] == {}
    assert "tags" not in by["denied"]


def test_waf_rule_group_and_ip_set_registered():
    """gap L253: two new WAF types — columns verified against the pinned plugin source
    (v0.142.0 table_aws_wafv2_{rule_group,ip_set}.go; List needs no key quals)."""
    for t, table, cols in (
        ("waf_rule_group", "aws_wafv2_rule_group",
         ("name", "scope", "capacity", "rules", "visibility_config", "tags")),
        ("waf_ip_set", "aws_wafv2_ip_set",
         ("name", "scope", "ip_address_version", "addresses", "tags")),
    ):
        assert t in sync_lambda.QUERIES and t in sync_lambda._ALLOWED
        sql, id_col, region_col = sync_lambda.QUERIES[t]
        assert table in sql
        for c in cols:
            assert c in sql, (t, c)
        assert id_col == "name" and region_col == "region"


def test_iam_role_query_carries_attached_policy_arns():
    """gap L242: the S3 detail's IAM-access drill-down reads the SYNCED attached policies —
    a per-row ListAttachedRolePolicies hydrate in the pinned plugin (quota-safe post-ADR-021)."""
    sql, id_col, _rg = sync_lambda.QUERIES["iam_role"]
    assert "attached_policy_arns" in sql
    assert id_col == "name"


def test_iam_role_hydrate_fallback_sql_is_the_query_minus_the_hydrate():
    """Round-8 gate: a fleet whose aggregate role count exceeds the hydrate budget must not
    permanently fail the whole iam_role sync — the fallback SQL is EXACTLY the primary query
    with the hydrate column removed, so the base inventory never regresses and only the
    drill-down column disappears (its consumer renders 'not synced yet')."""
    sql, _id, _rg = sync_lambda.QUERIES["iam_role"]
    fallback = sync_lambda.HYDRATE_FALLBACK_SQL["iam_role"]
    assert "attached_policy_arns" not in fallback
    assert fallback == sql.replace("attached_policy_arns, ", "")
    # the hydrated attempt runs under a TIGHTER statement_timeout than the 240s default so
    # the fallback + the Aurora reserve still fit inside the 420s Lambda budget
    assert sync_lambda.HYDRATE_STATEMENT_TIMEOUT_S == 180
    assert sync_lambda.HYDRATE_FALLBACK_STATEMENT_TIMEOUT_S == 90
    assert (sync_lambda.HYDRATE_STATEMENT_TIMEOUT_S + sync_lambda.HYDRATE_FALLBACK_STATEMENT_TIMEOUT_S
            + sync_lambda.AURORA_RESERVE_S) <= 420 - 30  # 30s slack under the Terraform timeout


def _fake_steampipe_factory(script, timeouts):
    """script: list of ('raise'|rows) per successive query; timeouts collects each conn's
    statement_timeout."""
    state = {"i": 0}

    class FakeConn:
        def __init__(self):
            self.columns = [{"name": "name"}, {"name": "region"}]
            self.closed = False

        def run(self, q):
            step = script[state["i"]]
            state["i"] += 1
            if isinstance(step, Exception):
                raise step
            if step == "raise":
                raise RuntimeError("canceling statement due to statement timeout")
            return step

        def close(self):
            self.closed = True

    def fake(timeout_s=240):
        timeouts.append(timeout_s)
        return FakeConn()

    return fake


def test_hydrated_query_failure_falls_back_to_base_inventory(monkeypatch):
    """Round-8 gate control flow: primary (hydrated, 180s) fails → ONE hydrate-free retry
    (90s) succeeds, the base rows come back, and fallback_used=True so the caller can
    disclose the degraded sweep (round-9 gate) — never a whole-type failure."""
    timeouts = []
    monkeypatch.setattr(
        sync_lambda, "_steampipe",
        _fake_steampipe_factory(["raise", [["r1", "global"]]], timeouts))
    rows, cols, fallback_used = sync_lambda._run_steampipe_query(
        "iam_role", sync_lambda.QUERIES["iam_role"][0])
    assert rows == [["r1", "global"]] and cols == ["name", "region"]
    assert fallback_used is True
    assert timeouts == [180, 90]


def test_hydrated_query_success_reports_no_fallback(monkeypatch):
    timeouts = []
    monkeypatch.setattr(
        sync_lambda, "_steampipe",
        _fake_steampipe_factory([[["r1", "global"]]], timeouts))
    rows, _cols, fallback_used = sync_lambda._run_steampipe_query(
        "iam_role", sync_lambda.QUERIES["iam_role"][0])
    assert rows and fallback_used is False
    assert timeouts == [180]


def test_non_hydrate_types_do_not_retry(monkeypatch):
    timeouts = []
    monkeypatch.setattr(
        sync_lambda, "_steampipe", _fake_steampipe_factory(["raise"], timeouts))
    with pytest.raises(RuntimeError):
        sync_lambda._run_steampipe_query("iam_user", sync_lambda.QUERIES["iam_user"][0])
    assert timeouts == [240]


def test_query_budget_clamps_to_remaining_lambda_time(monkeypatch):
    """Round-9 gate: budgets shrink with the invocation's remaining time (minus the Aurora
    reserve) and a sliver refuses up-front instead of racing the Lambda wall."""
    import time as _time
    # no deadline armed → fixed caps apply
    monkeypatch.setattr(sync_lambda, "_DEADLINE", None)
    assert sync_lambda._query_budget_s(180, also_reserve_s=90) == 180
    # plenty of time → cap wins
    monkeypatch.setattr(sync_lambda, "_DEADLINE", _time.monotonic() + 415)
    assert sync_lambda._query_budget_s(180, also_reserve_s=90) == 180
    # mid-invocation → remaining-time clamp wins (remaining 200 − 120 reserve − 0 = 80)
    monkeypatch.setattr(sync_lambda, "_DEADLINE", _time.monotonic() + 200)
    assert sync_lambda._query_budget_s(90) <= 80
    # sliver → refuse before starting a query
    monkeypatch.setattr(sync_lambda, "_DEADLINE", _time.monotonic() + 130)
    with pytest.raises(RuntimeError):
        sync_lambda._query_budget_s(180)


def test_account_reachable_probe_is_remaining_time_clamped(monkeypatch):
    """Round-10 gate: the prune-phase reachability probe must not inherit the 240s default —
    it gets a short clamped budget, and when even that cannot fit ahead of the Aurora reserve
    it refuses WITHOUT connecting and reports unreachable (conservative: last-good protected)."""
    import time as _time
    mod = sync_lambda
    timeouts = []

    class FakeConn:
        def run(self, sql):
            return [("111111111111",)]

        def close(self):
            pass

    monkeypatch.setattr(mod, "_steampipe", lambda t=240: (timeouts.append(t), FakeConn())[1])
    # plenty of remaining time → the short probe cap applies (never the 240s default)
    monkeypatch.setattr(mod, "_DEADLINE", _time.monotonic() + 400)
    assert mod._account_reachable("111111111111") is True
    assert timeouts == [mod.REACHABILITY_PROBE_TIMEOUT_S]
    # a sliver → refuse before connecting, report unreachable
    connected = []
    monkeypatch.setattr(mod, "_steampipe", lambda t=240: connected.append(t))
    monkeypatch.setattr(mod, "_DEADLINE", _time.monotonic() + 125)
    assert mod._account_reachable("111111111111") is False
    assert connected == []


def test_hydrate_fallback_log_is_sanitized(monkeypatch, capsys):
    """Round-10 gate: the fallback event carries a bounded error_category + exception type,
    NEVER raw exception text (which can embed role ARNs/account IDs/SQL — ADR-021 contract)."""
    import json as _json
    timeouts = []
    secret_msg = ("AccessDenied: arn:aws:sts::999999999999:assumed-role/leaky is not "
                  "authorized to perform iam:ListAttachedRolePolicies")
    monkeypatch.setattr(
        sync_lambda, "_steampipe",
        _fake_steampipe_factory([RuntimeError(secret_msg), [["r1", "global"]]], timeouts))
    rows, _cols, fallback_used = sync_lambda._run_steampipe_query(
        "iam_role", sync_lambda.QUERIES["iam_role"][0])
    assert fallback_used is True
    events = [_json.loads(l) for l in capsys.readouterr().out.splitlines()
              if '"inventory_sync_hydrate_fallback"' in l]
    assert len(events) == 1
    ev = events[0]
    assert ev["error_category"] == "denial" and ev["error_type"] == "RuntimeError"
    assert "error" not in ev
    assert "999999999999" not in _json.dumps(ev)


def test_hydrate_fallback_remedy_is_cause_specific():
    """Round-9 L5 gate: rate tuning cannot fix a denial and a grant cannot fix a timeout —
    the log remedy must name the right knob per cause."""
    denial = sync_lambda._hydrate_fallback_remedy(RuntimeError(
        "AccessDenied: user is not authorized to perform iam:ListAttachedRolePolicies"))
    assert "grant iam:ListAttachedRolePolicies" in denial and "fill_rate" not in denial.split("(")[0]
    timeout = sync_lambda._hydrate_fallback_remedy(RuntimeError(
        "canceling statement due to statement timeout"))
    assert "fill_rate" in timeout and "grant" not in timeout
    unknown = sync_lambda._hydrate_fallback_remedy(RuntimeError("connection reset"))
    assert "AccessDenied" in unknown and "fill_rate" in unknown


def test_steampipe_conn_rejects_arbitrary_statement_timeouts(monkeypatch):
    """_steampipe() interpolates the timeout into SQL — a bounded int is enforced with a real
    ValueError BEFORE connecting (no -O elision, no leaked connection on a bad value)."""
    calls = []
    connected = []

    class FakeConn:
        def run(self, q):
            calls.append(q)

    def fake_connection(**kw):
        connected.append(1)
        return FakeConn()

    monkeypatch.setattr(sync_lambda.pg8000.native, "Connection", fake_connection)
    monkeypatch.setattr(sync_lambda, "_secret", lambda arn: "pw")
    monkeypatch.setattr(sync_lambda, "_ssl_ctx", lambda: None)
    monkeypatch.setenv("STEAMPIPE_SECRET_ARN", "arn:x")
    monkeypatch.setenv("STEAMPIPE_HOST", "h")
    sync_lambda._steampipe(180)
    assert calls == ["SET statement_timeout = '180s'"]
    for bad in ("180s", 0, 241, 9.5):
        with pytest.raises(ValueError):
            sync_lambda._steampipe(bad)
    assert len(connected) == 1  # rejected values never opened a connection
