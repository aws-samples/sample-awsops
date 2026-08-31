"""ADR-020 false-positive guards. A guard hit does NOT drop a finding — it demotes status to
'needs_review' and records the reason in guard_hits, so the finding stays visible (the ADR's
explicit "does not hide" invariant) instead of silently vanishing.

Each guard is a pure function: (evidence: dict) -> str | None (the guard-hit reason, or None).
Keep them independent and side-effect-free so rules.py can call all of them uniformly.
"""

# Tag keys whose presence (any non-empty, non-'false' value) marks a resource as intentionally
# kept — DR standby, compliance retention, or an explicit do-not-touch marker. Case-insensitive on
# both key and value. This is a small, explicit denylist rather than a heuristic guess — false
# negatives (a real DR volume with an unrecognized tag key) fall through un-guarded, which is the
# safer failure direction for a "does not hide, only flags" system: the item is still visible.
_PROTECTED_TAG_KEYS = {"dr", "disaster-recovery", "compliance", "retention", "do-not-delete", "donotdelete"}
_FALSY = {"false", "0", "no", ""}


def protected_tag(tags):
    """tags: dict[str, str] (or None). Returns 'protected_tag:<key>' on a hit."""
    if not tags:
        return None
    for k, v in tags.items():
        if str(k).lower() in _PROTECTED_TAG_KEYS and str(v).lower() not in _FALSY:
            return f"protected_tag:{k}"
    return None


# Compute Optimizer's own console/docs describe recommendations as unreliable below roughly two
# weeks of metrics. There is NO "INSUFFICIENT_DATA" value in either GetEC2InstanceRecommendations'
# or GetRDSDatabaseRecommendations' `finding` enum (verified against botocore's service model) —
# `lookBackPeriodInDays`/`lookbackPeriodInDays` is the real per-recommendation signal.
_MIN_OBSERVATION_DAYS = 14


def insufficient_observation(lookback_days):
    """lookback_days: the Compute Optimizer recommendation's own lookBackPeriodInDays (or None —
    not a Compute Optimizer finding, e.g. the EBS rule). Below the threshold, the metrics behind
    the recommendation haven't accumulated long enough to be trustworthy yet — the finding still
    carries a real dollar estimate worth showing, just with lower confidence, so it's demoted
    rather than omitted."""
    if lookback_days is not None and lookback_days < _MIN_OBSERVATION_DAYS:
        return "insufficient_observation_period"
    return None


def stale_row_data(is_stale):
    """A per-row inventory_resources.captured_at that's older than the rule's own freshness
    threshold. This is DIFFERENT from _require_fresh_inventory's job-level check in rules.py:
    inventory_sync_runs can legitimately say `succeeded` for the whole batch while one specific
    account's connection failed that cycle — sync_lambda.py's own M5 guard deliberately PRESERVES
    (does not prune) that account's now-stale rows rather than deleting them, specifically so nothing
    gets lost. That means a row can come back from a perfectly "successful" sync while itself being
    weeks old. Demoting it here — rather than trusting it as confirmed-current evidence — is what
    stops a job-level "succeeded" from masking genuinely stale per-account data."""
    return "stale_inventory_data" if is_stale else None


def guard_hits(*, tags=None, lookback_days=None, stale=False):
    """Run every guard and return the list of hit reasons (empty = no guard fired)."""
    hits = []
    for hit in (protected_tag(tags), insufficient_observation(lookback_days), stale_row_data(stale)):
        if hit:
            hits.append(hit)
    return hits
