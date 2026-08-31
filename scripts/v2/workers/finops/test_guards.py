from finops import guards


def test_protected_tag_hit_case_insensitive_key_and_value():
    assert guards.protected_tag({"DR": "true"}) == "protected_tag:DR"
    assert guards.protected_tag({"Compliance": "yes"}) == "protected_tag:Compliance"


def test_protected_tag_no_hit_on_falsy_value():
    assert guards.protected_tag({"dr": "false"}) is None
    assert guards.protected_tag({"dr": "0"}) is None
    assert guards.protected_tag({"dr": ""}) is None


def test_protected_tag_no_hit_on_unrelated_tags_or_none():
    assert guards.protected_tag({"Name": "web-1"}) is None
    assert guards.protected_tag(None) is None
    assert guards.protected_tag({}) is None


def test_insufficient_observation_hit_below_threshold():
    assert guards.insufficient_observation(7) == "insufficient_observation_period"
    assert guards.insufficient_observation(13) == "insufficient_observation_period"


def test_insufficient_observation_no_hit_at_or_above_threshold():
    assert guards.insufficient_observation(14) is None
    assert guards.insufficient_observation(30) is None


def test_insufficient_observation_no_hit_when_not_a_compute_optimizer_finding():
    assert guards.insufficient_observation(None) is None


def test_stale_row_data_hit_only_when_true():
    assert guards.stale_row_data(True) == "stale_inventory_data"
    assert guards.stale_row_data(False) is None


def test_guard_hits_aggregates_all_firing_guards():
    hits = guards.guard_hits(tags={"dr": "true"}, lookback_days=7, stale=True)
    assert hits == ["protected_tag:dr", "insufficient_observation_period", "stale_inventory_data"]


def test_guard_hits_empty_when_nothing_fires():
    assert guards.guard_hits(tags={"Name": "x"}, lookback_days=30, stale=False) == []


def test_guard_hits_defaults_stale_to_false():
    assert guards.guard_hits(tags=None, lookback_days=None) == []
