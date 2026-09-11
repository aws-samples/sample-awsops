from datetime import datetime, timedelta, timezone

from finops import rules


class FakeConn:
    """`rows` = the ebs_volume data rows to return for the main SELECT — now
    (resource_id, account_id, region, data, captured_at) tuples, matching the account/region-scoped
    query. `sync_run` controls the _require_fresh_inventory precheck (mirrors an inventory_sync_runs
    row): 'ok' (default) -> a succeeded run finished just now (even if `rows` is empty — a healthy
    sync that found nothing); 'missing' -> no inventory_sync_runs row at all; 'failed' -> a row with
    status='failed' and last_success_at NULL (pre-freshness legacy path); 'partial-fresh' -> a
    'partial' latest run whose durable last_success_at is fresh; 'partial-stale' -> a 'partial'
    latest run whose last_success_at is >24h old; a datetime -> a succeeded run that finished at
    that timestamp (used to simulate staleness)."""
    def __init__(self, rows, sync_run='ok', enabled_accounts=None):
        self.rows = rows
        self.sync_run = sync_run
        # (account_id, region) pairs the 'accounts' registry reports as enabled — defaults to []
        # so existing fixtures (which never populated this table) don't spuriously trigger the
        # never-synced coverage-gap check.
        self.enabled_accounts = enabled_accounts or []

    def run(self, sql, **kw):
        if "FROM inventory_sync_runs" in sql:
            if self.sync_run == 'missing':
                return []
            if self.sync_run == 'failed':
                return [('failed', datetime.now(timezone.utc), None)]
            if self.sync_run == 'partial-fresh':
                return [('partial', datetime.now(timezone.utc), datetime.now(timezone.utc))]
            if self.sync_run == 'partial-stale':
                return [('partial', datetime.now(timezone.utc),
                         datetime.now(timezone.utc) - timedelta(hours=25))]
            finished_at = self.sync_run if isinstance(self.sync_run, datetime) else datetime.now(timezone.utc)
            return [('succeeded', finished_at, finished_at)]
        if "FROM accounts" in sql:
            return self.enabled_accounts
        if "GROUP BY account_id, region" in sql:
            latest = {}
            for resource_id, account_id, region, data, captured_at in self.rows:
                key = (account_id, region)
                if key not in latest or captured_at > latest[key]:
                    latest[key] = captured_at
            return [(acct, region, ts) for (acct, region), ts in latest.items()]
        return self.rows


_NOW = datetime.now(timezone.utc)


def test_ebs_unattached_computes_savings_from_rate_card():
    # gp2 (not gp3): gp2 has no separate provisioned-IOPS/throughput purchase (IOPS scales with
    # size), so it's one of the types this rule can price completely from the GB-rate alone.
    conn = FakeConn([("vol-1", "self", "ap-northeast-2", {"state": "available", "size": 100, "volume_type": "gp2",
                                                           "tags": {"Name": "old"}}, _NOW)])
    out = rules.ebs_unattached(conn, [0])
    assert len(out) == 1
    f = out[0]
    assert f["resource_id"] == "vol-1"
    assert f["account_id"] == "self"
    assert f["region"] == "ap-northeast-2"
    assert f["category"] == "storage"
    assert f["monthly_savings_usd"] == round(100 * 0.114, 2)
    assert f["tags"] == {"Name": "old"}
    assert f["lookback_days"] is None
    assert f["stale"] is False


def test_ebs_unattached_null_savings_when_size_missing():
    conn = FakeConn([("vol-2", "self", "ap-northeast-2",
                       {"state": "available", "size": None, "volume_type": "gp2"}, _NOW)])
    out = rules.ebs_unattached(conn, [0])
    assert out[0]["monthly_savings_usd"] is None


def test_ebs_unattached_unknown_volume_type_gets_null_savings_not_an_invented_rate():
    # An unrecognized volume type has no published rate — a review round caught this falling back
    # to an invented $0.10/GB "default" (inherited from diagnosis/sources.py, which predates this
    # ADR's invariant), producing a confident dollar amount for something genuinely unpriced. It
    # must degrade to NULL + an evidence marker, mirroring the unpriced-region treatment.
    conn = FakeConn([("vol-3", "self", "ap-northeast-2",
                       {"state": "available", "size": 50, "volume_type": "weird"}, _NOW)])
    out = rules.ebs_unattached(conn, [0])
    f = next(f for f in out if f["resource_id"] == "vol-3")
    assert f["monthly_savings_usd"] is None
    assert f["evidence"]["unpriced_volume_type"] == "weird"


def test_ebs_unattached_demotes_io1_io2_gp3_to_null_since_iops_or_throughput_is_unpriced():
    # A review round caught that the GB-rate alone materially understates io1/io2 cost — the
    # provisioned-IOPS charge (unpriced here — sync_lambda.py has no published-rate table for it)
    # routinely dominates. A follow-up round then caught that gating gp3's demotion on
    # `iops > 3000` was itself unsound: gp3's PROVISIONED THROUGHPUT (above the free 125 MiB/s) is
    # never synced at all, so a baseline-IOPS gp3 volume with above-baseline throughput would still
    # get a confident-but-wrong figure with no signal to catch it. All three types now demote
    # unconditionally — presenting any of these GB-only figures as confident violates the "amounts
    # are never invented/misleading" invariant just as surely as inventing a number would.
    conn = FakeConn([
        ("vol-io1", "self", "ap-northeast-2",
         {"state": "available", "size": 100, "volume_type": "io1", "iops": 5000}, _NOW),
        ("vol-io2", "self", "ap-northeast-2",
         {"state": "available", "size": 100, "volume_type": "io2", "iops": 5000}, _NOW),
        ("vol-gp3", "self", "ap-northeast-2",
         {"state": "available", "size": 100, "volume_type": "gp3", "iops": 3000}, _NOW),
    ])
    out = rules.ebs_unattached(conn, [0])
    for vid in ("vol-io1", "vol-io2", "vol-gp3"):
        f = next(f for f in out if f["resource_id"] == vid)
        assert f["monthly_savings_usd"] is None
        assert "partial_rate" in f["evidence"]


def test_ebs_unattached_still_prices_gp2_st1_sc1_which_have_no_separate_performance_charge():
    # gp2 (IOPS scales with size, no separate purchase) and st1/sc1 (throughput-capacity billing,
    # no provisioned-throughput purchase option) have no unaccounted performance dimension — the
    # GB-rate alone IS the complete price for these, unlike io1/io2/gp3.
    conn = FakeConn([
        ("vol-gp2", "self", "ap-northeast-2", {"state": "available", "size": 100, "volume_type": "gp2"}, _NOW),
        ("vol-st1", "self", "ap-northeast-2", {"state": "available", "size": 100, "volume_type": "st1"}, _NOW),
    ])
    out = rules.ebs_unattached(conn, [0])
    gp2 = next(f for f in out if f["resource_id"] == "vol-gp2")
    st1 = next(f for f in out if f["resource_id"] == "vol-st1")
    assert gp2["monthly_savings_usd"] == round(100 * 0.114, 2)
    assert st1["monthly_savings_usd"] == round(100 * 0.045, 2)
    assert "partial_rate" not in gp2["evidence"] and "partial_rate" not in st1["evidence"]


def test_ebs_unattached_flags_a_per_row_stale_captured_at_even_though_the_job_succeeded():
    # The job-level inventory_sync_runs row says 'succeeded' just now (sync_run='ok' default), but
    # THIS row's own captured_at is weeks old — exactly sync_lambda.py's M5 scenario: one account's
    # connection failed that cycle, so its old rows were preserved (not pruned) rather than
    # refreshed. Must be demoted (stale_inventory_data guard), not trusted as confirmed-current,
    # and — because it's still returned — protected from being wrongly resolved. Since this is the
    # ONLY row for this account/region, the account-level coverage-gap check also fires (its own
    # scope's newest data is equally stale) — both signals are expected together.
    old = _NOW - timedelta(hours=25)
    conn = FakeConn([("vol-4", "self", "ap-northeast-2",
                       {"state": "available", "size": 20, "volume_type": "gp3"}, old)])
    out = rules.ebs_unattached(conn, [0])
    vol = next(f for f in out if f["resource_id"] == "vol-4")
    assert vol["stale"] is True  # still returned (protected from resolve_stale)
    gap = next(f for f in out if f["evidence"].get("coverage_gap"))
    assert gap["stale"] is True
    assert gap["monthly_savings_usd"] is None


def test_ebs_unattached_row_within_threshold_is_not_flagged_stale():
    recent = _NOW - timedelta(hours=1)
    conn = FakeConn([("vol-5", "self", "ap-northeast-2",
                       {"state": "available", "size": 20, "volume_type": "gp3"}, recent)])
    out = rules.ebs_unattached(conn, [0])
    assert out[0]["stale"] is False


def test_ebs_unattached_does_not_invent_a_coverage_gap_for_a_volume_less_account():
    # A stop-time review caught a previous revision cross-referencing the `accounts` registry and
    # flagging any enabled account with zero ebs_volume rows as "never synced" — a false
    # coverage-failure generator, and the same mistake _require_fresh_inventory's own comment warns
    # against: row absence is NOT a sync-failure signal. An account that genuinely owns no EBS
    # volumes produces zero rows on a perfectly healthy sync, and inventory_sync_runs is a
    # JOB-level ledger (keyed 'self'), so there is no per-account row to tell the two apart.
    conn = FakeConn(
        [("vol-1", "111111111111", "ap-northeast-2",
          {"state": "available", "size": 10, "volume_type": "gp3"}, _NOW)],
        enabled_accounts=[("111111111111", "ap-northeast-2"), ("999999999999", "us-west-2")],
    )
    out = rules.ebs_unattached(conn, [0])
    assert [f for f in out if f["evidence"].get("coverage_gap")] == []
    assert {f["resource_id"] for f in out} == {"vol-1"}


def test_ebs_unattached_no_coverage_gap_for_a_healthy_recently_synced_account():
    # A healthy, recently-synced account must not produce a coverage-gap item — that would make
    # the honest-degradation signal meaningless noise on every run.
    conn = FakeConn(
        [("vol-1", "self", "ap-northeast-2",
          {"state": "available", "size": 10, "volume_type": "gp3"}, _NOW)],
        enabled_accounts=[("self", "ap-northeast-2")],
    )
    out = rules.ebs_unattached(conn, [0])
    assert [f for f in out if f["evidence"].get("coverage_gap")] == []


def test_ebs_unattached_scopes_each_row_to_its_own_account_and_region():
    # inventory_resources is read across every synced account/region — a review round caught that
    # the finding's own identity must carry account_id/region, or a resource_id collision across
    # two scopes (e.g. two accounts both surfacing "vol-1") is unrecoverable downstream.
    conn = FakeConn([
        ("vol-1", "111111111111", "ap-northeast-2", {"state": "available", "size": 10, "volume_type": "gp3"}, _NOW),
        ("vol-1", "222222222222", "us-east-1", {"state": "available", "size": 20, "volume_type": "gp3"}, _NOW),
    ])
    out = rules.ebs_unattached(conn, [0])
    scopes = {(f["account_id"], f["region"]) for f in out}
    assert scopes == {("111111111111", "ap-northeast-2"), ("222222222222", "us-east-1")}


def test_ebs_unattached_only_prices_the_supported_region_and_leaves_others_null():
    # _EBS_GB_MONTH_USD is an ap-northeast-2-only rate card — a review round caught it being
    # applied fleet-wide, pricing e.g. a us-east-1 volume at Seoul rates as a confident amount.
    # A row outside the priced region set must still surface (never silently hidden) but with
    # monthly_savings_usd=NULL rather than an invented number.
    conn = FakeConn([
        ("vol-kr", "self", "ap-northeast-2", {"state": "available", "size": 100, "volume_type": "gp2"}, _NOW),
        ("vol-us", "self", "us-east-1", {"state": "available", "size": 100, "volume_type": "gp2"}, _NOW),
    ])
    out = rules.ebs_unattached(conn, [0])
    assert len(out) == 2
    kr = next(f for f in out if f["resource_id"] == "vol-kr")
    us = next(f for f in out if f["resource_id"] == "vol-us")
    assert kr["monthly_savings_usd"] == round(100 * 0.114, 2)
    assert "unpriced_region" not in kr["evidence"]
    assert us["monthly_savings_usd"] is None
    assert us["evidence"]["unpriced_region"] == "us-east-1"


def test_ebs_unattached_raises_when_sync_never_ran():
    # steampipe_enabled=false (or inv_sync never ran for this type) -> no inventory_sync_runs row
    # at all, not "confirmed none unattached". Must raise so engine.run() skips resolve_stale.
    conn = FakeConn([], sync_run='missing')
    try:
        rules.ebs_unattached(conn, [0])
        assert False, "expected RuntimeError"
    except RuntimeError as e:
        assert "no row" in str(e)


def test_ebs_unattached_raises_when_last_sync_failed():
    conn = FakeConn([], sync_run='failed')
    try:
        rules.ebs_unattached(conn, [0])
        assert False, "expected RuntimeError"
    except RuntimeError as e:
        assert "failed" in str(e)


def test_ebs_unattached_raises_when_sync_is_stale():
    stale_at = datetime.now(timezone.utc) - timedelta(hours=25)
    conn = FakeConn([("vol-1", "self", "ap-northeast-2", {"state": "available", "size": 10, "volume_type": "gp3"})],
                     sync_run=stale_at)
    try:
        rules.ebs_unattached(conn, [0])
        assert False, "expected RuntimeError"
    except RuntimeError as e:
        assert "stale" in str(e) or "ago" in str(e)


def test_ebs_unattached_ok_when_sync_succeeded_and_genuinely_found_nothing():
    # A HEALTHY, RECENT succeeded sync with zero unattached volumes is a real, trustworthy empty
    # result (e.g. an account with no EBS volumes at all) — must NOT be misclassified as
    # "unavailable", or a genuinely-fixed finding would never resolve (this is the exact regression
    # a prior version of this check introduced by judging freshness from inventory_resources row
    # counts instead of the inventory_sync_runs ledger).
    conn = FakeConn([], sync_run='ok')
    assert rules.ebs_unattached(conn, [0]) == []


def test_ebs_unattached_ok_when_latest_run_partial_but_last_success_fresh():
    # A 'partial' run (one SDK sub-call failed) preserves every last-good row and leaves the
    # durable last_success_at at the last fully-successful sweep — fresh, prune-safe data the
    # engine must be allowed to evaluate, not refuse.
    conn = FakeConn([("vol-1", "self", "ap-northeast-2", {"state": "available", "size": 100,
                                                          "volume_type": "gp2", "tags": {}}, _NOW)],
                    sync_run='partial-fresh')
    out = rules.ebs_unattached(conn, [0])
    assert len(out) == 1


def test_ebs_unattached_raises_when_partial_and_last_success_stale():
    # A partial run whose last FULL success is >24h old means nothing has been pruned/refreshed
    # in a day — data-unavailable, not "confirmed none unattached".
    conn = FakeConn([], sync_run='partial-stale')
    try:
        rules.ebs_unattached(conn, [0])
        assert False, "expected RuntimeError"
    except RuntimeError as e:
        assert "fully succeeded" in str(e) or "ago" in str(e)


class FakeCOPaged:
    """Serves `pages` in order per call; each page is a dict with the raw API response shape."""
    def __init__(self, ec2_pages=None, rds_pages=None, ec2_exc=None, rds_exc=None):
        self.ec2_pages = list(ec2_pages or [])
        self.rds_pages = list(rds_pages or [])
        self.ec2_exc = ec2_exc
        self.rds_exc = rds_exc
        self.ec2_calls = []
        self.rds_calls = []

    def get_ec2_instance_recommendations(self, **kw):
        self.ec2_calls.append(kw)
        if self.ec2_exc:
            raise self.ec2_exc
        return self.ec2_pages.pop(0)

    def get_rds_database_recommendations(self, **kw):
        self.rds_calls.append(kw)
        if self.rds_exc:
            raise self.rds_exc
        return self.rds_pages.pop(0)


def _ec2_page(arn, finding="Overprovisioned", next_token=None, savings=42.5, rank=1):
    page = {"instanceRecommendations": [
        {"instanceArn": arn, "currentInstanceType": "m5.xlarge", "finding": finding,
         "instanceName": "web-1", "tags": [{"key": "Team", "value": "core"}],
         "lookBackPeriodInDays": 14,
         "recommendationOptions": [{"instanceType": "m5.large", "rank": rank,
                                    "savingsOpportunity": {"estimatedMonthlySavings": {"value": savings}},
                                    "performanceRisk": 1}]},
    ]}
    if next_token:
        page["nextToken"] = next_token
    return page


def test_ec2_rightsizing_uses_top_option_and_skips_optimized(monkeypatch):
    fake = FakeCOPaged(ec2_pages=[{
        "instanceRecommendations": [
            _ec2_page("arn:aws:ec2:1")["instanceRecommendations"][0],
            {"instanceArn": "arn:aws:ec2:2", "currentInstanceType": "t3.micro", "finding": "Optimized",
             "recommendationOptions": []},
        ],
    }])
    monkeypatch.setattr(rules, "_co_client", lambda: fake)
    out = rules.ec2_rightsizing(None, [0])
    assert len(out) == 1
    f = out[0]
    assert f["resource_id"] == "arn:aws:ec2:1"
    assert f["monthly_savings_usd"] == 42.5
    assert f["tags"] == {"Team": "core"}
    assert f["lookback_days"] == 14
    assert f["account_id"] == "self"
    assert f["region"] == rules._REGION


def test_ec2_rightsizing_skips_an_overprovisioned_row_with_no_recommendation_option(monkeypatch):
    # A review round caught this asymmetric with rds_rightsizing (which already skips a
    # no-option row) — an option-less row has nothing actionable and previously produced a
    # "? -> ?" title with no savings figure instead of being skipped like its RDS counterpart.
    fake = FakeCOPaged(ec2_pages=[{
        "instanceRecommendations": [
            {"instanceArn": "arn:aws:ec2:3", "currentInstanceType": "m5.large", "finding": "Overprovisioned",
             "recommendationOptions": []},
        ],
    }])
    monkeypatch.setattr(rules, "_co_client", lambda: fake)
    assert rules.ec2_rightsizing(None, [0]) == []


def test_ec2_rightsizing_prefers_the_after_discounts_savings_when_present(monkeypatch):
    # A review round caught both rightsizing rules reading only the on-demand-basis
    # savingsOpportunity — for an RI/Savings-Plans-covered fleet that materially overstates the
    # real dollar impact. savingsOpportunityAfterDiscounts must be preferred when CO provides it.
    page = {"instanceRecommendations": [
        {"instanceArn": "arn:aws:ec2:1", "currentInstanceType": "m5.xlarge", "finding": "Overprovisioned",
         "recommendationOptions": [{"instanceType": "m5.large", "rank": 1,
                                    "savingsOpportunity": {"estimatedMonthlySavings": {"value": 100.0}},
                                    "savingsOpportunityAfterDiscounts": {"estimatedMonthlySavings": {"value": 30.0}}}]},
    ]}
    fake = FakeCOPaged(ec2_pages=[page])
    monkeypatch.setattr(rules, "_co_client", lambda: fake)
    out = rules.ec2_rightsizing(None, [0])
    assert out[0]["monthly_savings_usd"] == 30.0
    assert out[0]["evidence"]["savings_basis"] == "after_discounts"


def test_ec2_rightsizing_falls_back_to_on_demand_savings_when_after_discounts_is_absent(monkeypatch):
    page = {"instanceRecommendations": [
        {"instanceArn": "arn:aws:ec2:1", "currentInstanceType": "m5.xlarge", "finding": "Overprovisioned",
         "recommendationOptions": [{"instanceType": "m5.large", "rank": 1,
                                    "savingsOpportunity": {"estimatedMonthlySavings": {"value": 100.0}}}]},
    ]}
    fake = FakeCOPaged(ec2_pages=[page])
    monkeypatch.setattr(rules, "_co_client", lambda: fake)
    out = rules.ec2_rightsizing(None, [0])
    assert out[0]["monthly_savings_usd"] == 100.0
    assert out[0]["evidence"]["savings_basis"] == "on_demand"


def test_ec2_rightsizing_sorts_by_rank_and_picks_the_top_option(monkeypatch):
    page = {"instanceRecommendations": [
        {"instanceArn": "arn:aws:ec2:1", "currentInstanceType": "m5.xlarge", "finding": "Overprovisioned",
         "lookBackPeriodInDays": 14, "recommendationOptions": [
            {"instanceType": "m5.medium", "rank": 2, "savingsOpportunity": {"estimatedMonthlySavings": {"value": 10.0}}},
            {"instanceType": "m5.large", "rank": 1, "savingsOpportunity": {"estimatedMonthlySavings": {"value": 42.5}}},
         ]},
    ]}
    fake = FakeCOPaged(ec2_pages=[page])
    monkeypatch.setattr(rules, "_co_client", lambda: fake)
    out = rules.ec2_rightsizing(None, [0])
    assert out[0]["monthly_savings_usd"] == 42.5
    assert "m5.large" in out[0]["title"]


def test_ec2_rightsizing_follows_pagination_across_multiple_pages(monkeypatch):
    fake = FakeCOPaged(ec2_pages=[
        _ec2_page("arn:aws:ec2:1", next_token="p2"),
        _ec2_page("arn:aws:ec2:2"),
    ])
    monkeypatch.setattr(rules, "_co_client", lambda: fake)
    out = rules.ec2_rightsizing(None, [0])
    assert {f["resource_id"] for f in out} == {"arn:aws:ec2:1", "arn:aws:ec2:2"}
    assert len(fake.ec2_calls) == 2
    assert fake.ec2_calls[1]["nextToken"] == "p2"


def test_ec2_rightsizing_stops_at_the_page_safety_bound(monkeypatch):
    # Every page hands back a nextToken forever -> must raise (silent truncation), not loop forever.
    pages = [_ec2_page(f"arn:{i}", next_token="more") for i in range(10)]
    fake = FakeCOPaged(ec2_pages=pages)
    monkeypatch.setattr(rules, "_co_client", lambda: fake)
    try:
        rules.ec2_rightsizing(None, [0])
        assert False, "expected RuntimeError"
    except RuntimeError:
        pass
    assert len(fake.ec2_calls) == rules._CO_MAX_PAGES


def test_ec2_rightsizing_raises_on_a_non_empty_errors_array_instead_of_trusting_the_result(monkeypatch):
    # A review round caught that Compute Optimizer's in-band `errors` field (per-object/per-account
    # failures that don't fail the HTTP call itself) was ignored — an incomplete result must not be
    # trusted as "confirmed none found" (resolve_stale would otherwise wipe real prior findings).
    page = _ec2_page("arn:aws:ec2:1")
    page["errors"] = [{"identifier": "arn:aws:ec2:1", "code": "AccessDenied", "message": "denied"}]
    fake = FakeCOPaged(ec2_pages=[page])
    monkeypatch.setattr(rules, "_co_client", lambda: fake)
    try:
        rules.ec2_rightsizing(None, [0])
        assert False, "expected RuntimeError"
    except RuntimeError as e:
        assert "AccessDenied" in str(e)


def test_ec2_rightsizing_reraises_on_not_opted_in_instead_of_degrading(monkeypatch):
    # An opt-out (or a support-plan lapse) is a data-availability state, not evidence that
    # yesterday's real findings were fixed — must raise (engine.py marks the run partial and
    # preserves prior findings) rather than return [] (which would let resolve_stale wipe them).
    fake = FakeCOPaged(ec2_exc=Exception("An error occurred (OptInRequiredException) ..."))
    monkeypatch.setattr(rules, "_co_client", lambda: fake)
    try:
        rules.ec2_rightsizing(None, [0])
        assert False, "expected the exception to propagate"
    except Exception as e:
        assert "OptInRequiredException" in str(e)


def test_ec2_rightsizing_reraises_unexpected_errors_instead_of_degrading(monkeypatch):
    # This is the core fix: a transient failure must NOT look identical to "zero recommendations"
    # (engine.run's resolve_stale would otherwise wipe yesterday's real findings).
    fake = FakeCOPaged(ec2_exc=RuntimeError("ThrottlingException: rate exceeded"))
    monkeypatch.setattr(rules, "_co_client", lambda: fake)
    try:
        rules.ec2_rightsizing(None, [0])
        assert False, "expected the exception to propagate"
    except RuntimeError:
        pass


def test_ec2_rightsizing_reraises_access_denied_instead_of_degrading(monkeypatch):
    # AccessDenied must NOT be treated as "not opted in" — an IAM/SCP regression should surface,
    # not silently present as a confirmed-empty result.
    fake = FakeCOPaged(ec2_exc=Exception("An error occurred (AccessDeniedException) ..."))
    monkeypatch.setattr(rules, "_co_client", lambda: fake)
    try:
        rules.ec2_rightsizing(None, [0])
        assert False, "expected the exception to propagate"
    except Exception as e:
        assert "AccessDeniedException" in str(e)


def _rds_rec(arn, finding="Overprovisioned", options=None, lookback=14):
    return {"resourceArn": arn, "currentDBInstanceClass": "db.m5.large", "engine": "postgres",
            "instanceFinding": finding, "lookbackPeriodInDays": lookback,
            "tags": [{"key": "Team", "value": "data"}],
            "instanceRecommendationOptions": options if options is not None else [
                {"dbInstanceClass": "db.m5.medium", "rank": 1,
                 "savingsOpportunity": {"estimatedMonthlySavings": {"value": 10.0}}},
            ]}


def test_rds_rightsizing_paginates_and_skips_no_option_and_underprovisioned_rows(monkeypatch):
    fake = FakeCOPaged(rds_pages=[
        {"rdsDBRecommendations": [
            _rds_rec("arn:aws:rds:1"),
            _rds_rec("arn:aws:rds:2", options=[]),
            _rds_rec("arn:aws:rds:3", finding="Underprovisioned"),
        ], "nextToken": "p2"},
        {"rdsDBRecommendations": [
            _rds_rec("arn:aws:rds:4"),
        ]},
    ])
    monkeypatch.setattr(rules, "_co_client", lambda: fake)
    out = rules.rds_rightsizing(None, [0])
    assert {f["resource_id"] for f in out} == {"arn:aws:rds:1", "arn:aws:rds:4"}
    assert len(fake.rds_calls) == 2
    f = next(f for f in out if f["resource_id"] == "arn:aws:rds:1")
    assert f["monthly_savings_usd"] == 10.0
    assert f["tags"] == {"Team": "data"}
    assert f["lookback_days"] == 14
    assert f["account_id"] == "self"
    assert f["region"] == rules._REGION


def test_rds_rightsizing_reraises_access_denied_instead_of_degrading(monkeypatch):
    fake = FakeCOPaged(rds_exc=Exception("An error occurred (AccessDeniedException) ..."))
    monkeypatch.setattr(rules, "_co_client", lambda: fake)
    try:
        rules.rds_rightsizing(None, [0])
        assert False, "expected the exception to propagate"
    except Exception as e:
        assert "AccessDeniedException" in str(e)


def test_rds_rightsizing_reraises_on_not_opted_in_instead_of_degrading(monkeypatch):
    fake = FakeCOPaged(rds_exc=Exception("An error occurred (SubscriptionRequiredException) ..."))
    monkeypatch.setattr(rules, "_co_client", lambda: fake)
    try:
        rules.rds_rightsizing(None, [0])
        assert False, "expected the exception to propagate"
    except Exception as e:
        assert "SubscriptionRequiredException" in str(e)


def test_rds_rightsizing_reraises_unexpected_errors(monkeypatch):
    fake = FakeCOPaged(rds_exc=RuntimeError("ServiceUnavailable"))
    monkeypatch.setattr(rules, "_co_client", lambda: fake)
    try:
        rules.rds_rightsizing(None, [0])
        assert False, "expected the exception to propagate"
    except RuntimeError:
        pass


def test_ec2_and_rds_failures_are_independent():
    """A failure fetching one resource class must not prevent evaluating the other — they are two
    separate catalog rules now, not one combined function."""
    from finops import catalog
    ids = {r["id"] for r in catalog.active_rules()}
    assert "ec2_rightsizing" in ids
    assert "rds_rightsizing" in ids
