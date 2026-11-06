from concurrent.futures import ThreadPoolExecutor

import pytest

from diagnosis import budget as module
from diagnosis.budget import BudgetExceeded, ReportBudget


def test_deadline_reserves_export_from_handler_start(monkeypatch):
    monkeypatch.setattr(module.time, "monotonic", lambda: 1000.0)
    budget = ReportBudget("mid", started_at=900.0)
    assert budget.remaining() == 2600.0
    assert budget.remaining(analysis=False) == 3200.0
    monkeypatch.setattr(module.time, "monotonic", lambda: 3700.0)
    assert budget.remaining() == 0
    with pytest.raises(BudgetExceeded, match="deadline"):
        budget.reserve("specialist:security", "model", 100, 8192)


def test_concurrent_reservations_cannot_overrun_ceiling_or_final_review():
    budget = ReportBudget("light")

    def reserve(_):
        try:
            return budget.reserve("specialist:security", "model", 10, 8192)
        except BudgetExceeded:
            return None

    with ThreadPoolExecutor(max_workers=4) as pool:
        admitted = [value for value in pool.map(reserve, range(30)) if value]
    assert len(admitted) == 11
    assert len(set(admitted)) == 11
    final = budget.reserve("final_review", "model", 10, 8192)
    budget.record(final, "succeeded", {"input_tokens": 5, "output_tokens": 20})
    assert budget.snapshot()["reserved_output_tokens"] == 12 * 8192


def test_failed_and_retried_attempts_remain_charged_usage_unknown():
    budget = ReportBudget("mid")
    attempt = budget.reserve("review", "model", 100, 8192)
    budget.record(attempt, "provider_error")
    retry = budget.reserve("review", "model", 100, 8192)
    budget.record(retry, "succeeded", {"input_tokens": 10, "output_tokens": 40})
    state = budget.snapshot()
    assert state["attempt_count"] == 2
    assert state["submitted_input_bytes"] == 200
    assert state["reserved_output_tokens"] == 16384
    assert state["actual_usage"] is None
    assert state["known_usage"] == {"input_tokens": 10, "output_tokens": 40}
    assert state["unknown_usage_attempts"] == 1
    with pytest.raises(ValueError, match="recorded"):
        budget.record(retry, "succeeded")


@pytest.mark.parametrize("input_bytes,max_tokens", [(98305, 8192), (100, 8193),
                                                   (-1, 10), (1, 0), (True, 1)])
def test_per_attempt_bounds(input_bytes, max_tokens):
    with pytest.raises((BudgetExceeded, ValueError)):
        ReportBudget("deep").reserve("specialist:security", "model", input_bytes, max_tokens)


def test_input_ceiling_cannot_be_circumvented_by_unknown_usage():
    budget = ReportBudget("light")
    for _ in range(19):
        attempt = budget.reserve("review", "model", 98304, 1)
        budget.record(attempt, "provider_error")
    with pytest.raises(BudgetExceeded):
        budget.reserve("specialist:security", "model", 98304, 1)
    assert budget.snapshot()["unknown_usage_attempts"] == 19


def test_snapshot_is_detached_and_unknown_tier_rejected():
    with pytest.raises(ValueError):
        ReportBudget("unknown")
    budget = ReportBudget("deep")
    attempt = budget.reserve("review", "model", 1, 1)
    state = budget.snapshot()
    state["attempts"][0]["stage"] = "tampered"
    assert budget.snapshot()["attempts"][0]["stage"] == "review"
    with pytest.raises(ValueError):
        budget.record("fabricated", "succeeded")
    budget.record(attempt, "invalid_output", {"input_tokens": -1, "output_tokens": 2})
    assert budget.snapshot()["actual_usage"] is None


def test_ledger_reads_the_same_task_and_reserve_env_as_report():
    # A fresh interpreter: reloading modules in-process would fork exception classes.
    import os
    import subprocess
    import sys
    code = ("import time; from diagnosis import budget, report; "
            "assert (budget.TASK_SECONDS, budget.EXPORT_RESERVE_SECONDS) == (1800, 300); "
            "assert (report._TASK_BUDGET_S, report._POST_RENDER_RESERVE_S) == (1800, 300); "
            "b = budget.ReportBudget('mid', started_at=time.monotonic()); "
            "assert 1490 < b.remaining() <= 1500 and 1790 < b.remaining(analysis=False) <= 1800")
    env = {**os.environ, "DIAGNOSIS_TASK_BUDGET_S": "1800", "DIAGNOSIS_POST_RENDER_RESERVE_S": "300"}
    workers = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    subprocess.run([sys.executable, "-c", code], cwd=workers, env=env, check=True)
