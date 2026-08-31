"""Exhaustive tests for the deterministic per-candidate and overall status reduction rules
(network_path_reduce.py) — the deterministic core the whole Network Path Check feature's
correctness depends on. Every case here cites the design spec paragraph it verifies."""
import pytest

import network_path_reduce as reduce


# ── Per-candidate reduction ──────────────────────────────────────────────────────────────────────

class TestCandidateReduction:
    def test_all_not_run_is_failed(self):
        # Rule 1: zero evidence gathered -> failed (checked BEFORE rule 3's "at least one not_run").
        assert reduce.reduce_candidate_status(["not_run", "not_run"]) == "failed"

    def test_empty_layer_list_is_failed(self):
        # No layer even started == zero evidence, same as all-not_run.
        assert reduce.reduce_candidate_status([]) == "failed"

    def test_rule1_precedes_rule3_not_swallowed(self):
        # This is the exact case the 2026-08-19 review fix closed: without explicit precedence,
        # "all not_run" also satisfies "at least one not_run" and `failed` would be unreachable.
        result = reduce.reduce_candidate_status(["not_run", "not_run", "not_run"])
        assert result == "failed"
        assert result != "conditional"

    def test_any_blocked_is_blocked(self):
        assert reduce.reduce_candidate_status(["allowed", "blocked", "allowed"]) == "blocked"

    def test_blocked_takes_precedence_over_not_run(self):
        assert reduce.reduce_candidate_status(["blocked", "not_run"]) == "blocked"

    @pytest.mark.parametrize("mix", [
        ["allowed", "unknown"],
        ["allowed", "not_run"],
        ["allowed", "conditional"],
        ["unknown"],
        ["conditional"],
    ])
    def test_conditional_when_no_blocked_but_uncertain(self, mix):
        assert reduce.reduce_candidate_status(mix) == "conditional"

    def test_layer_own_conditional_propagates_never_generalized_to_allowed(self):
        # The NACL-ephemeral-probe case: a layer that emits `conditional` itself must make the
        # candidate `conditional`, never silently become `allowed`.
        assert reduce.reduce_candidate_status(["allowed", "allowed", "conditional"]) == "conditional"

    def test_all_allowed_is_allowed(self):
        assert reduce.reduce_candidate_status(["allowed", "allowed", "allowed"]) == "allowed"


# ── Overall reduction: all-resolved ──────────────────────────────────────────────────────────────

class TestAllResolved:
    def _cands(self, statuses):
        return [{"kind": "resolved", "status": s} for s in statuses]

    def test_all_allowed(self):
        assert reduce.reduce_overall_status(self._cands(["allowed", "allowed"])) == "allowed"

    def test_all_blocked(self):
        assert reduce.reduce_overall_status(self._cands(["blocked", "blocked"])) == "blocked"

    def test_blocked_and_allowed_is_conditional_not_allowed(self):
        # Disagreement among resolved candidates -> conditional, never allowed.
        assert reduce.reduce_overall_status(self._cands(["blocked", "allowed"])) == "conditional"

    def test_no_allowed_at_least_one_conditional_is_conditional(self):
        assert reduce.reduce_overall_status(self._cands(["blocked", "conditional"])) == "conditional"

    def test_no_allowed_no_conditional_blocked_and_failed_mix_is_failed(self):
        # A zero-evidence `failed` candidate mixed with `blocked` (not all-blocked) -> failed, not
        # blocked (overstates confidence otherwise).
        assert reduce.reduce_overall_status(self._cands(["blocked", "failed"])) == "failed"

    def test_all_failed_is_failed(self):
        assert reduce.reduce_overall_status(self._cands(["failed", "failed"])) == "failed"


# ── Overall reduction: all-hypothesis ────────────────────────────────────────────────────────────

class TestAllHypothesis:
    def _cands(self, statuses):
        return [{"kind": "hypothesis", "status": s} for s in statuses]

    def test_all_allowed(self):
        assert reduce.reduce_overall_status(self._cands(["allowed", "allowed"])) == "allowed"

    def test_all_blocked(self):
        assert reduce.reduce_overall_status(self._cands(["blocked", "blocked"])) == "blocked"

    def test_all_failed(self):
        assert reduce.reduce_overall_status(self._cands(["failed", "failed"])) == "failed"

    def test_disagreement_allowed_and_blocked_is_conditional(self):
        assert reduce.reduce_overall_status(self._cands(["allowed", "blocked"])) == "conditional"

    def test_all_blocked_and_failed_no_allowed_not_unanimous_is_conditional(self):
        # Spec: "entirely blocked+failed (no allowed, not unanimous) still reduces to conditional,
        # not blocked or failed — the disagreement rule takes precedence."
        assert reduce.reduce_overall_status(self._cands(["blocked", "failed"])) == "conditional"

    def test_single_hypothesis_allowed(self):
        assert reduce.reduce_overall_status(self._cands(["allowed"])) == "allowed"


# ── Overall reduction: mixed resolved + hypothesis ──────────────────────────────────────────────

class TestMixedSet:
    def _mix(self, resolved_statuses, hyp_statuses):
        return ([{"kind": "resolved", "status": s} for s in resolved_statuses]
                + [{"kind": "hypothesis", "status": s} for s in hyp_statuses])

    def test_both_all_allowed(self):
        assert reduce.reduce_overall_status(self._mix(["allowed"], ["allowed"])) == "allowed"

    def test_both_all_blocked(self):
        assert reduce.reduce_overall_status(self._mix(["blocked"], ["blocked"])) == "blocked"

    def test_resolved_allowed_hypothesis_blocked_is_conditional_not_allowed(self):
        # A resolved `allowed` never offsets a hypothesis `blocked`.
        assert reduce.reduce_overall_status(self._mix(["allowed"], ["blocked"])) == "conditional"

    def test_hypothesis_allowed_resolved_blocked_is_conditional_not_allowed(self):
        # And vice versa: a unanimous-allowed hypothesis set never offsets a resolved blocked.
        assert reduce.reduce_overall_status(self._mix(["blocked"], ["allowed"])) == "conditional"

    def test_either_partial_failed_neither_allowed_nor_conditional_is_failed(self):
        assert reduce.reduce_overall_status(self._mix(["blocked", "failed"], ["blocked"])) == "failed"

    def test_conditional_present_anywhere_is_conditional(self):
        assert reduce.reduce_overall_status(self._mix(["allowed"], ["blocked", "allowed"])) == "conditional"


class TestGlobalFailureBypass:
    def test_empty_candidate_list_raises_caller_must_bypass(self):
        # Global execution-level failure before discovery bypasses this function entirely — an
        # empty candidate list reaching it is a caller bug, not a valid "failed" input.
        with pytest.raises(ValueError):
            reduce.reduce_overall_status([])
