"""One thread-safe allocation ledger from handler entry through artifact export."""
from copy import deepcopy
import math
import os
import threading
import time


# The single parse of the task ledger; report.py imports these so the render
# deadline and this analysis ledger cannot desynchronize.
TASK_SECONDS = int(os.environ.get("DIAGNOSIS_TASK_BUDGET_S", "3300"))
EXPORT_RESERVE_SECONDS = int(os.environ.get("DIAGNOSIS_POST_RENDER_RESERVE_S", "600"))
MAX_INPUT_BYTES = 96 * 1024
MAX_OUTPUT_TOKENS = 8192
# Opus 5.x cannot disable thinking, which spends from max_tokens; report.py shares this parse.
OPUS_THINKING_HEADROOM = max(0, int(os.environ.get("DIAGNOSIS_OPUS_THINKING_HEADROOM", "8000")))


def opus_headroom(model_id):
    """Thinking headroom for Opus 5.x only; an Opus 4.x rollback override takes thinking off."""
    return OPUS_THINKING_HEADROOM if "claude-opus-5" in model_id else 0


def attempt_tokens(model_id):
    return MAX_OUTPUT_TOKENS + opus_headroom(model_id)


# Holdback for the final review: the largest attempt any review model can request.
MAX_REVIEW_TOKENS = MAX_OUTPUT_TOKENS + OPUS_THINKING_HEADROOM


TIER_LIMITS = {
    "light": {"attempts": 20, "input_bytes": 2 * 1024 * 1024, "output_tokens": 100000},
    "mid": {"attempts": 24, "input_bytes": 3 * 1024 * 1024, "output_tokens": 120000},
    "deep": {"attempts": 32, "input_bytes": 4 * 1024 * 1024, "output_tokens": 200000},
}


class BudgetExceeded(RuntimeError):
    """A visible allocation/deadline failure; callers return partial coverage."""


class ReportBudget:
    def __init__(self, tier, started_at=None):
        if tier not in TIER_LIMITS:
            raise ValueError("unknown diagnosis tier")
        self.tier = tier
        self.started_at = time.monotonic() if started_at is None else started_at
        if not isinstance(self.started_at, (int, float)) or not math.isfinite(self.started_at):
            raise ValueError("started_at must be a monotonic timestamp")
        self.limits = dict(TIER_LIMITS[tier])
        self._lock = threading.Lock()
        self._attempts = {}
        self._input_bytes = 0
        self._output_tokens = 0

    def remaining(self, analysis=True):
        reserve = EXPORT_RESERVE_SECONDS if analysis else 0
        return max(0.0, self.started_at + TASK_SECONDS - reserve - time.monotonic())

    def reserve(self, stage, model_id, input_bytes, max_tokens):
        if not isinstance(stage, str) or not stage or not isinstance(model_id, str) or not model_id:
            raise ValueError("stage and model_id must be named")
        if type(input_bytes) is not int or type(max_tokens) is not int or input_bytes < 0 or max_tokens < 1:
            raise ValueError("attempt allocations must be nonnegative integer bytes and positive tokens")
        if input_bytes > MAX_INPUT_BYTES or max_tokens > attempt_tokens(model_id):
            raise BudgetExceeded("per-attempt allocation exceeded")
        with self._lock:
            if self.remaining() <= 0:
                raise BudgetExceeded("analysis deadline exhausted")
            # Every specialist/retry leaves capacity for a bounded final review.
            # Review attempts can consume this reserve. Nothing refunds a failed attempt.
            final = stage in {"review", "final_review"}
            held_calls = 0 if final else 1
            held_bytes = 0 if final else MAX_INPUT_BYTES
            # The review may run on a heavier model than this specialist (Opus-class thinking).
            held_tokens = 0 if final else MAX_REVIEW_TOKENS
            if len(self._attempts) + 1 + held_calls > self.limits["attempts"]:
                raise BudgetExceeded("model attempt ceiling exhausted")
            if self._input_bytes + input_bytes + held_bytes > self.limits["input_bytes"]:
                raise BudgetExceeded("submitted input ceiling exhausted")
            if self._output_tokens + max_tokens + held_tokens > self.limits["output_tokens"]:
                raise BudgetExceeded("reserved output ceiling exhausted")
            attempt_id = f"attempt-{len(self._attempts) + 1}"
            self._attempts[attempt_id] = {
                "id": attempt_id, "stage": stage, "model_id": model_id,
                "input_bytes": input_bytes, "max_tokens": max_tokens,
                "outcome": "pending", "usage": None, "elapsed_seconds": None,
                "_started_at": time.monotonic(),
            }
            self._input_bytes += input_bytes
            self._output_tokens += max_tokens
            return attempt_id

    def record(self, attempt_id, outcome, usage=None):
        if not isinstance(outcome, str) or not outcome:
            raise ValueError("outcome must be named")
        with self._lock:
            attempt = self._attempts.get(attempt_id)
            if attempt is None:
                raise ValueError("unknown attempt")
            if attempt["outcome"] != "pending":
                raise ValueError("attempt already recorded")
            normalized = None
            if isinstance(usage, dict):
                counts = {key: usage.get(key) for key in ("input_tokens", "output_tokens")}
                if all(type(value) is int and value >= 0 for value in counts.values()):
                    normalized = counts
            attempt["outcome"] = outcome
            attempt["usage"] = normalized
            attempt["elapsed_seconds"] = max(0.0, time.monotonic() - attempt["_started_at"])

    def snapshot(self):
        with self._lock:
            attempts = [{key: deepcopy(value) for key, value in row.items() if not key.startswith("_")}
                        for row in self._attempts.values()]
            known = {"input_tokens": 0, "output_tokens": 0}
            unknown = 0
            for row in attempts:
                if row["usage"] is None:
                    unknown += 1
                else:
                    for key in known:
                        known[key] += row["usage"][key]
            return {
                "tier": self.tier, "limits": dict(self.limits),
                "attempt_count": len(attempts), "attempts": attempts,
                "submitted_input_bytes": self._input_bytes,
                "reserved_output_tokens": self._output_tokens,
                "actual_usage": None if unknown else dict(known),
                "known_usage": known, "unknown_usage_attempts": unknown,
                "analysis_remaining_seconds": self.remaining(),
                "task_remaining_seconds": self.remaining(analysis=False),
                "export_reserve_seconds": EXPORT_RESERVE_SECONDS,
            }
