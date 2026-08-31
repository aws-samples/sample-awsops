"""Pure matching-engine tests for the SG Rules & Usage design spec's "Matching" test list
(docs/superpowers/specs/2026-08-13-security-group-rules-usage-design.md)."""
from datetime import date, datetime, timedelta, timezone

import pytest

import sg_rule_matching as m


def utc(y, mo, d, h=0, mi=0):
    return datetime(y, mo, d, h, mi, tzinfo=timezone.utc)


# ── fingerprint ───────────────────────────────────────────────────────────────────────────────

def test_fingerprint_stable_for_identical_shape():
    r1 = {"group_id": "sg-1", "is_egress": False, "protocol": "tcp", "from_port": 443,
          "to_port": 443, "peer_kind": "cidr", "peer_value": "10.0.0.0/8"}
    r2 = dict(r1)
    assert m.rule_fingerprint(r1) == m.rule_fingerprint(r2)


def test_fingerprint_changes_on_shape_change():
    r1 = {"group_id": "sg-1", "is_egress": False, "protocol": "tcp", "from_port": 443,
          "to_port": 443, "peer_kind": "cidr", "peer_value": "10.0.0.0/8"}
    r2 = {**r1, "to_port": 8443}
    assert m.rule_fingerprint(r1) != m.rule_fingerprint(r2)


# ── day-boundary fingerprint-epoch-crossing ──────────────────────────────────────────────────────

def test_day_confidently_matched_when_one_version_covers_whole_day():
    versions = [{"valid_from": utc(2026, 1, 1), "valid_to": None}]
    cov = m.day_coverage(versions, date(2026, 3, 5))
    assert cov["crossing"] is False
    assert cov["version"]["valid_from"] == utc(2026, 1, 1)


def test_day_crossing_when_version_changes_mid_day_never_a_lower_bound():
    versions = [
        {"valid_from": utc(2026, 1, 1), "valid_to": utc(2026, 3, 5, 14, 0)},
        {"valid_from": utc(2026, 3, 5, 14, 0), "valid_to": None},
    ]
    cov = m.day_coverage(versions, date(2026, 3, 5))
    assert cov["crossing"] is True
    assert cov["version"] is None


def test_day_not_crossing_when_transition_is_well_beyond_the_observation_lag():
    # valid_to is 3 days after the day in question — with the default 1-day observation_lag, the
    # actual rule-change instant (bounded to (valid_to - lag, valid_to]) cannot have fallen inside
    # day 3/5, so the day is confidently covered by the earlier version.
    versions = [
        {"valid_from": utc(2026, 1, 1), "valid_to": utc(2026, 3, 8, 0, 0)},
        {"valid_from": utc(2026, 3, 8, 0, 0), "valid_to": None},
    ]
    cov = m.day_coverage(versions, date(2026, 3, 5))
    assert cov["crossing"] is False


def test_day_crossing_when_transition_observed_at_next_midnight_is_within_observation_lag():
    # item 3 follow-up fix: valid_from/valid_to are OBSERVATION timestamps (this scan's own run
    # time), not the actual change timestamp — a version closed at exactly the next day's midnight
    # was, per the default 1-day scan cadence, possibly closed by a change that happened anywhere
    # in the preceding 24h, i.e. during day 3/5 itself. The old behavior (crossing=False here) was
    # exactly the false-confident-day bug this item fixes.
    versions = [
        {"valid_from": utc(2026, 1, 1), "valid_to": utc(2026, 3, 6, 0, 0)},
        {"valid_from": utc(2026, 3, 6, 0, 0), "valid_to": None},
    ]
    cov = m.day_coverage(versions, date(2026, 3, 5))
    assert cov["crossing"] is True
    assert cov["version"] is None


def test_day_not_crossing_with_a_shorter_observation_lag_when_transition_is_outside_it():
    # A scan cadence shorter than 1 day (observation_lag override) narrows the uncertainty window
    # accordingly — a transition observed 6h after day-end is outside a 1h lag.
    versions = [
        {"valid_from": utc(2026, 1, 1), "valid_to": utc(2026, 3, 6, 6, 0)},
        {"valid_from": utc(2026, 3, 6, 6, 0), "valid_to": None},
    ]
    cov = m.day_coverage(versions, date(2026, 3, 5), observation_lag=timedelta(hours=1))
    assert cov["crossing"] is False


def test_day_not_crossing_when_covering_version_is_still_open():
    # A still-open version (valid_to is None) keeps the pre-existing "no lower bound assumed"
    # behavior — a change that hasn't happened yet can never retroactively taint this day.
    versions = [{"valid_from": utc(2026, 1, 1), "valid_to": None}]
    cov = m.day_coverage(versions, date(2026, 3, 5), observation_lag=timedelta(days=1))
    assert cov["crossing"] is False


def test_day_crossing_when_no_version_covers_a_boundary():
    versions = [{"valid_from": utc(2026, 3, 6), "valid_to": None}]  # starts AFTER the day in question
    cov = m.day_coverage(versions, date(2026, 3, 5))
    assert cov["crossing"] is True
    assert cov["version"] is None


# ── item 2 follow-up fix (round 2): observation_lag must reflect the ACTUAL gap since the previous
#    successful scan, not a fixed nominal cadence — a multi-day scan outage must widen the window. ──

def test_day_crossing_when_observation_lag_is_unknown_never_guesses():
    # A closed version with no resolvable observation_lag (the caller found no reasonably recent
    # previous successful scan) must never be trusted as confident — even though, with the OLD
    # fixed-24h behavior, this exact valid_to (3 days after the day in question) would have been
    # confidently NOT crossing (see test_day_not_crossing_when_transition_is_well_beyond_the_
    # observation_lag above).
    versions = [
        {"valid_from": utc(2026, 1, 1), "valid_to": utc(2026, 3, 8, 0, 0)},
        {"valid_from": utc(2026, 3, 8, 0, 0), "valid_to": None},
    ]
    cov = m.day_coverage(versions, date(2026, 3, 5), observation_lag=None)
    assert cov["crossing"] is True
    assert cov["version"] is None
    assert cov["reason"] == "observation_lag_unknown"


def test_day_crossing_after_a_multi_day_scan_gap_widens_the_window():
    # Simulates a real multi-day scan outage: the previous successful scan was 4 days before the
    # closing observation (valid_to) — a FIXED 24h/1-day lag would have missed this entirely and
    # confidently attributed day 3/5 to the old version (the false-confidence bug this item fixes).
    # With the real ~4-day gap threaded through as observation_lag, the uncertainty window covers
    # day 3/5 and the day must be marked unassessable (crossing), not confidently resolved.
    versions = [
        {"valid_from": utc(2026, 1, 1), "valid_to": utc(2026, 3, 8, 0, 0)},
        {"valid_from": utc(2026, 3, 8, 0, 0), "valid_to": None},
    ]
    real_gap = timedelta(days=4)  # scans were missed for several days before this observation
    cov = m.day_coverage(versions, date(2026, 3, 5), observation_lag=real_gap)
    assert cov["crossing"] is True
    assert cov["version"] is None
    assert cov["reason"] == "observation_lag_boundary"


# ── item 3 follow-up fix (round 2): a genuinely `date`-typed Glue partition key must get a typed
#    literal (Athena/Trino rejects comparing a `date` column to a bare string literal). ─────────────

def test_date_literal_uses_typed_literal_for_a_date_typed_key():
    assert m.date_literal("2026-03-05", "date") == "DATE '2026-03-05'"


def test_date_literal_keeps_quoted_string_for_a_string_typed_key():
    assert m.date_literal("2026-03-05", "string") == "'2026-03-05'"


def test_build_partition_predicate_emits_date_literal_for_a_date_typed_single_key():
    validation = {"partitionKeys": ["dt"], "partitionKeyTypes": ["date"]}
    predicate = m._build_partition_predicate(validation, date(2026, 3, 5))
    assert "DATE '2026-03-05'" in predicate
    assert "DATE '2026-03-06'" in predicate
    assert "'2026-03-05'" not in predicate.replace("DATE '2026-03-05'", "")


def test_build_partition_predicate_keeps_string_literal_for_a_string_typed_single_key():
    validation = {"partitionKeys": ["dt"], "partitionKeyTypes": ["string"]}
    predicate = m._build_partition_predicate(validation, date(2026, 3, 5))
    assert "'2026-03-05'" in predicate
    assert "DATE '2026-03-05'" not in predicate


def test_build_partition_predicate_raises_on_an_unsafe_single_partition_key_name():
    """MINOR fix: an unsafe/corrupted stored partition-key name that nonetheless passes the
    date-type strategy gate (e.g. `has_resolved_partition_strategy` sees a confirmed `date` type)
    used to fall back to `_safe_ident(dk_raw, "")` — silently building an empty/no-op predicate
    instead of raising. For the `partition_keys` strategy this still failed closed via
    `_partition_exists` returning `None`, but for `projection` (no existence check at all) it would
    have run the query fully partition-unbounded. Now matches `scope_partition_expr_clauses`'
    fail-closed posture (round 4) and raises `UnsafeIdentifier` instead."""
    validation = {"partitionKeys": ["dt; DROP TABLE x"], "partitionKeyTypes": ["date"]}
    with pytest.raises(m.UnsafeIdentifier):
        m._build_partition_predicate(validation, date(2026, 3, 5))


def test_build_partition_predicate_uses_a_range_not_an_exact_match_for_a_timestamp_typed_key():
    """CI-review MAJOR fix (round 4): a `timestamp`-typed partition value is not guaranteed to sit
    at exact midnight (e.g. an hourly-partitioned table) — an equality/IN predicate against
    midnight-only literals would silently exclude every non-midnight partition value even though
    the column validated as date-like. The predicate must be a half-open range spanning the whole
    two-day window instead."""
    validation = {"partitionKeys": ["ts"], "partitionKeyTypes": ["timestamp"]}
    predicate = m._build_partition_predicate(validation, date(2026, 3, 5))
    assert ">=" in predicate and "<" in predicate
    assert "IN (" not in predicate
    assert "TIMESTAMP '2026-03-05 00:00:00'" in predicate
    assert "TIMESTAMP '2026-03-07 00:00:00'" in predicate  # exclusive upper bound covers D and D+1


def test_classify_rule_day_crossing_downgrades_to_unassessable_not_lower_bound():
    status = m.classify_rule_day(compatible_count=0, overlap_count=0, has_source=True, unassessable=True)
    assert status == "unassessable"
    # Never rendered as e.g. "at least N" — the classification itself has no numeric lower bound field.


# ── ENI-membership snapshot staleness three-way split ────────────────────────────────────────────

def test_membership_in_window():
    snaps = [{"observed_at": utc(2026, 3, 3)}, {"observed_at": utc(2026, 3, 7)}]  # 3/7 is AFTER day end
    snap, outcome = m.resolve_membership_snapshot(snaps, date(2026, 3, 5), staleness_days=3)
    assert outcome == "in_window"
    assert snap["observed_at"] == utc(2026, 3, 3)


def test_membership_stale_beyond_staleness_days():
    snaps = [{"observed_at": utc(2026, 1, 1)}]
    snap, outcome = m.resolve_membership_snapshot(snaps, date(2026, 3, 5), staleness_days=3)
    assert outcome == "stale"


def test_membership_pre_snapshotting_backfill_pins_to_earliest():
    snaps = [{"observed_at": utc(2026, 6, 1)}, {"observed_at": utc(2026, 7, 1)}]
    snap, outcome = m.resolve_membership_snapshot(snaps, date(2026, 1, 1), staleness_days=3)
    assert outcome == "pre_snapshotting_backfill"
    assert snap["observed_at"] == utc(2026, 6, 1)  # earliest, not latest


def test_membership_no_snapshot_at_all():
    snap, outcome = m.resolve_membership_snapshot([], date(2026, 1, 1), staleness_days=3)
    assert outcome == "no_snapshot"
    assert snap is None


def test_reprocessing_pre_snapshotting_day_is_idempotent_even_with_a_newer_snapshot_added_later():
    """The idempotent-retry regression test: pinning to the EARLIEST snapshot (not "current") means
    reprocessing the same historical day produces the same result even after a new snapshot appears."""
    first_run_snaps = [{"observed_at": utc(2026, 6, 1)}]
    snap1, outcome1 = m.resolve_membership_snapshot(first_run_snaps, date(2026, 1, 1), staleness_days=3)

    later_snaps = first_run_snaps + [{"observed_at": utc(2026, 8, 1)}]  # a newer snapshot appeared
    snap2, outcome2 = m.resolve_membership_snapshot(later_snaps, date(2026, 1, 1), staleness_days=3)

    assert outcome1 == outcome2 == "pre_snapshotting_backfill"
    assert snap1["observed_at"] == snap2["observed_at"] == utc(2026, 6, 1)


def test_membership_pins_to_explicit_earliest_snapshot_at_when_given():
    """Callers may pass the source's durably-recorded earliest_snapshot_at directly (not derived
    from whatever snapshot rows happen to be in the passed-in list) — this must still win."""
    snaps = [{"observed_at": utc(2026, 6, 1)}]
    snap, outcome = m.resolve_membership_snapshot(
        snaps, date(2026, 1, 1), staleness_days=3, earliest_snapshot_at=utc(2026, 6, 1))
    assert outcome == "pre_snapshotting_backfill"


# ── CIDR / IPv6 / SG-reference / prefix-list / protocol / port-range matching ────────────────────

def test_cidr_v4_match():
    rule = {"protocol": "tcp", "from_port": 443, "to_port": 443, "peer_kind": "cidr",
            "peer_value": "10.0.0.0/8", "is_egress": False}
    flow = {"peer_ip": "10.1.2.3", "port": 443, "protocol": "6", "direction": "ingress"}
    assert m.match_flow_against_rule(rule, flow) == m.MatchOutcome.MATCH


def test_cidr_v4_no_match_outside_range():
    rule = {"protocol": "tcp", "from_port": 443, "to_port": 443, "peer_kind": "cidr",
            "peer_value": "10.0.0.0/8", "is_egress": False}
    flow = {"peer_ip": "192.168.1.1", "port": 443, "protocol": "6", "direction": "ingress"}
    assert m.match_flow_against_rule(rule, flow) == m.MatchOutcome.NO_MATCH


def test_ipv6_internet_match():
    rule = {"protocol": "tcp", "from_port": 443, "to_port": 443, "peer_kind": "cidr",
            "peer_value": "::/0", "is_egress": False}
    flow = {"peer_ip": "2001:db8::1", "port": 443, "protocol": "6", "direction": "ingress"}
    assert m.match_flow_against_rule(rule, flow) == m.MatchOutcome.MATCH


def test_ipv6_family_mismatch_no_match():
    rule = {"protocol": "tcp", "from_port": 443, "to_port": 443, "peer_kind": "cidr",
            "peer_value": "::/0", "is_egress": False}
    flow = {"peer_ip": "10.0.0.1", "port": 443, "protocol": "6", "direction": "ingress"}
    assert m.match_flow_against_rule(rule, flow) == m.MatchOutcome.NO_MATCH


def test_sg_reference_match_via_resolver():
    rule = {"protocol": "tcp", "from_port": 22, "to_port": 22, "peer_kind": "sg",
            "peer_value": "sg-peer", "is_egress": False}
    flow = {"peer_ip": "10.5.5.5", "port": 22, "protocol": "6", "direction": "ingress"}
    resolver = lambda gid: {"10.5.5.5"} if gid == "sg-peer" else set()
    assert m.match_flow_against_rule(rule, flow, sg_peer_ip_resolver=resolver) == m.MatchOutcome.MATCH


def test_sg_reference_unassessable_when_resolver_returns_none():
    rule = {"protocol": "tcp", "from_port": 22, "to_port": 22, "peer_kind": "sg",
            "peer_value": "sg-peer", "is_egress": False}
    flow = {"peer_ip": "10.5.5.5", "port": 22, "protocol": "6", "direction": "ingress"}
    resolver = lambda gid: None  # not resolvable this window (e.g. outside VPC scope / no snapshot)
    assert m.match_flow_against_rule(rule, flow, sg_peer_ip_resolver=resolver) == m.MatchOutcome.UNASSESSABLE


def test_sg_reference_unassessable_when_no_resolver_given():
    rule = {"protocol": "tcp", "from_port": 22, "to_port": 22, "peer_kind": "sg",
            "peer_value": "sg-peer", "is_egress": False}
    flow = {"peer_ip": "10.5.5.5", "port": 22, "protocol": "6", "direction": "ingress"}
    assert m.match_flow_against_rule(rule, flow) == m.MatchOutcome.UNASSESSABLE


def test_prefix_list_match_via_resolver():
    rule = {"protocol": "tcp", "from_port": 443, "to_port": 443, "peer_kind": "pl",
            "peer_value": "pl-1", "is_egress": False}
    flow = {"peer_ip": "203.0.113.5", "port": 443, "protocol": "6", "direction": "ingress"}
    resolver = lambda pl: ["203.0.113.0/24"] if pl == "pl-1" else None
    assert m.match_flow_against_rule(rule, flow, prefix_list_resolver=resolver) == m.MatchOutcome.MATCH


def test_prefix_list_unassessable_when_not_resolvable():
    rule = {"protocol": "tcp", "from_port": 443, "to_port": 443, "peer_kind": "pl",
            "peer_value": "pl-1", "is_egress": False}
    flow = {"peer_ip": "203.0.113.5", "port": 443, "protocol": "6", "direction": "ingress"}
    assert m.match_flow_against_rule(rule, flow) == m.MatchOutcome.UNASSESSABLE


def test_icmp_is_structurally_unassessable():
    rule = {"protocol": "icmp", "from_port": 8, "to_port": 0, "peer_kind": "cidr",
            "peer_value": "0.0.0.0/0", "is_egress": False}
    flow = {"peer_ip": "1.2.3.4", "port": 0, "protocol": "1", "direction": "ingress"}
    assert m.match_flow_against_rule(rule, flow) == m.MatchOutcome.UNASSESSABLE


def test_protocol_mismatch_no_match():
    rule = {"protocol": "udp", "from_port": 53, "to_port": 53, "peer_kind": "cidr",
            "peer_value": "0.0.0.0/0", "is_egress": False}
    flow = {"peer_ip": "1.2.3.4", "port": 53, "protocol": "6", "direction": "ingress"}
    assert m.match_flow_against_rule(rule, flow) == m.MatchOutcome.NO_MATCH


def test_port_range_match():
    rule = {"protocol": "tcp", "from_port": 1024, "to_port": 2048, "peer_kind": "cidr",
            "peer_value": "0.0.0.0/0", "is_egress": False}
    flow = {"peer_ip": "1.2.3.4", "port": 1500, "protocol": "6", "direction": "ingress"}
    assert m.match_flow_against_rule(rule, flow) == m.MatchOutcome.MATCH


def test_all_protocol_all_ports_rule_matches_anything():
    rule = {"protocol": "all", "from_port": None, "to_port": None, "peer_kind": "cidr",
            "peer_value": "0.0.0.0/0", "is_egress": False}
    flow = {"peer_ip": "1.2.3.4", "port": 9999, "protocol": "17", "direction": "ingress"}
    assert m.match_flow_against_rule(rule, flow) == m.MatchOutcome.MATCH


def test_ingress_egress_direction_gating():
    egress_rule = {"protocol": "tcp", "from_port": 443, "to_port": 443, "peer_kind": "cidr",
                   "peer_value": "0.0.0.0/0", "is_egress": True}
    ingress_flow = {"peer_ip": "1.2.3.4", "port": 443, "protocol": "6", "direction": "ingress"}
    assert m.match_flow_against_rule(egress_rule, ingress_flow) == m.MatchOutcome.NO_MATCH


def test_eni_matches_vpc_scope_same_vpc():
    assert m.eni_matches_vpc_scope("vpc-1", "vpc-1", set())


def test_eni_matches_vpc_scope_peered_vpc():
    assert m.eni_matches_vpc_scope("vpc-1", "vpc-2", {"vpc-2"})


def test_eni_matches_vpc_scope_unrelated_vpc_rejected():
    assert not m.eni_matches_vpc_scope("vpc-1", "vpc-9", {"vpc-2"})


# ── classification roll-up ────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("compatible,overlap,has_source,unassessable,expected", [
    (0, 0, False, False, "not_configured"),
    (0, 0, True, True, "unassessable"),
    (0, 0, True, False, "no_observed_evidence"),
    (3, 0, True, False, "observed_compatible"),
    (3, 2, True, False, "overlapping"),
    (3, 0, True, True, "observed_compatible"),  # positive evidence wins over an unassessable flag elsewhere
])
def test_classify_rule_day(compatible, overlap, has_source, unassessable, expected):
    assert m.classify_rule_day(compatible, overlap, has_source, unassessable) == expected


# ── daily pipeline pure helpers ───────────────────────────────────────────────────────────────

def test_delivery_lag_grace_period_honored():
    day = date(2026, 3, 5)
    # exactly at day end + 5h < 6h lag -> not yet eligible
    assert not m.is_day_eligible(day, utc(2026, 3, 6, 5, 0), delivery_lag_hours=6)
    # at day end + 6h -> eligible
    assert m.is_day_eligible(day, utc(2026, 3, 6, 6, 0), delivery_lag_hours=6)


def test_next_day_to_process_from_watermark():
    assert m.next_day_to_process(date(2026, 3, 5), date(2026, 1, 1)) == date(2026, 3, 6)


def test_next_day_to_process_first_run_uses_source_created_day():
    assert m.next_day_to_process(None, date(2026, 1, 1)) == date(2026, 1, 1)


def test_rescan_window_days_trailing_and_ascending():
    days = m.rescan_window_days(date(2026, 3, 5), window_days=2)
    assert days == [date(2026, 3, 4), date(2026, 3, 5)]


def test_rescan_window_never_moves_watermark_itself():
    """rescan_window_days is read-only advice for a re-run — the watermark (last_committed_day) is
    a caller-owned value this function never mutates or returns a "new" version of."""
    watermark = date(2026, 3, 5)
    _ = m.rescan_window_days(watermark, window_days=2)
    assert watermark == date(2026, 3, 5)  # untouched


# ── L3 finding #7: database_name/table_name must be re-validated (no fallback -> raise) ──────────

def _src(database_name="flowlogsdb", table_name="flow_logs", validation=None):
    return {"account_id": "123456789012", "region": "ap-northeast-2", "workgroup": "primary",
            "database_name": database_name, "table_name": table_name, "validation": validation or {}}


def test_safe_ident_raises_without_fallback_on_unsafe_name():
    with pytest.raises(m.UnsafeIdentifier):
        m._safe_ident('db"; DROP TABLE x; --')


def test_safe_ident_falls_back_when_fallback_given():
    assert m._safe_ident("bad name!", "fallback") == "fallback"


def test_build_day_select_raises_on_unsafe_database_name():
    source = _src(database_name='evil"; DROP TABLE x; --')
    with pytest.raises(m.UnsafeIdentifier):
        m.build_day_select(source, date(2026, 3, 5))


def test_build_day_select_raises_on_unsafe_table_name():
    source = _src(table_name='evil"; DROP TABLE x; --')
    with pytest.raises(m.UnsafeIdentifier):
        m.build_day_select(source, date(2026, 3, 5))


def test_scope_partition_expr_clauses_raises_on_unresolvable_account_id_column():
    """MINOR fix (CI review round 4): a scope field marked `scopeResolution: "partition"` but whose
    `columnMap` entry is missing/corrupted must raise `UnsafeIdentifier` (fail closed), not silently
    drop the clause — dropping it would reopen the any-tenant existence-check gap `_partition_exists`'s
    scoping exists to close, for exactly the corrupted-input case that's hardest to notice."""
    validation = {
        "partitionKeys": ["dt", "account-id"], "partitionKeyTypes": ["date", "string"],
        "scopeResolution": {"account_id": "partition", "region": None},
        "columnMap": {},  # corrupted: no "account_id" entry despite resolving as a partition key
    }
    source = {"account_id": "123456789012", "region": "ap-northeast-2"}
    with pytest.raises(m.UnsafeIdentifier):
        m.scope_partition_expr_clauses(validation, source)


def test_build_day_select_never_selects_or_groups_by_srcport():
    """L4 finding #9(i): srcport is unused downstream and inflates group cardinality — must not
    appear in the query at all."""
    sql = m.build_day_select(_src(), date(2026, 3, 5))
    assert "srcport" not in sql


# ── item 4 follow-up fix, MAJOR follow-up: the account/region scope predicate must actually be
#    reachable — it is emitted whenever `validation.columnMap` carries BOTH resolved columns (which
#    the broker's `_validate` now populates via its optional second resolution pass). ──────────────

def test_build_day_select_scopes_to_the_sources_own_account_and_region():
    source = _src(validation={
        "columnMap": {"interface_id": "interface_id", "log_status": "log_status", "start": "start",
                      "account_id": "account_id", "region": "region"},
        "partitionKeys": ["dt"], "partitionKeyTypes": ["date"], "optionalFields": [],
    })
    sql = m.build_day_select(source, date(2026, 3, 5))
    assert '"account_id" = \'123456789012\'' in sql
    assert '"region" = \'ap-northeast-2\'' in sql


def test_build_day_select_adds_no_scope_predicate_without_both_columns():
    """A single-account table (no account_id/region columns) must be unchanged — no predicate."""
    source = _src(validation={
        "columnMap": {"interface_id": "interface_id", "log_status": "log_status", "start": "start"},
        "partitionKeys": ["dt"], "partitionKeyTypes": ["date"], "optionalFields": [],
    })
    sql = m.build_day_select(source, date(2026, 3, 5))
    assert "123456789012" not in sql
    assert "ap-northeast-2" not in sql


# ── item 1 follow-up fix (round 2): each of account_id/region must be scoped INDEPENDENTLY — a
#    table exposing only one of the two still gets that half of scoping, which round 1 (requiring
#    both together) silently discarded entirely. ─────────────────────────────────────────────────

def test_build_day_select_scopes_partially_when_only_account_id_resolved():
    source = _src(validation={
        "columnMap": {"interface_id": "interface_id", "log_status": "log_status", "start": "start",
                      "account_id": "account_id"},
        "partitionKeys": ["dt"], "partitionKeyTypes": ["date"], "optionalFields": [],
    })
    sql = m.build_day_select(source, date(2026, 3, 5))
    assert '"account_id" = \'123456789012\'' in sql
    assert "ap-northeast-2" not in sql


def test_build_day_select_scopes_partially_when_only_region_resolved():
    source = _src(validation={
        "columnMap": {"interface_id": "interface_id", "log_status": "log_status", "start": "start",
                      "region": "region"},
        "partitionKeys": ["dt"], "partitionKeyTypes": ["date"], "optionalFields": [],
    })
    sql = m.build_day_select(source, date(2026, 3, 5))
    assert '"region" = \'ap-northeast-2\'' in sql
    assert "123456789012" not in sql


# ── has_resolved_partition_strategy (L3 finding #8b) ──────────────────────────────────────────────

def test_has_resolved_partition_strategy_true_for_hive_style():
    assert m.has_resolved_partition_strategy({"partitionKeys": ["year", "month", "day"]}) is True


def test_has_resolved_partition_strategy_true_for_single_date_key():
    assert m.has_resolved_partition_strategy(
        {"partitionKeys": ["dt"], "partitionKeyTypes": ["date"]}) is True


def test_has_resolved_partition_strategy_false_for_single_key_without_confirmed_type():
    # item 7 follow-up fix: partitionKeyTypes missing entirely (an older/never-re-validated
    # source) must not be assumed date-like — refuse rather than guess.
    assert m.has_resolved_partition_strategy({"partitionKeys": ["dt"]}) is False


def test_has_resolved_partition_strategy_false_for_single_key_with_non_date_type():
    # item 7 follow-up fix: a bigint-typed lone key (e.g. an epoch-day column happening to be
    # named `dt`) must not be treated as accepting an ISO date-string literal.
    assert m.has_resolved_partition_strategy(
        {"partitionKeys": ["dt"], "partitionKeyTypes": ["bigint"]}) is False


def test_has_resolved_partition_strategy_true_for_single_key_with_parameterized_varchar_type():
    # CI-review MAJOR fix (round 6): a `varchar(10)` (length-parameterized) Glue type is still
    # varchar — must resolve exactly like the bare `varchar` form does.
    assert m.has_resolved_partition_strategy(
        {"partitionKeys": ["dt"], "partitionKeyTypes": ["varchar(10)"]}) is True
    assert m.single_date_partition_key(
        {"partitionKeys": ["dt"], "partitionKeyTypes": ["varchar(10)"]}) == "dt"


# ── is_date_like_partition_type (item 4 follow-up fix, round 2 — public accessor used by
#    sg_rule_athena_broker._validate to reject a non-date-shaped single key at VALIDATE time). ──────

def test_is_date_like_partition_type_true_for_date_and_timestamp_and_text_types():
    assert m.is_date_like_partition_type("date") is True
    assert m.is_date_like_partition_type("timestamp") is True
    assert m.is_date_like_partition_type("string") is True
    assert m.is_date_like_partition_type("varchar") is True
    assert m.is_date_like_partition_type("char") is True


def test_is_date_like_partition_type_false_for_bigint_and_unknown():
    assert m.is_date_like_partition_type("bigint") is False
    assert m.is_date_like_partition_type(None) is False


def test_is_date_like_partition_type_normalizes_parameterized_glue_types():
    """CI-review MAJOR fix (round 6): Glue/Hive legitimately types a column `varchar(10)`/
    `char(20)` (length-parameterized) — an exact-string membership check regressed this to `False`
    even though the underlying type IS varchar/char, permanently refusing a table that scanned fine
    before this round's exact-match check existed."""
    assert m.is_date_like_partition_type("varchar(10)") is True
    assert m.is_date_like_partition_type("char(20)") is True
    assert m.is_date_like_partition_type("VARCHAR(10)") is True
    # Bare (non-parameterized) forms must keep working too.
    assert m.is_date_like_partition_type("varchar") is True
    assert m.is_date_like_partition_type("char") is True
    # A genuinely non-date type must still correctly NOT classify as date-like, parameterized or not.
    assert m.is_date_like_partition_type("boolean") is False
    assert m.is_date_like_partition_type("array<string>") is False
    assert m.is_date_like_partition_type("decimal(10,2)") is False


def test_single_date_partition_key_accepts_string_typed_column():
    assert m.single_date_partition_key(
        {"partitionKeys": ["dt"], "partitionKeyTypes": ["string"]}) == "dt"


def test_single_date_partition_key_none_for_multi_key_without_hive_names():
    assert m.single_date_partition_key(
        {"partitionKeys": ["region", "tier"], "partitionKeyTypes": ["string", "string"]}) is None


def test_has_resolved_partition_strategy_false_when_empty():
    assert m.has_resolved_partition_strategy({"partitionKeys": []}) is False
    assert m.has_resolved_partition_strategy({}) is False


def test_has_resolved_partition_strategy_false_for_ambiguous_multi_key():
    assert m.has_resolved_partition_strategy({"partitionKeys": ["region", "tier"]}) is False


# ── build_day_skipdata_count_select (L4 finding #9(iv)) ───────────────────────────────────────────

def test_build_day_skipdata_count_select_filters_on_skipdata():
    sql = m.build_day_skipdata_count_select(_src(), date(2026, 3, 5))
    assert "SKIPDATA" in sql
    assert "count(*)" in sql


def test_rescan_window_empty_before_first_commit():
    assert m.rescan_window_days(None, window_days=2) == []


# ── redact_sensitive (MINOR fix) ───────────────────────────────────────────────────────────────

def test_redact_sensitive_strips_an_arn():
    text = m.redact_sensitive("AccessDenied on arn:aws:iam::123456789012:role/AWSopsSgRuleAthenaRole")
    assert "123456789012" not in text
    assert "AWSopsSgRuleAthenaRole" not in text
    assert "<arn-redacted>" in text


def test_redact_sensitive_strips_a_bare_account_id():
    text = m.redact_sensitive("could not assume role in account 123456789012")
    assert "123456789012" not in text
    assert "<account-redacted>" in text


def test_redact_sensitive_strips_a_query_execution_id():
    text = m.redact_sensitive("query abcd1234-ab12-cd34-ef56-1234567890ab failed")
    assert "abcd1234-ab12-cd34-ef56-1234567890ab" not in text
    assert "<id-redacted>" in text


def test_redact_sensitive_passes_through_ordinary_text():
    assert m.redact_sensitive("workgroup does not enforce a byte cutoff") == \
        "workgroup does not enforce a byte cutoff"


def test_redact_sensitive_handles_none_and_empty():
    assert m.redact_sensitive(None) is None
    assert m.redact_sensitive("") == ""
